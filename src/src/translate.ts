/**
 * 在线翻译纯逻辑（v1.4.1）。
 * 主用 Google 免费接口 `translate_a/single`（无需 key）；失败自动降级 MyMemory（国内可达，免 key）。
 * 供「编辑标签」弹窗「翻译歌词」按钮使用：把歌词每行翻译为 `原文 | 译文` 双语竖线格式。
 * 纯逻辑（URL 构造 + 响应解析）可单测；网络层在编排处注入（复用 downloadManager 的 httpGetText）。
 */

/** 目标语言代码：翻译成什么语言（默认 zh-CN 中文） */
export type TranslateTarget = 'zh-CN' | 'en' | 'ja' | 'ko' | 'auto'

/** 翻译服务商（设置页「翻译」分组单选；'mymemory' 为免 key 国内可达的 MyMemory，'auto' 保留兼容旧配置 = Google→MyMemory 降级） */
export type TranslateProvider = 'google' | 'baidu' | 'youdao' | 'auto' | 'mymemory'

/** 构造 Google 翻译 URL（translate_a/single，dt=t 返回分句数组，sl=auto 自动检测源语言） */
export function buildGoogleTranslateUrl(text: string, target: string = 'zh-CN'): string {
    const params: Record<string, string> = { client: 'gtx', sl: 'auto', tl: target, dt: 't', q: text }
    const qs = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')
    return `https://translate.googleapis.com/translate_a/single?${qs}`
}

/**
 * 解析 Google 翻译响应：`[[["译文","原文",...],...], null, "zh-CN", ...]`。
 * 逐段拼接译文；解析失败返回 null。
 */
export function parseGoogleTranslateResponse(raw: string): string | null {
    try {
        const data = JSON.parse(raw)
        const segs = data?.[0]
        if (!Array.isArray(segs)) return null
        const parts: string[] = []
        for (const seg of segs) {
            const t = seg?.[0]
            if (typeof t === 'string' && t) parts.push(t)
        }
        return parts.length > 0 ? parts.join('') : null
    } catch {
        return null
    }
}

/** 构造 MyMemory 翻译 URL（免费，无需 key；langpair=源|目标，MyMemory 不支持 auto 源语言） */
export function buildMyMemoryUrl(text: string, target: string = 'zh-CN', source = 'auto'): string {
    // 默认源语言按目标推断：目标中文→源英文，其余→源中文（最常见歌词翻译场景）
    const src = source && source !== 'auto' ? source : (target === 'zh-CN' ? 'en' : 'zh-CN')
    const params: Record<string, string> = { q: text, langpair: `${src}|${target}` }
    const qs = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')
    return `https://api.mymemory.translated.net/get?${qs}`
}

/** 解析 MyMemory 翻译响应：`responseData.translatedText`；解析失败返回 null */
export function parseMyMemoryResponse(raw: string): string | null {
    try {
        const data = JSON.parse(raw)
        const t = data?.responseData?.translatedText
        return typeof t === 'string' && t.trim() ? t : null
    } catch {
        return null
    }
}

/** 有道翻译的语言代码映射（有道用 zh-CHS，Google 用 zh-CN 等） */
const YD_LANGS: Record<string, string> = {
    'zh-CN': 'zh-CHS', 'zh-TW': 'zh-CHT', en: 'en', ja: 'ja', ko: 'ko',
}
/** 百度翻译的语言代码映射（百度 sug 词典接口不区分目标语言，保留参数以便兼容） */
const BD_LANGS: Record<string, string> = {
    'zh-CN': 'zh', en: 'en', ja: 'jp', ko: 'kor',
}

/**
 * 构造百度翻译请求（POST `fanyi.baidu.com/sug`，**免签名词典释义**，实测无需 token/cookie 即可返回短词条）。
 * v2transapi 整句翻译需 JS 动态 token+sign（页面渲染，Node 侧拿不到），故用 sug 兜底；cookie 由调用方作为请求头传入。
 */
export function buildBaiduTranslateRequest(
    text: string,
    target: string = 'zh-CN',
): { url: string; body: string } {
    const to = BD_LANGS[target] ?? target
    // sug 为词典接口，to 仅作参考；body 只带 kw
    const body = `kw=${encodeURIComponent(text)}`
    return { url: 'https://fanyi.baidu.com/sug', body }
}

