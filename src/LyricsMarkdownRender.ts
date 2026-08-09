import {
    MarkdownRenderChild,
    type App,
    type MarkdownPostProcessorContext,
    Menu,
    MarkdownView,
    TFile,
} from 'obsidian'
import Player from './Player.svelte'
import LyricsPlugin from 'main'
import LyricsRenderer from 'renderers'
import { extractEmbeddedLyrics, pickEmbeddedLyrics } from 'renderers/id3'
import type { LyricsLine } from 'renderers/renderer'

export default class LyricsMarkdownRender extends MarkdownRenderChild {
    static readonly AUDIO_FILE_REGEX = /^source (?<audio>.*)/i
    static readonly LYRICS_FILE_REGEX = /^lyrics (?<links>.*)/i
    static readonly EMBEDDED_LYRICS_REGEX = /^embedded-lyrics\s*$/i
    static readonly INTERNAL_LINK_REGEX = /\[\[(?<link>.*)\]\]/

    /** Check if path is an absolute Windows path (C:\...) */
    private static isWinAbsolute(p: string): boolean {
        return p.length >= 3 && p.charCodeAt(1) === 58 && (p.charCodeAt(2) === 92 || p.charCodeAt(2) === 47)
    }

    /** Read a local file as text using Node.js fs */
    private static readLocalText(filePath: string): string | null {
        try {
            const fs = (window as any).require('fs')
            return fs.readFileSync(filePath, 'utf-8')
        } catch {
            return null
        }
    }

    /** Read a local file as Buffer using Node.js fs（异步，不阻塞主线程） */
    private static async readLocalBinary(filePath: string): Promise<Buffer | null> {
        try {
            const fs = (window as any).require('fs')
            return await fs.promises.readFile(filePath)
        } catch {
            return null
        }
    }

    private static getAudioMime(ext: string): string {
        const mimeMap: Record<string, string> = {
            mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac',
            ogg: 'audio/ogg', aac: 'audio/aac', m4a: 'audio/mp4',
        }
        return mimeMap[ext] || 'audio/mpeg'
    }

    private audioPath?: string
    private lyricsFilePath?: string
    private audioBlobUrl = '' // 库外绝对路径音频的 Blob URL，onunload 时释放
    private source: string
    private app: App
    private container: HTMLElement
    public player?: Player
    private currentHL: number = -1
    public path: string
    private plugin: LyricsPlugin
    private lyricsRenderer: LyricsRenderer
    private pauseHl: boolean = false
    private sentenceMode: boolean

    private autoScroll: boolean
    private onlyShowMarked: boolean = false
    private karaoke: boolean
    private lyricsLines: LyricsLine[] = []

    constructor(
        plugin: LyricsPlugin,
        source: string,
        container: HTMLElement,
        ctx: MarkdownPostProcessorContext,
    ) {
        super(container)
        this.plugin = plugin
        this.app = plugin.app
        this.source = source
        this.container = container
        this.path = ctx.sourcePath
        this.autoScroll = this.plugin.getSettings().autoScroll
        this.sentenceMode = this.plugin.getSettings().sentenceMode
        this.onlyShowMarked = this.plugin.getSettings().onlyShowMarked
        this.karaoke = this.plugin.getSettings().karaoke
        this.lyricsRenderer = new LyricsRenderer(plugin.app)
    }

    private seek = (e: MouseEvent) => {
        let target = e.target as HTMLElement
        let time = target?.dataset?.time
        if (time !== undefined) {
            const sec = parseInt(time) / 1000
            this.updateTimestamp(sec, true)
            this.player?.seek(sec)
        }
    }

    /** Read the source audio file as binary, resolving its path the same way the player does. */
    private async readAudioBinary(): Promise<ArrayBuffer | Uint8Array | null> {
        if (!this.audioPath) return null

        const internalLink = this.audioPath.match(LyricsMarkdownRender.INTERNAL_LINK_REGEX)
        if (internalLink?.groups?.link) {
            const file = this.plugin.app.metadataCache.getFirstLinkpathDest(internalLink.groups.link, this.path)
            if (file instanceof TFile) {
                try { return await this.app.vault.readBinary(file) } catch { return null }
            }
        } else if (LyricsMarkdownRender.isWinAbsolute(this.audioPath)) {
            // Absolute path outside vault — read via Node.js fs
            return LyricsMarkdownRender.readLocalBinary(this.audioPath)
        } else {
            // Vault-relative path
            const file = this.app.vault.getAbstractFileByPath(this.audioPath)
            if (file instanceof TFile) {
                try { return await this.app.vault.readBinary(file) } catch { return null }
            }
        }
        return null
    }

