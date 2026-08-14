import { ItemView, setIcon, TFile, type WorkspaceLeaf } from 'obsidian'
import type { LyricsLine } from 'renderers/renderer'
import { WORD_SPLIT_REGEX } from 'renderers/wordSplitter'
import { LYRICS_VIEW_TYPE, type PlayMode } from 'shared'
import type LyricsPlugin from 'main'
import type { LyricsState, LyricSong } from 'main'
import type { AudioSource } from 'tags'
import { isWindowsAbsolutePath } from 'songScanner'
import TagEditorModal from 'TagEditorModal'
import TagViewerModal from 'TagViewerModal'
import DownloadModal from 'DownloadModal'

/**
 * 侧边栏歌词视图：歌词面板 + 状态栏播放控制 + 歌单弹窗 + 音量弹窗。
 * 从 main.ts 拆出（v1.4.0 巩固：模块化），通过 LyricsPlugin 的公开 API 交互，
 * 仅依赖类型，与 main.ts 无运行时循环依赖。
 */
export default class LyricsView extends ItemView {
    private plugin: LyricsPlugin
    private lyricsEl: HTMLElement | null = null
    private playPauseBtn: HTMLElement | null = null
    private lyricsPanel: HTMLElement | null = null

    private statusBar: HTMLElement | null = null
    private statusBarTitle: HTMLElement | null = null
    private statusBarTime: HTMLElement | null = null
    private statusBarPlay: HTMLElement | null = null
    private statusBarMode: HTMLElement | null = null
    private statusBarSpeed: HTMLElement | null = null
    private statusBarVolume: HTMLElement | null = null
    private statusBarLocate: HTMLElement | null = null

    private songListPopup: HTMLElement | null = null
    private songListSearchEl: HTMLInputElement | null = null
    private songListTypeFilter: string = 'all'
    private songListCountEl: HTMLElement | null = null
    private songCoverUrls = new Map<string, string>() // song.path → 音频封面 blob URL

    private statusBarVolumeIcon: HTMLElement | null = null
    private volumePopup: HTMLElement | null = null
    private volumeOutsideClickHandler: ((e: MouseEvent) => void) | null = null

    /** 侧边栏增量渲染：记录上次渲染的歌词数组引用与当前行索引，判断是否需要重建 DOM */
    private lastLyricsRef: LyricsLine[] | null = null
    private lastCurrentIndex: number = -1
    /** 上次渲染时的 karaoke 开关：播放中切换开关需强制重建（实时 karaoke 切换） */
    private lastKaraoke: boolean = false
    /** 当前高亮行的元素（karaoke 逐字高亮更新用） */
    private currentHighlightedEls: HTMLElement[] = []

    constructor(leaf: WorkspaceLeaf, plugin: LyricsPlugin) {
        super(leaf)
        this.plugin = plugin
    }

    getViewType(): string { return LYRICS_VIEW_TYPE }
    getDisplayText(): string { return 'LyricFlux' }
    getIcon(): string { return 'music' }

    async onOpen() {
        const container = this.containerEl.children[1] as HTMLElement
        container.empty()
        container.addClass('lyrics-panel-container')

        this.lyricsPanel = container.createDiv({ cls: 'lyrics-panel-content' })
        this.lyricsEl = this.lyricsPanel

        this.playPauseBtn = this.lyricsPanel.createDiv({ cls: 'lyrics-panel-play-btn lyrics-panel-play-hidden' })
        this.playPauseBtn.addEventListener('click', () => this.plugin.toggleActivePlayer())
        this.updatePlayPauseIcon(false)

        this.createStatusBar(container)
        this.renderEmpty()

        this.plugin.onLyricsStateChange(this._onStateChange)
        this.plugin.onSongListChange(this._onSongListChange)
    }

    async onClose() {
        this.closeSongListPopup()
        this.closeVolumePopup()
        this.plugin.removeLyricsStateListener(this._onStateChange)
        this.plugin.removeSongListListener(this._onSongListChange)
        await super.onClose()
    }

    private _onStateChange = (state: LyricsState | null) => {
        this.renderLyrics(state)
        this.renderStatusBar(state)
    }

