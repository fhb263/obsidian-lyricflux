import { App, Modal, Notice, Setting, TFile, ButtonComponent, setIcon } from 'obsidian'
import type LyricsPlugin from 'main'
import { resolveAudioSource, readAudioFileBytes, parseTagsForPlugin, writeMp3Tags, getAudioFileSize, type Mp3Tags, type AudioSource } from 'tags'
import { downloadImage } from 'onlineLyrics'
import { searchCandidates, fetchSongLyrics, translateLyricText, type DownloadSong } from 'downloadManager'
import { formatDuration } from 'downloadUtils'
import { estimateEmbeddedSize, formatBytes } from 'tagSize'
import { estimateMp3Duration, formatDurationColon } from 'mp3Duration'
import { detectAudioContainer } from 'songScanner'

/** 多源来源标签（候选列表来源胶囊显示） */
const SOURCE_LABELS: Record<string, string> = {
    netease: '网易云',
    qq: 'QQ',
    kugou: '酷狗',
    kuwo: '酷我',
}

export default class TagEditorModal extends Modal {
    private tags: Mp3Tags = {}
    private source: AudioSource | null = null
    private saving = false
    private coverInput: HTMLInputElement | null = null
    private coverPreview: HTMLElement | null = null
    private coverCandidatesEl: HTMLElement | null = null // 多平台封面候选列表容器（缩略图网格）
    private newFileName = '' // 文件名重命名目标（含扩展名），空 = 不改名
    private fetching = false // 在线歌词获取中标志（防重复点击）
    private fileSizeBytes = 0 // 当前文件字节数（0 = 读取失败/未知）
    private durationSec = 0 // 当前音频时长（秒，0 = 解析失败/未知）
    private baselineEmbedded = 0 // 打开时原标签在 ID3v2 中的估算字节，用于计算保存后的预计增量
    private sizeDescEl: HTMLElement | null = null // 「文件大小」提示行，随编辑实时刷新
    private lyricCandidatesEl: HTMLElement | null = null // 多平台歌词候选列表容器
    private lyricCandidatesRow: DownloadSong[] = [] // 当前候选列表（保留供后续用）
    private fetchingLyrics = false // 歌词候选加载中标志
    private translating = false // 歌词翻译中标志
    private translateCancelled = false // 翻译取消标志（翻译中点按钮置 true 中断）
    private translateStartedAt = 0 // 翻译开始时间（performance.now），用于估算剩余时间
    private translateAbort: AbortController | null = null // 翻译取消控制器：abort 立即中止在途 DeepSeek 请求
    private translateProgressTimer: number | null = null // 动画进度条计时器：20 秒内 0→99%，超时卡 99% 等真实结果
    private translateProgressFlashTimer: number | null = null // 翻译完成「瞬间 100%」短暂停留后隐藏的定时器
    private translateProgressWrap: HTMLElement | null = null // 翻译进度条容器
    private translateProgressFill: HTMLElement | null = null // 翻译进度条填充
    private translateProgressText: HTMLElement | null = null // 翻译进度文字

    constructor(
        app: App,
        private plugin: LyricsPlugin,
        private notePath: string,
        private initialSource?: AudioSource, // v1.5.0：裸 MP3 直接传音频源（无笔记）
    ) {
        super(app)
    }

    async onOpen() {
        this.contentEl.empty()
        this.contentEl.addClass('lyrics-tag-editor')
        this.titleEl.setText('编辑标签')

        const loading = this.contentEl.createDiv({ cls: 'lyrics-tag-loading', text: '正在读取标签…' })
        this.source = this.initialSource ?? await resolveAudioSource(this.app, this.notePath)
        if (!this.source) {
            new Notice('未找到该歌曲的 MP3 文件')
            this.close()
            return
        }
        // 仅 MP3 可编辑：其余格式只读展示，拒绝编辑以免把 ID3 帧写进 FLAC/M4A/OGG 损坏文件
        const isMp3 = this.source.type === 'vault'
            ? /\.mp3$/i.test(this.source.file?.name ?? '')
            : /\.mp3$/i.test(this.source.path ?? '')
        if (!isMp3) {
            new Notice('仅 MP3 可编辑标签，该格式为只读展示', 4000)
            this.close()
            return
        }
        const bytes = await readAudioFileBytes(this.app, this.source)
        // 真实容器检测：扩展名为 .mp3 但实为 M4A/AAC（从 mp4 提取只改扩展名）等伪 mp3，
        // 若按 MP3 编辑保存，node-id3 会把 M4A 容器按 MPEG 处理破坏 moov atom → 文件损坏。
        // 直接拒绝编辑并提示，避免破坏文件。
        if (bytes) {
            const container = detectAudioContainer(bytes)
            if (container !== 'mp3' && container !== 'unknown') {
                const label = container === 'm4a' ? 'M4A/AAC' : container.toUpperCase()
                new Notice(`该文件实为 ${label} 格式（扩展名为 .mp3），为避免损坏文件已禁止编辑`, 6000)
                this.close()
                return
            }
        }
        this.tags = bytes ? parseTagsForPlugin(bytes) ?? {} : {}
        this.durationSec = bytes ? estimateMp3Duration(bytes) ?? 0 : 0
        const size = await getAudioFileSize(this.app, this.source)
        this.fileSizeBytes = size ?? 0
        this.baselineEmbedded = estimateEmbeddedSize(this.tags)
        loading.remove()
        this.render()
    }