    private lastTime: number = 0

    private updateTimestamp = (sec: number, seek: boolean = false) => {
        // Loop detection: time jumped backwards = song restarted
        if (sec < this.lastTime - 1) {
            // Clear all highlights
            const allLyrics = this.container.querySelectorAll('.lyrics-line[data-time]') as NodeListOf<HTMLElement>
            allLyrics.forEach((el) => el.removeClass('lyrics-highlighted'))
            this.currentHL = -1
            // Clear karaoke word highlights
            const allWords = this.container.querySelectorAll('.lyrics-word-active') as NodeListOf<HTMLElement>
            allWords.forEach((el) => el.removeClass('lyrics-word-active'))
        }
        this.lastTime = sec

        const lyrics = this.container.querySelectorAll(
            '.lyrics-line[data-time]',
        ) as NodeListOf<HTMLElement>

        let hl = this.binarySearch(lyrics, Math.round(sec * 1000))

        if (hl !== this.currentHL) {
            if (this.player) {
                if (
                    this.sentenceMode &&
                    !this.player.paused() &&
                    this.currentHL != -1 &&
                    !seek
                ) {
                    this.player.pause()
                    this.pauseHl = true
                }
            }
            this.currentHL = hl
        }

        this.emitState()

        if (!this.pauseHl) {
            // 对唱/合唱：同一时间戳对应多行歌词，全部作为当前行高亮
            let hlStart = hl
            let hlEnd = hl
            if (hl >= 0) {
                const t = lyrics.item(hl).dataset.time
                while (hlStart > 0 && lyrics.item(hlStart - 1).dataset.time === t) hlStart--
                while (hlEnd + 1 < lyrics.length && lyrics.item(hlEnd + 1).dataset.time === t) hlEnd++
            }

            //remove highlight and set past/future
            lyrics.forEach((el, index) => {
                el.removeClass('lyrics-highlighted')
                el.removeClass('lyrics-line-past')
                el.removeClass('lyrics-line-future')
                if (index < hlStart) {
                    el.addClass('lyrics-line-past')
                } else if (index > hlEnd) {
                    el.addClass('lyrics-line-future')
                }
            })

            if (hl >= 0) {
                // 高亮同一时间戳的所有行
                for (let i = hlStart; i <= hlEnd; i++) {
                    const hlel = lyrics.item(i)
                    if (hlel && !hlel.hasClass('lyrics-highlighted')) {
                        hlel.addClass('lyrics-highlighted')
                    }
                }
                if (this.autoScroll) {
                    lyrics.item(hlStart).scrollIntoView({
                        behavior: 'smooth',
                        block: 'center',
                    })
                }
                // Karaoke: highlight words up to current time
                if (this.karaoke) {
                    for (let i = hlStart; i <= hlEnd; i++) {
                        this.highlightWords(lyrics.item(i), sec)
                    }
                }
            }
        }
    }

    private highlightWords(lineEl: HTMLElement, sec: number) {
        const words = lineEl.querySelectorAll('.lyrics-word') as NodeListOf<HTMLElement>
        if (words.length === 0) return
        const timeMs = Math.round(sec * 1000)
        let currentIdx = -1
        words.forEach((word, i) => {
            const wt = parseInt(word.dataset.time || '0')
            if (wt <= timeMs) currentIdx = i
        })
        words.forEach((word, i) => {
            if (i <= currentIdx) {
                word.addClass('lyrics-word-active')
            } else {
                word.removeClass('lyrics-word-active')
            }
        })
    }

    private findParentData(element: HTMLElement | null) {
        while (element && element.className !== 'lyrics-wrapper') {
            if (element.dataset && element.dataset['offset']) {
                return {
                    time: element.dataset['time'],
                    offset: element.dataset['offset'],
                }
            }
            element = element.parentElement
        }
        return null
    }

