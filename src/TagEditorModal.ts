import { App, Modal, Notice, Setting, TFile, ButtonComponent } from 'obsidian'
import type LyricsPlugin from 'main'
import { resolveAudioSource, readMp3Tags, writeMp3Tags, type Mp3Tags, type AudioSource } from 'tags'
import { searchSong, fetchLyric, pickBestMatch, downloadImage, type NetEaseSong } from 'onlineLyrics'

export default class TagEditorModal extends Modal {
    private tags: Mp3Tags = {}
    private source: AudioSource | null = null
    private saving = false
    private coverInput: HTMLInputElement | null = null
    private coverPreview: HTMLElement | null = null
    private newFileName = '' // 文件名重命名目标（含扩展名），空 = 不改名
    private fetching = false // 在线歌词获取中标志（防重复点击）

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
        const tags = await readMp3Tags(this.app, this.source)
        this.tags = tags ?? {}
        loading.remove()
        this.render()
    }

    private render() {
        const { contentEl } = this
        contentEl.empty()

        // 文件名（重命名；保存时对 vault 用 Obsidian 重命名，库外同步改笔记 source 行）
        const nameSetting = new Setting(contentEl)
            .setName('文件名')
            .setDesc('重命名文件（vault 内自动更新引用，库外同步改笔记 source 行）')
        nameSetting.addText((text) => {
            const current = this.getCurrentFileName()
            text.setValue(current)
                .setPlaceholder('输入新文件名（含扩展名）')
                .onChange((v) => { this.newFileName = v.trim() })
        })

        const textFields: Array<['title' | 'artist' | 'album', string]> = [
            ['title', '标题'], ['artist', '艺术家'], ['album', '专辑'],
        ]
        for (const [key, label] of textFields) {
            new Setting(contentEl).setName(label).addText((text) => {
                text.setValue(this.tags[key] ?? '')
                text.onChange((v) => { this.tags[key] = v })
            })
        }

        // 歌词（textarea，一键粘贴整段；右下角「获取歌词」从网易云拉取）
        new Setting(contentEl).setName('歌词').setDesc('可整段粘贴 LRC（含 [mm:ss] 时间戳），保存写回 USLT 帧')
        const lyricsArea = contentEl.createEl('textarea', { cls: 'lyrics-tag-lyrics' })
        lyricsArea.value = this.tags.lyrics ?? ''
        lyricsArea.addEventListener('input', () => { this.tags.lyrics = lyricsArea.value })
        const lyricsFooter = contentEl.createDiv({ cls: 'lyrics-tag-lyrics-footer' })
        const fetchBtn = lyricsFooter.createEl('button', { text: '获取歌词', cls: 'mod-cta' })
        fetchBtn.addEventListener('click', () => void this.fetchOnlineLyrics(lyricsArea, fetchBtn))

        // 封面
        const coverSetting = new Setting(contentEl).setName('封面')
        this.coverPreview = contentEl.createDiv({ cls: 'lyrics-tag-cover-preview' })
        this.renderCoverPreview()
        coverSetting.addButton((btn) => btn.setButtonText('选择图片').onClick(() => this.coverInput?.click()))
        coverSetting.addButton((btn) => btn.setCta().setButtonText('获取封面').onClick(() => void this.fetchCover(btn)))
        coverSetting.addButton((btn) => btn.setWarning().setButtonText('移除封面').onClick(() => {
            this.tags.cover = null
            this.renderCoverPreview()
        }))
        this.coverInput = contentEl.createEl('input', {
            cls: 'lyrics-tag-cover-input',
            attr: { type: 'file', accept: 'image/*' },
        })
        this.coverInput.addEventListener('change', () => {
            const f = this.coverInput?.files?.[0]
            if (!f) return
            const reader = new FileReader()
            reader.onload = () => {
                this.tags.cover = { mime: f.type || 'image/jpeg', data: new Uint8Array(reader.result as ArrayBuffer) }
                this.renderCoverPreview()
            }
            reader.readAsArrayBuffer(f)
        })

        // 按钮
        const actions = contentEl.createDiv({ cls: 'lyrics-tag-actions' })
        actions.createEl('button', { text: '取消', cls: 'mod-cta lyrics-tag-cancel' })
            .addEventListener('click', () => this.close())
        actions.createEl('button', { text: '保存', cls: 'mod-cta lyrics-tag-save' })
            .addEventListener('click', () => this.save())
    }

    /** 用标题/艺术家搜索当前歌曲并选最优匹配；无标题/无结果返回 null（已弹 Notice） */
    private async searchCurrentSong(): Promise<NetEaseSong | null> {
        const title = (this.tags.title ?? '').trim() || this.getCurrentFileName().replace(/\.[^.]+$/, '')
        const artist = (this.tags.artist ?? '').trim()
        if (!title) {
            new Notice('无标题，无法搜索')
            return null
        }
        const query = artist ? `${title} ${artist}` : title
        const songs = await searchSong(query)
        const match = pickBestMatch(songs, title, artist)
        if (!match) {
            new Notice('未找到匹配的歌曲')
            return null
        }
        return match
    }

    /** 从网易云拉取当前歌曲歌词，导入歌词框（保存时写回 USLT） */
    private async fetchOnlineLyrics(lyricsArea: HTMLTextAreaElement, btn: HTMLElement): Promise<void> {
        if (this.fetching) return
        this.fetching = true
        btn.setAttribute('disabled', 'true')
        btn.setText('获取中…')
        try {
            const match = await this.searchCurrentSong()
            if (!match) return
            const lrc = await fetchLyric(match.id)
            if (!lrc) {
                new Notice('该歌曲无歌词')
                return
            }
            lyricsArea.value = lrc
            this.tags.lyrics = lrc
            const matchLabel = [match.name, ...match.artists].filter(Boolean).join(' - ')
            new Notice(`已导入歌词：${matchLabel}`, 3000)
        } catch (e) {
            new Notice(`获取歌词失败：${(e as Error).message || '网络错误'}`, 5000)
        } finally {
            this.fetching = false
            btn.removeAttribute('disabled')
            btn.setText('获取歌词')
        }
    }

    /** 从网易云拉取当前歌曲封面，写入标签（保存时写回 APIC 帧） */
    private async fetchCover(btn: ButtonComponent): Promise<void> {
        if (this.fetching) return
        this.fetching = true
        btn.setDisabled(true)
        btn.setButtonText('获取中…')
        try {
            const match = await this.searchCurrentSong()
            if (!match) return
            if (!match.coverUrl) {
                new Notice('该歌曲无封面')
                return
            }
            const img = await downloadImage(match.coverUrl)
            if (!img) {
                new Notice('封面下载失败')
                return
            }
            this.tags.cover = img
            this.renderCoverPreview()
            const matchLabel = [match.name, ...match.artists].filter(Boolean).join(' - ')
            new Notice(`已导入封面：${matchLabel}`, 3000)
        } catch (e) {
            new Notice(`获取封面失败：${(e as Error).message || '网络错误'}`, 5000)
        } finally {
            this.fetching = false
            btn.setDisabled(false)
            btn.setButtonText('获取封面')
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