    private render() {
        const { contentEl } = this
        contentEl.empty()

        // 文件名（重命名；保存时对 vault 用 Obsidian 重命名，库外同步改笔记 source 行）
        const nameSetting = new Setting(contentEl)
            .setName('文件名')
            .setDesc(this.getCurrentAbsolutePath())
        nameSetting.addText((text) => {
            const current = this.getCurrentFileName()
            text.setValue(current)
                .setPlaceholder('输入新文件名（含扩展名）')
                .onChange((v) => { this.newFileName = v.trim() })
        })

        // 文件大小 + 预计保存后大小（歌词/封面/文本编辑时实时刷新）
        const sizeSetting = new Setting(contentEl).setName('文件大小')
        this.sizeDescEl = sizeSetting.descEl
        this.updateSizeEstimate()

        const textFields: Array<['title' | 'artist' | 'album', string]> = [
            ['title', '标题'], ['artist', '艺术家'], ['album', '专辑'],
        ]
        for (const [key, label] of textFields) {
            new Setting(contentEl).setName(label).addText((text) => {
                text.setValue(this.tags[key] ?? '')
                text.onChange((v) => { this.tags[key] = v; this.updateSizeEstimate() })
            })
        }

        // 歌词（textarea，一键粘贴整段；「获取歌词」多平台搜索候选手动选择、「翻译歌词」生成 原文 | 译文）
        // desc 显示当前音频时长（如 03:25）；「获取歌词」「翻译歌词」放标题行右侧，与封面区按钮同高
        const lyricsSetting = new Setting(contentEl).setName('歌词').setDesc(
            this.durationSec > 0 ? formatDurationColon(this.durationSec) : '时长未知',
        )
        const lyricsArea = contentEl.createEl('textarea', { cls: 'lyrics-tag-lyrics' })
        lyricsArea.value = this.tags.lyrics ?? ''
        lyricsArea.addEventListener('input', () => { this.tags.lyrics = lyricsArea.value; this.updateSizeEstimate() })
        lyricsSetting.addButton((btn) => btn.setButtonText('翻译歌词').onClick(() => void this.translateLyrics(lyricsArea, btn)))
        lyricsSetting.addButton((btn) => btn.setCta().setButtonText('获取歌词').onClick(() => void this.fetchOnlineLyrics(lyricsArea, btn)))
        // 翻译歌词进度条（默认隐藏，翻译中显示；位于歌词框正下方）
        const translateProgressWrap = contentEl.createDiv({ cls: 'lyrics-tag-translate-progress lyrics-tag-translate-progress-hidden' })
        const translateProgressTrack = translateProgressWrap.createDiv({ cls: 'lyrics-tag-translate-progress-track' })
        this.translateProgressFill = translateProgressTrack.createDiv({ cls: 'lyrics-tag-translate-progress-fill' })
        this.translateProgressText = translateProgressWrap.createDiv({ cls: 'lyrics-tag-translate-progress-text' })
        this.translateProgressWrap = translateProgressWrap
        // 多平台歌词候选列表（获取歌词后展示，点击某条导入后收起）
        const candidateBox = contentEl.createDiv({ cls: 'lyrics-tag-lyric-candidates lyrics-tag-lyric-candidates-hidden' })
        this.lyricCandidatesEl = candidateBox

        // 封面
        const coverSetting = new Setting(contentEl).setName('封面')
        this.coverPreview = contentEl.createDiv({ cls: 'lyrics-tag-cover-preview' })
        this.renderCoverPreview()
        coverSetting.addButton((btn) => btn.setButtonText('选择图片').onClick(() => this.coverInput?.click()))
        coverSetting.addButton((btn) => btn.setCta().setButtonText('获取封面').onClick(() => void this.fetchCover(btn)))
        coverSetting.addButton((btn) => btn.setWarning().setButtonText('移除封面').onClick(() => {
            this.tags.cover = null
            this.renderCoverPreview()
            this.updateSizeEstimate()
        }))
        this.coverInput = contentEl.createEl('input', {
            cls: 'lyrics-tag-cover-input',
            attr: { type: 'file', accept: 'image/*' },
        })
        // 多平台封面候选列表（获取封面后展示，缩略图，点击某条导入后收起）
        const coverCandidatesBox = contentEl.createDiv({ cls: 'lyrics-tag-cover-candidates lyrics-tag-lyric-candidates-hidden' })
        this.coverCandidatesEl = coverCandidatesBox
        this.coverInput.addEventListener('change', () => {
            const f = this.coverInput?.files?.[0]
            if (!f) return
            const reader = new FileReader()
            reader.onload = () => {
                this.tags.cover = { mime: f.type || 'image/jpeg', data: new Uint8Array(reader.result as ArrayBuffer) }
                this.renderCoverPreview()
                this.updateSizeEstimate()
            }
            reader.readAsArrayBuffer(f)
        })

        // 按钮：删除文件（垃圾桶图标，二次点击确认）/ 取消 / 保存
        const actions = contentEl.createDiv({ cls: 'lyrics-tag-actions' })
        const deleteBtn = actions.createEl('button', { cls: 'lyrics-tag-delete' })
        let deleteArmed = false
        let armTimer: number | null = null
        const renderDelete = () => {
            deleteBtn.empty()
            if (deleteArmed) {
                deleteBtn.setText('再次点击确认删除')
                return
            }
            const ic = deleteBtn.createSpan({ cls: 'lyrics-tag-delete-icon' })
            setIcon(ic, 'trash')
            deleteBtn.createSpan({ text: '删除文件' })
        }
        renderDelete()
        deleteBtn.addEventListener('click', () => {
            if (this.saving) return
            if (!deleteArmed) {
                // 第一次点击：武装，需再次点击才真正删除
                deleteArmed = true
                deleteBtn.addClass('lyrics-tag-delete-armed')
                renderDelete()
                new Notice('再次点击确认删除该文件', 4000)
                if (armTimer !== null) window.clearTimeout(armTimer)
                armTimer = window.setTimeout(() => {
                    deleteArmed = false
                    deleteBtn.removeClass('lyrics-tag-delete-armed')
                    renderDelete()
                }, 4000)
                return
            }
            if (armTimer !== null) window.clearTimeout(armTimer)
            void this.deleteFile()
        })
        actions.createEl('button', { text: '取消', cls: 'mod-cta lyrics-tag-cancel' })
            .addEventListener('click', () => this.close())
        actions.createEl('button', { text: '保存', cls: 'mod-cta lyrics-tag-save' })
            .addEventListener('click', () => this.save())
    }

