import { MarkdownRenderer, type App, type Component } from 'obsidian'
import chunk from 'lodash/chunk'

export type LyricsWord = {
    text: string
    timestamp: number // milliseconds
}

export type LyricsLine = {
    timestamp?: number // milliseconds
    timestr?: string
    text: string
    rows: number
    words?: LyricsWord[]
    annotation?: string // text inside <...>, no karaoke
}

export const DEFAULT_LRC: LyricsLine = {
    text: '',
    timestr: '',
    rows: 1,
}

export abstract class AbstractLyricsRenderer {
    protected app: App

    protected chunk = chunk

    constructor(app: App) {
        this.app = app
    }

    public abstract match(content: string): number

    protected async renderLine(
        container: HTMLDivElement,
        line: LyricsLine,
        from: number,
        to: number,
        path: string,
        component: Component,
    ): Promise<HTMLElement> {
        const lineEl = container.createSpan()

        if (line) {
            lineEl.addClass('lyrics-line')
            lineEl.dataset.offset = `${from},${to}`
            const timeEl = lineEl.createSpan()
            timeEl.setText(line.timestr || '')
            timeEl.addClass('lyrics-timestamp')
            timeEl.dataset.offset = `${from},${to}`
            if (line.timestamp !== undefined) {
                const millis = Math.floor(line.timestamp)
                timeEl.dataset.time = `${millis}`
                lineEl.dataset.time = `${millis}`
            }
            const text = lineEl.createDiv()
            text.addClass('lyrics-text')

            // Bilingual support: <annotation> shown as secondary, no karaoke
            if (line.annotation) {
                await MarkdownRenderer.render(this.app, line.text, text, path, component)
                if (line.annotation) {
                    const sec = text.createDiv()
                    sec.addClass('lyrics-lang-secondary')
                    await MarkdownRenderer.render(this.app, line.annotation, sec, path, component)
                }
            } else {
                await MarkdownRenderer.render(this.app, line.text, text, path, component)
            }

            const mark = lineEl.find('mark')
            lineEl.dataset.mark = mark ? 'true' : 'false'
        }

        return lineEl
    }

    public abstract render(
        content: string,
        container: HTMLDivElement,
        path: string,
        component: Component,
        karaoke?: boolean,
    ): Promise<void>

    protected async renderKaraokeLine(
        container: HTMLDivElement,
        line: LyricsLine,
        from: number,
        to: number,
        path: string,
        component: Component,
    ): Promise<HTMLElement> {
        const lineEl = container.createSpan()
        if (line) {
            lineEl.addClass('lyrics-line')
            lineEl.dataset.offset = `${from},${to}`
            // Timestamp
            const timeEl = lineEl.createSpan()
            timeEl.setText(line.timestr || '')
            timeEl.addClass('lyrics-timestamp')
            timeEl.dataset.offset = `${from},${to}`
            if (line.timestamp !== undefined) {
                const millis = Math.floor(line.timestamp)
                timeEl.dataset.time = `${millis}`
                lineEl.dataset.time = `${millis}`
            }
            const text = lineEl.createDiv()
            text.addClass('lyrics-text')
            text.addClass('lyrics-karaoke')

            if (line.words && line.words.length > 0) {
                // Primary language: word-by-word karaoke
                for (const word of line.words) {
                    const wordEl = text.createSpan({
                        cls: 'lyrics-word',
                        text: word.text,
                    })
                    wordEl.dataset.time = `${Math.floor(word.timestamp)}`
                }
            } else {
                await MarkdownRenderer.render(this.app, line.text, text, path, component)
            }

            // Always show annotation (plain text, no karaoke)
            if (line.annotation) {
                const secEl = text.createDiv({ cls: 'lyrics-lang-secondary' })
                secEl.setText(line.annotation)
            }
            const mark = lineEl.find('mark')
            lineEl.dataset.mark = mark ? 'true' : 'false'
        }
        return lineEl
    }

}
