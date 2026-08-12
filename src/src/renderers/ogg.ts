import { readUInt32LE, decodeUtf8 } from './vorbis'

export interface OggTags {
    title?: string
    artist?: string
    album?: string
    year?: string
    lyrics?: string
    genre?: string
}

/** 在字节流中查找 pattern（子字节序列），返回起始索引，未找到返回 -1 */
function indexOfBytes(haystack: Uint8Array, needle: number[], from = 0): number {
    outer: for (let i = from; i + needle.length <= haystack.length; i++) {
        for (let j = 0; j < needle.length; j++) {
            if (haystack[i + j] !== needle[j]) continue outer
        }
        return i
    }
    return -1
}

/** 拼接 Ogg 流前若干页的 payload 数据（覆盖 identification + comment 头即可），最多 64 页/500KB */
function concatOggData(b: Uint8Array): Uint8Array {
    const parts: number[] = []
    let offset = 0
    let guard = 0
    while (offset + 27 <= b.length && guard < 64) {
        if (b[offset] !== 0x4f || b[offset + 1] !== 0x67 || b[offset + 2] !== 0x67 || b[offset + 3] !== 0x53) break // 'OggS'
        const pageSegments = b[offset + 26]
        const segTable = b.slice(offset + 27, offset + 27 + pageSegments)
        const dataStart = offset + 27 + pageSegments
        let segTotal = 0
        for (let i = 0; i < pageSegments; i++) segTotal += segTable[i]
        for (let i = 0; i < segTotal && dataStart + i < b.length; i++) parts.push(b[dataStart + i])
        offset = dataStart + segTotal
        guard++
        if (parts.length > 500000) break
    }
    return new Uint8Array(parts)
}

/** 解析 Vorbis/Opus comment 结构：vendor 长度(LE u32)+vendor+评论数(LE u32)+评论列表("KEY=value") */
function parseComments(data: Uint8Array, start: number): Map<string, string> {
    const map = new Map<string, string>()
    let p = start
    if (p + 4 > data.length) return map
    const vendorLen = readUInt32LE(data, p)
    p += 4 + vendorLen
    if (p + 4 > data.length) return map
    const count = readUInt32LE(data, p)
    p += 4
    for (let i = 0; i < count; i++) {
        if (p + 4 > data.length) break
        const clen = readUInt32LE(data, p)
        p += 4
        if (p + clen > data.length) break
        const comment = decodeUtf8(data.slice(p, p + clen))
        p += clen
        const eq = comment.indexOf('=')
        if (eq > 0) {
            map.set(comment.slice(0, eq).trim().toUpperCase(), comment.slice(eq + 1))
        }
    }
    return map
}

/** 从 OGG 字节流解析 Vorbis/Opus comment 标签（jsmediatags 不支持 OGG）。非 OGG/无 comment 返回 null。 */
export function extractOggTags(bytes: Uint8Array | ArrayBuffer): OggTags | null {
    try {
        const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
        if (b.length < 27) return null
        const data = concatOggData(b)
        // Vorbis comment 头：0x03 'vorbis'；Opus：'OpusTags'
        const vorbisIdx = indexOfBytes(data, [0x03, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73])
        const opusIdx = indexOfBytes(data, [0x4f, 0x70, 0x75, 0x73, 0x54, 0x61, 0x67, 0x73])
        const idx = vorbisIdx >= 0 ? vorbisIdx + 7 : opusIdx >= 0 ? opusIdx + 8 : -1
        if (idx < 0) return null
        const map = parseComments(data, idx)
        if (map.size === 0) return null
        const out: OggTags = {}
        const get = (k: string) => map.get(k)
        const t = get('TITLE'); if (t) out.title = t
        const a = get('ARTIST'); if (a) out.artist = a
        const al = get('ALBUM'); if (al) out.album = al
        const y = get('DATE') || get('YEAR'); if (y) out.year = y
        const g = get('GENRE'); if (g) out.genre = g
        const l = get('LYRICS') || get('UNSYNCEDLYRICS'); if (l) out.lyrics = l
        return out.title || out.artist || out.lyrics ? out : null
    } catch {
        return null
    }
}

/** 从 OGG 字节流提取歌词（Vorbis/Opus comment 的 LYRICS/UNSYNCEDLYRICS 字段） */
export function extractOggLyrics(bytes: Uint8Array | ArrayBuffer): string | null {
    return extractOggTags(bytes)?.lyrics ?? null
}