    /** 用标题/艺术家做多平台搜索，返回候选列表（含来源/时长），供手动选择；无标题返回空 */
    private async searchLyricCandidates(): Promise<DownloadSong[]> {
        const title = (this.tags.title ?? '').trim() || this.getCurrentFileName().replace(/\.[^.]+$/, '')
        const artist = (this.tags.artist ?? '').trim()
        if (!title) {
            new Notice('无标题，无法搜索')
            return []
        }
        const query = artist ? `${title} ${artist}` : title
        // 四平台并行搜索（downloadManager 内部已按相似度排序），返回含 source/duration 的候选
        return await searchCandidates(query, this.plugin.getSettings().downloadSources)
    }

    /** 从多平台拉取当前歌曲歌词：搜索后展示候选列表（含来源/时长），点击某条导入歌词框 */
    private async fetchOnlineLyrics(lyricsArea: HTMLTextAreaElement, btn: ButtonComponent): Promise<void> {
        if (this.fetching) return
        this.fetching = true
        btn.setDisabled(true)
        btn.setButtonText('搜索中…')
        try {
            const candidates = await this.searchLyricCandidates()
            if (candidates.length === 0) {
                new Notice('未找到匹配的歌曲')
                return
            }
            this.renderLyricCandidates(candidates, lyricsArea)
        } catch (e) {
            new Notice(`获取歌词失败：${(e as Error).message || '网络错误'}`, 5000)
        } finally {
            this.fetching = false
            btn.setDisabled(false)
            btn.setButtonText('获取歌词')
        }
    }