    private _onSongListChange = () => {
        // 歌单变化（富化完成/标签编辑后）时刷新仍打开的列表
        if (this.songListPopup) this.renderPopupSongList()
    }

    private updatePlayPauseIcon(isPlaying: boolean) {
        if (!this.playPauseBtn) return
        this.playPauseBtn.empty()
        const icon = this.playPauseBtn.createSpan({ cls: 'lyrics-panel-play-icon' })
        setIcon(icon, isPlaying ? 'pause' : 'play')
    }

    // --- Status bar ---

    private createStatusBar(container: HTMLElement) {
        this.statusBar = container.createDiv({ cls: 'lyrics-statusbar' })

        // Play mode
        this.statusBarMode = this.statusBar.createSpan({ cls: 'lyrics-statusbar-mode-btn' })
        this.statusBarMode.addEventListener('click', () => {
            this.plugin.cyclePlayMode()
            this.renderModeIcon()
        })

        // Play/pause
        const controls = this.statusBar.createDiv({ cls: 'lyrics-statusbar-controls' })
        this.statusBarPlay = controls.createSpan({ cls: 'lyrics-statusbar-btn' })
        this.statusBarPlay.setAttribute('title', '播放/暂停')
        setIcon(this.statusBarPlay, 'play')
        this.statusBarPlay.addEventListener('click', () => this.plugin.toggleActivePlayer())

        // Volume button + floating slider popup
        this.statusBarVolumeIcon = this.statusBar.createSpan({ cls: 'lyrics-statusbar-volume-icon' })
        this.renderVolumeIcon()
        this.statusBarVolumeIcon.addEventListener('mousedown', (e) => {
            e.stopPropagation()
        })
        this.statusBarVolumeIcon.addEventListener('click', (e) => {
            e.stopPropagation()
            if (this.volumePopup) {
                this.closeVolumePopup()
            } else {
                this.openVolumePopup()
            }
        })

        // Speed
        this.statusBarSpeed = this.statusBar.createSpan({ cls: 'lyrics-statusbar-speed-btn' })
        this.statusBarSpeed.setAttribute('title', '调整播放倍速')
        this.statusBarSpeed.setText(`${this.plugin.getPlaybackRate()}x`)
        this.statusBarSpeed.addEventListener('click', () => {
            this.plugin.cyclePlaybackRate()
            this.renderSpeedLabel()
        })

        // Locate: switch to the tab already showing this LRC note (like a browser tab)
        this.statusBarLocate = this.statusBar.createSpan({ cls: 'lyrics-statusbar-locate-btn' })
        this.statusBarLocate.setAttribute('title', '定位到当前歌曲（歌单打开时滚动定位）或歌词笔记标签页')
        setIcon(this.statusBarLocate, 'locate-fixed')
        this.statusBarLocate.addEventListener('click', () => this.locateLyricsNote())

        // Song name
        const info = this.statusBar.createDiv({ cls: 'lyrics-statusbar-info' })
        this.statusBarTitle = info.createSpan({ cls: 'lyrics-statusbar-song', text: 'LyricFlux' })
        this.statusBarTitle.addEventListener('click', (e) => {
            e.stopPropagation()
            this.toggleSongListPopup()
        })

        // Time
        this.statusBarTime = this.statusBar.createDiv({ cls: 'lyrics-statusbar-time' })

        this.renderModeIcon()
    }

    private renderModeIcon() {
        if (!this.statusBarMode) return
        const mode = this.plugin.getPlayMode()
        const icon = mode === 'single' ? 'repeat-1' : mode === 'shuffle' ? 'shuffle' : 'repeat'
        setIcon(this.statusBarMode, icon)
        const titles: Record<PlayMode, string> = {
            off: '播放模式：关闭',
            single: '播放模式：单曲循环',
            sequential: '播放模式：顺序播放',
            shuffle: '播放模式：乱序播放',
        }
        this.statusBarMode.setAttribute('title', titles[mode])
        this.statusBarMode.toggleClass('lyrics-mode-active', mode !== 'off')
    }

