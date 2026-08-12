import type { LyricsLine } from 'renderers/renderer'

/**
 * 把 LyricsLine[] 序列化为标准 LRC 文本。
 * 时间戳统一为 `mm:ss.xx`（小时存在时 `hh:mm:ss.xx`），
 * annotation 以 `原文 | 译文` 形式拼回，保证编辑后注释不丢。
 */
export function serializeLrc(lines: LyricsLine[]): string {
    const parts: string[] = []
    for (const line of lines) {
        if (line.timestamp === undefined) {
            const text = line.annotation
                ? `${line.text} | ${line.annotation}`
                : line.text
            if (text.trim()) parts.push(text)
            continue
        }
        const ts = formatLrcTimestamp(line.timestamp)
        const text = line.annotation
            ? `${line.text} | ${line.annotation}`
            : line.text
        if (text.trim()) parts.push(`[${ts}]${text}`)
    }
    return parts.join('\n')
}

/** 毫秒 → `mm:ss.xx`（超过 1 小时 → `hh:mm:ss.xx`） */
export function formatLrcTimestamp(ms: number): string {
    const totalCs = Math.round(Math.max(0, ms) / 10) // 厘秒，四舍五入
    const cs = totalCs % 100
    const totalSec = Math.floor(totalCs / 100)
    const h = Math.floor(totalSec / 3600)
    const m = Math.floor((totalSec % 3600) / 60)
    const s = totalSec % 60
    const mm = String(m).padStart(2, '0')
    const ss = `${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`
    return h > 0 ? `${String(h).padStart(2, '0')}:${mm}:${ss}` : `${mm}:${ss}`
}