    /** 渲染多平台歌词候选列表：每行来源胶囊 + 歌名/歌手 + 时长，点击导入对应歌词 */
    private renderLyricCandidates(candidates: DownloadSong[], lyricsArea: HTMLTextAreaElement): void {
        const box = this.lyricCandidatesEl
        if (!box) return
        box.empty()
        box.removeClass('lyrics-tag-lyric-candidates-hidden')
        // 标题行：文字 + 右上角关闭按钮
        const titleRow = box.createDiv({ cls: 'lyrics-tag-lyric-candidates-title' })
        titleRow.createSpan({ cls: 'lyrics-tag-lyric-candidates-title-text', text: '选择歌词来源（点击导入）：' })
        const closeBtn = titleRow.createEl('button', { cls: 'lyrics-tag-lyric-candidates-close', text: '✕' })
        closeBtn.setAttribute('title', '关闭')
        closeBtn.addEventListener('click', () => this.hideLyricCandidates())
        for (const s of candidates) {
            const row = box.createDiv({ cls: 'lyrics-tag-lyric-candidate' })
            row.setAttribute('data-key', `${s.source}:${s.id}`)
            // 来源胶囊
            row.createSpan({ cls: `lyrics-tag-lyric-source lyrics-tag-lyric-source-${s.source}`, text: SOURCE_LABELS[s.source] ?? s.source })
            // 歌名/歌手 + 时长
            const meta = row.createSpan({ cls: 'lyrics-tag-lyric-candidate-meta' })
            meta.setText(`${s.name} - ${s.artist || '未知艺术家'}${s.duration ? ` · ${formatDuration(s.duration)}` : ''}`)
            row.addEventListener('click', () => void this.importLyric(s, row, lyricsArea))
        }
        this.lyricCandidatesRow = candidates
    }

    /** 拉取并导入所选候选的歌词到歌词框（保存时写回 USLT） */
    private async importLyric(song: DownloadSong, row: HTMLElement, lyricsArea: HTMLTextAreaElement): Promise<void> {
        if (this.fetchingLyrics) return
        this.fetchingLyrics = true
        row.addClass('lyrics-tag-lyric-candidate-loading')
        try {
            const lrc = await fetchSongLyrics(song)
            if (!lrc) {
                new Notice(`该歌曲无歌词（${SOURCE_LABELS[song.source] ?? song.source}）`, 4000)
                return
            }
            lyricsArea.value = lrc
            this.tags.lyrics = lrc
            this.updateSizeEstimate()
            new Notice(`已导入歌词：${song.name} - ${song.artist}`, 3000)
        } catch (e) {
            new Notice(`获取歌词失败：${(e as Error).message || '网络错误'}`, 5000)
        } finally {
            this.fetchingLyrics = false
            row.removeClass('lyrics-tag-lyric-candidate-loading')
        }
    }

    /** 收起多平台歌词候选列表 */
    private hideLyricCandidates(): void {
        if (this.lyricCandidatesEl) {
            this.lyricCandidatesEl.empty()
            this.lyricCandidatesEl.addClass('lyrics-tag-lyric-candidates-hidden')
        }
    }

