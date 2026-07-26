import { MarkdownRenderer, type App, type Component } from 'obsidian'
import {
    DEFAULT_LRC,
    type LyricsLine,
    AbstractLyricsRenderer,
} from 'renderers/renderer'

export default class LrcRenderer extends AbstractLyricsRenderer {
    static readonly LRC_SPLITTER = /\[(((\d+):)?(\d+):(\d+(\.\d+)?))\]/g

    constructor(app: App) {
        super(app)
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

                    // Extract annotation inside <...>
                    const annotationMatch = text.match(/<([^>]+)>/)
                    if (annotationMatch) {
                        cur.line.annotation = annotationMatch[1]
                        text = text.replace(/<[^>]+>/, '').trim()
                        cur.line.text = text
                    }

                    // Check for precise word timestamps: {seconds}word pattern
                    // e.g. {0.3}你{0.6}好{1.0}世{1.5}界
                    const preciseWordRegex = /\{(\d+(?:\.\d+)?)\}([^{<]+)/g
                    const preciseWords: { text: string; timestamp: number }[] = []
                    let match: RegExpExecArray | null
                    while ((match = preciseWordRegex.exec(text)) !== null) {
                        const relativeSec = parseFloat(match[1])
                        const wordText = match[2]
                        preciseWords.push({
                            text: wordText,
                            timestamp: (cur.line.timestamp || 0) + relativeSec * 1000,
                        })
                    }

                    if (preciseWords.length > 0) {
                        // Strip {seconds} markers from display text, keep only word text
                        cur.line.text = preciseWords.map(w => w.text).join('')
                        cur.line.words = preciseWords
                    } else {
                        // Fallback: auto-distribute timestamps across words
                        // Split: CJK/Hangul/Arabic/Devanagari/Thai/Tibetan individually,
                        // Latin/Cyrillic/Armenian/Georgian words, spaces preserved
                        const words = text.match(/[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff\ufe70-\ufeff\u0900-\u097f\u0e00-\u0e7f\u0f00-\u0fff\u4e00-\u9fff\u3400-\u4dbf\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af\u3130-\u318f]|[a-zA-Z0-9\u0400-\u04ff\u0530-\u058f\u10a0-\u10ff]+|\s+/g)
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
                // Extract precise word timestamps from {seconds} markers
                const preciseWordRegex = /\{(\d+(?:\.\d+)?)\}([^{<]+)/g
                const preciseWords: { text: string; timestamp: number }[] = []
                let match: RegExpExecArray | null
                while ((match = preciseWordRegex.exec(line.text)) !== null) {
                    const relativeSec = parseFloat(match[1])
                    preciseWords.push({
                        text: match[2],
                        timestamp: (line.timestamp || 0) + relativeSec * 1000,
                    })
                }
                if (preciseWords.length > 0) {
                    line.text = preciseWords.map(w => w.text).join('')
                    line.words = preciseWords
                }
                // Extract annotation <...>
                const annotationMatch = line.text.match(/<([^>]+)>/)
                if (annotationMatch) {
                    line.annotation = annotationMatch[1]
                    line.text = line.text.replace(/<[^>]+>/, '').trim()
                }
                results.push(line)
            }
        }
        return results
    }
}
