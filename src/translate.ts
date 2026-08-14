/**
 * 在线翻译纯逻辑（v1.4.2）。
 * 主用 Google 免费接口 `translate_a/single`（无需 key）；失败自动降级 MyMemory（国内可达，免 key）。
 * DeepSeek（需 API Key）作为可选翻译源，由设置页「歌词翻译」分组勾选。
 * 供「编辑标签」弹窗「翻译歌词」按钮使用：把歌词每行翻译为 `原文 | 译文` 双语竖线格式。
 * 纯逻辑（URL 构造 + 响应解析）可单测；网络层在编排处注入（复用 downloadManager 的 httpGetText）。
 */

/** 目标语言代码：翻译成什么语言（默认 zh-CN 中文） */
export type TranslateTarget = 'zh-CN' | 'en' | 'ja' | 'ko' | 'auto'

/** 翻译服务商（设置页「翻译」分组单选；'mymemory' 为免 key 国内可达的 MyMemory，'auto' 保留兼容旧配置 = Google→MyMemory 降级） */
export type TranslateProvider = 'google' | 'deepseek' | 'auto' | 'mymemory'

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

/** DeepSeek 翻译 API 端点（OpenAI 兼容 `chat/completions`，v1.4.2） */
export const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions'

/** DeepSeek 翻译默认提示词（v1.4.3）：适配多场景（元数据标签行不翻译原样保留、已双语行只译原文、人名/语气词/数字保留），要求**每行仅输出译文**（原文/格式由 buildBilingualLrc 拼接），整首一次翻译避免逐行上下文断裂 */
export const DEFAULT_DEEPSEEK_PROMPT =
    '你是专业的歌词翻译助手。下面是用户提供的歌词，每行前面有数字编号，请把每行歌词翻译成目标语言（通常为中文）。\n' +
    '规则：\n' +
    '1. 每行仅输出该行的译文，一行对应一行，用换行分隔，不要输出编号；\n' +
    '2. 元数据/标签行（形如 [ti:标题]、[ar:歌手]、[al:专辑]、[by:作者]、[offset:偏移] 等方括号标签）不翻译，原样输出；\n' +
    '3. 某行原文已含译文（竖线分隔「原文 | 译文」）时，只翻译其中非中文的原文部分；\n' +
    '4. 人名、语气词、舞台提示、纯数字、重复段标记等无法翻译的内容，保留原文；\n' +
    '5. 不要重复原文、不要加任何分隔符或格式标记，只输出翻译结果，不要任何解释。'

/**
 * 构造 DeepSeek `chat/completions` 请求（POST，OpenAI 兼容格式）。
 * 提示词留空时使用默认提示词；返回 url/body/headers 供编排层注入网络请求。
 */
