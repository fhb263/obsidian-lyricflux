import { Notice, type App, type TFile } from 'obsidian'
import Player from './Player.svelte'
import type LyricsPlugin from 'main'
import { extractEmbeddedLyrics, pickEmbeddedLyrics } from 'renderers/id3'
import { extractFlacLyrics } from 'renderers/vorbis'
import { extractMp4Lyrics } from 'renderers/mp4'
import { extractOggLyrics } from 'renderers/ogg'
import type { LyricsLine } from 'renderers/renderer'
import LyricsRenderer from 'renderers'
import { detectAudioContainer } from 'songScanner'

interface Mp3AudioSource {
    type: 'vault' | 'external'
    file?: TFile
    path?: string
}

/**
 * 裸 MP3 虚拟渲染器：不依赖 .md 笔记，直接挂载播放器播放音频。
 * 有内嵌 LRC 歌词则解析显示，无则空态（LyricsState.sourceKind='mp3'）。
 * 注册进 activeRenderers 复用切歌/侧边栏/状态同步机制。
 */
export default class Mp3PlayerRender {
    public path: string
    public player?: Player
    private plugin: LyricsPlugin
    private app: App
    private audioSource: Mp3AudioSource
    private lyricsLines: LyricsLine[] = []
    private lyricsRenderer: LyricsRenderer
    private hostEl: HTMLElement
    private audioBlobUrl = ''
    private title = ''
    private actor = ''
    private destroyed = false
    /** 上次读取内嵌歌词时的文件修改时间（外部改动检测用） */
    private lastLoadedMtime = 0
    /** 当前高亮行索引（timeupdate 时二分定位，供侧边栏滚动/高亮） */
    private currentHL = -1

    constructor(plugin: LyricsPlugin, path: string, audioSource: Mp3AudioSource) {
        this.plugin = plugin
        this.app = plugin.app
        this.path = path
        this.audioSource = audioSource
        this.lyricsRenderer = new LyricsRenderer(plugin.app)
        this.hostEl = document.body.createDiv({ cls: 'lyrics-mp3-host' })
        // 宿主隐藏，避免页面出现空白 div
        this.hostEl.style.display = 'none'
    }

    /** 初始化：读内嵌歌词 → 挂载播放器 → 注册 → emitState */
    async init() {
        const lyrics = await this.readEmbeddedLyrics()
        if (lyrics) {
            this.lyricsLines = this.lyricsRenderer.parse(lyrics)
        }
        const playerEl = this.hostEl.createDiv({ cls: 'player-wrapper' })
        const src = await this.resolvePlayableUrl()
        if (src) {
            this.player = new Player({
                target: playerEl,
                props: {
                    src,
                    timeupdate: (t: number) => { this.updateHighlight(t); this.emitState() },
                    onPlay: () => { this.plugin.markPlayerActive(this.path); this.emitState() },
                    onPause: () => { this.plugin.onRendererPaused(this.path) },
                    onended: () => { this.plugin.handleSongEnded(this) },
                },
            })
        }
        this.plugin.registerRenderer(this.path, this)
        this.emitState()
    }

    /** 读音频内嵌歌词（USLT 帧），并记录文件修改时间供外部改动检测 */
    private async readEmbeddedLyrics(): Promise<string | null> {
        try {
            let buf: ArrayBuffer | Uint8Array | null = null
            let mtime = 0
            if (this.audioSource.type === 'vault' && this.audioSource.file) {
                mtime = this.audioSource.file.stat.mtime
                buf = await this.app.vault.readBinary(this.audioSource.file)
            } else if (this.audioSource.type === 'external' && this.audioSource.path) {
                const fs = (window as any).require('fs')
                const st = await fs.promises.stat(this.audioSource.path)
                mtime = st.mtimeMs
                buf = await fs.promises.readFile(this.audioSource.path)
            }
            if (!buf) return null
            this.lastLoadedMtime = mtime
            const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
            const id3Lyrics = pickEmbeddedLyrics(extractEmbeddedLyrics(b))
            if (id3Lyrics) return id3Lyrics
            // FLAC / M4A / OGG：ID3 读不到，按容器逐一解析内嵌歌词
            const flacLyrics = extractFlacLyrics(b)
            if (flacLyrics) return flacLyrics
            const m4aLyrics = extractMp4Lyrics(b)
            if (m4aLyrics) return m4aLyrics
            return extractOggLyrics(b)
        } catch {
            return null
        }
    }