    private contextMenu = (e: MouseEvent) => {
        let target = e.target as HTMLElement
        let data = this.findParentData(target)
        const menu = new Menu()

        menu.addItem((item) => {
            item.setTitle('播放')
                .setIcon('play')
                .onClick(async () => {
                    this.player?.play()
                })
        })

        menu.addItem((item) => {
            item.setTitle('暂停')
                .setIcon('pause')
                .onClick(async () => {
                    this.player?.pause()
                })
        })

        menu.addItem((item) =>
            item
                .setTitle('跳转到此时间')
                .setIcon('fast-forward')
                .onClick(() => {
                    if (data?.time) {
                        this.player?.seek(parseInt(data.time) / 1000)
                    }
                }),
        )

        menu.addItem((item) =>
            item
                .setTitle('编辑源码')
                .setIcon('edit')
                .onClick(async () => {
                    const view =
                        this.plugin.app.workspace.getActiveViewOfType(
                            MarkdownView,
                        )
                    if (view && data?.offset) {
                        const state = view.getState()
                        let [from, to] = data.offset.split(',')
                        state.mode = 'source'
                        await view.leaf.setViewState({
                            type: 'markdown',
                            state: state,
                        })
                        const lineCount = view.editor.lineCount()
                        let start = 0
                        for (let i = 0; i < lineCount; i++) {
                            const lineText = view.editor.getLine(i)
                            // NOTE: can only calculate the first lrc code block position
                            if (lineText.includes('```lrc')) {
                                start = i
                                break
                            }
                        }
                        let head = this.player ? 2 : 1
                        let lineFrom = head + parseInt(from) + start
                        let lineTo = head + parseInt(to) + start
                        let lineContent = view.editor.getLine(lineTo)
                        view.editor.focus()
                        view.editor.setCursor(lineFrom, 0)
                        view.editor.setSelection(
                            {
                                line: lineFrom,
                                ch: 0,
                            },
                            {
                                line: lineTo,
                                ch: lineContent.length,
                            },
                        )
                        view.editor.scrollIntoView(
                            {
                                from: {
                                    line: lineFrom,
                                    ch: 0,
                                },
                                to: {
                                    line: lineTo,
                                    ch: lineContent.length,
                                },
                            },
                            true,
                        )
                    }
                }),
        )

        menu.addItem((item) => {
            item.setTitle('复制时间戳')
                .setIcon('copy')
                .onClick(async () => {
                    const timestamp = this.player?.getTimeStamp() || 0
                    const hours = Math.floor(timestamp / 3600)
                    const hourStr =
                        hours == 0
                            ? ''
                            : hours < 10
                              ? `0${hours}:`
                              : `${hours}:`
                    const secmode = timestamp % 3600
                    const minutes = Math.floor(secmode / 60)
                    const minStr = minutes < 10 ? `0${minutes}` : `${minutes}`
                    const seconds = secmode % 60
                    const secStr =
                        seconds < 10
                            ? `0${seconds.toFixed(2)}`
                            : `${seconds.toFixed(2)}`
                    navigator.clipboard.writeText(
                        `[${hourStr}${minStr}:${secStr}]`,
                    )
                })
        })

        menu.addItem((item) => {
            item.setTitle('自动滚动')
                .setIcon('refresh-cw')
                .setChecked(this.autoScroll)
                .onClick(async () => {
                    const lyrics = this.container.querySelectorAll(
                        '.lyrics-line[data-time]',
                    ) as NodeListOf<HTMLElement>

                    if (lyrics.length > 0 && this.currentHL >= 0) {
                        lyrics.item(this.currentHL).scrollIntoView({
                            behavior: 'smooth',
                            block: 'center',
                        })
                    }
                    this.autoScroll = !this.autoScroll
                    this.plugin.updateSettings({ autoScroll: this.autoScroll })
                })
        })

        menu.addItem((item) => {
            item.setTitle('逐句模式')
                .setIcon('align-left')
                .setChecked(this.sentenceMode)
                .onClick(async () => {
                    this.sentenceMode = !this.sentenceMode
                    this.plugin.updateSettings({
                        sentenceMode: this.sentenceMode,
                    })
                })
        })

        menu.showAtMouseEvent(e)
    }

    private applyOnlyShowMarked() {
        if (this.onlyShowMarked) {
            this.container.addClass('lyrics-show-marked')
        } else {
            this.container.removeClass('lyrics-show-marked')
        }
    }

    private onSettingsChanged = () => {
        const newKaraoke = this.plugin.getSettings().karaoke
        if (newKaraoke !== this.karaoke) {
            this.karaoke = newKaraoke
            this.reloadLyrics()
        }
    }

