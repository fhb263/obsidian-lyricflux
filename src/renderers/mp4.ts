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
    return extractMp4Text(bytes, '©lyr')
}

/** 从 M4A(MP4) 字节流提取指定文本 atom 的 data 文本（如 ©nam/©ART/©alb/©lyr）。
 *  用于 jsmediatags 读不到自研 data box 布局文本时的兜底读取。非 M4A 或无该原子返回 null。 */
export function extractMp4Text(bytes: Uint8Array | ArrayBuffer, name: string): string | null {
    try {
        const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
        if (b.length < 100) return null
        return findAtomText(b, 0, b.length, name)
    } catch {
        return null
    }
}

/** 拼接多个 Uint8Array */
function concatBytes(...parts: Uint8Array[]): Uint8Array {
    let len = 0
    for (const p of parts) len += p.length
    const out = new Uint8Array(len)
    let off = 0
    for (const p of parts) { out.set(p, off); off += p.length }
    return out
}

/** 构造 atom：8 字节头（大端 size + 4 字节类型）+ payload */
function atomBytes(name: string, payload: Uint8Array): Uint8Array {
    const out = new Uint8Array(8 + payload.length)
    new DataView(out.buffer).setUint32(0, out.length)
    for (let i = 0; i < 4; i++) out[4 + i] = name.charCodeAt(i)
    out.set(payload, 8)
    return out
}

/** data box：version/flags(4) + type(4) + 负载；文本 type=1，JPEG=13，PNG=14（与 findDataText 的 8 字节跳过对齐，回读无损） */
function dataBoxBytes(type: number, payload: Uint8Array): Uint8Array {
    const head = new Uint8Array(8)
    new DataView(head.buffer).setUint32(4, type)
    return atomBytes('data', concatBytes(head, payload))
}

/** 写文本标签原子（©nam/©ART/©alb/©lyr） */
function textTagAtom(name: string, text: string): Uint8Array {
    return atomBytes(name, dataBoxBytes(1, new TextEncoder().encode(text)))
}

/** 写封面原子（covr）：按魔数判 JPEG/PNG，默认 JPEG */
function coverTagAtom(data: Uint8Array): Uint8Array {
    const isPng = data.length >= 4 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47
    const isJpeg = data.length >= 2 && data[0] === 0xff && data[1] === 0xd8
    return atomBytes('covr', dataBoxBytes(isPng ? 14 : isJpeg ? 13 : 13, data))
}

/** 新建 meta 用的 hdlr（iTunes 规范：version/flags + predefined + 'mdir' + reserved 12 + 'appl\0'） */
function buildHdlr(): Uint8Array {
    const enc = new TextEncoder()
    return atomBytes('hdlr', concatBytes(
        new Uint8Array(8), enc.encode('mdir'), new Uint8Array(12), enc.encode('appl'), new Uint8Array(1),
    ))
}

/** 原子引用：文件内绝对区间 */
interface AtomRef { start: number; end: number; name: string; payload: number }

/** 遍历 [start, end) 内的原子（处理 64 位 size 与 size=0），结构损坏时提前结束 */
function walkAtoms(b: Uint8Array, start: number, end: number): AtomRef[] {
    const out: AtomRef[] = []
    let offset = start
    while (offset + 8 <= end) {
        let size = readUInt32BE(b, offset)
        const name = atomName(b, offset + 4)
        let headerLen = 8
        if (size === 1) {
            if (offset + 16 > end) break
            size = readUInt32BE(b, offset + 8) * 0x100000000 + readUInt32BE(b, offset + 12)
            headerLen = 16
        } else if (size === 0) {
            size = end - offset
        }
        if (size < headerLen || offset + size > end) break
        out.push({ start: offset, end: offset + size, name, payload: offset + headerLen })
        offset += size
    }
    return out
}

/** 组装新 ilst：保留非目标原子 + 保留 tags 中 undefined 的旧目标原子；替换其余 */
function buildNewIlst(b: Uint8Array, ilstRef: AtomRef | null, tags: Mp4TagSet): Uint8Array {
    const provided = new Map<string, Uint8Array | null>()
    if (tags.title !== undefined) provided.set('\u00a9nam', textTagAtom('\u00a9nam', tags.title))
    if (tags.artist !== undefined) provided.set('\u00a9ART', textTagAtom('\u00a9ART', tags.artist))
    if (tags.album !== undefined) provided.set('\u00a9alb', textTagAtom('\u00a9alb', tags.album))
    if (tags.lyrics !== undefined) provided.set('\u00a9lyr', textTagAtom('\u00a9lyr', tags.lyrics))
    if (tags.cover !== undefined) provided.set('covr', tags.cover === null ? null : coverTagAtom(tags.cover))
    const children: Uint8Array[] = []
    if (ilstRef) {
        for (const child of walkAtoms(b, ilstRef.payload, ilstRef.end)) {
            if (!provided.has(child.name)) children.push(b.slice(child.start, child.end))
        }
    }
    for (const [, atom] of provided) {
        if (atom !== null) children.push(atom)
    }
    return atomBytes('ilst', concatBytes(...children))
}

