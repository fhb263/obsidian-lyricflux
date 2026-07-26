import LyricsMarkdownRender from 'LyricsMarkdownRender'
import LyricsSettings, { DEFAULT_SETTINGS, type Settings } from 'Settings'
import { Plugin, type MarkdownPostProcessorContext, ItemView, type WorkspaceLeaf, setIcon } from 'obsidian'
import type { LyricsLine } from 'renderers/renderer'

export const LYRICS_VIEW_TYPE = 'lyrics-sidebar'

export const SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2]
export const VOLUME_OPTIONS = [0, 25, 50, 75, 100]

export interface LyricsState {
    filePath: string
    lyrics: LyricsLine[]
    currentIndex: number
    isPlaying: boolean
    currentTime: number
    karaoke: boolean
    title?: string
    actor?: string
    duration?: number
}

export interface LyricSong {
    path: string
    title: string
    actor: string
    type: string
    banner: string
}

export default class LyricsPlugin extends Plugin {
    private settings?: LyricsSettings
    private state: LyricsState | null = null
    private stateListeners: ((state: LyricsState | null) => void)[] = []
    private settingsListeners: (() => void)[] = []
    private activeRenderers: Map<string, LyricsMarkdownRender> = new Map()
    private songList: LyricSong[] = []
    private songListListeners: (() => void)[] = []

    private _singleLoop = false
    private _playbackRate = 1
    private _volume = 75

    public getSettings(): Settings {
        return this.settings?.getSettings() || DEFAULT_SETTINGS
    }

    public updateSettings(newSettings: Partial<Settings>) {
        this.settings?.updateSettings(newSettings)
        this.settingsListeners.forEach((cb) => cb())
    }

    public onSettingsChange(callback: () => void) {
        this.settingsListeners.push(callback)
    }

    public removeSettingsListener(callback: () => void) {
        this.settingsListeners = this.settingsListeners.filter((cb) => cb !== callback)
    }

    // --- State management ---

    public registerRenderer(path: string, renderer: LyricsMarkdownRender) {
        const old = this.activeRenderers.get(path)
        if (old?.player) old.player.pause()
        this.activeRenderers.set(path, renderer)
        if (renderer.player) {
            renderer.player.setRate(this._playbackRate)
            renderer.player.setVolume(this._volume / 100)
            renderer.player.setLoop(this._singleLoop)
        }
    }

    public unregisterRenderer(path: string) {
        this.activeRenderers.delete(path)
    }

    public updateLyricsState(state: LyricsState | null) {
        this.state = state
        this.stateListeners.forEach((cb) => cb(state))
    }

    public getLyricsState(): LyricsState | null {
        return this.state
    }

    public onLyricsStateChange(callback: (state: LyricsState | null) => void) {
        this.stateListeners.push(callback)
    }

    public removeLyricsStateListener(callback: (state: LyricsState | null) => void) {
        this.stateListeners = this.stateListeners.filter((cb) => cb !== callback)
    }

    public seekActivePlayer(time: number) {
        const player = this.getActivePlayer()
        if (player) player.seek(time)
    }

    public toggleActivePlayer() {
        const player = this.getActivePlayer()
        if (!player) return
        if (player.paused()) player.play()
        else player.pause()
    }

    public async playActivePlayer(): Promise<boolean> {
        const player = this.getActivePlayer()
        if (player) {
            if (player.paused()) player.play()
            // Wait until audio is actually ready to play
            for (let i = 0; i < 50; i++) {
                if (player.isReady()) return true
                await new Promise(r => setTimeout(r, 200))
            }
            return true // still return true, audio may just be slow
        }
        return false
    }

    public getActivePlayer() {
        const activeFile = this.app.workspace.getActiveFile()
        if (activeFile) {
            const renderer = this.activeRenderers.get(activeFile.path)
            if (renderer?.player) return renderer.player
        }
        for (const renderer of this.activeRenderers.values()) {
            if (renderer.player) return renderer.player
        }
        return null
    }

    // --- Playback controls ---

    public isSingleLoop(): boolean { return this._singleLoop }

    public toggleSingleLoop() {
        this._singleLoop = !this._singleLoop
        for (const renderer of this.activeRenderers.values()) {
            if (renderer.player) renderer.player.setLoop(this._singleLoop)
        }
        this.stateListeners.forEach((cb) => cb(this.state))
    }

    public getPlaybackRate(): number { return this._playbackRate }