    private renderSpeedLabel() {
        if (!this.statusBarSpeed) return
        this.statusBarSpeed.setText(`${this.plugin.getPlaybackRate()}x`)
    }

    private renderVolumeIcon() {
        if (!this.statusBarVolumeIcon) return
        const vol = this.plugin.getVolume()
        const icon = vol === 0 ? 'volume-x' : vol < 50 ? 'volume-1' : 'volume-2'
        setIcon(this.statusBarVolumeIcon, icon)
        this.statusBarVolumeIcon.setAttribute('title', `音量 ${vol}%`)
    }

    private toggleVolumePopup() {
        if (this.volumePopup) { this.closeVolumePopup(); return }
        this.openVolumePopup()
    }

    private openVolumePopup() {
        if (!this.statusBarVolumeIcon) return
        this.closeVolumePopup()
        this.volumePopup = document.body.createDiv({ cls: 'lyrics-volume-popup' })
        // Prevent interactions inside popup from closing it
        this.volumePopup.addEventListener('pointerdown', (e) => e.stopPropagation())
        this.volumePopup.addEventListener('click', (e) => e.stopPropagation())
        const vol = this.plugin.getVolume()
        const sliderWrap = this.volumePopup.createDiv({ cls: 'lyrics-volume-popup-slider-wrap' })
        const slider = sliderWrap.createEl('input', {
            cls: 'lyrics-volume-popup-slider',
            attr: { type: 'range', min: '0', max: '100', step: '5', value: String(vol) },
        }) as HTMLInputElement
        const label = this.volumePopup.createDiv({ cls: 'lyrics-volume-popup-label', text: `${vol}%` })
        // Position popup above the volume icon
        const iconRect = this.statusBarVolumeIcon.getBoundingClientRect()
        const popupWidth = 36
        this.volumePopup.style.left = `${iconRect.left + iconRect.width / 2 - popupWidth / 2}px`
        this.volumePopup.style.top = `${iconRect.top - 4}px`
        this.volumePopup.style.transform = 'translateY(-100%)'
        slider.addEventListener('input', () => {
            const val = Number(slider.value)
            this.plugin.setVolume(val)
            this.renderVolumeIcon()
            label.setText(`${val}%`)
        })
        // Click outside to close
        this.volumeOutsideClickHandler = (e: MouseEvent) => {
            if (!this.volumePopup?.contains(e.target as Node)) {
                this.closeVolumePopup()
            }
        }
        // Use setTimeout(0) so the current click event finishes first
        setTimeout(() => {
            document.addEventListener('mousedown', this.volumeOutsideClickHandler!)
        }, 0)
    }

    private closeVolumePopup() {
        if (this.volumePopup) { this.volumePopup.remove(); this.volumePopup = null }
        if (this.volumeOutsideClickHandler) {
            document.removeEventListener('pointerdown', this.volumeOutsideClickHandler)
            this.volumeOutsideClickHandler = null
        }
    }

    private renderStatusBar(state: LyricsState | null) {
        if (!this.statusBarTitle) return
        this.renderModeIcon()
        this.renderSpeedLabel()
        this.renderVolumeIcon()

        // 裸 MP3 即使无歌词也有标题/作者/时长可显示，仅真正的空态（无状态或非 mp3 且无歌词）才显示默认
        if (!state || (state.lyrics.length === 0 && state.sourceKind !== 'mp3')) {
            this.statusBarTitle.setText('LyricFlux')
            if (this.statusBarTime) this.statusBarTime.setText('')
            setIcon(this.statusBarPlay!, 'play')
            this.statusBarLocate?.addClass('lyrics-statusbar-locate-hidden')
            return
        }
        this.statusBarLocate?.removeClass('lyrics-statusbar-locate-hidden')
        const title = state.title || '未知歌曲'
        const actor = state.actor || '未知艺术家'
        this.statusBarTitle.setText(`${title} - ${actor}`)
        setIcon(this.statusBarPlay!, state.isPlaying ? 'pause' : 'play')
        this.statusBarPlay!.setAttribute('title', state.isPlaying ? '暂停' : '播放')
        if (this.statusBarTime) {
            if (state.duration) {
                this.statusBarTime.setText(`${this.formatTime(state.currentTime)} / ${this.formatTime(state.duration)}`)
            } else {
                this.statusBarTime.setText(this.formatTime(state.currentTime))
            }
        }
    }

