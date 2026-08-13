import LyricsMarkdownRender from 'LyricsMarkdownRender'
import Mp3PlayerRender from 'Mp3PlayerRender'
import LyricsSettings, { DEFAULT_SETTINGS, type Settings } from 'Settings'
import { Plugin, type MarkdownPostProcessorContext, TFile, type WorkspaceLeaf, type App } from 'obsidian'
import type { LyricsLine } from 'renderers/renderer'
import { LYRICS_VIEW_TYPE, PLAY_MODES, SPEED_OPTIONS, VOLUME_OPTIONS, type PlayMode } from 'shared'
import { resolveAudioSource, readMp3TagHead, parseTagsForPlugin, type Mp3Tags, type AudioSource } from 'tags'
import { isAudioFile, buildMp3Song, dedupeMp3ByNote, resolvePlayingMp3Metadata, isWindowsAbsolutePath } from 'songScanner'
import LyricsView from 'LyricsView'

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
    /** 歌曲来源：笔记(默认) / 裸 MP3（v1.5.0 新增，供侧边栏空态区分） */
    sourceKind?: 'note' | 'mp3'
}

export interface LyricSong {
    path: string
    title: string
    actor: string
    type: string
    banner: string
    /** 歌曲来源：'note'=LRC笔记（默认），'mp3'=裸音频文件（v1.5.0 新增） */
    kind: 'note' | 'mp3'
    audioPath?: string // 解析出的音频路径，作为标签缓存 key
}

/**
 * 构造裸 MP3 的 AudioSource（v1.4.2 库外音频文件夹支持）：
 * Windows 盘符绝对路径 → external（fs 直读）；否则按 vault 内路径找 TFile。
 * 找不到返回 null。
 */
function resolveSongAudioSource(app: App, path: string): AudioSource | null {
    if (isWindowsAbsolutePath(path)) {
        return { type: 'external', path }
    }
    const file = app.vault.getAbstractFileByPath(path)
    return file instanceof TFile ? { type: 'vault', file } : null
}

/** 递归枚举库外目录下所有音频文件（Windows 盘符绝对路径的音频文件夹用） */
async function listExternalAudioFiles(root: string): Promise<string[]> {
    try {
        const fs = (window as any).require('fs')
        const out: string[] = []
        const walk = async (dir: string): Promise<void> => {
            let entries: any[] = []
            try { entries = await fs.promises.readdir(dir, { withFileTypes: true }) } catch { return }
            for (const e of entries) {
                const full = dir.replace(/[\\/]+$/, '') + '/' + e.name
                if (e.isDirectory()) await walk(full)
                else if (e.isFile() && isAudioFile(e.name)) out.push(full)
            }
        }
        await walk(root.replace(/[\\/]+$/, ''))
        return out
    } catch {
        return []
    }
}

export default class LyricsPlugin extends Plugin {
    private settings?: LyricsSettings
    private state: LyricsState | null = null
    private stateListeners: ((state: LyricsState | null) => void)[] = []
    private settingsListeners: (() => void)[] = []
    private activeRenderers: Map<string, LyricsMarkdownRender | Mp3PlayerRender> = new Map()
    private songList: LyricSong[] = []
    private songListListeners: (() => void)[] = []
    /** 乱序播放的洗牌队列：整张歌单随机播完一遍后才重新洗牌，避免隔几首又重复同一首 */
    private shuffleQueue: LyricSong[] = []
    /** 音频标签缓存：key = 音频路径 */
    private audioTagCache = new Map<string, Mp3Tags | null>()

