import * as NodeID3 from 'node-id3'
import * as jsmediatags from 'jsmediatags'
import { type App, TFile } from 'obsidian'
import { extractFlacLyrics } from 'renderers/vorbis'
import { extractOggTags } from 'renderers/ogg'
import { estimateMp3Duration } from 'mp3Duration'
import { writeMp4Tags, extractMp4Text, extractMp4Cover, type Mp4TagSet } from 'renderers/mp4'
import { detectAudioContainer } from 'songScanner'

export interface Mp3Tags {
    title?: string
    artist?: string
    album?: string
    year?: string
    comment?: string
    lyrics?: string
    cover?: { mime: string; data: Uint8Array } | null
}

export interface AudioSource {
    type: 'vault' | 'external'
    file?: TFile
    path?: string
}

function isWinAbsolute(p: string): boolean {
    return p.length >= 3 && p.charCodeAt(1) === 58 && (p.charCodeAt(2) === 92 || p.charCodeAt(2) === 47)
}

/** 可编辑音频路径判别：MP3 / M4A（v1.4.3 M4A 标签写入支持；笔记 source 与编辑弹窗共用） */
function isEditableAudioPath(p: string): boolean {
    return /\.(mp3|m4a)$/i.test(p)
}

/** Mp3Tags → Mp4TagSet 映射：cover undefined/null 语义一致 */
function toMp4TagSet(tags: Mp3Tags): Mp4TagSet {
    return {
        title: tags.title,
        artist: tags.artist,
        album: tags.album,
        lyrics: tags.lyrics,
        cover: tags.cover !== undefined && tags.cover !== null ? tags.cover.data : tags.cover,
    }
}

/** 解析 LRC 笔记的 source 指令定位音频源；非 MP3/M4A 或找不到返回 null */
export async function resolveAudioSource(app: App, notePath: string): Promise<AudioSource | null> {
    const note = app.vault.getAbstractFileByPath(notePath)
    if (!(note instanceof TFile)) return null
    let content = ''
    try { content = await app.vault.read(note) } catch { return null }

    // `source` 指令位于 ```lrc 代码块内部（可能前面有 frontmatter/标题/围栏行）。
    // 只在该代码块范围内查找第一行 `source`，避免误匹配正文中以 `source` 开头的普通行；
    // 若找不到 ```lrc 围栏（遗留无围栏格式），回退为全笔记匹配，兼容 v1.4.0 行为。
    const block = content.match(/```lrc[^\r\n]*\r?\n([\s\S]*?)(?:```|$)/i)
    const scope = block ? block[1] : content
    const m = scope.match(/^source (?<audio>.*)/im)
    const raw = m?.groups?.audio?.trim()
    if (!raw) return null

    const link = raw.match(/\[\[(?<link>[^\]]+)\]\]/)
    if (link?.groups?.link) {
        const name = link.groups.link.trim()
        if (!isEditableAudioPath(name)) return null
        const file = app.metadataCache.getFirstLinkpathDest(name, notePath)
        return file instanceof TFile ? { type: 'vault', file } : null
    }
    if (isWinAbsolute(raw)) {
        return isEditableAudioPath(raw) ? { type: 'external', path: raw } : null
    }
    if (isEditableAudioPath(raw)) {
        const file = app.vault.getAbstractFileByPath(raw)
        return file instanceof TFile ? { type: 'vault', file } : null
    }
    return null
}

async function readFileBuffer(app: App, source: AudioSource): Promise<Uint8Array | null> {
    try {
        if (source.type === 'vault' && source.file) return new Uint8Array(await app.vault.readBinary(source.file))
        if (source.type === 'external' && source.path) {
            const fs = (window as any).require('fs')
            return new Uint8Array(await fs.promises.readFile(source.path))
        }
    } catch { /* fallthrough */ }
    return null
}

async function writeFileBuffer(app: App, source: AudioSource, data: Uint8Array): Promise<boolean> {
    try {
        if (source.type === 'vault' && source.file) {
            await app.vault.modifyBinary(source.file, data)
            return true
        }
        if (source.type === 'external' && source.path) {
            const fs = (window as any).require('fs')
            await fs.promises.writeFile(source.path, data)
            return true
        }
    } catch { /* fallthrough */ }
    return false
}