    public cyclePlaybackRate() {
        const idx = SPEED_OPTIONS.indexOf(this._playbackRate)
        this._playbackRate = SPEED_OPTIONS[(idx + 1) % SPEED_OPTIONS.length]
        for (const renderer of this.activeRenderers.values()) {
            if (renderer.player) renderer.player.setRate(this._playbackRate)
        }
        this.stateListeners.forEach((cb) => cb(this.state))
    }

    public getVolume(): number { return this._volume }

    public setVolume(vol: number) {
        this._volume = Math.max(0, Math.min(100, vol))
        for (const renderer of this.activeRenderers.values()) {
            if (renderer.player) renderer.player.setVolume(this._volume / 100)
        }
        this.stateListeners.forEach((cb) => cb(this.state))
    }

    public cycleVolume() {
        const idx = VOLUME_OPTIONS.indexOf(this._volume)
        this._volume = VOLUME_OPTIONS[(idx + 1) % VOLUME_OPTIONS.length]
        for (const renderer of this.activeRenderers.values()) {
            if (renderer.player) renderer.player.setVolume(this._volume / 100)
        }
        this.stateListeners.forEach((cb) => cb(this.state))
    }

    // --- Song list management ---

    public async scanLyricSongs(): Promise<void> {
        const folder = this.getSettings().lyricsFolder
        if (!folder) {
            this.songList = []
            this.songListListeners.forEach((cb) => cb())
            return
        }
        const files = this.app.vault.getMarkdownFiles().filter(f => f.path.startsWith(folder))
        const songs: LyricSong[] = []
        for (const file of files) {
            const cache = this.app.metadataCache.getFileCache(file)
            const frontmatter = cache?.frontmatter
            if (frontmatter?.['title']) {
                songs.push({
                    path: file.path,
                    title: frontmatter['title'],
                    actor: frontmatter['actor'] || '未知艺术家',
                    type: frontmatter['type'] || '',
                    banner: frontmatter['banner'] || frontmatter['cover'] || '',
                })
            }
        }
        this.songList = songs.sort((a, b) => a.title.localeCompare(b.title))
        this.songListListeners.forEach((cb) => cb())
    }

    public getSongList(): LyricSong[] { return this.songList }

    public getNextSong(currentPath: string): LyricSong | null {
        if (this.songList.length === 0) return null
        if (this._singleLoop) {
            return this.songList.find(s => s.path === currentPath) || this.songList[0]
        }
        const idx = this.songList.findIndex(s => s.path === currentPath)
        if (idx === -1) return this.songList[0]
        return this.songList[(idx + 1) % this.songList.length]
    }

    public getPrevSong(currentPath: string): LyricSong | null {
        if (this.songList.length === 0) return null
        if (this._singleLoop) {
            return this.songList.find(s => s.path === currentPath) || this.songList[0]
        }
        const idx = this.songList.findIndex(s => s.path === currentPath)
        if (idx === -1) return this.songList[this.songList.length - 1]
        return this.songList[(idx - 1 + this.songList.length) % this.songList.length]
    }

    public async openLyricNote(path: string) {
        await this.app.workspace.openLinkText(path, '', false)
    }

    public onSongListChange(callback: () => void) {
        this.songListListeners.push(callback)
    }

    public removeSongListListener(callback: () => void) {
        this.songListListeners = this.songListListeners.filter((cb) => cb !== callback)
    }

    // --- Sidebar view ---

    async activateLyricsView() {
        const existing = this.app.workspace.getLeavesOfType(LYRICS_VIEW_TYPE)
        if (existing.length > 0) {
            this.app.workspace.revealLeaf(existing[0])
            return
        }
        const rightLeaf = this.app.workspace.getRightLeaf(false)
        if (rightLeaf) {
            await rightLeaf.setViewState({ type: LYRICS_VIEW_TYPE, active: true })
        }
    }

    async onload() {
        const settings = { ...DEFAULT_SETTINGS, ...(await this.loadData()) }
        this.settings = new LyricsSettings(this, settings)
        this.addSettingTab(this.settings)

        this.registerMarkdownCodeBlockProcessor(
            'lrc',
            (source: string, element: HTMLElement, context: MarkdownPostProcessorContext) => {
                context.addChild(new LyricsMarkdownRender(this, source, element, context))
            },
        ).sortOrder = -1000

        this.registerView(LYRICS_VIEW_TYPE, (leaf) => new LyricsView(leaf, this))
        this.addRibbonIcon('music', 'LyricFlux', () => this.activateLyricsView())
        this.addCommand({
            id: 'open-lyricflux-panel',
            name: 'Open LyricFlux',
            callback: () => this.activateLyricsView(),
        })

        // Re-emit state when switching to a note with a renderer
        this.registerEvent(this.app.workspace.on('active-leaf-change', () => {
            setTimeout(() => {
                const activeFile = this.app.workspace.getActiveFile()
                if (activeFile) {
                    const renderer = this.activeRenderers.get(activeFile.path)
                    if (renderer) {
                        renderer.emitState()
                        return
                    }
                }
                // Only clear if no renderer is registered at all
                if (this.activeRenderers.size === 0) {
                    this.updateLyricsState(null)
                }
            }, 300)
        }))

        await this.scanLyricSongs()
        this.registerEvent(this.app.vault.on('create', () => this.scanLyricSongs()))
        this.registerEvent(this.app.vault.on('delete', () => this.scanLyricSongs()))
        this.registerEvent(this.app.vault.on('rename', () => this.scanLyricSongs()))
    }

