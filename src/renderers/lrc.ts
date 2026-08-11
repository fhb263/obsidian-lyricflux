import { MarkdownRenderer, type App, type Component } from 'obsidian'
import {
    DEFAULT_LRC,
    type LyricsLine,
    AbstractLyricsRenderer,
} from 'renderers/renderer'
import { WORD_SPLIT_REGEX } from './wordSplitter'

export default class LrcRenderer extends AbstractLyricsRenderer {
    static readonly LRC_SPLITTER = /\[(((\d+):)?(\d+):(\d+(\.\d+)?))\]/g

    constructor(app: App) {
        super(app)
    }

    /** 把 `mm:ss.xx`（或 `hh:mm:ss.xx`）解析为秒；无效返回 NaN */
    private static parseClock(t: string): number {
        const parts = t.split(':')
        if (parts.length === 2) return parseInt(parts[0], 10) * 60 + parseFloat(parts[1])
        if (parts.length === 3) return parseInt(parts[0], 10) * 3600 + parseInt(parts[1], 10) * 60 + parseFloat(parts[2])
        return NaN
    }

    /**
     * 提取逐字时间标记，返回 { 显示文本, 逐字数组 }；无任何标记返回 null。
     * 仅支持主流增强 LRC 的 `<mm:ss.xx>` 绝对时间语法。
     */
    private static extractPreciseWords(
        text: string,
    ): { text: string; words: { text: string; timestamp: number }[] } | null {
        const re = /<(\d{1,2}:\d{2}(?:\.\d+)?)>([^<]*)/g
        const words: { text: string; timestamp: number }[] = []
        let display = ''
        let m: RegExpExecArray | null
        while ((m = re.exec(text)) !== null) {
            const sec = LrcRenderer.parseClock(m[1])
            if (!isFinite(sec)) continue
            display += m[2]
            words.push({ text: m[2], timestamp: Math.round(sec * 1000) })
        }
        if (words.length > 0) return { text: display, words }
        return null
    }

    /**
     * 提取双语注释：用竖线 `原文 | 译文` 分隔。
     * 竖线两边都非空才视为双语，避免误判歌词中孤立的 `|`；多个 `|` 取最后一个作分隔，保留原文中的 `|`。
     * 逐字时间戳 `<mm:ss.xx>` 不在此处理，由 extractPreciseWords 解析。
     */
    private static extractAnnotation(text: string): { text: string; annotation?: string } {
        const pipe = text.lastIndexOf('|')
        if (pipe >= 0) {
            const before = text.slice(0, pipe).trim()
            const after = text.slice(pipe + 1).trim()
            if (before && after) {
                return { text: before, annotation: after }
            }
        }
        return { text }
    }

    public match(content: string): number {
        const s = content.split(LrcRenderer.LRC_SPLITTER)
        s.shift()
        return this.chunk(s, 7).length
    }

    public async render(
        content: string,
        container: HTMLDivElement,
        path: string,
        component: Component,
        karaoke?: boolean,
    ) {
        let s = content.split(LrcRenderer.LRC_SPLITTER)
        if (s.length > 0) {
            let from = 0
            let head = s.shift()
            if (head) {
                from += head.split(/\r?\n/g).length - 1
                await MarkdownRenderer.render(
                    this.app, head, container, path, component,
                )
            }
            let lines = this.chunk(s, 7)

            // Pass 1: parse all lines
            let parsed: { line: LyricsLine; from: number; to: number }[] = []
            for (const parts of lines) {
                let lrcLine = this.parseLrc(parts)
                let to = from + lrcLine.rows - 1
                parsed.push({ line: lrcLine, from, to })
                from = to + 1
            }

            // Pass 2: auto-generate word timestamps (only when karaoke enabled)
            if (karaoke) {
                for (let i = 0; i < parsed.length; i++) {
                    const cur = parsed[i]
                    let text = cur.line.text.trim()
                    if (!text) continue

                    // Extract bilingual annotation: `原文 | 译文`
                    const extracted = LrcRenderer.extractAnnotation(text)
                    if (extracted.annotation) {
                        cur.line.annotation = extracted.annotation
                        cur.line.text = extracted.text
                        text = extracted.text
                    }

                    // Precise word timestamps: 主流 <mm:ss.xx>（绝对时间）
                    const precise = LrcRenderer.extractPreciseWords(text)
                    if (precise && precise.words.length > 0) {
                        // Strip markers from display text, keep only word text
                        cur.line.text = precise.text
                        cur.line.words = precise.words
                    } else {
                        // Fallback: auto-distribute timestamps across words
                        // Split: CJK/Hangul/Arabic/Devanagari/Thai/Tibetan individually,
                        // Latin/Cyrillic/Armenian/Georgian words, spaces preserved
                        const words = text.match(WORD_SPLIT_REGEX)
                        if (!words || words.length === 0) continue

                        const start = cur.line.timestamp || 0
                        const end = (i + 1 < parsed.length)
                            ? (parsed[i + 1].line.timestamp || start + 3000)
                            : start + 3000
                        const perWord = (end - start) / words.length

                        cur.line.words = words.map((w, j) => ({
                            text: w,
                            timestamp: start + j * perWord,
                        }))
                    }
                }
            }

            // Pass 3: render
            let mdEl: HTMLSpanElement[] = await Promise.all(
                parsed.map(({ line, from, to }) =>
                    karaoke && line.words
                        ? this.renderKaraokeLine(container, line, from, to, path, component)
                        : this.renderLine(container, line, from, to, path, component),
                ),
            )
            container.append(...mdEl)
        }
    }

    private parseLrc(parts: string[]): LyricsLine {
        const lrc: LyricsLine = { ...DEFAULT_LRC }

        try {
            let hours = parts[2] ? parseInt(parts[2], 10) : 0
            let minutes = parts[3] ? parseInt(parts[3], 10) : 0
            let seconds = parts[4] ? parseFloat(parts[4]) : 0

            const timestamp = hours * 3600 + minutes * 60 + seconds

            const inMin = Math.floor(timestamp / 60)
            const inSec = Math.floor(timestamp % 60)

            const minStr = inMin < 10 ? `0${inMin}` : `${inMin}`
            const secStr = inSec < 10 ? `0${inSec}` : `${inSec}`
            const text = parts[6] ? parts[6].trim() : ''
            let rows = parts[6].split(/\r?\n/g).length - 1
            return {
                timestamp: timestamp * 1000,
                timestr: `${minStr}:${secStr}`, //normalize the time string
                text,
                rows,
            }
        } catch {
            return lrc
        }
    }

    public parse(content: string): LyricsLine[] {
        const lines = content.split(LrcRenderer.LRC_SPLITTER)
        lines.shift()
        const results: LyricsLine[] = []
        for (const parts of this.chunk(lines, 7)) {
            const line = this.parseLrc(parts)
            if (line.text) {
                // Extract bilingual annotation: `原文 | 译文`
                const extracted = LrcRenderer.extractAnnotation(line.text)
                if (extracted.annotation) {
                    line.annotation = extracted.annotation
                    line.text = extracted.text
                }
                // Precise word timestamps: 主流 <mm:ss.xx>（绝对时间）
                const precise = LrcRenderer.extractPreciseWords(line.text)
                if (precise && precise.words.length > 0) {
                    line.text = precise.text
                    line.words = precise.words
                }
                results.push(line)
            }
        }
        return results
    }
}