    /** 逐行翻译歌词为 `原文 | 译文` 双语格式（翻译源取设置，失败降级 MyMemory）；翻译中按钮变「取消」可随时中断，结果写回歌词框 */
    private async translateLyrics(lyricsArea: HTMLTextAreaElement, btn: ButtonComponent): Promise<void> {
        // 翻译中再点按钮 = 取消：置标志 + abort 在途 DeepSeek 请求（立即中断，不再等超时）
        if (this.translating) {
            this.translateCancelled = true
            this.translateAbort?.abort()
            return
        }
        const text = (this.tags.lyrics ?? lyricsArea.value ?? '').trim()
        if (!text) {
            new Notice('请先输入或获取歌词再翻译')
            return
        }
        this.translating = true
        this.translateCancelled = false
        this.translateStartedAt = performance.now()
        const translateAbortCtrl = new AbortController()
        this.translateAbort = translateAbortCtrl
        const settings = this.plugin.getSettings()
        const provider = settings.translateProvider ?? 'auto'
        // 按当前翻译源取对应凭证：DeepSeek 用 API Key + 提示词，其他源无需
        const translateApiKey = provider === 'deepseek' ? (settings.translateDeepseekApiKey ?? '') : ''
        const translatePrompt = provider === 'deepseek' ? (settings.translateDeepseekPrompt ?? '') : ''
        btn.setButtonText('取消')
        // DeepSeek 单次请求无真实中间进度 → 用动画进度条（20 秒内 0→99%，超时卡 99% 等真实结果）；
        // 其他源逐行并发仍走真实进度回调
        if (provider === 'deepseek') {
            this.startTranslateProgressAnim()
        } else {
            this.showTranslateProgress(0, '正在翻译…', 0, 1)
        }
        try {
            const bilingual = await translateLyricText(
                text,
                'zh-CN',
                (done, total) => {
                    const pct = total > 0 ? Math.round((done / total) * 100) : 0
                    // 预计剩余 ≈ 已用时长 × 剩余比例（按已完成比例线性外推）
                    const elapsed = performance.now() - this.translateStartedAt
                    const etaMs = total > 0 && done > 0
                        ? (elapsed / done) * (total - done)
                        : 0
                    this.showTranslateProgress(pct, `正在翻译 ${done}/${total} 行`, etaMs, total)
                },
                provider,
                () => this.translateCancelled,
                translateApiKey,
                translatePrompt,
                translateAbortCtrl.signal,
            )
            if (!bilingual) {
                new Notice(this.translateCancelled ? '已取消翻译' : '翻译失败（网络错误或歌词为空）', 5000)
                return
            }
            lyricsArea.value = bilingual
            this.tags.lyrics = bilingual
            this.updateSizeEstimate()
            // AI 提前返回（进度条可能才到 20%）：瞬间到 100%，短暂停留后隐藏（更好的完成反馈）
            this.stopTranslateProgressAnim()
            this.showTranslateProgress(100, '翻译完成', 0, 1)
            if (this.translateProgressFlashTimer !== null) clearTimeout(this.translateProgressFlashTimer)
            this.translateProgressFlashTimer = window.setTimeout(() => {
                this.translateProgressFlashTimer = null
                this.hideTranslateProgress()
            }, 400)
            new Notice(this.translateCancelled ? `已中断，保留已翻译 ${this.countTranslated(bilingual)} 行` : '已生成 原文 | 译文 双语歌词', 3000)
        } catch (e) {
            new Notice(`翻译失败：${(e as Error).message || '网络错误'}`, 5000)
        } finally {
            this.translating = false
            this.translateCancelled = false
            this.translateAbort = null
            this.stopTranslateProgressAnim() // 停动画计时器（DeepSeek 动画进度）
            // 成功分支已安排 flash timer 延迟隐藏（显示 100% 完成感）；失败/取消/异常才立即隐藏
            if (this.translateProgressFlashTimer === null) {
                this.hideTranslateProgress()
            }
            btn.setButtonText('翻译歌词')
        }
    }

    /** 统计已翻译行数（含 ` | ` 分隔的） */
    private countTranslated(bilingual: string): number {
        return bilingual.split(/\r?\n/).filter((l) => l.includes(' | ')).length
    }

    /**
     * 启动动画式进度条（v1.4.2）：DeepSeek 单次请求期间无真实中间进度，
     * 用 20 秒内 0→99% 的模拟动画让用户感知「在跑」；超过 20 秒仍未返回结果则停在 99% 等待真实结果。
     */
    private startTranslateProgressAnim(): void {
        this.stopTranslateProgressAnim()
        const started = performance.now()
        const ANIM_MS = 20000 // 20 秒内播完
        this.translateProgressTimer = window.setInterval(() => {
            const elapsed = performance.now() - started
            const pct = Math.min(99, Math.round((elapsed / ANIM_MS) * 99))
            this.showTranslateProgress(pct, '正在翻译…（AI 生成中）', 0, 1)
            if (pct >= 99) this.stopTranslateProgressAnim() // 播完停表，卡 99% 等真实结果
        }, 200)
    }

    /** 停止动画进度条计时器（翻译完成/失败/取消时调用） */
    private stopTranslateProgressAnim(): void {
        if (this.translateProgressTimer !== null) {
            clearInterval(this.translateProgressTimer)
            this.translateProgressTimer = null
        }
    }