/** udta 的子原子（除 metaRef 外） */
function keepUdtaChildren(b: Uint8Array, udtaRef: AtomRef, metaRef: AtomRef | null): Uint8Array[] {
    const out: Uint8Array[] = []
    for (const c of walkAtoms(b, udtaRef.payload, udtaRef.end)) {
        if (metaRef && c.start === metaRef.start) continue
        out.push(b.slice(c.start, c.end))
    }
    return out
}

/** 遍历整文件修正 stco/co64 chunk 偏移（写入使 mdat 位移后必须调用；resolve 前无副作用） */
function patchChunkOffsets(b: Uint8Array, delta: number): void {
    if (delta === 0) return
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
    const walk = (start: number, end: number): void => {
        let offset = start
        while (offset + 8 <= end) {
            let size = dv.getUint32(offset)
            const name = String.fromCharCode(b[offset + 4], b[offset + 5], b[offset + 6], b[offset + 7])
            let headerLen = 8
            if (size === 1) {
                if (offset + 16 > end) return
                size = dv.getUint32(offset + 8) * 0x100000000 + dv.getUint32(offset + 12)
                headerLen = 16
            } else if (size === 0) {
                size = end - offset
            }
            if (size < headerLen || offset + size > end) return
            const payload = offset + headerLen
            if (name === 'stco') {
                // stco 是 FullBox：payload 前 4 字节 version/flags，entry_count 在其后
                const count = dv.getUint32(payload + 4)
                if (payload + 8 + count * 4 > offset + size) return
                for (let i = 0; i < count; i++) {
                    const p = payload + 8 + i * 4
                    dv.setUint32(p, (dv.getUint32(p) + delta) >>> 0)
                }
            } else if (name === 'co64') {
                const count = dv.getUint32(payload + 4)
                if (payload + 8 + count * 8 > offset + size) return
                for (let i = 0; i < count; i++) {
                    const p = payload + 8 + i * 8
                    let lo = dv.getUint32(p + 4)
                    let hi = dv.getUint32(p)
                    lo += delta
                    if (lo > 0xffffffff) { hi += 1; lo -= 0x100000000 }
                    else if (lo < 0) { hi -= 1; lo += 0x100000000 }
                    dv.setUint32(p, hi)
                    dv.setUint32(p + 4, lo)
                }
            } else if (name === 'moov' || name === 'trak' || name === 'mdia' || name === 'minf'
                || name === 'stbl' || name === 'edts' || name === 'dinf' || name === 'udta' || name === 'meta') {
                const childStart = name === 'meta' ? payload + 4 : payload
                if (childStart < offset + size) walk(childStart, offset + size)
            }
            offset += size
        }
    }
    walk(0, b.length)
}

/** 可写标签集：undefined=保持原值；cover 传 null=移除 */
export interface Mp4TagSet {
    title?: string
    artist?: string
    album?: string
    lyrics?: string
    cover?: Uint8Array | null
}

/**
 * 向 M4A(MP4) 字节流写入标签（纯 JS，无依赖）：替换 moov.udta.meta.ilst 中的
 * ©nam/©ART/©alb/©lyr/covr 原子；meta 缺失时按规范创建（version/flags + hdlr + ilst）。
 * moov 位于 mdat 之前时，插入字节使 mdat 位移 → 同步修正 stco/co64 chunk 偏移。
 * 结构损坏/非 M4A 返回 null（不抛异常）。
 */
