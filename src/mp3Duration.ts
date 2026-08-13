/**
 * MP3 时长解析（纯逻辑，无 obsidian 依赖，可单测）。
 * 从 MP3 字节流估算时长：优先解析首帧头 + Xing/Info 头帧数（VBR 精确），否则按 CBR 码率估算。
 */

/** MPEG1 采样率表（index → Hz） */
const MPEG1_SAMPLE_RATES = [44100, 48000, 32000]
/** MPEG2 采样率表 */
const MPEG2_SAMPLE_RATES = [22050, 24000, 16000]
/** MPEG2.5 采样率表 */
const MPEG25_SAMPLE_RATES = [11025, 12000, 8000]
/** MPEG1 Layer III 码率表（index → kbps，index 0/15 非法） */
const MPEG1_BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
/** MPEG2 / MPEG2.5 Layer III 码率表（约为 MPEG1 的一半） */
const MPEG2_BITRATES = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]

interface MpegFrame {
    version: 1 | 2 | 25 // 1 = MPEG1 / 2 = MPEG2 / 25 = MPEG2.5
    layer: 1 | 2 | 3    // 1 = Layer III（MP3）
    bitrateKbps: number
    sampleRate: number
    samplesPerFrame: number // 每帧采样数
    frameLenBytes: number   // 每帧字节数（含 padding）
}

/** 解析 offset 处的 4 字节 MPEG 帧头；非法/不完整返回 null */
function parseFrameHeader(bytes: Uint8Array, offset: number): MpegFrame | null {
    if (bytes.length < offset + 4) return null
    if (bytes[offset] !== 0xff) return null
    const b1 = bytes[offset + 1]
    if ((b1 & 0xe0) !== 0xe0) return null // 同步字 11 位
    const versionBits = (b1 >> 3) & 0x3   // 0=2.5 / 1=reserved / 2=2 / 3=1
    if (versionBits === 1) return null
    const version = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 25
    const layerBits = (b1 >> 1) & 0x3     // 0=reserved / 1=III / 2=II / 3=I
    if (layerBits === 0) return null
    const layer = layerBits === 1 ? 3 : layerBits === 2 ? 2 : 1
    const b2 = bytes[offset + 2]
    const bitrateIndex = b2 >> 4
    if (bitrateIndex === 0 || bitrateIndex === 15) return null
    const sampleRateIndex = (b2 >> 2) & 0x3
    if (sampleRateIndex === 3) return null
    const padding = (b2 >> 1) & 0x1
    const sampleRates = version === 1 ? MPEG1_SAMPLE_RATES : version === 2 ? MPEG2_SAMPLE_RATES : MPEG25_SAMPLE_RATES
    const bitrateTable = version === 1 ? MPEG1_BITRATES : MPEG2_BITRATES
    const sampleRate = sampleRates[sampleRateIndex]
    const bitrateKbps = bitrateTable[bitrateIndex]
    // 每帧采样数：Layer I=384，Layer II=1152，Layer III（MPEG1=1152 / MPEG2/2.5=576）
    const samplesPerFrame = layer === 1 ? 384 : layer === 2 ? 1152 : version === 1 ? 1152 : 576
    // 每帧字节数：Layer I = (12×码率÷采样率 + padding)×4；Layer II/III = 144×码率÷采样率 + padding
    const frameLenBytes = layer === 1
        ? (Math.floor((12 * bitrateKbps * 1000) / sampleRate) + padding) * 4
        : Math.floor((144 * bitrateKbps * 1000) / sampleRate) + padding
    return { version, layer, bitrateKbps, sampleRate, samplesPerFrame, frameLenBytes }
}

/** ID3v2 标签区总字节数（10 字节头 + 4 字节 synchsafe 大小）；无 ID3v2 返回 0 */
function id3v2Size(bytes: Uint8Array): number {
    if (bytes.length < 10 || bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return 0
    const sz = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f)
    return 10 + sz
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
    return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0
}

/**
 * 估算 MP3 时长（秒）。
 * 策略：
 *  1. 跳过 ID3v2 标签，找首个合法帧头；
 *  2. 若首帧后存在 Xing/Info 头且含帧数（VBR 编码器标准做法），用 `帧数 × 每帧采样数 ÷ 采样率` 精确计算；
 *  3. 否则**逐帧遍历累加**每帧采样数（无论 CBR/VBR、有无 Xing 都精确，如 VBR 无 Xing 头文件），
 *     时长 = 总采样数 ÷ 采样率。帧长由帧头码率/采样率/padding 计算，遇非法帧头即停（防误同步）。
 * 解析失败返回 null。
 */
export function estimateMp3Duration(bytes: Uint8Array): number | null {
    const start = id3v2Size(bytes)
    let headerOffset = -1
    let frame: MpegFrame | null = null
    for (let i = start; i + 4 <= bytes.length; i++) {
        const f = parseFrameHeader(bytes, i)
        if (f) { headerOffset = i; frame = f; break }
    }
    if (!frame || headerOffset < 0) return null

    // ① Xing/Info 头：位于首帧头之后 4~36 字节范围内（不同编码器偏移不同），含帧数时用它（O(1) 快路径）
    for (let i = headerOffset + 4; i + 12 <= bytes.length && i <= headerOffset + 36; i++) {
        const isXing = bytes[i] === 0x58 && bytes[i + 1] === 0x69 && bytes[i + 2] === 0x6e && bytes[i + 3] === 0x67
        const isInfo = bytes[i] === 0x49 && bytes[i + 1] === 0x6e && bytes[i + 2] === 0x66 && bytes[i + 3] === 0x6f
        if (isXing || isInfo) {
            const flags = readUint32BE(bytes, i + 4)
            if (flags & 0x1) { // bit0 = frame count 存在
                const frames = readUint32BE(bytes, i + 8)
                if (frames > 0) return (frames * frame.samplesPerFrame) / frame.sampleRate
            }
            break // 找到 Xing 头但无帧数 → 继续走遍历
        }
    }

    // ② 逐帧遍历累加采样数（覆盖 CBR / VBR 无 Xing 头，均精确）
    // 防御：总字节上限 + 首帧必须合法，防止误同步后无谓扫描；帧长 <4 视为损坏立即停止
    let totalSamples = 0
    let totalFrames = 0
    let pos = headerOffset
    let guard = 0
    const maxFrames = Math.max(1, Math.floor(bytes.length / 24)) // 最小合法帧约 24 字节，超量即中断
    while (pos + 4 <= bytes.length && totalFrames < maxFrames && guard++ < 5_000_000) {
        const f = parseFrameHeader(bytes, pos)
        if (!f || f.frameLenBytes < 4) break
        totalSamples += f.samplesPerFrame
        totalFrames++
        pos += f.frameLenBytes
    }
    if (totalFrames > 0 && frame.sampleRate > 0) {
        const sec = totalSamples / frame.sampleRate
        if (sec > 0) return sec
    }
    return null
}

/** 时长格式化（秒 → MM:SS，分钟补零，如 205 → 03:25；≥1 小时 → H:MM:SS）；非法输入返回空串 */
export function formatDurationColon(seconds: number | undefined): string {
    if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return ''
    const total = Math.round(seconds)
    const h = Math.floor(total / 3600)
    const m = Math.floor((total % 3600) / 60)
    const s = total % 60
    const mm = String(m).padStart(2, '0')
    const ss = String(s).padStart(2, '0')
    return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}