    private _playMode: PlayMode = 'off'
    private _playbackRate = 1
    private _volume = 75
    /** 切歌序号令牌：新的 advanceToSong 会让旧的（仍在轮询中的）切歌立即失效，避免并发竞争同一标签页 */
    private advanceSeq = 0
    /** flashSwitch 关闭时，最小化自动暂停播放的标记，恢复窗口后据此续播 */
    private autoPausedForMinimize = false
    /** 最后活跃播放器的渲染器路径（播放时由 markPlayerActive 更新），供 getActivePlayer 精确命中 */
    private lastActiveRenderPath: string | null = null
    /** 上一个播放源渲染器路径（新播放源接管前记录），供其卸载后复位状态 */
    private previousActiveRenderPath: string | null = null
    /** 上一播放源被接管时是否在播放（复位时是否自动续播） */
    private previousWasPlaying = false
    /** 临时强制某个路径可发状态（onRendererUnloaded 复位时绕过状态源门控） */
    private forceEmitPath: string | null = null
    /** 歌单重扫防抖定时器（vault 事件高频触发时合并） */
    private scanTimer: number | null = null
    /** active-leaf-change 300ms 延迟回调的定时器，onunload 时清理 */
    private leafChangeTimer: number | null = null
    /** 音量持久化防抖定时器（滑条拖动高频触发） */
    private saveVolumeTimer: number | null = null
    /** 歌单富化代际令牌：新 scanLyricSongs 使在途旧富化循环失效，避免旧结果污染新列表 */
    private enrichSeq = 0

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