export function buildDeepseekRequest(
    text: string,
    apiKey: string,
    prompt: string,
    target: string = 'zh-CN',
    stream = false,
): { url: string; body: string; headers: Record<string, string> } {
    const targetName = target === 'zh-CN' ? '中文' : target === 'en' ? '英文' : target === 'ja' ? '日语' : target === 'ko' ? '韩语' : target
    const sys = 'You are a professional lyrics translator.'
    const userMsg = prompt && prompt.trim()
        ? `${prompt.trim()}\n\n歌词：\n${text}`
        : `${DEFAULT_DEEPSEEK_PROMPT}\n\n目标语言：${targetName}\n歌词：\n${text}`
    const body = JSON.stringify({
        // v1.4.2 默认使用 deepseek-v4-flash（设置页「翻译 → DeepSeek」有注释说明）
        model: 'deepseek-v4-flash',
        messages: [
            { role: 'system', content: sys },
            { role: 'user', content: userMsg },
        ],
        temperature: 0.3,
        stream,
    })
    return {
        url: DEEPSEEK_API_URL,
        body,
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey.trim()}`,
        },
    }
}

/** 解析 DeepSeek `chat/completions` 响应：`choices[0].message.content`；剥掉可能的 ``` 代码块包裹；解析失败/空返回 null */
export function parseDeepseekResponse(raw: string): string | null {
    try {
        const data = JSON.parse(raw)
        const content: unknown = data?.choices?.[0]?.message?.content
        if (typeof content !== 'string' || !content.trim()) return null
        return content.trim().replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```$/, '')
    } catch {
        return null
    }
}

/** 拒绝式回复检测词：模型没当歌词翻译、转而「请用户提供歌词」等废话，该行判翻译失败 */
const DEEPSEEK_REFUSAL_MARKS = [
    '请提供', '请发送', '请补充', '请把需要', '请您提供', '您没有提供', '您提供的',
    '需要翻译的歌词', '歌词内容', '内容不完整', '并不完整', '看起来不是', '如果您能提供', '若您需要',
]

/** 判定一行是否为「拒绝式回复」（模型要求用户提供歌词等），是则整行不作为译文 */
export function isDeepseekRefusalLine(line: string): boolean {
    return DEEPSEEK_REFUSAL_MARKS.some((r) => line.includes(r))
}

/**
 * 把 DeepSeek 歌词翻译响应按行解析为逐行译文数组（纯逻辑，v1.4.2 整首翻译配套）。
 * 模型输出可能为：纯译文行（默认提示词）、`原文 | 译文`、甚至 `原文 | 原文 | 译文`（原歌词已含双语）。
 * 每行取最后一个 `|`/`｜` 之后作为译文，无分隔符则整行为译文；拒绝式回复/空行判 null；
 * 行数不足补 null，超出丢弃。expected = 期望行数（= 发送的歌词行数）。
 */
export function splitDeepseekLyricsResponse(raw: string, expected: number): Array<string | null> {
    const out: Array<string | null> = []
    for (const line of raw.split(/\r?\n/)) {
        if (out.length >= expected) break
        const trimmed = line.trim()
        if (!trimmed) continue
        // 去行首数字编号（`12. 译文` / `12、译文` / `(12) 译文`）
        const noNum = trimmed.replace(/^\(?\d{1,3}\)?[.、:：)\s]+/, '')
        const idx = Math.max(noNum.lastIndexOf('|'), noNum.lastIndexOf('｜'))
        let trans = (idx >= 0 ? noNum.slice(idx + 1) : noNum).trim()
        if (!trans || isDeepseekRefusalLine(trans)) {
            out.push(null)
            continue
        }
        out.push(trans)
    }
    while (out.length < expected) out.push(null)
    return out.slice(0, expected)
}

/**
 * 解析一行 SSE `data:` 负载（DeepSeek 流式响应）：`{"choices":[{"delta":{"reasoning_content":"…","content":"…"}}]}`。
 * [DONE] / finish_reason=stop → { done: true }；无效行 → null。
 */
export function parseDeepseekSseData(rawLine: string): { reasoning?: string; content?: string; done?: boolean } | null {
    const trimmed = rawLine.trim()
    if (!trimmed.startsWith('data:')) return null
    const payload = trimmed.slice(5).trim()
    if (!payload || payload === '[DONE]') return { done: true }
    try {
        const data = JSON.parse(payload)
        if (data?.choices?.[0]?.finish_reason === 'stop') return { done: true }
        const delta = data?.choices?.[0]?.delta
        if (!delta) return null
        const out: { reasoning?: string; content?: string } = {}
        const reasoning = delta.reasoning_content ?? delta.reasoning
        if (typeof reasoning === 'string' && reasoning) out.reasoning = reasoning
        if (typeof delta.content === 'string' && delta.content) out.content = delta.content
        return Object.keys(out).length > 0 ? out : null
    } catch {
        return null
    }
}

/** DeepSeek SSE 流式累计器：按行解析 `data:` 分片，累计 reasoning/content；供实时显示思考过程 */
export class DeepseekSseAccumulator {
    private buffer = ''
    reasoning = ''
    content = ''
    done = false

    /** 喂入一段流式文本，返回本次新增的 reasoning 文本（供实时显示）；content 累计供结束后解析 */
    push(chunk: string): string {
        this.buffer += chunk
        let newReasoning = ''
        let nl: number
        while ((nl = this.buffer.indexOf('\n')) >= 0) {
            const line = this.buffer.slice(0, nl).trim()
            this.buffer = this.buffer.slice(nl + 1)
            if (!line) continue
            const parsed = parseDeepseekSseData(line)
            if (!parsed) continue
            if (parsed.done) { this.done = true; continue }
            if (parsed.reasoning) { this.reasoning += parsed.reasoning; newReasoning += parsed.reasoning }
            if (parsed.content) this.content += parsed.content
        }
        return newReasoning
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
            // 无时间戳行（含 [ti:][ar:][by:][offset:] 等元数据标签行）：保留原样，
            // 翻译层识别为标签行后原样输出（不翻译、不丢失）
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

/** LRC 元数据标签行判别：无时间戳且形如 [ti:…]/[ar:…]/[al:…]/[by:…]/[offset:…] 等（翻译时原样保留） */
export function isMetaTagLine(line: LyricLine): boolean {
    return !line.time && /^\[[a-zA-Z]+:/.test(line.text.trim())
}

/** 拆分可翻译行与元数据标签行（携带原索引，供按原顺序合并） */
export function splitLyricLines(lines: LyricLine[]): {
    content: Array<{ line: LyricLine; idx: number }>
    meta: Array<{ line: LyricLine; idx: number }>
} {
    const content: Array<{ line: LyricLine; idx: number }> = []
    const meta: Array<{ line: LyricLine; idx: number }> = []
    lines.forEach((line, idx) => {
        if (!line.text.trim()) return
        if (isMetaTagLine(line)) meta.push({ line, idx })
        else content.push({ line, idx })
    })
    return { content, meta }
}

/** 按原顺序合并：标签行原样保留，内容行取对应译文 */
export function mergeTranslatedRows(
    lines: LyricLine[],
    meta: Array<{ line: LyricLine; idx: number }>,
    translated: Array<{ time: string; text: string; translation?: string }>,
): Array<{ time: string; text: string; translation?: string }> {
    const metaIdx = new Set(meta.map((m) => m.idx))
    const out: Array<{ time: string; text: string; translation?: string }> = []
    let ti = 0
    lines.forEach((l, idx) => {
        if (metaIdx.has(idx)) out.push({ time: l.time, text: l.text, translation: l.text }) // 原样保留（buildBilingualLrc 译文==原文 → 输出原文）
        else if (l.text.trim() && ti < translated.length) out.push(translated[ti++])
    })
    return out
}

/** 是否全部译文为空（模型整首拒绝/未按格式返回；用于触发默认提示词自动重试） */
export function isAllRejected(translations: Array<string | null>): boolean {
    return translations.length > 0 && translations.every((t) => t === null)
}