/** node-id3 的歌词帧键名：USLT（非 USYT）；注释帧键名 COMM 读取后是 {language, text} 对象 */
function parseTags(bytes: Uint8Array): Mp3Tags | null {
    try {
        const tags = NodeID3.read(Buffer.from(bytes))
        if (!tags) return null
        const out: Mp3Tags = {}
        if (typeof tags.title === 'string') out.title = tags.title
        if (typeof tags.artist === 'string') out.artist = tags.artist
        if (typeof tags.album === 'string') out.album = tags.album
        if (typeof tags.year === 'string') out.year = tags.year
        if (typeof tags.comment === 'string') {
            out.comment = tags.comment
        } else if (tags.comment) {
            out.comment = tags.comment.text
        }
        if (typeof tags.unsynchronisedLyrics === 'string') {
            out.lyrics = tags.unsynchronisedLyrics
        } else if (tags.unsynchronisedLyrics) {
            out.lyrics = tags.unsynchronisedLyrics.text
        }
        const img = tags.image
        if (img && typeof img !== 'string' && img.imageBuffer) {
            out.cover = { mime: img.mime || 'image/jpeg', data: new Uint8Array(img.imageBuffer) }
        }
        return out
    } catch {
        return null
    }
}

/** 读整个音频文件并解析标签（编辑器用，单文件） */
export async function readMp3Tags(app: App, source: AudioSource): Promise<Mp3Tags | null> {
    const buf = await readFileBuffer(app, source)
    return buf ? parseTags(buf) : null
}

/** 读整个音频文件字节（编辑弹窗用：一次读取同时解析标签和时长）；失败返回 null */
export async function readAudioFileBytes(app: App, source: AudioSource): Promise<Uint8Array | null> {
    return readFileBuffer(app, source)
}

/** 获取音频文件字节大小（vault 走 adapter.stat 实时查盘，库外走 fs.stat）；失败返回 null */
export async function getAudioFileSize(app: App, source: AudioSource): Promise<number | null> {
    try {
        if (source.type === 'vault' && source.file) {
            const stat = await app.vault.adapter.stat(source.file.path)
            return typeof stat?.size === 'number' ? stat.size : null
        }
        if (source.type === 'external' && source.path) {
            const fs = (window as any).require('fs')
            const stat = await fs.promises.stat(source.path)
            return typeof stat?.size === 'number' ? stat.size : null
        }
    } catch { /* fallthrough */ }
    return null
}

/** 桌面环境：用 fs 局部读音频 ID3 头部（10 字节头 + 标签区），避免整文件读（列表富化用） */
export async function readMp3TagHead(app: App, source: AudioSource): Promise<Uint8Array | null> {
    try {
        const fs = (window as any).require('fs')
        let fullPath: string | null = null
        if (source.type === 'external' && source.path) {
            fullPath = source.path
        } else if (source.type === 'vault' && source.file) {
            const adapter = app.vault.adapter as any
            fullPath = typeof adapter?.getFullPath === 'function' ? adapter.getFullPath(source.file.path) : null
        }
        if (!fullPath) return null
        const fd = await fs.promises.open(fullPath, 'r')
        try {
            const head = Buffer.alloc(10)
            await fd.read(head, 0, 10, 0)
            if (head[0] !== 0x49 || head[1] !== 0x44 || head[2] !== 0x33) return null
            const tagSize = ((head[6] & 0x7f) << 21) | ((head[7] & 0x7f) << 14) | ((head[8] & 0x7f) << 7) | (head[9] & 0x7f)
            if (tagSize <= 0 || tagSize > 10_000_000) return null // 防御：异常大小
            const total = 10 + tagSize
            const buf = Buffer.alloc(total)
            await fd.read(buf, 0, total, 0)
            return new Uint8Array(buf)
        } finally {
            await fd.close()
        }
    } catch {
        return null
    }
}

/** 桌面环境：定位读取 M4A 的 moov box 字节（歌单富化用，避免整文件读）。
 *  moov 可能在文件头部（faststart）或尾部（moov 在 mdat 后）：先读头/尾 64KB 窗口定位 moov 起点与大小，
 *  再按位置精确读取 moov 区域（上限 8MB 防御）。找不到返回 null。 */