export function writeMp4Tags(bytes: Uint8Array, tags: Mp4TagSet): Uint8Array | null {
    try {
        const b = bytes
        if (b.length < 100) return null
        const top = walkAtoms(b, 0, b.length)
        const moov = top.find((a) => a.name === 'moov')
        const mdat = top.find((a) => a.name === 'mdat')
        if (!moov || !mdat) return null

        // 定位 moov > udta > meta(前 4 字节 version/flags) > ilst
        let udtaRef: AtomRef | null = null
        let metaRef: AtomRef | null = null
        let ilstRef: AtomRef | null = null
        for (const kid of walkAtoms(b, moov.payload, moov.end)) {
            if (kid.name === 'udta' && !udtaRef) {
                udtaRef = kid
                for (const m of walkAtoms(b, kid.payload, kid.end)) {
                    if (m.name === 'meta' && !metaRef) {
                        metaRef = m
                        for (const i of walkAtoms(b, m.payload + 4, m.end)) {
                            if (i.name === 'ilst') { ilstRef = i; break }
                        }
                        break
                    }
                }
            }
        }

        const newIlst = buildNewIlst(b, ilstRef, tags)
        let newUdta: Uint8Array
        if (metaRef) {
            // 保留原 version/flags 与其他 meta 子原子（hdlr 等），替换/追加 ilst
            const metaFlags = b.slice(metaRef.payload, metaRef.payload + 4)
            const keepMeta: Uint8Array[] = []
            for (const m of walkAtoms(b, metaRef.payload + 4, metaRef.end)) {
                if (!ilstRef || m.start !== ilstRef.start) keepMeta.push(b.slice(m.start, m.end))
            }
            const newMeta = atomBytes('meta', concatBytes(metaFlags, ...keepMeta, newIlst))
            // metaRef 只会在 udtaRef 已赋值后设置，故此处 udtaRef 必非 null
            newUdta = atomBytes('udta', concatBytes(...keepUdtaChildren(b, udtaRef!, metaRef), newMeta))
        } else {
            const newMeta = atomBytes('meta', concatBytes(new Uint8Array(4), buildHdlr(), newIlst))
            newUdta = udtaRef
                ? atomBytes('udta', concatBytes(...keepUdtaChildren(b, udtaRef, null), newMeta))
                : atomBytes('udta', newMeta)
        }

        const keepMoov: Uint8Array[] = []
        for (const k of walkAtoms(b, moov.payload, moov.end)) {
            if (!udtaRef || k.start !== udtaRef.start) keepMoov.push(b.slice(k.start, k.end))
        }
        const newMoov = atomBytes('moov', concatBytes(...keepMoov, newUdta))
        if (newMoov.length > 0xffffffff) return null // 防 4GB+ 极端文件

        // mdat 在 moov 之后：mdat 位移量 = moov 尺寸变化量；moov 在 mdat 之后则无需修正
        const oldMoovLen = moov.end - moov.start
        const delta = moov.start < mdat.start ? newMoov.length - oldMoovLen : 0
        const out = concatBytes(b.slice(0, moov.start), newMoov, b.slice(moov.end))
        if (delta !== 0) patchChunkOffsets(out, delta)
        return out
    } catch {
        return null
    }
}

/** 解析 M4A 时长（秒）：moov > mvhd 的 timescale/duration（v0=32 位 / v1=64 位）；非 M4A 或无 mvhd 返回 null */
export function extractMp4Duration(bytes: Uint8Array | ArrayBuffer): number | null {
    try {
        const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
        if (b.length < 100) return null
        let mvhd: { payload: number; end: number } | null = null
        for (const top of walkAtoms(b, 0, b.length)) {
            if (top.name !== 'moov') continue
            for (const k of walkAtoms(b, top.payload, top.end)) {
                if (k.name === 'mvhd') { mvhd = k; break }
            }
            break
        }
        if (!mvhd) return null
        const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
        const version = b[mvhd.payload]
        const timescale = dv.getUint32(mvhd.payload + 12)
        if (timescale === 0) return null
        const duration = version === 1
            ? dv.getUint32(mvhd.payload + 20) * 0x100000000 + dv.getUint32(mvhd.payload + 24)
            : dv.getUint32(mvhd.payload + 16)
        if (duration <= 0) return null
        return duration / timescale
    } catch {
        return null
    }
}

/** 在原子树中查找目标原子（如 'covr'），返回其 data box 的 {type, payload}；找不到返回 null */
function findAtomData(b: Uint8Array, start: number, end: number, target: string): { type: number; payload: Uint8Array } | null {
    let offset = start
    while (offset + 8 <= end) {
        let size = readUInt32BE(b, offset)
        const name = atomName(b, offset + 4)
        let headerLen = 8
        if (size === 1) {
            if (offset + 16 > end) return null
            size = readUInt32BE(b, offset + 8) * 0x100000000 + readUInt32BE(b, offset + 12)
            headerLen = 16
        } else if (size === 0) {
            size = end - offset
        }
        if (size < headerLen || offset + size > end) return null
        const payload = offset + headerLen
        const childEnd = offset + size
        if (name === target) {
            // 目标原子下找 data box：data payload 前 8 字节为 version/flags + type
            const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
            let d = payload
            while (d + 8 <= childEnd) {
                const dsize = readUInt32BE(b, d)
                if (dsize < 8 || d + dsize > childEnd) return null
                if (atomName(b, d + 4) === 'data') {
                    const type = dv.getUint32(d + 12) // data payload+4 = type（13=JPEG / 14=PNG）
                    return { type, payload: b.slice(d + 16, d + dsize) }
                }
                d += dsize
            }
            return null
        }
        if (name === 'moov' || name === 'udta' || name === 'ilst' || name === 'meta') {
            const childStart = name === 'meta' ? payload + 4 : payload
            const found = findAtomData(b, childStart, childEnd, target)
            if (found) return found
        }
        offset = childEnd
    }
    return null
}

/** 从 M4A(MP4) 字节流提取封面（covr atom 的 data 负载，type 13=JPEG / 14=PNG → mime）；无封面或非 M4A 返回 null */
export function extractMp4Cover(bytes: Uint8Array | ArrayBuffer): { mime: string; data: Uint8Array } | null {
    try {
        const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
        if (b.length < 100) return null
        const found = findAtomData(b, 0, b.length, 'covr')
        if (!found || found.payload.length === 0) return null
        return { mime: found.type === 14 ? 'image/png' : 'image/jpeg', data: found.payload }
    } catch {
        return null
    }
}