    /** 生成可播放 URL。检测真实容器：M4A 伪 mp3 用 audio/mp4 并提示，避免「有歌名但进度不动」。 */
    private async resolvePlayableUrl(): Promise<string> {
        if (this.audioSource.type === 'external' && this.audioSource.path) {
            const fs = (window as any).require('fs')
            const buf: Buffer = await fs.promises.readFile(this.audioSource.path)
            const mime = this.pickAudioMime(new Uint8Array(buf))
            if (mime !== 'audio/mpeg') {
                new Notice(`该文件实为 ${mime === 'audio/mp4' ? 'M4A/AAC' : mime.split('/')[1].toUpperCase()} 格式，已按实际格式播放`, 6000)
            }
            this.audioBlobUrl = URL.createObjectURL(new Blob([buf], { type: mime }))
            return this.audioBlobUrl
        }
        if (this.audioSource.type === 'vault' && this.audioSource.file) {
            // vault 内文件：读字节检测真实容器，M4A 伪 mp3 需 Blob（audio/mp4），否则用资源路径
            try {
                const bin = await this.app.vault.readBinary(this.audioSource.file)
                const mime = this.pickAudioMime(new Uint8Array(bin))
                if (mime !== 'audio/mpeg') {
                    new Notice(`该文件实为 ${mime === 'audio/mp4' ? 'M4A/AAC' : mime.split('/')[1].toUpperCase()} 格式，已按实际格式播放`, 6000)
                    this.audioBlobUrl = URL.createObjectURL(new Blob([bin], { type: mime }))
                    return this.audioBlobUrl
                }
            } catch { /* 读失败回退资源路径 */ }
            return this.app.vault.getResourcePath(this.audioSource.file)
        }
        return ''
    }

    /** 按文件头魔数选 MIME：标准 MPEG 帧/ID3 → audio/mpeg；M4A → audio/mp4；FLAC/OGG 对应；未知按扩展名兜底 mp3 */
    private pickAudioMime(bytes: Uint8Array): string {
        const container = detectAudioContainer(bytes)
        switch (container) {
            case 'm4a': return 'audio/mp4'
            case 'flac': return 'audio/flac'
            case 'ogg': return 'audio/ogg'
            default: return 'audio/mpeg'
        }
    }

    /** 设置展示用元数据（来自歌单富化后的标签），供状态栏显示 */
    public setMetadata(title: string, actor: string) {
        this.title = title
        this.actor = actor
    }

    /** 标签编辑后实时重读内嵌歌词并刷新侧边栏/状态栏（按当前播放位置对齐新歌词） */
    public async reloadLyrics() {
        const lyrics = await this.readEmbeddedLyrics()
        this.lyricsLines = lyrics ? this.lyricsRenderer.parse(lyrics) : []
        this.currentHL = -1
        const t = this.player?.getTimeStamp() ?? 0
        this.updateHighlight(t)
        this.emitState()
    }

    /** 外部改动 MP3 文件后检测 mtime 变化，有变化才重读内嵌歌词（避免每次重扫都全量读文件） */
    public async reloadLyricsIfChanged(): Promise<boolean> {
        let mtime = 0
        try {
            if (this.audioSource.type === 'vault' && this.audioSource.file) {
                mtime = this.audioSource.file.stat.mtime
            } else if (this.audioSource.type === 'external' && this.audioSource.path) {
                const fs = (window as any).require('fs')
                const st = await fs.promises.stat(this.audioSource.path)
                mtime = st.mtimeMs
            }
        } catch {
            return false
        }
        if (mtime <= this.lastLoadedMtime) return false
        await this.reloadLyrics()
        return true
    }

    /** 播放中按当前时间二分定位歌词行，供侧边栏当前行滚动/高亮 */
    private updateHighlight(sec: number) {
        const timeMs = Math.round(sec * 1000)
        let lo = 0
        let hi = this.lyricsLines.length - 1
        let result = -1
        while (lo <= hi) {
            const mid = lo + Math.floor((hi - lo) / 2)
            const t = this.lyricsLines[mid].timestamp ?? 0
            if (t <= timeMs) {
                result = mid
                lo = mid + 1
            } else {
                hi = mid - 1
            }
        }
        this.currentHL = result
    }

    public emitState() {
        if (this.destroyed) return
        // 有歌在播时仅播放中的渲染器可发状态（与笔记渲染器一致，避免抢占/闪烁）
        if (!this.plugin.isStateSource(this.path)) return
        this.plugin.updateLyricsState({
            filePath: this.path,
            lyrics: this.lyricsLines,
            currentIndex: this.currentHL,
            isPlaying: this.player ? !this.player.paused() : false,
            currentTime: this.player?.getTimeStamp() || 0,
            karaoke: this.plugin.getSettings().karaoke,
            title: this.title || undefined,
            actor: this.actor || undefined,
            duration: this.player?.getDuration() || 0,
            sourceKind: 'mp3',
        })
    }

    async onunload() {
        this.destroyed = true
        if (this.player) this.player.pause()
        if (this.audioBlobUrl) {
            URL.revokeObjectURL(this.audioBlobUrl)
            this.audioBlobUrl = ''
        }
        this.hostEl.remove()
        this.plugin.unregisterRenderer(this.path)
    }
}