    private async reloadLyrics() {
        const wrapper = this.container.querySelector('.lyrics-wrapper')
        if (!wrapper) return
        wrapper.innerHTML = ''
        this.currentHL = -1
        this.lastTime = 0

        // Try loading from external file first
        if (this.lyricsFilePath) {
            const file = this.plugin.app.metadataCache.getFirstLinkpathDest(this.lyricsFilePath, '')
            if (file && file instanceof TFile) {
                try {
                    const content = await this.app.vault.read(file)
                    this.lyricsRenderer.render(content, wrapper as HTMLDivElement, this.path, this, this.karaoke)
                    if (this.player) {
                        const sec = this.player.getTimeStamp()
                        this.updateTimestamp(sec, true)
                    }
                    return
                } catch {
                    // fallback to inline
                }
            }
        }

        // Lyrics already resolved during onload (embedded-in-MP3 or inline)
        if (this.effectiveLyricsContent) {
            this.lyricsRenderer.render(
                this.effectiveLyricsContent,
                wrapper as HTMLDivElement,
                this.path,
                this,
                this.karaoke,
            )
            if (this.player) {
                const sec = this.player.getTimeStamp()
                this.updateTimestamp(sec, true)
            }
            return
        }

        if (this.source.length > 0) {
            let eol = this.source.indexOf('\n')
            if (eol >= 0 && this.source.length > eol) {
                this.lyricsRenderer.render(
                    this.source.substring(eol + 1),
                    wrapper as HTMLDivElement,
                    this.path,
                    this,
                    this.karaoke,
                )
            }
        }

        // Re-apply highlight for current time
        if (this.player) {
            const sec = this.player.getTimeStamp()
            this.updateTimestamp(sec, true)
        }
    }

    async onload() {
        const lines = this.source.split('\n')
        let directiveEnd = 0
        let lyricsContent = ''

        // Pass 1: scan directive lines (source / lyrics) from top
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i]
            const sourceMatch = line.match(LyricsMarkdownRender.AUDIO_FILE_REGEX)
            const lyricsMatch = line.match(LyricsMarkdownRender.LYRICS_FILE_REGEX)