    private formatTime(sec: number): string {
        if (!sec || !isFinite(sec)) return '00:00'
        const m = Math.floor(sec / 60)
        const s = Math.floor(sec % 60)
        return `${m < 10 ? '0' + m : m}:${s < 10 ? '0' + s : s}`
    }

    /** 定位：裸 MP3 在歌单弹窗中定位当前歌曲；笔记则跳到对应标签页（若已开则切换，否则新开） */
    private locateLyricsNote() {
        const state = this.plugin.getLyricsState()

        // 裸 MP3：无笔记可跳，打开（或复用）歌单弹窗并滚动定位当前歌曲
        if (state?.sourceKind === 'mp3') {
            if (!this.songListPopup) this.openSongListPopup()
            this.scrollPopupToActive()
            return
        }

        // 歌单弹窗打开时：滚动列表定位到当前播放歌曲（若可见）
        if (this.songListPopup) {
            this.scrollPopupToActive()
            return
        }

        const path = state?.filePath
        if (!path) return

        // 查找该笔记是否已在一个 markdown 标签页中打开
        const leaves = this.plugin.app.workspace.getLeavesOfType('markdown')
        const existing = leaves.find((leaf) => leaf.getViewState().state?.file === path)
        if (existing) {
            // 已打开：切换到那个标签页，保持标签排序位置
            this.plugin.app.workspace.setActiveLeaf(existing)
            return
        }
        // 未打开：新开一个标签页打开（不覆盖当前标签页）
        this.plugin.app.workspace.openLinkText(path, '', true)
    }

    /** 歌单弹窗内滚动到当前高亮的歌曲行 */
    private scrollPopupToActive() {
        if (!this.songListPopup) return
        const list = this.songListPopup.querySelector('.lyrics-song-popup-list') as HTMLElement | null
        const active = this.songListPopup.querySelector('.lyrics-songs-item-active') as HTMLElement | null
        if (list && active) {
            const target = active.offsetTop - list.clientHeight / 2 + active.clientHeight / 2
            list.scrollTo({ top: Math.max(0, target), behavior: 'smooth' })
        }
    }

    // --- Lyrics rendering ---

    private renderEmpty() {
        if (!this.lyricsEl) return
        this.lyricsEl.empty()
        this.lyricsEl.createDiv({
            cls: 'lyrics-panel-empty',
            text: '暂无歌词，请打开包含 lrc 代码块的笔记或编辑音频文件标签以显示歌词。',
        })
        this.playPauseBtn?.addClass('lyrics-panel-play-hidden')
    }

    /**
     * 侧边栏歌词增量渲染：仅在歌词数组引用变化（换歌/重渲染）或当前行索引变化时全量重建，
     * 其余 timeupdate 只刷新播放图标 + karaoke 逐字高亮，避免每 250ms 重建整表 DOM。
     */
    private renderLyrics(state: LyricsState | null) {
        if (!this.lyricsEl) return

        if (!state || state.lyrics.length === 0) {
            // 空态：仅当此前非空时才清空重建（避免重复 empty）
            if (this.lastLyricsRef !== null || this.lastCurrentIndex !== -1) {
                this.lastLyricsRef = null
                this.lastCurrentIndex = -1
                this.lastKaraoke = false
                this.currentHighlightedEls = []
                this.renderEmpty()
                this.updatePlayPauseIcon(false)
            }
            return
        }

        const lyricsChanged = state.lyrics !== this.lastLyricsRef
        const indexChanged = state.currentIndex !== this.lastCurrentIndex
        const karaokeChanged = state.karaoke !== this.lastKaraoke
        this.lastLyricsRef = state.lyrics
        this.lastCurrentIndex = state.currentIndex
        this.lastKaraoke = state.karaoke

        if (lyricsChanged || indexChanged || karaokeChanged) {
            this.renderLyricsFull(state)
        } else {
            this.updatePlayPauseIcon(state.isPlaying)
            // 同句内逐字高亮随时间推进（仅当前高亮行的 span）
            if (state.karaoke) this.updateKaraokeWords(state)
        }
        // 每 timeupdate 实时跟随：当前行脱离可视区则拉回居中（不重建 DOM，不打扰同区内浏览）
        this.keepCurrentLineVisible(false)
    }