    /** 显示并更新翻译进度条（percent 0-100；label 状态文字；etaMs 预计剩余毫秒，0 或不足则省略） */
    private showTranslateProgress(percent: number, label: string, etaMs = 0, total = 0): void {
        if (!this.translateProgressWrap || !this.translateProgressFill || !this.translateProgressText) return
        this.translateProgressWrap.removeClass('lyrics-tag-translate-progress-hidden')
        this.translateProgressFill.style.width = `${percent}%`
        let text = `${label}（${percent}%）`
        // 已有进度且总行数 >1 时显示预计剩余时间
        if (etaMs > 0 && total > 1) {
            const eta = this.formatEta(etaMs)
            if (eta) text += ` · 预计剩余 ${eta}`
        }
        this.translateProgressText.setText(text)
    }

    /** 格式化预计剩余时长：≥1 分钟 → X分Y秒；否则 → X秒 */
    private formatEta(ms: number): string {
        const sec = Math.max(1, Math.round(ms / 1000))
        if (sec >= 60) {
            const m = Math.floor(sec / 60)
            const s = sec % 60
            return `${m}分${s}秒`
        }
        return `${sec}秒`
    }

    /** 隐藏翻译进度条 */
    private hideTranslateProgress(): void {
        if (!this.translateProgressWrap || !this.translateProgressFill) return
        this.translateProgressWrap.addClass('lyrics-tag-translate-progress-hidden')
        this.translateProgressFill.style.width = '0%'
    }

    /** 搜索多平台候选，过滤有封面的，展示封面候选缩略图列表（点击某条导入） */
    private async fetchCover(btn: ButtonComponent): Promise<void> {
        if (this.fetching) return
        this.fetching = true
        btn.setDisabled(true)
        btn.setButtonText('获取中…')
        try {
            const candidates = await this.searchLyricCandidates()
            // 候选带 coverUrl（各平台搜索解析均带）；无 coverUrl 的跳过
            const withCover = candidates.filter((c) => c.coverUrl)
            if (withCover.length === 0) {
                new Notice('该歌曲无封面')
                return
            }
            this.renderCoverCandidates(withCover)
        } catch (e) {
            new Notice(`获取封面失败：${(e as Error).message || '网络错误'}`, 5000)
        } finally {
            this.fetching = false
            btn.setDisabled(false)
            btn.setButtonText('获取封面')
        }
    }

    /** 渲染多平台封面候选列表：标题行 + 缩略图网格（来源胶囊 + 歌名/歌手），点击某条导入对应封面；手动点 ✕ 才关闭 */
    private renderCoverCandidates(candidates: DownloadSong[]): void {
        const box = this.coverCandidatesEl
        if (!box) return
        box.empty()
        box.removeClass('lyrics-tag-lyric-candidates-hidden')
        // 标题行：文字 + 右上角关闭按钮
        const titleRow = box.createDiv({ cls: 'lyrics-tag-lyric-candidates-title' })
        titleRow.createSpan({ cls: 'lyrics-tag-lyric-candidates-title-text', text: '选择封面来源（点击导入）：' })
        const closeBtn = titleRow.createEl('button', { cls: 'lyrics-tag-lyric-candidates-close', text: '✕' })
        closeBtn.setAttribute('title', '关闭')
        closeBtn.addEventListener('click', () => this.hideCoverCandidates())
        // 缩略图网格
        const grid = box.createDiv({ cls: 'lyrics-tag-cover-candidates-grid' })
        for (const s of candidates) {
            if (!s.coverUrl) continue
            const item = grid.createDiv({ cls: 'lyrics-tag-cover-candidate' })
            item.setAttribute('data-key', `${s.source}:${s.id}`)
            const img = item.createEl('img', { cls: 'lyrics-tag-cover-candidate-img' })
            img.src = s.coverUrl
            img.alt = `${s.name} - ${s.artist || ''}`
            // 缩略图加载失败：隐藏 img 留灰底占位，避免破图图标
            img.onerror = () => { img.addClass('lyrics-tag-cover-candidate-img-broken') }
            // 来源胶囊
            item.createSpan({ cls: `lyrics-tag-lyric-source lyrics-tag-lyric-source-${s.source}`, text: SOURCE_LABELS[s.source] ?? s.source })
            // 歌名/歌手
            const meta = item.createDiv({ cls: 'lyrics-tag-cover-candidate-meta' })
            meta.setText(`${s.name}${s.artist ? ` - ${s.artist}` : ''}`)
            item.addEventListener('click', () => void this.importCover(s, item))
        }
        // 无任何可用缩略图项（理论上 filter 已保证至少一个，但防御性兜底）
        if (grid.children.length === 0) {
            new Notice('该歌曲无封面')
            this.hideCoverCandidates()
        }
    }

