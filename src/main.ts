import LyricsMarkdownRender from 'LyricsMarkdownRender'
import LyricsSettings, { DEFAULT_SETTINGS, type Settings } from 'Settings'
import { Plugin, type MarkdownPostProcessorContext, ItemView, type WorkspaceLeaf, setIcon, TFile } from 'obsidian'
import type { LyricsLine } from 'renderers/renderer'

export const LYRICS_VIEW_TYPE = 'lyrics-sidebar'

export type PlayMode = 'off' | 'single' | 'sequential' | 'shuffle'
export const PLAY_MODES: PlayMode[] = ['off', 'single', 'sequential', 'shuffle']

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
    /** 乱序播放的洗牌队列：整张歌单随机播完一遍后才重新洗牌，避免隔几首又重复同一首 */
    private shuffleQueue: LyricSong[] = []

    private _playMode: PlayMode = 'off'
    private _playbackRate = 1
    private _volume = 75
    /** 切歌序号令牌：新的 advanceToSong 会让旧的（仍在轮询中的）切歌立即失效，避免并发竞争同一标签页 */
    private advanceSeq = 0
    /** flashSwitch 关闭时，最小化自动暂停播放的标记，恢复窗口后据此续播 */
    private autoPausedForMinimize = false

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

    /** 安全获取 Electron 当前窗口（remote 不可用时返回 null，功能降级为不重新最小化） */
    private getElectronWindow(): any {
        try {
            const req = (window as any).require
            if (typeof req !== 'function') return null
            const electron = req('electron')
            const remote = electron?.remote ?? req('@electron/remote')
            return remote?.getCurrentWindow?.() ?? null
        } catch {
            return null
        }
    }

    private reMinimize(win: any) {
        try {
            if (win?.minimize) win.minimize()
        } catch { /* 忽略最小化失败 */ }
    }

    /** flashSwitch 关闭时：最小化/隐藏自动暂停，恢复可见后续播 */
    private onVisibilityChange = () => {
        if (this.getSettings().flashSwitch) return // 开启闪现时不暂停
        if (document.hidden) {
            const player = this.getActivePlayer()
            if (player && !player.paused()) {
                player.pause()
                this.autoPausedForMinimize = true
            }
        } else if (this.autoPausedForMinimize) {
            this.autoPausedForMinimize = false
            const player = this.getActivePlayer()
            if (player && player.paused()) player.play()
        }
    }

    // --- Playback controls ---

    public getPlayMode(): PlayMode { return this._playMode }

    public cyclePlayMode() {
        const idx = PLAY_MODES.indexOf(this._playMode)
        this._playMode = PLAY_MODES[(idx + 1) % PLAY_MODES.length]
        this.shuffleQueue = [] // 模式变化时重置洗牌队列
        this.updateSettings({ playMode: this._playMode })
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

    public handleSongEnded(renderer: LyricsMarkdownRender) {
        switch (this._playMode) {
            case 'single':
                renderer.player?.seek(0)
                break
            case 'sequential':
            case 'shuffle': {
                const next = this.getNextSong(renderer.path)
                if (next && next.path !== renderer.path) {
                    void this.advanceToSong(next, renderer.path)
                } else {
                    // 乱序且歌单仅1首：等效单曲循环
                    renderer.player?.seek(0)
                }
                break
            }
            case 'off':
            default:
                break // 自然停止
        }
    }

    public async advanceToSong(song: LyricSong, fromPath?: string): Promise<void> {
        const mySeq = ++this.advanceSeq
        const file = this.app.vault.getAbstractFileByPath(song.path)
        if (!(file instanceof TFile)) return

        // 覆盖来源歌曲所在标签页（ended 路径传 renderer.path；popup 路径回退当前播放歌曲）
        const sourcePath = fromPath ?? this.getLyricsState()?.filePath
        let leaf: WorkspaceLeaf | null = null
        if (sourcePath) {
            leaf = this.app.workspace.getLeavesOfType('markdown')
                .find((l) => l.getViewState().state?.file === sourcePath) ?? null
        }
        if (!leaf) {
            leaf = this.app.workspace.getLeaf(false)
        }

        // 记录切歌前的活动标签页，播放后归还，避免长期占用用户正在工作的标签页
        const prevLeaf = this.app.workspace.getMostRecentLeaf()
        // 窗口状态分三态：
        //  - 前台：直接激活渲染，可靠
        //  - 后台但未最小化：非聚焦方式激活，不弹窗
        //  - 最小化：后台无法渲染，只能弹出渲染播放后立刻再最小化回去
        const windowFocused = document.hasFocus()
        const electronWin = this.getElectronWindow()
        const minimized = electronWin ? electronWin.isMinimized() : document.hidden
        // flashSwitch 关闭且窗口最小化：不切歌不弹窗（播放已由 visibilitychange 暂停）
        if (minimized && !this.getSettings().flashSwitch) {
            return
        }
        try {
            if (windowFocused || minimized) {
                await leaf.openFile(file, { active: true })
            } else {
                await leaf.openFile(file, { active: false })
                this.app.workspace.setActiveLeaf(leaf, { focus: false })
            }
        } catch {
            if (minimized) this.reMinimize(electronWin)
            return // 打开失败，放弃自动切歌
        }
        // 打开期间若有更新的切歌，本次已过时，立即放弃
        if (mySeq !== this.advanceSeq) return

        // 暂停当前播放（ended 路径下旧 audio 已自然暂停；此处兜底 popup 路径）
        const player = this.getActivePlayer()
        if (player && !player.paused()) player.pause()

        // 阶段一：等新歌曲的渲染器注册（渲染完成）
        const registered = await this.waitForRenderer(song.path, mySeq)
        if (mySeq !== this.advanceSeq) return

        let played = false
        if (registered) {
            if (minimized) {
                // 最小化 + 闪现：渲染完成立即开始播放并最小化，缩短弹窗时间（音频在后台继续加载播放）
                const target = this.activeRenderers.get(song.path)?.player
                if (target) {
                    if (target.paused()) target.play()
                    played = true
                }
                this.reMinimize(electronWin)
            } else {
                // 前台/后台：等音频就绪后再播放，保证首音
                played = await this.waitForPlayerReady(song.path, mySeq)
            }
        } else if (!windowFocused && !minimized) {
            // 后台（未最小化）渲染失败：退回主动激活兜底（可能弹窗，但保证能播）
            if (mySeq !== this.advanceSeq) return
            try {
                await leaf.openFile(file, { active: true })
            } catch { /* 忽略兜底失败 */ }
            const ok = await this.waitForRenderer(song.path, mySeq)
            if (ok) played = await this.waitForPlayerReady(song.path, mySeq)
        }
        if (mySeq !== this.advanceSeq) return

        // 把活动状态归还给切歌前的标签页（歌曲在后台标签页继续播放）；
        // 前台用 focus:true 把键盘焦点还给原标签页，后台/最小化用 focus:false 避免弹回前台
        if (prevLeaf && prevLeaf !== leaf) {
            try {
                this.app.workspace.setActiveLeaf(prevLeaf, { focus: windowFocused && !minimized })
            } catch { /* 忽略归还失败 */ }
        }
        // 最小化场景兜底：无论成功与否，最终把窗口最小化回去
        if (minimized) this.reMinimize(electronWin)
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
        this.shuffleQueue = [] // 歌单变化时重置洗牌队列
        this.songListListeners.forEach((cb) => cb())
    }

    public getSongList(): LyricSong[] { return this.songList }

    public getNextSong(currentPath: string): LyricSong | null {
        if (this.songList.length === 0) return null
        switch (this._playMode) {
            case 'single':
                return this.songList.find((s) => s.path === currentPath) || this.songList[0]
            case 'shuffle': {
                // 洗牌队列：整张歌单随机播完一遍后才重新洗牌，避免隔几首又重复同一首
                if (this.shuffleQueue.length === 0) {
                    this.buildShuffleQueue(currentPath)
                }
                return this.shuffleQueue.shift() ?? null
            }
            case 'sequential':
            case 'off':
            default: {
                const idx = this.songList.findIndex((s) => s.path === currentPath)
                if (idx === -1) return this.songList[0]
                return this.songList[(idx + 1) % this.songList.length]
            }
        }
    }

    public getPrevSong(currentPath: string): LyricSong | null {
        if (this.songList.length === 0) return null
        switch (this._playMode) {
            case 'single':
                return this.songList.find((s) => s.path === currentPath) || this.songList[0]
            case 'shuffle': {
                const idx = this.songList.findIndex((s) => s.path === currentPath)
                if (this.songList.length === 1) return this.songList[0]
                let rand = idx
                while (rand === idx) {
                    rand = Math.floor(Math.random() * this.songList.length)
                }
                return this.songList[rand]
            }
            default: {
                const idx = this.songList.findIndex((s) => s.path === currentPath)
                if (idx === -1) return this.songList[this.songList.length - 1]
                return this.songList[(idx - 1 + this.songList.length) % this.songList.length]
            }
        }
    }

    /** 生成洗牌队列：整张歌单 Fisher-Yates 打乱，每首播一遍后才重复；队首避免是当前歌曲 */
    private buildShuffleQueue(excludePath?: string): void {
        const songs = [...this.songList]
        for (let i = songs.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1))
            ;[songs[i], songs[j]] = [songs[j], songs[i]]
        }
        if (excludePath && songs.length > 1 && songs[0]?.path === excludePath) {
            const [first] = songs.splice(0, 1)
            songs.push(first)
        }
        this.shuffleQueue = songs
    }

    /** 等待指定歌曲的渲染器注册（渲染完成） */
    private async waitForRenderer(path: string, mySeq: number, limit = 50): Promise<boolean> {
        for (let i = 0; i < limit; i++) {
            if (mySeq !== this.advanceSeq) return false
            if (this.activeRenderers.get(path)) return true
            await new Promise((r) => setTimeout(r, 200))
        }
        return false
    }

    /** 等待指定歌曲音频就绪并开始播放 */
    private async waitForPlayerReady(path: string, mySeq: number, limit = 50): Promise<boolean> {
        for (let i = 0; i < limit; i++) {
            if (mySeq !== this.advanceSeq) return false
            const target = this.activeRenderers.get(path)?.player
            if (target && target.isReady()) {
                if (target.paused()) target.play()
                return true
            }
            await new Promise((r) => setTimeout(r, 200))
        }
        return false
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
        this._playMode = this.getSettings().playMode
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

        // 最小化自动暂停/恢复（flashSwitch 关闭时生效）
        this.registerDomEvent(document, 'visibilitychange', this.onVisibilityChange)

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
    private statusBarLocate: HTMLElement | null = null

    private songListPopup: HTMLElement | null = null
    private songListSearchEl: HTMLInputElement | null = null
    private songListTypeFilter: string = 'all'
    private songListCountEl: HTMLElement | null = null

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
        this.statusBarLocate.setAttribute('title', '定位到歌词笔记标签页')
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

        if (!state || state.lyrics.length === 0) {
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

    /** 定位到歌词笔记标签页：若已打开则切换到该标签（排序不变），否则新开标签页打开 */
    private locateLyricsNote() {
        const state = this.plugin.getLyricsState()
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
        const titleWrap = header.createDiv({ cls: 'lyrics-song-popup-title-wrap' })
        titleWrap.createSpan({ text: '歌曲列表' })
        this.songListCountEl = titleWrap.createSpan({ cls: 'lyrics-song-popup-count', text: `(${this.plugin.getSongList().length})` })
        const closeBtn = header.createSpan({ cls: 'lyrics-song-popup-close' })
        setIcon(closeBtn, 'x')
        closeBtn.addEventListener('click', () => this.closeSongListPopup())

        // 搜索 + 类型筛选并排一行：搜索占 2/3，类型占 1/3
        const filterRow = this.songListPopup.createDiv({ cls: 'lyrics-song-popup-filters' })
        const searchWrap = filterRow.createDiv({ cls: 'lyrics-song-popup-search' })
        this.songListSearchEl = searchWrap.createEl('input', {
            cls: 'lyrics-song-popup-search-input',
            attr: { type: 'text', placeholder: '搜索歌曲...' },
        })
        this.songListSearchEl.addEventListener('input', () => this.renderPopupSongList())

        // Type filter（来自 frontmatter type 字段）
        const types = Array.from(new Set(
            this.plugin.getSongList().map((s) => s.type).filter((t) => t && t.trim()),
        )).sort((a, b) => a.localeCompare(b))
        if (types.length > 0) {
            if (!types.includes(this.songListTypeFilter)) this.songListTypeFilter = 'all'
            const filterWrap = filterRow.createDiv({ cls: 'lyrics-song-popup-filter' })
            const select = filterWrap.createEl('select', { cls: 'lyrics-song-popup-filter-select' })
            select.createEl('option', { value: 'all', text: '全部类型' })
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
            const matchType = typeFilter === 'all' || s.type === typeFilter
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
                await this.plugin.advanceToSong(song)
            })
        })
    }

    private closeSongListPopup() {
        if (this.songListPopup) { this.songListPopup.remove(); this.songListPopup = null }
        this.songListCountEl = null
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