    public registerRenderer(path: string, renderer: LyricsMarkdownRender | Mp3PlayerRender) {
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

    /** 渲染器暂停后上报：按当前状态源重新推一次状态，使状态栏播放/暂停图标即时更新。
     *  活动文件有渲染器时发它（暂停后侧边栏跟随活动文件）；否则发暂停的歌曲自身。 */
    public onRendererPaused(path: string) {
        const activeFile = this.app.workspace.getActiveFile()
        const active = activeFile ? this.activeRenderers.get(activeFile.path) : null
        if (active && active.player && active.path !== path) {
            active.emitState()
            return
        }
        const self = this.activeRenderers.get(path)
        self?.emitState()
    }

    /** 播放时由渲染器上报：接管状态源并暂停其他所有渲染器（单音轨不变量，避免手动播放 LRC 笔记与裸 MP3 双音轨） */
    public markPlayerActive(path: string) {
        if (path !== this.lastActiveRenderPath && this.lastActiveRenderPath) {
            const prev = this.activeRenderers.get(this.lastActiveRenderPath)
            this.previousActiveRenderPath = this.lastActiveRenderPath
            this.previousWasPlaying = prev?.player ? !prev.player.paused() : false
        }
        this.lastActiveRenderPath = path
        for (const [p, renderer] of this.activeRenderers) {
            if (p !== path && renderer.player && !renderer.player.paused()) {
                renderer.player.pause()
            }
        }
    }

    /** 该渲染器是否应作为侧边栏/状态栏的状态源：有播放中的源时仅该源可发（避免查看 LRC 笔记抢占闪烁）；
     *  无播放中源（暂停/结束/未播放）时跟随当前活动文件；forceEmitPath 供复位时绕过门控 */
    public isStateSource(path: string): boolean {
        if (this.forceEmitPath === path) return true
        const playingPath = this.lastActiveRenderPath
        const playing = playingPath ? this.activeRenderers.get(playingPath) : null
        if (playing?.player && !playing.player.paused()) {
            return playingPath === path
        }
        // 无播放中：活动文件有渲染器 → 跟随它；否则回到最后活跃的渲染器（暂停的最后播放歌曲，使状态栏能显示其暂停态）
        const activeFile = this.app.workspace.getActiveFile()
        if (activeFile && this.activeRenderers.has(activeFile.path)) {
            return activeFile.path === path
        }
        return this.lastActiveRenderPath === path
    }

    /** 渲染器卸载后若其为当前状态源，复位到上一个播放源（关闭 LRC 笔记后回到之前的歌曲，可选续播） */
    public onRendererUnloaded(path: string) {
        const isDisplay = this.getLyricsState()?.filePath === path
        if (!isDisplay && this.lastActiveRenderPath !== path) return
        // 播放过的渲染器 → 复位到 markPlayerActive 记录的上一个源；仅查看的渲染器 → 回到当前 lastActiveRenderPath
        const wasPlayed = this.lastActiveRenderPath === path
        const prev = wasPlayed ? this.previousActiveRenderPath : this.lastActiveRenderPath
        const wasPlaying = this.previousWasPlaying
        this.previousActiveRenderPath = null
        this.previousWasPlaying = false
        this.lastActiveRenderPath = prev
        const prevRenderer = prev ? this.activeRenderers.get(prev) : null
        if (prevRenderer?.player) {
            if (wasPlayed && wasPlaying && prevRenderer.player.paused()) prevRenderer.player.play()
            // 复位 emit 绕过门控：上一源即使暂停也要显示其状态
            this.forceEmitPath = prev
            prevRenderer.emitState()
            this.forceEmitPath = null
        } else {
            this.updateLyricsState(null)
        }
    }

    public getActivePlayer() {
        // 与状态源一致：优先命中正在播放的歌曲（如裸 MP3，即使活动文件是其它 LRC 笔记，
        // 否则状态栏会误控到活动笔记里那个暂停的播放器，导致「暂停不了」）
        const playingPath = this.lastActiveRenderPath
        const playing = playingPath ? this.activeRenderers.get(playingPath) : null
        if (playing?.player && !playing.player.paused()) {
            return playing.player
        }
        // 无歌播放时跟随当前活动文件
        const activeFile = this.app.workspace.getActiveFile()
        if (activeFile) {
            const renderer = this.activeRenderers.get(activeFile.path)
            if (renderer?.player) return renderer.player
        }
        // 回退：暂停的最后播放歌曲，或任一渲染器
        if (playing?.player) return playing.player
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

    /** 停止所有播放（切换歌单来源等场景）：卸载裸 MP3 渲染器、暂停笔记渲染器、清空歌词状态 */
    public async stopAllPlayback() {
        this.advanceSeq++ // 使在途切歌立即失效
        for (const renderer of [...this.activeRenderers.values()]) {
            if (renderer instanceof Mp3PlayerRender) {
                await renderer.onunload()
            } else if (renderer.player) {
                renderer.player.pause()
            }
        }
        this.lastActiveRenderPath = null
        this.autoPausedForMinimize = false
        this.updateLyricsState(null)
    }

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
        // 倍速持久化，重启不丢失
        void this.updateSettings({ playbackRate: this._playbackRate })
    }

    public getVolume(): number { return this._volume }

    public setVolume(vol: number) {
        this._volume = Math.max(0, Math.min(100, vol))
        this.applyVolumeToPlayers()
        // 音量持久化（防抖，避免滑条拖动高频写 data.json）
        if (this.saveVolumeTimer !== null) clearTimeout(this.saveVolumeTimer)
        this.saveVolumeTimer = window.setTimeout(() => {
            this.saveVolumeTimer = null
            void this.updateSettings({ volume: this._volume })
        }, 300)
    }

    public cycleVolume() {
        const idx = VOLUME_OPTIONS.indexOf(this._volume)
        this.setVolume(VOLUME_OPTIONS[(idx + 1) % VOLUME_OPTIONS.length])
    }

    private applyVolumeToPlayers() {
        for (const renderer of this.activeRenderers.values()) {
            if (renderer.player) renderer.player.setVolume(this._volume / 100)
        }
        this.stateListeners.forEach((cb) => cb(this.state))
    }

    public handleSongEnded(renderer: LyricsMarkdownRender | Mp3PlayerRender) {
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
        // 裸 MP3：不打开笔记，直接用虚拟渲染器播放
        if (song.kind === 'mp3') {
            await this.advanceToMp3(song)
            return
        }
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

    /** 切到裸 MP3：创建虚拟渲染器（复用 waitForRenderer 机制等就绪后播放） */
    private async advanceToMp3(song: LyricSong): Promise<void> {
        // 清理上一首裸 MP3 渲染器（避免残留）
        for (const [path, renderer] of this.activeRenderers) {
            if (renderer instanceof Mp3PlayerRender) {
                await renderer.onunload()
            }
        }
        // 暂停当前播放
        const player = this.getActivePlayer()
        if (player && !player.paused()) player.pause()

        // 解析音频源（库外盘符路径 → external；vault 内 → TFile）
        const src = resolveSongAudioSource(this.app, song.path)
        if (!src) return
        const render = new Mp3PlayerRender(this, `mp3://${song.path}`, src)
        render.setMetadata(song.title, song.actor)
        await render.init()
        await this.waitForRenderer(render.path, this.advanceSeq)
        const target = this.activeRenderers.get(render.path)?.player
        if (target && target.paused()) target.play()
    }

    // --- Song list management ---

    public async scanLyricSongs(): Promise<void> {
        const songs: LyricSong[] = []
        const source = this.getSettings().songSource

        if (source === 'audio') {
            // --- 裸 MP3 扫描（音频文件路径） ---
            const audioFolder = this.getSettings().audioFolder
            if (audioFolder) {
                if (isWindowsAbsolutePath(audioFolder)) {
                    // 库外盘符绝对路径：用 fs 递归枚举音频文件，产出 external 歌项
                    const externalPaths = await listExternalAudioFiles(audioFolder)
                    songs.push(...externalPaths.map((p) => buildMp3Song(p)))
                } else {
                    const audioPrefix = audioFolder.replace(/\/+$/, '') + '/'
                    const allFiles = this.app.vault.getFiles()
                    const mp3Songs = allFiles
                        .filter((f) => f.path.startsWith(audioPrefix) && isAudioFile(f.path))
                        .map((f) => buildMp3Song(f.path))
                    songs.push(...mp3Songs)
                }
            }
        } else {
            // --- LRC 笔记扫描（LRC 笔记路径） ---
            const folder = this.getSettings().lyricsFolder
            if (folder) {
                // 精确前缀匹配：folder + '/'，避免 folder='Music' 误收 'Music-2024/...' 等同前缀兄弟路径
                const folderPrefix = folder.replace(/\/+$/, '') + '/'
                const files = this.app.vault.getMarkdownFiles().filter(f => f.path.startsWith(folderPrefix))
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
                            kind: 'note',
                        })
                    }
                }
            }
        }
        this.songList = songs.sort((a, b) => a.title.localeCompare(b.title))
        this.shuffleQueue = [] // 歌单变化时重置洗牌队列
        this.audioTagCache.clear() // 重扫时清理标签缓存，反映外部改动的标签
        // 当前播放歌曲不在新歌单（切换来源/改文件夹甩出）→ 停止播放，避免残留或双播
        const currentPath = this.lastActiveRenderPath?.replace(/^mp3:\/\//, '') ?? null
        const currentStillInList = currentPath
            ? this.songList.some((s) => s.path === currentPath)
            : true
        if (!currentStillInList) {
            await this.stopAllPlayback()
        }
        // 外部改动 MP3 文件（vault 事件触发重扫）时，正在播放的裸 MP3 检测 mtime 变化并重读内嵌歌词
        const playingState = this.getLyricsState()
        if (playingState?.sourceKind === 'mp3' && playingState.filePath) {
            const renderer = this.activeRenderers.get(playingState.filePath)
            if (renderer instanceof Mp3PlayerRender) {
                void renderer.reloadLyricsIfChanged()
            }
        }
        this.songListListeners.forEach((cb) => cb())
        this.enrichSongList() // 异步富化，不阻塞
    }

    /** 异步富化歌单：音频标签优先覆盖 title/actor；结果缓存，供歌单封面使用。
     *  并发限制 6 路读文件头，避免大歌单串行 IO；完成后一次性通知，避免每首触发全量列表刷新。 */
    private async enrichSongList() {
        const mySeq = ++this.enrichSeq
        const songs = this.songList
        const CONCURRENCY = 6
        let cursor = 0
        const worker = async () => {
            while (cursor < songs.length) {
                if (mySeq !== this.enrichSeq) return // 歌单已被更新，旧富化立即失效
                const song = songs[cursor++]
                await this.enrichOne(song)
            }
        }
        const workers = Array.from(
            { length: Math.min(CONCURRENCY, songs.length) },
            () => worker(),
        )
        await Promise.all(workers)
        if (mySeq === this.enrichSeq) {
            // 富化完成后：收集笔记类引用的音频路径，过滤掉重复的裸 MP3
            const noteAudioPaths = new Set(
                this.songList
                    .filter((s) => s.kind === 'note' && s.audioPath)
                    .map((s) => s.audioPath!),
            )
            this.songList = [
                ...this.songList.filter((s) => s.kind === 'note'),
                ...dedupeMp3ByNote(
                    this.songList.filter((s) => s.kind === 'mp3'),
                    noteAudioPaths,
                ),
            // 富化后按标签标题优先重排（MP3=标签标题；无标签/非 MP3=文件名），比 scan 时的文件名序更准
            ].sort((a, b) => a.title.localeCompare(b.title))
            this.songListListeners.forEach((cb) => cb())
            // 标签编辑/重扫后同步正在播放的裸 MP3 元数据，使状态栏标题/作者实时刷新
            this.syncPlayingMp3Metadata()
        }
    }

    /** 富化单首歌：解析音频源 → 读 ID3 头部 → 缓存标签 → 按设置覆盖 title/actor */
    private async enrichOne(song: LyricSong): Promise<void> {
        let key = song.audioPath
        let src = null as AudioSource | null
        if (song.kind === 'mp3') {
            // 裸 MP3：audioPath 即自身路径，构造 AudioSource（库外盘符路径 → external，否则 vault）
            key = song.audioPath ?? ''
            if (!key || this.audioTagCache.has(key)) return
            src = resolveSongAudioSource(this.app, key)
        } else if (key === undefined) {
            // 笔记类：现有逻辑
            src = await resolveAudioSource(this.app, song.path)
            if (!src) {
                song.audioPath = '' // 标记不可解析，避免下次重试
                return
            }
            key = src.type === 'external' ? src.path : src.file?.path ?? ''
            song.audioPath = key
        }
        if (!key || this.audioTagCache.has(key)) return
        if (!src) return
        const head = await readMp3TagHead(this.app, src)
        const tags = head ? parseTagsForPlugin(head) : null
        this.audioTagCache.set(key, tags)
        // 按来源自动决定元数据：裸 MP3 用音频标签覆盖 title/artist；笔记类保持 frontmatter（v1.5.0 移除开关）
        if (song.kind === 'mp3') {
            if (tags?.title) song.title = tags.title
            if (tags?.artist) song.actor = tags.artist
            if (tags?.album) song.type = tags.album
        }
    }

    /** 标签编辑/重扫后同步正在播放的裸 MP3 元数据到渲染器，使状态栏标题/作者实时刷新 */
    private syncPlayingMp3Metadata() {
        const meta = resolvePlayingMp3Metadata(this.getLyricsState(), this.songList)
        if (!meta) return
        const renderer = this.activeRenderers.get(`mp3://${meta.path}`)
        if (renderer instanceof Mp3PlayerRender) {
            renderer.setMetadata(meta.title, meta.actor)
            renderer.emitState()
        }
    }

    /** 取某歌曲的音频封面（无则 null） */
    public getAudioCover(song: LyricSong): { mime: string; data: Uint8Array } | null {
        if (!song.audioPath) return null
        return this.audioTagCache.get(song.audioPath)?.cover ?? null
    }

    /** 供弹窗保存后刷新列表（清除该歌缓存 + 重新扫描）；编辑的是正在播放的裸 MP3 时实时重读内嵌歌词 */
    public notifyTagsEdited(notePath: string) {
        const song = this.songList.find((s) => s.path === notePath)
        if (song?.audioPath) this.audioTagCache.delete(song.audioPath)
        const state = this.getLyricsState()
        if (state?.sourceKind === 'mp3' && state.filePath === `mp3://${notePath}`) {
            const renderer = this.activeRenderers.get(state.filePath)
            if (renderer instanceof Mp3PlayerRender) {
                void renderer.reloadLyrics()
            }
        }
        void this.scanLyricSongs()
    }

    /** 删除音频文件后调用：若删除的正是当前播放的裸 MP3 则卸载渲染器并复位状态；随后重扫歌单 */
    public async handleAudioDeleted(audioPath: string): Promise<void> {
        const state = this.getLyricsState()
        if (state?.sourceKind === 'mp3' && state.filePath === `mp3://${audioPath}`) {
            const renderer = this.activeRenderers.get(state.filePath)
            if (renderer instanceof Mp3PlayerRender) {
                await renderer.onunload()
                this.activeRenderers.delete(state.filePath)
            }
            this.lastActiveRenderPath = null
            this.updateLyricsState(null)
        }
        await this.scanLyricSongs()
    }

    public getSongList(): LyricSong[] { return this.songList }

    public getNextSong(currentPath: string): LyricSong | null {
        if (this.songList.length === 0) return null
        // 裸 MP3 渲染器路径带 mp3:// 前缀，剥掉后再与歌单真实路径匹配
        const searchPath = currentPath.replace(/^mp3:\/\//, '')
        switch (this._playMode) {
            case 'single':
                return this.songList.find((s) => s.path === searchPath) || this.songList[0]
            case 'shuffle': {
                // 洗牌队列：整张歌单随机播完一遍后才重新洗牌，避免隔几首又重复同一首
                if (this.shuffleQueue.length === 0) {
                    this.buildShuffleQueue(searchPath)
                }
                return this.shuffleQueue.shift() ?? null
            }
            case 'sequential':
            case 'off':
            default: {
                const idx = this.songList.findIndex((s) => s.path === searchPath)
                if (idx === -1) return this.songList[0]
                return this.songList[(idx + 1) % this.songList.length]
            }
        }
    }

    public getPrevSong(currentPath: string): LyricSong | null {
        if (this.songList.length === 0) return null
        // 裸 MP3 渲染器路径带 mp3:// 前缀，剥掉后再与歌单真实路径匹配
        const searchPath = currentPath.replace(/^mp3:\/\//, '')
        switch (this._playMode) {
            case 'single':
                return this.songList.find((s) => s.path === searchPath) || this.songList[0]
            case 'shuffle': {
                const idx = this.songList.findIndex((s) => s.path === searchPath)
                if (this.songList.length === 1) return this.songList[0]
                let rand = idx
                while (rand === idx) {
                    rand = Math.floor(Math.random() * this.songList.length)
                }
                return this.songList[rand]
            }
            default: {
                const idx = this.songList.findIndex((s) => s.path === searchPath)
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
        this._playbackRate = this.getSettings().playbackRate ?? 1
        this._volume = this.getSettings().volume ?? 75
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
            if (this.leafChangeTimer !== null) clearTimeout(this.leafChangeTimer)
            this.leafChangeTimer = window.setTimeout(() => {
                this.leafChangeTimer = null
                const activeFile = this.app.workspace.getActiveFile()
                // 有歌正在播放时：侧边栏始终跟随正在播放的歌曲，
                // 打开/切换任意笔记都不把侧边栏切走（避免正在播放的歌词滚动被重载）
                const playingRenderer = this.lastActiveRenderPath
                    ? this.activeRenderers.get(this.lastActiveRenderPath)
                    : null
                if (playingRenderer && playingRenderer.player && !playingRenderer.player.paused()) {
                    playingRenderer.emitState()
                    return
                }
                // 无歌播放时：跟随当前笔记（保持原行为）
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
        // vault 事件防抖：新建/删除/改名高频触发时合并为一次重扫，避免频繁清缓存+全量重读标签
        this.registerEvent(this.app.vault.on('create', () => this.scheduleScan()))
        this.registerEvent(this.app.vault.on('delete', () => this.scheduleScan()))
        this.registerEvent(this.app.vault.on('rename', () => this.scheduleScan()))
    }

    /** 歌单重扫防抖：300ms 内多次事件只执行一次 */
    private scheduleScan() {
        if (this.scanTimer !== null) clearTimeout(this.scanTimer)
        this.scanTimer = window.setTimeout(() => {
            this.scanTimer = null
            void this.scanLyricSongs()
        }, 300)
    }

    async onunload() {
        if (this.scanTimer !== null) clearTimeout(this.scanTimer)
        if (this.leafChangeTimer !== null) clearTimeout(this.leafChangeTimer)
        if (this.saveVolumeTimer !== null) clearTimeout(this.saveVolumeTimer)
        // 停止所有裸 MP3 播放器：其宿主挂在 document.body 而非 Obsidian 视图，
        // 禁用插件不会自动触发 onunload，需显式暂停播放器并移除 DOM，否则音频继续播放
        for (const renderer of this.activeRenderers.values()) {
            if (renderer instanceof Mp3PlayerRender) {
                await renderer.onunload()
            }
        }
        this.stateListeners = []
        this.activeRenderers.clear()
        this.state = null
    }
}
