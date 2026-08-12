import { decodeUtf8 } from './vorbis'

/** 读大端 uint32 */
function readUInt32BE(b: Uint8Array, offset: number): number {
    return ((b[offset] << 24) | (b[offset + 1] << 16) | (b[offset + 2] << 8) | b[offset + 3]) >>> 0
}

function atomName(b: Uint8Array, offset: number): string {
    return String.fromCharCode(b[offset], b[offset + 1], b[offset + 2], b[offset + 3])
}

/**
 * 在 MP4 原子树中查找目标原子（如 '©lyr'），返回其 'data' 子原子的文本。
 * M4A 标签路径通常为 moov > udta > meta > ilst > ©lyr > data；meta 原子带 4 字节版本头。
 */
function findAtomText(b: Uint8Array, start: number, end: number, target: string): string | null {
    let offset = start
    while (offset + 8 <= end) {
        let size = readUInt32BE(b, offset)
        const name = atomName(b, offset + 4)
        let headerLen = 8
        if (size === 1) {
            // 64 位 size（高 4 字节在 +8，低 4 字节在 +12）
            if (offset + 16 > end) return null
            size = readUInt32BE(b, offset + 8) * 0x100000000 + readUInt32BE(b, offset + 12)
            headerLen = 16
        } else if (size === 0) {
            size = end - offset // 到容器末尾
        }
        if (size < headerLen || offset + size > end) return null
        const payload = offset + headerLen
        const childEnd = offset + size
        if (name === target) {
            return findDataText(b, payload, childEnd)
        }
        if (name === 'moov' || name === 'udta' || name === 'ilst' || name === 'meta') {
            // meta 原子 payload 前有 4 字节 version/flags
            const childStart = name === 'meta' ? payload + 4 : payload
            const found = findAtomText(b, childStart, childEnd, target)
            if (found !== null) return found
        }
        offset = childEnd
    }
    return null
}

/** 目标原子下找 'data' 子原子，返回其文本（跳过 version/flags + reserved 共 8 字节） */
function findDataText(b: Uint8Array, start: number, end: number): string | null {
    let offset = start
    while (offset + 8 <= end) {
        const size = readUInt32BE(b, offset)
        if (size < 8 || offset + size > end) return null
        if (atomName(b, offset + 4) === 'data') {
            const textStart = offset + 8 + 8
            if (textStart < offset + size) return decodeUtf8(b.slice(textStart, offset + size))
            return null
        }
        offset += size
    }
    return null
}

/** 从 M4A(MP4) 字节流提取歌词（©lyr atom 的 data 文本）。非 M4A 或无歌词返回 null。 */
export function extractMp4Lyrics(bytes: Uint8Array | ArrayBuffer): string | null {
    try {
        const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
        if (b.length < 100) return null
        return findAtomText(b, 0, b.length, '©lyr')
    } catch {
        return null
    }
}