export async function readM4aTagHead(app: App, source: AudioSource): Promise<Uint8Array | null> {
    try {
        const fs = (window as any).require('fs')
        let fullPath: string | null = null
        if (source.type === 'external' && source.path) {
            fullPath = source.path
        } else if (source.type === 'vault' && source.file) {
            const adapter = app.vault.adapter as any
            fullPath = typeof adapter?.getFullPath === 'function' ? adapter.getFullPath(source.file.path) : null
        }
        if (!fullPath) return null
        const fd = await fs.promises.open(fullPath, 'r')
        try {
            const stat = await fd.stat()
            const WINDOW = 64 * 1024
            /** 在窗口缓冲内找顶层 moov 原子，返回其绝对起点与大小（大小可为窗口外值，供定位读） */
            const findMoov = (buf: Buffer, base: number): { start: number; size: number } | null => {
                let offset = 0
                while (offset + 8 <= buf.length) {
                    let size = ((buf[offset] << 24) | (buf[offset + 1] << 16) | (buf[offset + 2] << 8) | buf[offset + 3]) >>> 0
                    const name = String.fromCharCode(buf[offset + 4], buf[offset + 5], buf[offset + 6], buf[offset + 7])
                    let headerLen = 8
                    if (size === 1) {
                        if (offset + 16 > buf.length) break
                        size = ((buf[offset + 8] << 24) | (buf[offset + 9] << 16) | (buf[offset + 10] << 8) | buf[offset + 11]) >>> 0 * 0x100000000
                            + ((buf[offset + 12] << 24) | (buf[offset + 13] << 16) | (buf[offset + 14] << 8) | buf[offset + 15]) >>> 0
                        headerLen = 16
                    } else if (size === 0) {
                        size = buf.length - offset
                    }
                    if (size < headerLen) break
                    if (name === 'moov') return { start: base + offset, size }
                    offset += size
                }
                return null
            }
            // ① 头部窗口（faststart：moov 在前）
            const headLen = Math.min(WINDOW, stat.size)
            const head = Buffer.alloc(headLen)
            await fd.read(head, 0, headLen, 0)
            let moov = findMoov(head, 0)
            // ② 尾部窗口（moov 在 mdat 后的非 faststart 布局）
            if (!moov && stat.size > WINDOW) {
                const tail = Buffer.alloc(WINDOW)
                await fd.read(tail, 0, WINDOW, stat.size - WINDOW)
                moov = findMoov(tail, stat.size - WINDOW)
            }
            if (!moov) return null
            if (moov.size < 8 || moov.size > 8_000_000) return null
            const buf = Buffer.alloc(moov.size)
            await fd.read(buf, 0, moov.size, moov.start)
            return new Uint8Array(buf)
        } finally {
            await fd.close()
        }
    } catch {
        return null
    }
}

/** 组装 node-id3 update 的 patch（写标签与下载内嵌共用；歌词空串=移除 USLT、cover null=移除 APIC） */
function buildTagPatch(tags: Mp3Tags): Record<string, any> {
    const patch: Record<string, any> = {}
    if (tags.title !== undefined) patch.title = tags.title
    if (tags.artist !== undefined) patch.artist = tags.artist
    if (tags.album !== undefined) patch.album = tags.album
    if (tags.year !== undefined) patch.year = tags.year
    if (tags.comment !== undefined) patch.comment = tags.comment === '' ? '' : { language: 'eng', text: tags.comment }
    if (tags.lyrics !== undefined) patch.unsynchronisedLyrics = tags.lyrics === '' ? '' : { language: 'chi', text: tags.lyrics }
    if (tags.cover !== undefined) {
        patch.image = tags.cover
            ? { mime: tags.cover.mime, type: { id: 3 }, description: '', imageBuffer: Buffer.from(tags.cover.data) }
            : undefined // 移除封面：node-id3 update({image:undefined}) 会丢弃 APIC 帧（已验证）
    }
    return patch
}

/** 把标签内嵌进内存中的音频字节（下载后写盘前用），失败返回 null；mp3→node-id3，m4a→writeMp4Tags */
export function embedTagsIntoBytes(bytes: Uint8Array, tags: Mp3Tags): Uint8Array | null {
    try {
        if (detectAudioContainer(bytes) === 'm4a') return writeMp4Tags(bytes, toMp4TagSet(tags))
        const updated = NodeID3.update(buildTagPatch(tags), Buffer.from(bytes))
        return updated instanceof Uint8Array ? updated : null
    } catch {
        return null
    }
}

/**
 * 写标签：备份原文件 → node-id3.update → 写回 → 回读校验（长度与可解析性）→ 失败还原。
 * 移除封面：cover 传 null；歌词/注释传空串表示移除。
 */