            if (sourceMatch) {
                this.audioPath = sourceMatch.groups?.audio
                directiveEnd = i + 1
            } else if (lyricsMatch?.groups?.links) {
                const rawPath = lyricsMatch.groups.links.trim()
                // Absolute path outside vault
                if (LyricsMarkdownRender.isWinAbsolute(rawPath)) {
                    const content = LyricsMarkdownRender.readLocalText(rawPath)
                    if (content !== null) {
                        lyricsContent = content
                        this.lyricsFilePath = rawPath
                    }
                } else {
                    // Internal link [[file.lrc]]
                    const link = rawPath.match(/\[\[(?<link>[^\]]+)\]\]/)?.groups?.link
                    if (link) {
                        const file = this.plugin.app.metadataCache.getFirstLinkpathDest(link, '')
                        if (file && file instanceof TFile) {
                            try {
                                lyricsContent = await this.app.vault.read(file)
                                this.lyricsFilePath = file.path
                            } catch { /* ignore */ }
                        }
                    }
                }
                directiveEnd = i + 1
            } else if (line.match(LyricsMarkdownRender.EMBEDDED_LYRICS_REGEX)) {
                // Legacy explicit directive: auto-detection now covers this, just skip the line
                directiveEnd = i + 1
            } else {
                break
            }
        }

        // Auto-detect: when there is no external lyrics file and no inline lyrics,
        // try reading lyrics embedded inside the audio file's ID3 tag (USLT frame)
        const inlineLyrics = lines.slice(directiveEnd).join('\n').trim()
        if (!lyricsContent && !inlineLyrics && this.audioPath) {
            const audioBuf = await this.readAudioBinary()
            if (audioBuf) {
                const picked = pickEmbeddedLyrics(extractEmbeddedLyrics(audioBuf))
                if (picked) lyricsContent = picked
            }
        }

        let fragment = new DocumentFragment()

        // Render player if audio source found
        if (this.audioPath) {
            const playerEl = fragment.createDiv()
            playerEl.addClass('player-wrapper')
            let src: string | null = null

            const internalLink = this.audioPath.match(
                LyricsMarkdownRender.INTERNAL_LINK_REGEX,
            )
            if (internalLink) {
                const link = internalLink.groups?.link
                if (link) {
                    const file =
                        this.plugin.app.metadataCache.getFirstLinkpathDest(link, '')
                    if (file) {
                        src = this.app.vault.getResourcePath(file)
                    }
                }
            } else if (LyricsMarkdownRender.isWinAbsolute(this.audioPath)) {
                // 库外绝对路径：异步读入 → Blob URL（避免 base64 内存膨胀约 2.7×）
                const buf = await LyricsMarkdownRender.readLocalBinary(this.audioPath)
                if (buf) {
                    const ext = this.audioPath.split('.').pop()?.toLowerCase() || 'mp3'
                    src = URL.createObjectURL(new Blob([buf], { type: LyricsMarkdownRender.getAudioMime(ext) }))
                    this.audioBlobUrl = src
                }
            } else {
                // Vault-relative path
                src = this.app.vault.adapter.getResourcePath(this.audioPath)
            }

            if (!src) {
                fragment.appendText(`Error: Invalid source ${this.audioPath}.`)
                this.container.append(fragment)
                return
            }

            this.player = new Player({
                target: playerEl,
                props: {
                    src,
                    timeupdate: this.updateTimestamp,
                    onPlay: () => { this.pauseHl = false },
                    onended: () => { this.plugin.handleSongEnded(this) },
                },
            })
            fragment.append(playerEl)
        }

        const div = fragment.createDiv()
        div.addEventListener('click', this.seek)
        div.addEventListener('contextmenu', this.contextMenu)
        div.className = 'lyrics-wrapper'

        // Render lyrics: external file > inline (from after directive lines)
        if (lyricsContent) {
            this.effectiveLyricsContent = lyricsContent
            this.lyricsRenderer.render(lyricsContent, div, this.path, this, this.karaoke)
        } else {
            const lyricsLines = lines.slice(directiveEnd).join('\n')
            if (lyricsLines.length > 0) {
                this.effectiveLyricsContent = lyricsLines
                this.lyricsRenderer.render(lyricsLines, div, this.path, this, this.karaoke)
            }
        }

        this.container.append(fragment)
        this.applyOnlyShowMarked()

        // Register with plugin for sidebar sync
        this.plugin.registerRenderer(this.path, this)
        this.plugin.onSettingsChange(this.onSettingsChanged)
        this.parseLyricsContent()
        this.emitState()
    }

    async onunload() {
        // Directly find and stop all <audio> elements in this component's DOM
        const audios = this.containerEl.querySelectorAll('audio') as NodeListOf<HTMLAudioElement>
        audios.forEach((audio) => {
            audio.pause()
            audio.removeAttribute('src')
            audio.load()
        })
        // 释放库外音频的 Blob URL，回收内存
        if (this.audioBlobUrl) {
            URL.revokeObjectURL(this.audioBlobUrl)
            this.audioBlobUrl = ''
        }
        this.plugin.unregisterRenderer(this.path)
        this.plugin.removeSettingsListener(this.onSettingsChanged)
        this.plugin.updateLyricsState(null)
    }

    private effectiveLyricsContent: string = ''

    private parseLyricsContent() {
        if (this.effectiveLyricsContent) {
            this.lyricsLines = this.lyricsRenderer.parse(this.effectiveLyricsContent)
        }
    }

    public emitState() {
        const file = this.app.vault.getAbstractFileByPath(this.path)
        const cache = file instanceof TFile ? this.app.metadataCache.getFileCache(file) : null
        this.plugin.updateLyricsState({
            filePath: this.path,
            lyrics: this.lyricsLines,
            currentIndex: this.currentHL,
            isPlaying: this.player ? !this.player.paused() : false,
            currentTime: this.player?.getTimeStamp() || 0,
            karaoke: this.karaoke,
            // v2: 从笔记 frontmatter 获取
            title: cache?.frontmatter?.['title'],
            actor: cache?.frontmatter?.['actor'],
            duration: this.player?.getDuration() || 0,
        })
    }

    private binarySearch(arr: NodeListOf<HTMLElement>, time: number): number {
        let left = 0
        let right = arr.length - 1

        while (left <= right) {
            const mid = left + Math.floor((right - left) / 2)
            let mt = Number(arr.item(mid).dataset.time!)

            if (mt == time) {
                return mid
            } else if (mt < time) {
                if (mid < arr.length - 1) {
                    let next = Number(arr.item(mid + 1).dataset.time!)
                    if (next > time) {
                        return mid
                    } else {
                        left = mid + 1
                    }
                } else {
                    return arr.length - 1
                }
            } else if (mt > time) {
                if (mid >= 1) {
                    let prev = Number(arr.item(mid - 1).dataset.time!)
                    if (prev <= time) {
                        return mid - 1
                    } else {
                        right = mid - 1
                    }
                } else {
                    return mid
                }
            }
        }
        return -1
    }
}