/** 解析百度翻译响应：`data[0].v`（分号分隔的多个释义，取第一个有效译法）；解析失败/空返回 null */
export function parseBaiduTranslateResponse(raw: string): string | null {
    try {
        const data = JSON.parse(raw)
        if (Number(data?.errno ?? -1) !== 0) return null
        const first = data?.data?.[0]
        const v: unknown = first?.v
        if (typeof v !== 'string' || !v.trim()) return null
        const parts = v.split(';').map((p) => p.trim()).filter(Boolean)
        return parts[0] ?? null
    } catch {
        return null
    }
}

/** 构造有道翻译 URL（GET，`fanyi.youdao.com/translate`，doctype=json） */
export function buildYoudaoTranslateUrl(text: string, target: string = 'zh-CN'): string {
    const to = YD_LANGS[target] ?? target
    const params: Record<string, string> = { doctype: 'json', type: 'AUTO', to, i: text }
    const qs = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')
    return `https://fanyi.youdao.com/translate?${qs}`
}

/** 解析有道翻译响应：`translateResult[0][0].tgt`（译文）；解析失败返回 null */
export function parseYoudaoTranslateResponse(raw: string): string | null {
    try {
        const data = JSON.parse(raw)
        const segs = data?.translateResult?.[0]
        if (!Array.isArray(segs) || segs.length === 0) return null
        const parts: string[] = []
        for (const seg of segs) {
            const t = seg?.tgt
            if (typeof t === 'string' && t) parts.push(t)
        }
        return parts.length > 0 ? parts.join('') : null
    } catch {
        return null
    }
}

/**
 * 从歌词文本解析逐行（纯逻辑）：保留每行时间戳前缀，返回 [{ time: '00:01.23' | '', text }]。
 * 支持 `[mm:ss.xx]` 与多个时间戳（取首个）；无时间戳的行 time 为空。
 */
export interface LyricLine {
    /** 时间戳字符串（含括号，如 `[00:01.23]`），空 = 该行无时间戳 */
    time: string
    /** 歌词正文（已去时间戳） */
    text: string
}

/** 解析 LRC 文本为逐行结构（纯逻辑，供逐行翻译用） */
export function parseLyricLines(lrc: string): LyricLine[] {
    const lines: LyricLine[] = []
    for (const rawLine of lrc.split(/\r?\n/)) {
        const line = rawLine.trim()
        if (!line) continue
        // 提取所有 `[mm:ss.xx]` 时间戳（含 mm:ss）
        const stamps: string[] = []
        let rest = line
        let m: RegExpMatchArray | null
        const re = /\[(\d{1,3}):([0-5]?\d)(?:[.:](\d{1,3}))?\]/g
        while ((m = re.exec(line)) !== null) {
            const mm = m[1]
            const ss = m[2]
            const frac = m[3] ?? '00'
            stamps.push(`[${mm}:${ss.padStart(2, '0')}.${frac.padEnd(2, '0').slice(0, 2)}]`)
            rest = rest.replace(m[0], '')
        }
        const text = rest.trim()
        if (!stamps.length && !text) continue
        if (!stamps.length) {
            // 无时间戳行（如 [ti:][ar:] 元数据、标题行）：若含 `[xxx:` 则整体跳过
            if (/^\[[a-zA-Z]+:/.test(line)) continue
            lines.push({ time: '', text: line })
        } else {
            for (const stamp of stamps) {
                lines.push({ time: stamp, text })
            }
        }
    }
    return lines
}

/**
 * 把翻译后的歌词行拼回 `原文 | 译文`（纯逻辑）：
 * 输入逐行（含时间戳），输出 LRC 文本；译文为空或与原文相同则原样保留。
 */
export function buildBilingualLrc(lines: Array<{ time: string; text: string; translation?: string }>): string {
    const out: string[] = []
    for (const l of lines) {
        if (!l.translation || !l.translation.trim()) {
            out.push(`${l.time}${l.text}`)
            continue
        }
        const trans = l.translation.trim()
        if (trans === l.text.trim()) {
            out.push(`${l.time}${l.text}`)
            continue
        }
        out.push(`${l.time}${l.text} | ${trans}`)
    }
    return out.join('\n')
}