export async function writeMp3Tags(app: App, source: AudioSource, tags: Mp3Tags): Promise<boolean> {
    const buf = await readFileBuffer(app, source)
    if (!buf || buf.byteLength === 0) return false
    const original = new Uint8Array(buf)

    const patch = buildTagPatch(tags)

    try {
        const updated = NodeID3.update(patch, Buffer.from(original))
        if (!(updated instanceof Uint8Array)) return false
        if (!(await writeFileBuffer(app, source, updated))) {
            await writeFileBuffer(app, source, original) // 还原
            return false
        }
        const verify = await readFileBuffer(app, source)
        // 精确比对回读长度与写入长度（封面加/减任意大小都应通过）；
        // 只有部分写入/截断等异常才会长度不一致，配合可解析性兜底
        const lengthOk = !!verify && verify.byteLength === updated.byteLength && verify.byteLength > 512
        const readable = verify ? parseTags(verify) !== null : false
        // 音频完整性校验：节点标签区后应能遍历出 MPEG 帧（估计时长 >0）。
        // 防止 node-id3 在异常文件上把音频区写坏但标签仍可读 → 误判成功保存损坏文件。
        const audioOk = verify ? (estimateMp3Duration(verify) ?? 0) > 0 : false
        if (!lengthOk || !readable || !audioOk) {
            await writeFileBuffer(app, source, original) // 还原
            return false
        }
        return true
    } catch {
        await writeFileBuffer(app, source, original) // 还原
        return false
    }
}

/**
 * 写音频标签（编辑器保存用）：按真实容器分派——M4A 走 writeMp4Tags（备份-校验-还原），
 * MP3/unknown 走 writeMp3Tags；FLAC/OGG 无写入器直接拒绝（防 node-id3 写坏文件）。
 */
export async function writeAudioTags(app: App, source: AudioSource, tags: Mp3Tags): Promise<boolean> {
    const buf = await readFileBuffer(app, source)
    if (!buf || buf.byteLength === 0) return false
    const container = detectAudioContainer(buf)
    if (container === 'flac' || container === 'ogg') return false
    if (container !== 'm4a') return writeMp3Tags(app, source, tags)
    const original = new Uint8Array(buf)
    try {
        const updated = writeMp4Tags(original, toMp4TagSet(tags))
        if (!updated) return false
        if (!(await writeFileBuffer(app, source, updated))) {
            await writeFileBuffer(app, source, original)
            return false
        }
        const verify = await readFileBuffer(app, source)
        const lengthOk = !!verify && verify.byteLength === updated.byteLength && verify.byteLength > 512
        const readable = verify ? (await readGenericTags(verify)) !== null : false
        if (!lengthOk || !readable) {
            await writeFileBuffer(app, source, original)
            return false
        }
        return true
    } catch {
        await writeFileBuffer(app, source, original)
        return false
    }
}

/** 供歌单富化使用的标签解析（解析局部读取的 ID3 头部 Buffer） */
export function parseTagsForPlugin(bytes: Uint8Array): Mp3Tags | null {
    return parseTags(bytes)
}

/** 从 M4A moov 字节解析标签（歌单富化用）：文本原子走自研解析器，封面自研读取（jsmediatags 读不全自研布局） */
export function parseM4aTags(bytes: Uint8Array): Mp3Tags | null {
    const out: Mp3Tags = {}
    const title = extractMp4Text(bytes, '\u00a9nam')
    const artist = extractMp4Text(bytes, '\u00a9ART')
    const album = extractMp4Text(bytes, '\u00a9alb')
    const lyrics = extractMp4Text(bytes, '\u00a9lyr')
    const cover = extractMp4Cover(bytes)
    if (title) out.title = title
    if (artist) out.artist = artist
    if (album) out.album = album
    if (lyrics) out.lyrics = lyrics
    if (cover) out.cover = cover
    return title || artist || album || lyrics || cover ? out : null
}

/** 用 jsmediatags 读取跨格式标签（FLAC/M4A/MP3 等）+ 自研 OGG 解析，只读，供非 MP3「查看标签」。
 *  node-id3 只解析 MP3 ID3 帧；jsmediatags 不读 FLAC 的 LYRICS 且不支持 OGG，故各自补解析。 */
