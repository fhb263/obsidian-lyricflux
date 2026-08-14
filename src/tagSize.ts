/**
 * 标签体积估算（纯逻辑，无 obsidian 依赖，可单测）。
 * 供「编辑标签」弹窗展示「当前文件大小 → 预计保存后大小」。
 * 模型：node-id3.update 会重写 ID3v2 标签区并保留音频字节，
 * 故 预计文件大小 ≈ 当前文件大小 − 旧标签字节 + 新标签字节。
 */

/** 文本帧固定开销：10 字节帧头 + 1 字节文本编码 */
const TEXT_FRAME_OVERHEAD = 11
/** 带语言字段的帧（歌词 USLT / 注释 COMM）额外开销：3 语言 + 1 内容描述符 */
const LANG_FRAME_OVERHEAD = 4
/** 封面 APIC 帧额外开销：1 编码 + 1 MIME 分隔符 + 1 图片类型 + 1 描述 */
const APIC_FRAME_OVERHEAD = 3

/** 参与体积估算的标签字段（结构兼容 tags.ts 的 Mp3Tags，此处不依赖 obsidian） */
export interface SizeTags {
    title?: string
    artist?: string
    album?: string
    year?: string
    comment?: string
    lyrics?: string
    cover?: { mime: string; data: Uint8Array } | null
}

const utf8Len = (s: string): number => new TextEncoder().encode(s).byteLength

/** 文本帧字节数（空串视为无帧——写入端会丢弃空帧） */
const textFrameBytes = (text: string | undefined): number =>
    text ? TEXT_FRAME_OVERHEAD + utf8Len(text) : 0

/** 带语言字段的帧（歌词 USLT / 注释 COMM）字节数 */
const langFrameBytes = (text: string | undefined): number =>
    text ? TEXT_FRAME_OVERHEAD + LANG_FRAME_OVERHEAD + utf8Len(text) : 0

/** 封面 APIC 帧字节数（undefined 未设置 / null 移除均计 0） */
const apicFrameBytes = (cover: SizeTags['cover']): number => {
    if (!cover || cover.data.byteLength === 0) return 0
    return TEXT_FRAME_OVERHEAD + APIC_FRAME_OVERHEAD + utf8Len(cover.mime) + cover.data.byteLength
}

/** 估算给定标签在 ID3v2 标签区所占字节数（近似，未含 padding / ID3v1 / 其他未识别帧） */
export function estimateEmbeddedSize(tags: SizeTags): number {
    return (
        textFrameBytes(tags.title) +
        textFrameBytes(tags.artist) +
        textFrameBytes(tags.album) +
        textFrameBytes(tags.year) +
        langFrameBytes(tags.comment) +
        langFrameBytes(tags.lyrics) +
        apicFrameBytes(tags.cover)
    )
}

/** M4A atom 写入的层级固定开销近似：moov/udta/meta/ilst 4 层 box 头（8×4=32）+ meta version/flags（4）+ 余量（4） */
const M4A_FIXED_OVERHEAD = 40

/** M4A 文本标签原子字节：atom 头 8 + data box 头 8 + utf8 文本（空串视为无原子） */
const m4aTextAtomBytes = (text: string | undefined): number =>
    text ? 8 + 8 + utf8Len(text) : 0

/** M4A 封面原子字节：atom 头 8 + data box 头 8 + 图片字节（undefined/null 计 0） */
const m4aCoverAtomBytes = (cover: SizeTags['cover']): number => {
    if (!cover || cover.data.byteLength === 0) return 0
    return 8 + 8 + cover.data.byteLength
}

/** 估算 M4A 标签写入后的字节增量（近似，与 writeMp4Tags 结构对齐） */
export function estimateM4aEmbeddedSize(tags: SizeTags): number {
    return (
        M4A_FIXED_OVERHEAD +
        m4aTextAtomBytes(tags.title) +
        m4aTextAtomBytes(tags.artist) +
        m4aTextAtomBytes(tags.album) +
        m4aTextAtomBytes(tags.lyrics) +
        m4aCoverAtomBytes(tags.cover)
    )
}

/** 格式化文件大小：3.06 MB / 125 KB / 500 B */
export function formatBytes(bytes: number): string {
    const b = Math.max(0, Math.round(bytes))
    if (b >= 1 << 20) return `${(b / (1 << 20)).toFixed(2)} MB`
    if (b >= 1 << 10) return `${Math.round(b / (1 << 10))} KB`
    return `${b} B`
}
