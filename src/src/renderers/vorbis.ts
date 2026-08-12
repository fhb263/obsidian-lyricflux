/**
 * FLAC / OGG 的 Vorbis comment 歌词解析。
 * jsmediatags 的 FLACTagReader 只映射 TITLE/ARTIST/ALBUM/TRACKNUMBER/GENRE，
 * 丢弃 LYRICS 字段，故单独解析 Vorbis comment 提取歌词。
 */

/** 读小端 uint32 */
export function readUInt32LE(b: Uint8Array, offset: number): number {
    return (b[offset] | (b[offset + 1] << 8) | (b[offset + 2] << 16) | (b[offset + 3] << 24)) >>> 0
}

/** UTF-8 解码（浏览器/Node 均可用 TextDecoder） */
export function decodeUtf8(bytes: Uint8Array): string {
    try {
        return new TextDecoder('utf-8').decode(bytes)
    } catch {
        return ''
    }
}

/**
 * 从 FLAC 字节流解析 Vorbis comment 的 LYRICS 字段。
 * FLAC 布局：'fLaC' 标志 → 元数据块（1 字节头：last 标志+类型，3 字节长度）。
 * 类型 4 = VORBIS_COMMENT：vendor 长度(LE u32)+vendor+评论数(LE u32)+评论列表("KEY=value")。
 * 无 LYRICS 或非 FLAC 返回 null。
 */
export function extractFlacLyrics(bytes: Uint8Array | ArrayBuffer): string | null {
    try {
        const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
        if (b.length < 4) return null
        if (b[0] !== 0x66 || b[1] !== 0x4c || b[2] !== 0x61 || b[3] !== 0x43) return null // 'fLaC'
        let offset = 4
        while (offset + 4 <= b.length) {
            const header = b[offset]
            const isLast = (header & 0x80) !== 0
            const type = header & 0x7f
            const len = (b[offset + 1] << 16) | (b[offset + 2] << 8) | b[offset + 3]
            offset += 4
            if (type === 4) { // VORBIS_COMMENT
                let p = offset
                const vendorLen = readUInt32LE(b, p)
                p += 4 + vendorLen
                const count = readUInt32LE(b, p)
                p += 4
                for (let i = 0; i < count; i++) {
                    if (p + 4 > b.length) return null
                    const clen = readUInt32LE(b, p)
                    p += 4
                    if (p + clen > b.length) return null
                    const comment = decodeUtf8(b.slice(p, p + clen))
                    p += clen
                    const eq = comment.indexOf('=')
                    if (eq > 0) {
                        const key = comment.slice(0, eq).trim().toUpperCase()
                        const value = comment.slice(eq + 1)
                        if (key === 'LYRICS' && value.trim()) return value
                    }
                }
                return null
            }
            offset += len
            if (isLast) break
        }
        return null
    } catch {
        return null
    }
}