    /** 全量重建侧边栏歌词列表（仅换歌或换行时调用） */
    private renderLyricsFull(state: LyricsState) {
        this.lyricsEl!.empty()
        this.currentHighlightedEls = []
        this.updatePlayPauseIcon(state.isPlaying)
        this.playPauseBtn?.removeClass('lyrics-panel-play-hidden')

        // 对唱/合唱：同一时间戳的所有行视为当前行
        const curLine = state.lyrics[state.currentIndex]
        const curTs = curLine?.timestamp

        state.lyrics.forEach((line, index) => {
            const isCurrent = curTs !== undefined
                ? line.timestamp === curTs
                : index === state.currentIndex
            const isPast = curTs !== undefined
                ? (line.timestamp ?? -1) < curTs
                : index < state.currentIndex
            let cls = 'lyrics-panel-line'
            if (isCurrent) cls += ' lyrics-panel-highlighted'
            else if (isPast) cls += ' lyrics-panel-past'
            else cls += ' lyrics-panel-future'

            const lineEl = this.lyricsEl!.createDiv({ cls, attr: { 'data-time': String(line.timestamp || 0) } })
            const textEl = lineEl.createSpan({ cls: 'lyrics-panel-text' })

            if (state.karaoke && isCurrent && line.text.trim()) {
                // 字 span 统一用基础类，激活与否完全交给 updateKaraokeWords 按时间统一处理，
                // 避免创建时二选一导致增量更新查不到已激活的字（v1.4.0 巩固：侧边栏逐字高亮修复）
                if (line.words && line.words.length > 0) {
                    // Use precise word timestamps if available from LRC parser
                    line.words.forEach((word) => {
                        textEl.createSpan({
                            cls: 'lyrics-panel-word',
                            text: word.text,
                            attr: { 'data-time': String(Math.round(word.timestamp)) },
                        })
                    })
                } else {
                    // Fallback: auto-distribute timestamps across words
                    const words = line.text.match(WORD_SPLIT_REGEX)
                    if (words && words.length > 0) {
                        const start = line.timestamp || 0
                        const end = index + 1 < state.lyrics.length
                            ? (state.lyrics[index + 1].timestamp || start + 3000)
                            : start + 3000
                        const perWord = (end - start) / words.length
                        words.forEach((w, j) => {
                            textEl.createSpan({
                                cls: 'lyrics-panel-word',
                                text: w,
                                attr: { 'data-time': String(Math.round(start + j * perWord)) },
                            })
                        })
                    } else {
                        textEl.setText(line.text)
                    }
                }
                if (line.annotation) textEl.createDiv({ cls: 'lyrics-panel-annotation', text: line.annotation })
            } else {
                textEl.setText(line.text)
                if (line.annotation) textEl.createDiv({ cls: 'lyrics-panel-annotation', text: line.annotation })
            }

            if (isCurrent) this.currentHighlightedEls.push(lineEl)

            lineEl.addEventListener('click', () => {
                if (line.timestamp !== undefined) this.plugin.seekActivePlayer(line.timestamp / 1000)
            })
        })

        // 换行后强制居中当前高亮行（实时跟随的兜底，见 keepCurrentLineVisible）
        this.keepCurrentLineVisible(true)
        // 全量重建后按当前时间应用逐字高亮（字 span 统一基础类，激活态统一在此计算）
        if (state.karaoke) this.updateKaraokeWords(state)
    }

