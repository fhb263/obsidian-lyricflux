/**
 * 下载相关纯逻辑（无 obsidian 依赖，可单测）。
 * 内置网易云下载（v1.4.1）：文件名校验与构造。
 */

/** 文件名非法字符净化（替换 Windows 非法字符，保留中文/空格） */
export function sanitizeFilename(name: string): string {
    const cleaned = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim()
    return cleaned || 'Unknown'
}

/** 构造下载文件名：`艺术家 - 标题.{ext}`（缺项用 Unknown 兜底，ext 缺省 mp3） */
export function buildSongFilename(artist: string, title: string, ext = 'mp3'): string {
    const a = sanitizeFilename(artist || 'Unknown')
    const n = sanitizeFilename(title || 'Unknown')
    const e = (ext || 'mp3').replace(/^\./, '') || 'mp3'
    return `${a} - ${n}.${e}`
}

/**
 * 搜索相似度打分（下载多源结果排序用，v1.4.1）：
 * 标题精确/包含关键词 + 逐 token 标题命中 + 艺术家命中 + 标题长度惩罚（Live/Remix 等附加词越短越精确）。
 * 分越高越相似，供跨平台结果按相关度而非平台顺序排列。
 */
export function songSimilarityScore(keyword: string, name: string, artist: string): number {
    const kw = keyword.toLowerCase().trim()
    const n = name.toLowerCase().trim()
    const a = artist.toLowerCase().trim()
    if (!n) return -1
    const tokens = kw.split(/\s+/).filter(Boolean)
    let score = 0
    // 标题：整个关键词就是标题，或标题在关键词里（「晴天 周杰伦」含「晴天」）
    if (n === kw) score += 80
    else if (kw.includes(n)) score += 50
    else if (n.includes(kw)) score += 40
    // 逐 token：标题 token 精确/包含命中 + 艺术家命中（覆盖「晴天 周杰伦」双 token）
    for (const t of tokens) {
        if (n === t) score += 25
        else if (n.includes(t)) score += 12
        if (a.includes(t)) score += 30
        else {
            const ct = t.replace(/[.、，,·\-—\s]+$/g, '')
            if (ct && a.includes(ct)) score += 22
        }
    }
    // 标题附加词惩罚：晴天 > 晴天 (Live)
    score -= n.length / 10
    return score
}

/**
 * 网易云歌曲是否可下载（VIP 过滤，v1.4.2）：
 * fee 缺省视为可下；fee>0（VIP/付费/试听）外链拿不到完整音频，搜索时屏蔽。
 */
export function isNeteaseDownloadable(fee: number | undefined): boolean {
    return !(fee && fee > 0)
}

/** 时长格式化（秒 → MM:SS，如 269 → 4:29；≥1 小时 → H:MM:SS）；非法输入返回空串 */
export function formatDuration(seconds: number | undefined): string {
    if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return ''
    const total = Math.round(seconds)
    const h = Math.floor(total / 3600)
    const m = Math.floor((total % 3600) / 60)
    const s = total % 60
    const ss = String(s).padStart(2, '0')
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${ss}`
    return `${m}:${ss}`
}
