/**
 * 在线歌词获取（网易云为主）。接口模块化，后续可替换/追加数据源。
 * 供「编辑标签」弹窗的「获取歌词」按钮使用；仅拉取，不写盘。
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const HEADERS = { 'User-Agent': UA, Referer: 'https://music.163.com' }
const TIMEOUT_MS = 8000

export interface NetEaseSong {
    id: number
    name: string
    artists: string[]
    album?: string
    /** 专辑封面 URL（al.picUrl，多为 http，下载时统一转 https） */
    coverUrl?: string
}

interface ApiResult {
    lrc?: { lyric?: unknown }
    nolyric?: boolean
    result?: { songs?: unknown }
}

/** GET 拉取 JSON：优先走 Node https（绕过浏览器 CSP、可携带 Referer 头），否则回退浏览器 fetch */
async function fetchJson(url: string): Promise<ApiResult> {
    try {
        const r = (window as any).require
        if (typeof r === 'function') {
            const https = r('https')
            if (https && typeof https.request === 'function') {
                return await httpsGetJson(https, url)
            }
        }
    } catch { /* 回退 fetch */ }
    return fetchJsonViaFetch(url)
}

/** Node https 版：浏览器 fetch 会静默剥离 Referer（被禁用的请求头），网易云歌词接口要求 Referer，故必须走 https */
function httpsGetJson(https: any, url: string): Promise<ApiResult> {
    return new Promise((resolve, reject) => {
        const u = new URL(url)
        const req = https.request(
            {
                hostname: u.hostname,
                path: u.pathname + u.search,
                method: 'GET',
                headers: HEADERS,
            },
            (res: any) => {
                let body = ''
                res.setEncoding('utf8')
                res.on('data', (chunk: string) => { body += chunk })
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(body) as ApiResult)
                    } catch {
                        reject(new Error('响应解析失败'))
                    }
                })
            },
        )
        req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error('请求超时')))
        req.on('error', reject)
        req.end()
    })
}

/** 浏览器 fetch 回退（移动端等无 Node require 场景）；Referer 头会被剥离，接口可能拒绝 */
async function fetchJsonViaFetch(url: string): Promise<ApiResult> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    try {
        const res = await fetch(url, { signal: controller.signal })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return (await res.json()) as ApiResult
    } finally {
        clearTimeout(timer)
    }
}

/** 网易云搜索歌曲（无需登录）：`/api/cloudsearch/pc?s=…&type=1&limit=10`；歌手字段是 `ar`、专辑是 `al` */
export async function searchSong(query: string): Promise<NetEaseSong[]> {
    const url = `https://music.163.com/api/cloudsearch/pc?s=${encodeURIComponent(query)}&type=1&limit=10`
    const data = await fetchJson(url)
    const songs = data.result?.songs
    if (!Array.isArray(songs)) return []
    return songs.map((s) => {
        const raw = s as { id?: unknown; name?: unknown; ar?: Array<{ name?: unknown }>; al?: { name?: unknown; picUrl?: unknown } }
        return {
            id: Number(raw.id) || 0,
            name: typeof raw.name === 'string' ? raw.name : '',
            artists: Array.isArray(raw.ar)
                ? raw.ar.map((a) => (typeof a.name === 'string' ? a.name : ''))
                : [],
            album: raw.al && typeof raw.al.name === 'string' ? raw.al.name : undefined,
            coverUrl: raw.al && typeof raw.al.picUrl === 'string' ? raw.al.picUrl : undefined,
        }
    })
}

/** 下载图片（封面），返回 mime + 字节；优先 Node https（走 UA 头），回退 fetch */
export async function downloadImage(url: string): Promise<{ mime: string; data: Uint8Array } | null> {
    const safeUrl = url.replace(/^http:\/\//, 'https://')
    try {
        const r = (window as any).require
        if (typeof r === 'function') {
            const https = r('https')
            if (https && typeof https.request === 'function') {
                return await httpsGetBinary(https, safeUrl)
            }
        }
    } catch { /* 回退 fetch */ }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    try {
        const res = await fetch(safeUrl, { signal: controller.signal })
        if (!res.ok) return null
        const buf = await res.arrayBuffer()
        const ctype = res.headers.get('content-type') || ''
        if (ctype && !ctype.startsWith('image/')) return null
        return { mime: ctype.startsWith('image/') ? ctype : 'image/jpeg', data: new Uint8Array(buf) }
    } catch {
        return null
    } finally {
        clearTimeout(timer)
    }
}

function httpsGetBinary(https: any, url: string): Promise<{ mime: string; data: Uint8Array } | null> {
    return new Promise((resolve) => {
        const u = new URL(url)
        const req = https.request(
            {
                hostname: u.hostname,
                path: u.pathname + u.search,
                method: 'GET',
                headers: { 'User-Agent': UA },
            },
            (res: any) => {
                const chunks: Buffer[] = []
                res.on('data', (c: Buffer) => chunks.push(c))
                res.on('end', () => {
                    const ctype = (res.headers['content-type'] as string) || ''
                    const buf = Buffer.concat(chunks)
                    if (!buf.length || (ctype && !ctype.startsWith('image/'))) {
                        resolve(null)
                        return
                    }
                    resolve({ mime: ctype.startsWith('image/') ? ctype : 'image/jpeg', data: new Uint8Array(buf) })
                })
            },
        )
        req.setTimeout(TIMEOUT_MS, () => req.destroy())
        req.on('error', () => resolve(null))
        req.end()
    })
}

/** 网易云拉取歌词：`/api/song/lyric?id=…&lv=1&kv=1&tv=-1`，返回 LRC 文本；无歌词返回 null */
export async function fetchLyric(songId: number): Promise<string | null> {
    const url = `https://music.163.com/api/song/lyric?id=${songId}&lv=1&kv=1&tv=-1`
    const data = await fetchJson(url)
    if (data.nolyric) return null
    const lyric = data.lrc?.lyric
    return typeof lyric === 'string' && lyric.trim() ? lyric : null
}

/**
 * 从搜索结果选最优匹配（纯函数，可单测）：
 * 标题精确 +10 / 标题包含 +5；艺术家精确 +5 / 艺术家包含 +2。取最高分，平局取靠前者。
 */
export function pickBestMatch(
    songs: NetEaseSong[],
    title: string,
    artist: string,
): NetEaseSong | null {
    if (songs.length === 0) return null
    // 清理尾部标点（网易云翻唱/remix 歌手名常带杂音，如「周杰伦-」「周杰伦.」）
    const clean = (s: string) => s.trim().toLowerCase().replace(/[.、，,·\-—\s]+$/g, '')
    const t = clean(title)
    const a = clean(artist)
    let best = songs[0]
    let bestScore = -1
    for (const song of songs) {
        let score = 0
        const name = clean(song.name)
        if (t && name === t) score += 10
        else if (t && name && name.includes(t)) score += 5
        if (a) {
            if (song.artists.some((x) => clean(x) === a)) score += 5
            else if (song.artists.some((x) => x.toLowerCase().includes(a))) score += 2
        }
        if (score > bestScore) {
            bestScore = score
            best = song
        }
    }
    return best
}