    /** 拉取并导入所选候选的封面到标签（保存时写回 APIC 帧），成功后收起候选列表 */
    private async importCover(song: DownloadSong, item: HTMLElement): Promise<void> {
        if (this.fetching || !song.coverUrl) return
        this.fetching = true
        item.addClass('lyrics-tag-lyric-candidate-loading')
        try {
            const img = await downloadImage(song.coverUrl)
            if (!img) {
                new Notice('封面下载失败')
                return
            }
            this.tags.cover = img
            this.renderCoverPreview()
            this.updateSizeEstimate()
            new Notice(`已导入封面：${song.name} - ${song.artist}`, 3000)
            // 不自动收起候选列表：用户可连续试多个封面，需手动点右上角 ✕ 关闭
        } catch (e) {
            new Notice(`获取封面失败：${(e as Error).message || '网络错误'}`, 5000)
        } finally {
            this.fetching = false
            item.removeClass('lyrics-tag-lyric-candidate-loading')
        }
    }

    /** 收起多平台封面候选列表 */
    private hideCoverCandidates(): void {
        if (this.coverCandidatesEl) {
            this.coverCandidatesEl.empty()
            this.coverCandidatesEl.addClass('lyrics-tag-lyric-candidates-hidden')
        }
    }

    /** 当前音频文件名（含扩展名） */
    private getCurrentFileName(): string {
        if (!this.source) return ''
        if (this.source.type === 'vault' && this.source.file) return this.source.file.name
        if (this.source.type === 'external' && this.source.path) {
            return this.source.path.split(/[\\/]/).pop() ?? ''
        }
        return ''
    }

    /** 当前音频的绝对路径：vault 用 adapter.getFullPath（磁盘真实路径），库外即 source.path */
    private getCurrentAbsolutePath(): string {
        if (!this.source) return '未知'
        if (this.source.type === 'vault' && this.source.file) {
            try {
                const adapter = this.app.vault.adapter as any
                return typeof adapter?.getFullPath === 'function'
                    ? adapter.getFullPath(this.source.file.path)
                    : this.source.file.path
            } catch {
                return this.source.file.path
            }
        }
        if (this.source.type === 'external' && this.source.path) return this.source.path
        return '未知'
    }

    /** 实时刷新「当前大小 → 预计保存后大小」提示（歌词/封面/文本编辑时调用） */
    private updateSizeEstimate() {
        if (!this.sizeDescEl) return
        const current = formatBytes(this.fileSizeBytes)
        if (this.fileSizeBytes <= 0) {
            this.sizeDescEl.setText(`当前 ${current}`)
            return
        }
        // 预计大小 ≈ 当前大小 − 原标签字节 + 新标签字节（node-id3 重写标签区并保留音频）
        const newEmbedded = estimateEmbeddedSize(this.tags)
        const estimated = Math.max(0, this.fileSizeBytes - this.baselineEmbedded + newEmbedded)
        const delta = estimated - this.fileSizeBytes
        const deltaText = delta === 0 ? '' : `（${delta > 0 ? '+' : '-'}${formatBytes(Math.abs(delta))}）`
        this.sizeDescEl.setText(`当前 ${current} → 预计保存后 ${formatBytes(estimated)}${deltaText}`)
    }

    private renderCoverPreview() {
        if (!this.coverPreview) return
        this.coverPreview.empty()
        if (this.tags.cover) {
            const url = URL.createObjectURL(new Blob([this.tags.cover.data], { type: this.tags.cover.mime }))
            const img = this.coverPreview.createEl('img', { cls: 'lyrics-tag-cover-img' })
            img.src = url
            // onload / onerror 均释放，避免图片加载失败时 blob URL 泄漏（v1.4.0 巩固）
            const revoke = () => URL.revokeObjectURL(url)
            img.onload = revoke
            img.onerror = revoke
        } else {
            this.coverPreview.createDiv({
                cls: 'lyrics-tag-cover-empty',
                text: this.tags.cover === null ? '（无封面）' : '（未设置）',
            })
        }
    }