    async onunload() {
        this.stateListeners = []
        this.activeRenderers.clear()
        this.state = null
    }
}

// --- Sidebar View ---

class LyricsView extends ItemView {
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

    private songListPopup: HTMLElement | null = null
    private songListSearchEl: HTMLInputElement | null = null

    private statusBarVolumeIcon: HTMLElement | null = null
    private volumePopup: HTMLElement | null = null
    private volumeOutsideClickHandler: ((e: MouseEvent) => void) | null = null

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
    }

    async onClose() {
        this.closeSongListPopup()
        this.closeVolumePopup()
        this.plugin.removeLyricsStateListener(this._onStateChange)
    }

    private _onStateChange = (state: LyricsState | null) => {
        this.renderLyrics(state)
        this.renderStatusBar(state)
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

        // Single loop
        this.statusBarMode = this.statusBar.createSpan({ cls: 'lyrics-statusbar-mode-btn' })
        this.statusBarMode.setAttribute('title', '开启/关闭单曲循环')
        this.statusBarMode.addEventListener('click', () => {
            this.plugin.toggleSingleLoop()
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
        const on = this.plugin.isSingleLoop()
        setIcon(this.statusBarMode, on ? 'repeat-1' : 'repeat')
        this.statusBarMode.toggleClass('lyrics-mode-active', on)
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

        if (!state || state.lyrics.length === 0) {
            this.statusBarTitle.setText('LyricFlux')
            if (this.statusBarTime) this.statusBarTime.setText('')
            setIcon(this.statusBarPlay!, 'play')
            return
        }
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

    // --- Lyrics rendering ---

    private renderEmpty() {
        if (!this.lyricsEl) return
        this.lyricsEl.empty()
        this.lyricsEl.createDiv({ cls: 'lyrics-panel-empty', text: '暂无歌词，请打开包含 lrc 代码块的笔记以显示歌词。' })
        this.playPauseBtn?.addClass('lyrics-panel-play-hidden')
    }

    private renderLyrics(state: LyricsState | null) {
        if (!this.lyricsEl) return
        this.lyricsEl.empty()

        if (!state || state.lyrics.length === 0) {
            this.renderEmpty()
            this.updatePlayPauseIcon(false)
            return
        }

        this.updatePlayPauseIcon(state.isPlaying)
        this.playPauseBtn?.removeClass('lyrics-panel-play-hidden')

        const timeMs = Math.round(state.currentTime * 1000)

        state.lyrics.forEach((line, index) => {
            const isCurrent = index === state.currentIndex
            const isPast = index < state.currentIndex
            let cls = 'lyrics-panel-line'
            if (isCurrent) cls += ' lyrics-panel-highlighted'
            else if (isPast) cls += ' lyrics-panel-past'
            else cls += ' lyrics-panel-future'

            const lineEl = this.lyricsEl!.createDiv({ cls, attr: { 'data-time': String(line.timestamp || 0) } })
            const textEl = lineEl.createSpan({ cls: 'lyrics-panel-text' })

            if (state.karaoke && isCurrent && line.text.trim()) {
                // Use precise word timestamps if available from LRC parser
                if (line.words && line.words.length > 0) {
                    line.words.forEach((word) => {
                        textEl.createSpan({
                            cls: word.timestamp <= timeMs ? 'lyrics-panel-word-active' : 'lyrics-panel-word',
                            text: word.text,
                        })
                    })
                } else {
                    // Fallback: auto-distribute timestamps across words
                    const words = line.text.match(/[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff\ufe70-\ufeff\u0900-\u097f\u0e00-\u0e7f\u0f00-\u0fff\u4e00-\u9fff\u3400-\u4dbf\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af\u3130-\u318f]|[a-zA-Z0-9\u0400-\u04ff\u0530-\u058f\u10a0-\u10ff]+|\s+/g)
                    if (words && words.length > 0) {
                        const start = line.timestamp || 0
                        const end = index + 1 < state.lyrics.length
                            ? (state.lyrics[index + 1].timestamp || start + 3000)
                            : start + 3000
                        const perWord = (end - start) / words.length
                        words.forEach((w, j) => {
                            textEl.createSpan({
                                cls: (start + j * perWord) <= timeMs ? 'lyrics-panel-word-active' : 'lyrics-panel-word',
                                text: w,
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

            lineEl.addEventListener('click', () => {
                if (line.timestamp !== undefined) this.plugin.seekActivePlayer(line.timestamp / 1000)
            })
        })

        const highlighted = this.lyricsEl.querySelector('.lyrics-panel-highlighted')
        if (highlighted) highlighted.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }

    // --- Song list popup ---

    private toggleSongListPopup() {
        if (this.songListPopup) { this.closeSongListPopup(); return }
        this.openSongListPopup()
    }

    private openSongListPopup() {
        if (!this.lyricsPanel) return
        this.closeSongListPopup()
        this.lyricsPanel.addClass('lyrics-panel-hidden')

        const container = this.containerEl.children[1] as HTMLElement
        this.songListPopup = container.createDiv({ cls: 'lyrics-song-popup' })

        const header = this.songListPopup.createDiv({ cls: 'lyrics-song-popup-header' })
        header.createSpan({ text: '歌曲列表' })
        const closeBtn = header.createSpan({ cls: 'lyrics-song-popup-close' })
        setIcon(closeBtn, 'x')
        closeBtn.addEventListener('click', () => this.closeSongListPopup())

        // Search input
        const searchWrap = this.songListPopup.createDiv({ cls: 'lyrics-song-popup-search' })
        this.songListSearchEl = searchWrap.createEl('input', {
            cls: 'lyrics-song-popup-search-input',
            attr: { type: 'text', placeholder: '搜索歌曲...' },
        })
        this.songListSearchEl.addEventListener('input', () => this.renderPopupSongList())

        this.renderPopupSongList()
        this.songListSearchEl.focus()
    }

    private renderPopupSongList() {
        if (!this.songListPopup) return
        const oldList = this.songListPopup.querySelector('.lyrics-song-popup-list')
        if (oldList) oldList.remove()

        const allSongs = this.plugin.getSongList()
        const state = this.plugin.getLyricsState()

        // Filter by search query
        const query = this.songListSearchEl?.value?.toLowerCase().trim() || ''
        const songs = query
            ? allSongs.filter(s => s.title.toLowerCase().includes(query) || s.actor.toLowerCase().includes(query))
            : allSongs

        const list = this.songListPopup.createDiv({ cls: 'lyrics-song-popup-list' })
        if (songs.length === 0) {
            list.createDiv({ cls: 'lyrics-songs-empty', text: query ? '没有匹配的歌曲' : '暂无歌曲' })
            return
        }

        songs.forEach((song) => {
            const isActive = state?.filePath === song.path
            const item = list.createDiv({ cls: `lyrics-songs-item${isActive ? ' lyrics-songs-item-active' : ''}` })

            const bannerUrl = this.resolveBannerUrl(song.banner, song.path)
            if (bannerUrl) {
                const thumb = item.createDiv({ cls: 'lyrics-songs-item-thumb' })
                const img = document.createElement('img')
                img.src = bannerUrl
                img.alt = ''
                img.loading = 'lazy'
                thumb.appendChild(img)
            } else if (isActive) {
                item.createSpan({ cls: 'lyrics-songs-playing-indicator' })
            }

            const info = item.createDiv({ cls: 'lyrics-songs-item-info' })
            info.createDiv({ cls: 'lyrics-songs-item-title', text: song.title })
            info.createDiv({ cls: 'lyrics-songs-item-actor', text: song.actor })

            item.addEventListener('click', async (e) => {
                e.stopPropagation()
                this.closeSongListPopup()
                // Stop current playback first
                const player = this.plugin.getActivePlayer()
                if (player && !player.paused()) player.pause()
                // Open note in current tab
                await this.plugin.app.workspace.openLinkText(song.path, '', false)
                // Wait for renderer to register, then play
                for (let i = 0; i < 50; i++) {
                    const ok = await this.plugin.playActivePlayer()
                    if (ok) break
                    await new Promise(r => setTimeout(r, 200))
                }
            })
        })
    }

    private closeSongListPopup() {
        if (this.songListPopup) { this.songListPopup.remove(); this.songListPopup = null }
        this.lyricsPanel?.removeClass('lyrics-panel-hidden')
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