export async function readGenericTags(bytes: Uint8Array): Promise<Mp3Tags | null> {
    const isFlac = bytes.length >= 4 && bytes[0] === 0x66 && bytes[1] === 0x4c && bytes[2] === 0x61 && bytes[3] === 0x43 // 'fLaC'
    const isOgg = bytes.length >= 4 && bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53 // 'OggS'
    const isM4a = detectAudioContainer(bytes) === 'm4a'

    // OGG：jsmediatags 不支持，直接用自研 Vorbis/Opus comment 解析
    if (isOgg) {
        const ogg = extractOggTags(bytes)
        if (!ogg) return null
        const out: Mp3Tags = {}
        if (ogg.title) out.title = ogg.title
        if (ogg.artist) out.artist = ogg.artist
        if (ogg.album) out.album = ogg.album
        if (ogg.year) out.year = ogg.year
        if (ogg.lyrics) out.lyrics = ogg.lyrics
        return out
    }

    return new Promise((resolve) => {
        try {
            // ArrayFileReader.canReadFile 只认 Array/Buffer，Uint8Array 需转 Buffer
            jsmediatags.read(Buffer.from(bytes), {
                onSuccess: (result) => {
                    const t = result.tags
                    const out: Mp3Tags = {}
                    if (typeof t.title === 'string') out.title = t.title
                    if (typeof t.artist === 'string') out.artist = t.artist
                    if (typeof t.album === 'string') out.album = t.album
                    if (t.year !== undefined && t.year !== null) out.year = String(t.year)
                    if (typeof t.lyrics === 'string') out.lyrics = t.lyrics
                    // jsmediatags 不读 FLAC 的 LYRICS 字段，单独解析 Vorbis comment 补上
                    if (!out.lyrics && isFlac) {
                        const flacLyrics = extractFlacLyrics(bytes)
                        if (flacLyrics) out.lyrics = flacLyrics
                    }
                    const pic = t.picture
                    if (pic && pic.data) {
                        out.cover = {
                            mime: pic.format || 'image/jpeg',
                            data: new Uint8Array(pic.data instanceof Uint8Array ? pic.data : Array.from(pic.data)),
                        }
                    }
                    // M4A：jsmediatags 读自研 8 字节 data box 头文本原子失败（读成偏移量/空），
                    // 标题/艺术家/专辑/歌词用自研解析器兜底补齐（covr 封面 jsmediatags 可读）
                    if (isM4a) {
                        if (typeof out.title !== 'string' || !out.title) { const t = extractMp4Text(bytes, '\u00a9nam'); if (t) out.title = t }
                        if (typeof out.artist !== 'string' || !out.artist) { const t = extractMp4Text(bytes, '\u00a9ART'); if (t) out.artist = t }
                        if (typeof out.album !== 'string' || !out.album) { const t = extractMp4Text(bytes, '\u00a9alb'); if (t) out.album = t }
                        if (typeof out.lyrics !== 'string' || !out.lyrics) { const t = extractMp4Text(bytes, '\u00a9lyr'); if (t) out.lyrics = t }
                    }
                    resolve(out)
                },
                onError: () => {
                    // jsmediatags 失败时（如某些 FLAC），仍可解析 FLAC 歌词
                    if (isM4a) {
                        // jsmediatags 整体失败：文本字段全部走自研解析器（封面无法自读，缺失可接受）
                        const out: Mp3Tags = {}
                        const title = extractMp4Text(bytes, '\u00a9nam')
                        const artist = extractMp4Text(bytes, '\u00a9ART')
                        const album = extractMp4Text(bytes, '\u00a9alb')
                        const lyrics = extractMp4Text(bytes, '\u00a9lyr')
                        if (title) out.title = title
                        if (artist) out.artist = artist
                        if (album) out.album = album
                        if (lyrics) out.lyrics = lyrics
                        resolve(out)
                    } else if (isFlac) {
                        const lyrics = extractFlacLyrics(bytes)
                        resolve(lyrics ? { lyrics } : null)
                    } else {
                        resolve(null)
                    }
                },
            })
        } catch {
            resolve(null)
        }
    })
}

/**
 * 从 AudioSource 生成可播放 URL，供标签编辑器内嵌播放器使用。
 * vault 内文件：Obsidian 资源路径；库外绝对路径：读文件转 Blob URL。
 * 返回的 Blob URL 需由调用方在使用完后 revoke。
 */
export async function resolvePlayableUrl(
    app: App,
    source: AudioSource,
): Promise<string> {
    if (source.type === 'vault' && source.file) {
        return app.vault.getResourcePath(source.file)
    }
    if (source.type === 'external' && source.path) {
        try {
            const fs = (window as any).require('fs')
            const buf: Buffer = await fs.promises.readFile(source.path)
            const ext = source.path.split('.').pop()?.toLowerCase() || 'mp3'
            const mime: Record<string, string> = {
                mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac',
                ogg: 'audio/ogg', aac: 'audio/aac', m4a: 'audio/mp4',
            }
            return URL.createObjectURL(new Blob([buf], { type: mime[ext] || 'audio/mpeg' }))
        } catch {
            // 文件被移动/删除/权限不足：返回 ''，编辑器对空 URL / audioError 优雅降级
            return ''
        }
    }
    return ''
}