    private async save() {
        if (this.saving || !this.source) return
        this.saving = true
        try {
            // 1. 先写标签（使用当前 source 路径）
            const ok = await writeMp3Tags(this.app, this.source, this.tags)
            if (!ok) {
                new Notice('保存失败，已还原原文件', 5000)
                return
            }
            // 2. 若改了文件名，重命名音频并同步引用
            const renamed = await this.renameAudioFile()
            if (!renamed) {
                new Notice('标签已保存，但文件名重命名失败（标签已写入原文件）', 5000)
                return
            }
            new Notice('保存成功')
            // 刷新歌单：笔记传 notePath；裸 MP3 无笔记，传音频路径（song.path 即音频路径）触发重扫
            const refreshKey = this.notePath
                || (this.source?.type === 'vault' ? this.source.file?.path : this.source?.path)
                || ''
            if (refreshKey) this.plugin.notifyTagsEdited(refreshKey)
            this.close()
        } finally {
            this.saving = false
        }
    }

    /** 删除当前歌曲文件：vault 内移入系统回收站（可恢复），库外永久删除；删除正在播放的文件会停播并复位 */
    private async deleteFile(): Promise<void> {
        if (!this.source || this.saving) return
        this.saving = true
        const name = this.getCurrentFileName()
        try {
            if (this.source.type === 'vault' && this.source.file) {
                await this.app.vault.trash(this.source.file, true) // 系统回收站
            } else if (this.source.type === 'external' && this.source.path) {
                const fs = (window as any).require('fs')
                await fs.promises.unlink(this.source.path) // 库外无回收站，永久删除
            } else {
                new Notice('未找到文件，无法删除')
                return
            }
        } catch {
            new Notice('删除失败，请检查文件权限', 5000)
            return
        } finally {
            this.saving = false
        }
        // 通知插件：若删除的是正在播放的文件则停播复位；随后重扫歌单
        const audioPath = this.source.type === 'vault' ? this.source.file?.path : this.source.path
        if (audioPath) await this.plugin.handleAudioDeleted(audioPath)
        new Notice(`已删除：${name}`, 4000)
        this.close()
    }

    /** 重命名音频文件：vault 内用 Obsidian 重命名（自动更新引用），库外用 fs 重命名 + 同步笔记 source 行 */
    private async renameAudioFile(): Promise<boolean> {
        if (!this.source || !this.newFileName || !this.newFileName.includes('.')) return true // 未改或非法 → 视为成功
        const current = this.getCurrentFileName()
        if (this.newFileName === current) return true

        if (this.source.type === 'vault' && this.source.file) {
            const dir = this.source.file.path.split('/').slice(0, -1).join('/')
            const newPath = dir ? `${dir}/${this.newFileName}` : this.newFileName
            try {
                await this.app.fileManager.renameFile(this.source.file, newPath)
                this.source.file = this.app.vault.getAbstractFileByPath(newPath) as TFile
                return true
            } catch {
                return false
            }
        }
        if (this.source.type === 'external' && this.source.path) {
            const oldPath = this.source.path
            try {
                const fs = (window as any).require('fs')
                const dir = oldPath.split(/[\\/]/).slice(0, -1).join('/')
                const newPath = dir ? `${dir}\\${this.newFileName}` : this.newFileName
                await fs.promises.rename(oldPath, newPath)
                this.source.path = newPath
                // 同步更新歌词笔记里的 source 绝对路径行
                await this.updateNoteSourceLine(oldPath, newPath)
                return true
            } catch {
                return false
            }
        }
        return true
    }

    /** 库外文件重命名后，把歌词笔记里 source 指令的旧绝对路径改成新路径 */
    private async updateNoteSourceLine(oldPath: string, newPath: string): Promise<void> {
        const file = this.app.vault.getAbstractFileByPath(this.notePath)
        if (!(file instanceof TFile)) return
        try {
            const content = await this.app.vault.read(file)
            const lines = content.split('\n')
            let changed = false
            for (let i = 0; i < lines.length; i++) {
                const m = lines[i].match(/^source (?<audio>.*)$/i)
                if (m?.groups?.audio === oldPath) {
                    lines[i] = `source ${newPath}`
                    changed = true
                }
            }
            if (changed) await this.app.vault.modify(file, lines.join('\n'))
        } catch { /* 更新笔记失败不影响重命名本身 */ }
    }

    onClose() {
        this.contentEl.empty()
    }
}
