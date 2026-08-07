/**
 * Minimal ID3v2 tag parser.
 *
 * Extracts "unsynchronized lyrics" (USLT / ULT frames) from an MP3 file so
 * that lyrics embedded in the audio itself can be displayed directly.
 * Zero external dependencies — works on both desktop and mobile.
 */

/** Read a syncsafe integer (each byte uses only 7 bits). */
function readSyncsafe(bytes: Uint8Array, offset: number, count: number): number {
    let value = 0
    for (let i = 0; i < count; i++) {
        value = (value << 7) | (bytes[offset + i] & 0x7f)
    }
    return value
}

/** Read a plain big-endian integer. */
function readBE(bytes: Uint8Array, offset: number, count: number): number {
    let value = 0
    for (let i = 0; i < count; i++) {
        value = (value << 8) | (bytes[offset + i] & 0xff)
    }
    return value
}

/** Undo ID3 unsynchronisation: `0xFF 0x00` → `0xFF`. */
function deunsync(data: Uint8Array): Uint8Array {
    const out: number[] = []
    for (let i = 0; i < data.length; i++) {
        out.push(data[i])
        if (data[i] === 0xff && i + 1 < data.length && data[i + 1] === 0x00) {
            i++
        }
    }
    return new Uint8Array(out)
}

/** Whether `len` consecutive zero bytes start at `pos`. */
function isTerminator(data: Uint8Array, pos: number, len: number): boolean {
    for (let i = 0; i < len; i++) {
        if (data[pos + i] !== 0) return false
    }
    return true
}

/**
 * Decode text according to the ID3 text-encoding byte.
 * Encoding 0 is nominally ISO-8859-1, but many tools actually store GBK/GB2312
 * bytes there, so we try UTF-8 → GBK → Latin-1 in order.
 */
function decodeText(bytes: Uint8Array, encoding: number): string {
    try {
        if (encoding === 3) return new TextDecoder('utf-8').decode(bytes)
        if (encoding === 1) return new TextDecoder('utf-16').decode(bytes)
        if (encoding === 2) return new TextDecoder('utf-16be').decode(bytes)
        // encoding 0
        try {
            return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
        } catch {
            try {
                return new TextDecoder('gbk').decode(bytes)
            } catch {
                return new TextDecoder('latin1').decode(bytes)
            }
        }
    } catch {
        return ''
    }
}

/**
 * Parse a single lyrics frame (after its header).
 * Format: `[encoding(1)] [language(3)] [content descriptor \0] [lyrics]`
 */
function parseLyricsFrame(data: Uint8Array): string | null {
    if (data.length < 4) return null
    const encoding = data[0]
    const termLen = encoding === 1 || encoding === 2 ? 2 : 1
    let pos = 4 // skip encoding + language
    while (pos + termLen <= data.length) {
        if (isTerminator(data, pos, termLen)) break
        pos++
    }
    pos += termLen
    if (pos >= data.length) return null
    const text = decodeText(data.subarray(pos), encoding).trim()
    return text ? text : null
}

/**
 * Extract embedded lyrics (USLT / ULT frames) from an MP3's ID3v2 tag.
 * Returns the raw frame texts (there may be several, e.g. one per language).
 * Returns an empty array when no lyrics are found or the tag isn't parseable.
 */
export function extractEmbeddedLyrics(input: ArrayBuffer | Uint8Array): string[] {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
    if (bytes.length < 10) return []
    // "ID3" magic
    if (bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return []

    const major = bytes[3]
    const flags = bytes[5]
    const tagSize = readSyncsafe(bytes, 6, 4)
    let tagData = bytes.slice(10, Math.min(10 + tagSize, bytes.length))

    // Undo tag-level unsynchronisation
    if ((flags & 0x80) !== 0) tagData = deunsync(tagData)

    const lyrics: string[] = []
    let offset = 0

    // Skip the extended header, if present
    if ((flags & 0x40) !== 0) {
        if (major >= 4) {
            const extSize = readSyncsafe(tagData, offset, 4)
            offset += 4 + extSize
        } else {
            const extSize = readBE(tagData, offset, 4)
            offset += 4 + extSize
        }
    }

    while (offset + 6 <= tagData.length) {
        let frameId = ''
        for (let i = 0; i < 4 && offset + i < tagData.length; i++) {
            frameId += String.fromCharCode(tagData[offset + i])
        }

        let frameSize = 0
        let frameHeaderSize = 10
        if (major === 2) {
            // v2.2: 3-byte id + 3-byte big-endian size
            frameId = frameId.substring(0, 3)
            frameSize = readBE(tagData, offset + 3, 3)
            frameHeaderSize = 6
        } else if (major >= 3) {
            frameSize = major === 3
                ? readBE(tagData, offset + 4, 4)
                : readSyncsafe(tagData, offset + 4, 4)
        } else {
            break // unsupported major version
        }

        const contentStart = offset + frameHeaderSize
        const contentEnd = contentStart + frameSize
        if (contentEnd > tagData.length) break

        let frameData = tagData.slice(contentStart, contentEnd)

        // v2.4 frame format flags: compression / encryption are unsupported here
        if (major === 4) {
            const fmt = tagData[offset + 9]
            if (fmt & 0x20) { offset = contentEnd; continue } // compressed
            if (fmt & 0x10) { offset = contentEnd; continue } // encrypted
            if (fmt & 0x40) frameData = frameData.subarray(1) // grouping identity byte
            if (fmt & 0x04) frameData = frameData.subarray(4) // data length indicator
            if (fmt & 0x08) frameData = deunsync(frameData)
        }

        const isLyric = major === 2 ? frameId === 'ULT' : frameId === 'USLT'
        if (isLyric) {
            const text = parseLyricsFrame(frameData)
            if (text) lyrics.push(text)
        }

        offset = contentEnd
    }

    return lyrics
}

/** Pick the most useful lyrics frame: prefer one that looks like LRC. */
export function pickEmbeddedLyrics(frames: string[]): string {
    if (frames.length === 0) return ''
    for (const text of frames) {
        if (/\[\d{1,2}:\d{2}/.test(text)) return text
    }
    return frames[0]
}