    /** 保证当前高亮行在可视区内：force=强制居中（换行时）；否则仅当脱离可视区时拉回（每 timeupdate 实时跟随）。
     *  用 getBoundingClientRect 对比面板与当前行的视口位置，不依赖 offsetParent，避免 scrollIntoView/offsetTop 被打断或滚错容器。 */
    private keepCurrentLineVisible(force = false) {
        const panel = this.lyricsEl
        const line = this.currentHighlightedEls[0] ?? null
        if (!panel || !line) return
        const panelRect = panel.getBoundingClientRect()
        const lineRect = line.getBoundingClientRect()
        const outOfView = lineRect.top < panelRect.top || lineRect.bottom > panelRect.bottom
        if (force || outOfView) {
            const target = panel.scrollTop + (lineRect.top - panelRect.top) - (panel.clientHeight - line.clientHeight) / 2
            panel.scrollTo({ top: Math.max(0, target), behavior: 'smooth' })
        }
    }

    /** karaoke 逐字高亮增量更新：只改当前高亮行的 span class，不重建整表。
     *  选择器同时匹配基础类与已激活类，保证 toggle 双向可靠。 */
    private updateKaraokeWords(state: LyricsState) {
        const timeMs = Math.round(state.currentTime * 1000)
        for (const lineEl of this.currentHighlightedEls) {
            const words = lineEl.querySelectorAll('.lyrics-panel-word, .lyrics-panel-word-active') as NodeListOf<HTMLElement>
            words.forEach((word) => {
                const t = parseInt(word.dataset.time || '0', 10)
                word.toggleClass('lyrics-panel-word-active', !isNaN(t) && t <= timeMs)
            })
        }
    }

    // --- Song list popup ---

    private toggleSongListPopup() {
        if (this.songListPopup) { this.closeSongListPopup(); return }
        this.openSongListPopup()
    }

    /** 打开歌单弹窗（状态栏点击 / 快捷键命令共用） */
    public openSongListPopup() {
        if (!this.lyricsPanel) return
        this.closeSongListPopup()
        this.lyricsPanel.addClass('lyrics-panel-hidden')

        const container = this.containerEl.children[1] as HTMLElement
        this.songListPopup = container.createDiv({ cls: 'lyrics-song-popup' })

        const header = this.songListPopup.createDiv({ cls: 'lyrics-song-popup-header' })
        const titleWrap = header.createDiv({ cls: 'lyrics-song-popup-title-wrap' })
        titleWrap.createSpan({ text: '歌曲列表' })
        this.songListCountEl = titleWrap.createSpan({ cls: 'lyrics-song-popup-count', text: `(${this.plugin.getSongList().length})` })
        const closeBtn = header.createSpan({ cls: 'lyrics-song-popup-close' })
        setIcon(closeBtn, 'x')
        closeBtn.addEventListener('click', () => this.closeSongListPopup())

        // 搜索 + 类型筛选并排一行：搜索占 2/3，类型占 1/3
        const filterRow = this.songListPopup.createDiv({ cls: 'lyrics-song-popup-filters' })

        // 下载按钮（v1.4.1）：搜索框左侧，打开「下载歌曲」弹窗
        const dlBtn = filterRow.createDiv({ cls: 'lyrics-song-popup-dl-btn' })
        setIcon(dlBtn, 'download')
        dlBtn.setAttribute('title', '下载歌曲')
        dlBtn.addEventListener('click', (e) => {
            e.stopPropagation()
            new DownloadModal(this.plugin.app, this.plugin).open()
        })

        const searchWrap = filterRow.createDiv({ cls: 'lyrics-song-popup-search' })
        this.songListSearchEl = searchWrap.createEl('input', {
            cls: 'lyrics-song-popup-search-input',
            attr: { type: 'text', placeholder: '搜索歌曲...' },
        })
        this.songListSearchEl.addEventListener('input', () => this.renderPopupSongList())

        // Type filter（来自 frontmatter type 字段；「未分类」= 无 type 或 type 为空的歌）
        const songsAll = this.plugin.getSongList()
        const types = Array.from(new Set(
            songsAll.map((s) => s.type).filter((t) => t && t.trim()),
        )).sort((a, b) => a.localeCompare(b))
        const hasUncategorized = songsAll.some((s) => !s.type || !s.type.trim())
        if (types.length > 0 || hasUncategorized) {
            if (!types.includes(this.songListTypeFilter) && this.songListTypeFilter !== '未分类') this.songListTypeFilter = 'all'
            const filterWrap = filterRow.createDiv({ cls: 'lyrics-song-popup-filter' })
            const select = filterWrap.createEl('select', { cls: 'lyrics-song-popup-filter-select' })
            select.createEl('option', { value: 'all', text: '全部类型' })
            if (hasUncategorized) select.createEl('option', { value: '未分类', text: '未分类' })
            types.forEach((t) => select.createEl('option', { value: t, text: t }))
            select.value = this.songListTypeFilter
            select.addEventListener('change', () => {
                this.songListTypeFilter = select.value
                this.renderPopupSongList()
            })
        } else {
            // 无类型可筛选：搜索框占满整行
            filterRow.addClass('lyrics-song-popup-filters-no-filter')
            this.songListTypeFilter = 'all'
        }

        this.renderPopupSongList()
        this.songListSearchEl.focus()
    }

