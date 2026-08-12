import * as NodeID3 from 'node-id3'
import * as jsmediatags from 'jsmediatags'
import { type App, TFile } from 'obsidian'
import { extractFlacLyrics } from 'renderers/vorbis'
import { extractOggTags } from 'renderers/ogg'

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

function isMp3Path(p: string): boolean {
    return /\.mp3$/i.test(p)
}

/** 解析 LRC 笔记的 source 指令定位音频源；非 MP3 或找不到返回 null */
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
        if (!isMp3Path(name)) return null
        const file = app.metadataCache.getFirstLinkpathDest(name, notePath)
        return file instanceof TFile ? { type: 'vault', file } : null
    }
    if (isWinAbsolute(raw)) {
        return isMp3Path(raw) ? { type: 'external', path: raw } : null
    }
    if (isMp3Path(raw)) {
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

/** 把标签内嵌进内存中的音频字节（下载后写盘前用），失败返回 null */
export function embedTagsIntoBytes(bytes: Uint8Array, tags: Mp3Tags): Uint8Array | null {
    try {
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
        if (!lengthOk || !readable) {
            await writeFileBuffer(app, source, original) // 还原
            return false
        }
        return true
    } catch {
        await writeFileBuffer(app, source, original) // 还原
        return false
    }
}

/** 供歌单富化使用的标签解析（解析局部读取的 ID3 头部 Buffer） */
export function parseTagsForPlugin(bytes: Uint8Array): Mp3Tags | null {
    return parseTags(bytes)
}

/** 用 jsmediatags 读取跨格式标签（FLAC/M4A/MP3 等）+ 自研 OGG 解析，只读，供非 MP3「查看标签」。
 *  node-id3 只解析 MP3 ID3 帧；jsmediatags 不读 FLAC 的 LYRICS 且不支持 OGG，故各自补解析。 */
export async function readGenericTags(bytes: Uint8Array): Promise<Mp3Tags | null> {
    const isFlac = bytes.length >= 4 && bytes[0] === 0x66 && bytes[1] === 0x4c && bytes[2] === 0x61 && bytes[3] === 0x43 // 'fLaC'
    const isOgg = bytes.length >= 4 && bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53 // 'OggS'

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
                    resolve(out)
                },
                onError: () => {
                    // jsmediatags 失败时（如某些 FLAC），仍可解析 FLAC 歌词
                    if (isFlac) {
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