    private renderPopupSongList() {
        if (!this.songListPopup) return
        const oldList = this.songListPopup.querySelector('.lyrics-song-popup-list')
        if (oldList) oldList.remove()

        const allSongs = this.plugin.getSongList()
        const state = this.plugin.getLyricsState()

        // Filter by search query + type
        const query = this.songListSearchEl?.value?.toLowerCase().trim() || ''
        const typeFilter = this.songListTypeFilter
        const songs = allSongs.filter((s) => {
            const matchQuery = !query
                || s.title.toLowerCase().includes(query)
                || s.actor.toLowerCase().includes(query)
            const matchType = typeFilter === 'all'
                || (typeFilter === '未分类' && (!s.type || !s.type.trim()))
                || s.type === typeFilter
            return matchQuery && matchType
        })
        // 计数：无筛选时显示总数，有筛选时显示「筛选后 / 总数」
        if (this.songListCountEl) {
            const countText = songs.length === allSongs.length
                ? `(${songs.length})`
                : `(${songs.length} / ${allSongs.length})`
            this.songListCountEl.setText(countText)
        }

        const list = this.songListPopup.createDiv({ cls: 'lyrics-song-popup-list' })
        if (songs.length === 0) {
            const hint = query ? '没有匹配的歌曲' : typeFilter !== 'all' ? '该类型下暂无歌曲' : '暂无歌曲'
            list.createDiv({ cls: 'lyrics-songs-empty', text: hint })
            return
        }

        songs.forEach((song) => {
            // 裸 MP3 的 filePath 带 mp3:// 前缀，与 song.path 比较前剥掉
            const isActive = state?.filePath?.replace(/^mp3:\/\//, '') === song.path
            const item = list.createDiv({ cls: `lyrics-songs-item${isActive ? ' lyrics-songs-item-active' : ''}` })

            // 封面按来源自动决定：笔记类优先 frontmatter 封面，裸 MP3 用音频 APIC 封面（v1.5.0 移除开关）
            const fmUrl = this.resolveBannerUrl(song.banner, song.path)
            const audioUrl = this.getAudioCoverUrl(song)
            const bannerUrl = song.kind === 'note' ? (fmUrl || audioUrl) : (audioUrl || fmUrl)
            if (bannerUrl) {
                const thumb = item.createDiv({ cls: 'lyrics-songs-item-thumb' })
                const img = document.createElement('img')
                img.src = bannerUrl
                img.alt = ''
                img.loading = 'lazy'
                thumb.appendChild(img)
            } else {
                // 无封面：显示音乐图标占位图
                const thumb = item.createDiv({ cls: 'lyrics-songs-item-thumb lyrics-songs-item-thumb-placeholder' })
                setIcon(thumb, 'music')
            }

            // 编辑/查看标签按钮（hover 显示）：MP3/M4A 可编辑（铅笔）；其余裸音频格式只读查看（眼睛）
            if (song.kind === 'note' || /\.(mp3|m4a)$/i.test(song.path)) {
                const editBtn = item.createDiv({ cls: 'lyrics-songs-edit-btn' })
                setIcon(editBtn, 'pencil')
                editBtn.setAttribute('title', '编辑标签')
                editBtn.addEventListener('click', (e) => {
                    e.stopPropagation()
                    if (song.kind === 'mp3') {
                        // 裸 MP3：直接传音频源（无笔记；库外盘符路径 → external）
                        const src = this.resolveSongSource(song.path)
                        if (src) new TagEditorModal(this.plugin.app, this.plugin, '', src).open()
                    } else {
                        // 不关闭歌单列表：弹窗盖在上面，保存/取消后回到列表仍保持打开
                        new TagEditorModal(this.plugin.app, this.plugin, song.path).open()
                    }
                })
            } else {
                // 非 MP3/M4A 裸音频（FLAC/OGG 等）：只读查看标签
                const viewBtn = item.createDiv({ cls: 'lyrics-songs-edit-btn' })
                setIcon(viewBtn, 'eye')
                viewBtn.setAttribute('title', '查看标签')
                viewBtn.addEventListener('click', (e) => {
                    e.stopPropagation()
                    const src = this.resolveSongSource(song.path)
                    if (src) new TagViewerModal(this.plugin.app, src).open()
                })
            }

            const info = item.createDiv({ cls: 'lyrics-songs-item-info' })
            info.createDiv({ cls: 'lyrics-songs-item-title', text: song.title })
            info.createDiv({ cls: 'lyrics-songs-item-actor', text: song.actor })

            item.addEventListener('click', async (e) => {
                e.stopPropagation()
                this.closeSongListPopup()
                await this.plugin.advanceToSong(song)
            })
        })
    }

    private closeSongListPopup() {
        if (this.songListPopup) { this.songListPopup.remove(); this.songListPopup = null }
        this.songListCountEl = null
        for (const url of this.songCoverUrls.values()) URL.revokeObjectURL(url)
        this.songCoverUrls.clear()
        this.lyricsPanel?.removeClass('lyrics-panel-hidden')
    }

    /** 构造歌曲的 AudioSource：库外盘符绝对路径 → external，否则 vault 内 TFile；找不到返回 null */
    private resolveSongSource(path: string): AudioSource | null {
        if (isWindowsAbsolutePath(path)) {
            return { type: 'external', path }
        }
        const file = this.plugin.app.vault.getAbstractFileByPath(path)
        return file instanceof TFile ? { type: 'vault', file } : null
    }

    /** 取某歌曲的音频封面 blob URL（缓存于 songCoverUrls，弹窗关闭时统一 revoke） */
    private getAudioCoverUrl(song: LyricSong): string {
        const audioCover = this.plugin.getAudioCover(song)
        if (!audioCover) return ''
        let url = this.songCoverUrls.get(song.path) ?? ''
        if (!url) {
            url = URL.createObjectURL(new Blob([audioCover.data], { type: audioCover.mime }))
            this.songCoverUrls.set(song.path, url)
        }
        return url
    }

    private resolveBannerUrl(banner: string, songPath?: string): string {
        if (!banner) return ''
        if (banner.startsWith('http://') || banner.startsWith('https://')) return banner

        // Strip Obsidian embed syntax ![[file.jpg]]
        const embedMatch = banner.match(/!\[\[(.+?)\]\]/)
        const rawPath = embedMatch ? embedMatch[1] : banner

        // 1. Use getFirstLinkpathDest — resolves relative to context path
        const contextPath = songPath || this.plugin.app.workspace.getActiveFile()?.path || ''
        const file = this.plugin.app.metadataCache.getFirstLinkpathDest(rawPath, contextPath)
        if (file) {
            return this.plugin.app.vault.getResourcePath(file)
        }

        // 2. If just a filename, search entire vault for matching file
        if (!rawPath.includes('/')) {
            const allFiles = this.plugin.app.vault.getFiles()
            const match = allFiles.find(f => f.name === rawPath)
            if (match) {
                return this.plugin.app.vault.getResourcePath(match)
            }
        }

        return banner
    }
}
