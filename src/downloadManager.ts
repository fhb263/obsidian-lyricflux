/**
 * 多源下载编排 + vault 写盘（v1.4.2）。
 * 支持源：网易云（免登录，外链标准音质；**配置 Cookie + 会员时可走 weapi/eapi 下载 VIP 高音质**）
 *        + QQ音乐（需登录 Cookie，musicu.fcg vkey）
 *        + 酷狗（免登录，getSongInfo.php 免费通道）+ 酷我（免登录，mobi.s 车载通道）。
 * 流程：多源搜索（合并结果）→ 按来源分发下载 → 内嵌标签（MP3/M4A，含歌词/封面）→ 写 vault（备份-校验-还原）→ 重扫。
 */
import { App, TAbstractFile, TFile } from 'obsidian'
import type LyricsPlugin from 'main'
import { searchSong, fetchLyric, downloadImage, type NetEaseSong } from 'onlineLyrics'
import { embedTagsIntoBytes, type Mp3Tags } from 'tags'
import { buildSongFilename, songSimilarityScore, isNeteaseDownloadable } from 'downloadUtils'
import {
    buildGoogleTranslateUrl, parseGoogleTranslateResponse,
    buildMyMemoryUrl, parseMyMemoryResponse, parseLyricLines, buildBilingualLrc,
    buildDeepseekRequest, parseDeepseekResponse, splitDeepseekLyricsResponse,
    splitLyricLines, mergeTranslatedRows, isAllRejected, type TranslateProvider,
    DeepseekSseAccumulator,
} from 'translate'
import { isWindowsAbsolutePath } from 'songScanner'
import { formatBytes } from 'tagSize'
import {
    encryptWeApi, encryptEApi, parseVipAccountResponse,
    buildRecommendedPlaylistsBody, parseRecommendedPlaylists,
    buildPlaylistDetailBody, parsePlaylistTrackIds, buildSongDetailBody, parseSongDetailSongs,
} from 'neteaseCrypto'
import {
    buildQqSearchUrl, parseQqSearchResponse, makeGuid, buildQqVkeyBody, buildQqVkeyUrl, parseQqPurl, extractQqUin,
    buildQqUserInfoUrl, parseQqUserInfo,
    buildQqDissListUrl, parseQqDissList, buildQqDissDetailUrl, parseQqDissDetail,
    QQ_MUSICU_URL, buildQqDissDetailV2Body, parseQqDissDetailV2, buildQqDissCountsBody, parseQqDissCounts,
    buildQqLyricUrl, parseQqLyricResponse,
} from 'qqMusic'
import {
    buildKugouSearchUrl, parseKugouSearchResponse, buildKugouSongInfoUrl, parseKugouSongInfoResponse,
    buildKugouTrackercdnUrl, parseKugouTrackercdnResponse, KUGOU_MOBILE_UA, KUGOU_MOBILE_REFERER, KUGOU_PC_REFERER,
    KUGOU_VIP_ROLEINFO_URL, parseKugouRoleinfo,
    buildKugouSpecialListUrl, parseKugouSpecialList, buildKugouSpecialDetailUrl, parseKugouSpecialDetail,
    buildKugouLyricSearchUrl, parseKugouLyricSearch, buildKugouLyricDownloadUrl, parseKugouLyricDownload,
} from 'kugouMusic'
import {
    buildKuwoSearchUrl, parseKuwoSearchResponse, buildKuwoMobiUrl, makeKuwoUser, parseKuwoMobiResponse,
    KUWO_QUALITIES, KUWO_UA,
    buildKuwoRcmPlaylistUrl, parseKuwoRcmPlaylist, buildKuwoPlaylistDetailUrl, parseKuwoPlaylistDetail,
    buildKuwoLyricUrl, parseKuwoLyricResponse,
} from 'kuwoMusic'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const REFERER = 'https://music.163.com'
const QQ_REFERER = 'https://y.qq.com/'
/** 网易云 VIP 下载接口（weapi/eapi） */
const NETEASE_ACCOUNT_API = 'https://music.163.com/weapi/nuser/account/get'
const NETEASE_WEAPI_URL = 'https://music.163.com/weapi/song/enhance/player/url'
const NETEASE_EAPI_URL = 'https://interface3.music.163.com/eapi/song/enhance/player/url/v1'
/** 网易云推荐歌单 / 歌单详情 / 批量歌曲详情（首屏推荐歌单用，免登录） */
const NETEASE_RECOMMEND_API = 'https://music.163.com/weapi/personalized/playlist'
const NETEASE_PLAYLIST_DETAIL_API = 'https://music.163.com/weapi/v3/playlist/detail'
const NETEASE_SONG_DETAIL_API = 'https://music.163.com/weapi/v3/song/detail'
/** 最小可接受音频字节数：更小基本是错误页/占位内容 */
const MIN_AUDIO_BYTES = 64 * 1024

/** 下载进度回调：percent 0-100 为字节进度；null 为阶段进行中（不确定进度） */
export type DownloadProgressCallback = (percent: number | null, label: string) => void

/** 统一的多源下载候选 */
export interface DownloadSong {
    source: 'netease' | 'qq' | 'kugou' | 'kuwo'
    /** 平台内 id：netease=数字 songid 字符串，qq=songmid，kugou=hash，kuwo=rid */
    id: string
    name: string
    artist: string
    album?: string
    coverUrl?: string
    /** 时长（秒），用于结果行展示 03:25 */
    duration?: number
    /** 文件大小（字节），用于结果行展示 2.08MB */
    size?: number
    /** 码率（kbps），用于结果行展示 128kbps */
    bitrate?: number
    /** netease 专用：数字 songid */
    neteaseId?: number
    /** qq 专用：songmid */
    songmid?: string
    /** VIP 受限标记：网易云 fee>0 / QQ payplay=1 / 酷狗 privilege=10，仅标注不屏蔽 */
    vip?: boolean
    /** kuwo 专用：纯数字 rid（不含 MUSIC_ 前缀） */
    kuwoRid?: string
    /** 该来源下载是否需要登录 Cookie */
    needsCookie?: boolean
    /** 音频格式（结果行格式胶囊，v1.4.2）：按该平台搜索档位推断 mp3/m4a/flac */
    ext?: 'mp3' | 'm4a' | 'flac'
}

/** 推荐歌单来源平台 */
export type PlaylistSource = 'netease' | 'qq' | 'kugou' | 'kuwo'

/** 统一的推荐歌单项（各平台解析后归一化，供首屏卡片渲染） */
export interface RecommendedPlaylist {
    source: PlaylistSource
    /** 平台内歌单 id：netease=数字、qq=dissid、kugou=specialid、kuwo=pid */
    id: string
    name: string
    coverUrl?: string
    /** 播放次数 */
    playCount: number
    /** 歌曲数（QQ 推荐歌单接口无该字段，缺省不显示） */
    trackCount?: number
    /** 创建者（酷我 uname 等） */
    creator?: string
}

interface HttpResult {
    status: number
    data: Uint8Array
    headers: Record<string, string>
}

/** 确保 vault 内文件夹存在（不存在则创建；根路径空串直接返回） */
export async function ensureFolder(app: App, folderPath: string): Promise<void> {
    const path = (folderPath || '').replace(/^\/+|\/+$/g, '')
    if (!path) return
    if (app.vault.getAbstractFileByPath(path)) return
    try {
        await app.vault.createFolder(path)
    } catch { /* 已存在/创建失败均不阻塞后续写入 */ }
}

/**
 * 多源搜索（网易云/QQ/酷狗/酷我全部免登录），合并结果。
 * enabled 为设置页勾选的平台映射（key=source，value 缺省视为启用）；未启用的平台跳过请求。
 */
export async function searchCandidates(
    keyword: string,
    enabled?: Record<string, boolean>,
    onPartial?: (songs: DownloadSong[]) => void,
    onEmpty?: (networkError: boolean) => void,
    order?: string[],
): Promise<DownloadSong[]> {
    const isOn = (k: string): boolean => !enabled || enabled[k] !== false
    // 各平台独立「请求+解析+映射」为 DownloadSong[]（VIP 歌曲不屏蔽仅标注：网易云 fee>0、QQ payplay=1、酷狗 privilege=10）
    const mapNetease = (list: Awaited<ReturnType<typeof searchSong>>): DownloadSong[] =>
        list.filter((x) => x.id > 0 && x.name).map((s) => ({
            source: 'netease' as const, id: String(s.id), neteaseId: s.id, name: s.name,
            artist: s.artists.join('/'), album: s.album, coverUrl: s.coverUrl,
            duration: s.duration, size: s.size, bitrate: s.bitrate, vip: !isNeteaseDownloadable(s.fee),
            ext: 'mp3' as const,
        }))
    const mapQq = (text: string): DownloadSong[] =>
        parseQqSearchResponse(text).map((s) => ({
            source: 'qq' as const, id: s.songmid, songmid: s.songmid, name: s.name, artist: s.artist,
            album: s.album, needsCookie: true, duration: s.duration, size: s.size, bitrate: s.bitrate,
            coverUrl: s.coverUrl, vip: s.vipOnly, ext: s.ext,
        }))
    const mapKugou = (text: string): DownloadSong[] =>
        parseKugouSearchResponse(text).map((s) => ({
            source: 'kugou' as const, id: s.hash, name: s.name, artist: s.artist, album: s.album,
            coverUrl: s.coverUrl, duration: s.duration, size: s.size, bitrate: s.bitrate, vip: s.privilege === 10,
            ext: 'mp3' as const,
        }))
    const mapKuwo = (text: string): DownloadSong[] =>
        parseKuwoSearchResponse(text).map((s) => ({
            source: 'kuwo' as const, id: s.rid, kuwoRid: s.rid, name: s.name, artist: s.artist, album: s.album,
            duration: s.duration, size: s.size, bitrate: s.bitrate, coverUrl: s.coverUrl,
            ext: s.format === 'flac' ? 'flac' as const : s.format === 'aac' ? 'm4a' as const : 'mp3' as const,
        }))

    // 四平台并行，各自记录是否失败（网络/解析错误），以便区分「无结果」与「网络错误」
    type SearchResult = { songs: DownloadSong[]; failed: boolean }
    const ok = (songs: DownloadSong[]): SearchResult => ({ songs, failed: false })
    const fail = (): SearchResult => ({ songs: [], failed: true })
    const tasks: Array<Promise<SearchResult>> = [
        isOn('netease') ? searchSong(keyword).then(mapNetease).then(ok).catch(fail) : Promise.resolve({ songs: [], failed: false }),
        // QQ/酷狗/酷我：请求层失败（httpGetTextChecked.failed）才算「网络错误」，成功但空结果不算
        isOn('qq') ? httpGetTextChecked(buildQqSearchUrl(keyword)).then(({ text, failed }) => failed ? fail() : ok(mapQq(text))).catch(fail) : Promise.resolve({ songs: [], failed: false }),
        isOn('kugou') ? httpGetTextChecked(buildKugouSearchUrl(keyword)).then(({ text, failed }) => failed ? fail() : ok(mapKugou(text))).catch(fail) : Promise.resolve({ songs: [], failed: false }),
        isOn('kuwo') ? httpGetTextChecked(buildKuwoSearchUrl(keyword)).then(({ text, failed }) => failed ? fail() : ok(mapKuwo(text))).catch(fail) : Promise.resolve({ songs: [], failed: false }),
    ]
    // 渐进上报：任一平台完成立即回调（不等最慢平台），供调用方增量渲染
    for (const t of tasks) {
        void t.then((r) => { if (r.songs.length > 0) onPartial?.(r.songs) })
    }
    const all = await Promise.all(tasks)
    const out = all.flatMap((r) => r.songs)
    // 全部结果为空时区分「网络错误」（所有启用平台都失败）与「确实无结果」（都成功但空）
    if (out.length === 0 && onEmpty) {
        const enabledCount = ['netease', 'qq', 'kugou', 'kuwo'].filter((k) => isOn(k)).length
        if (enabledCount > 0) {
            const failedCount = all.filter((r) => r.failed).length
            onEmpty(failedCount === enabledCount)
        } else {
            onEmpty(false)
        }
    }
    // 排序：平台优先级（设置页「平台优先级」顺序，未在 order 中/未知平台垫底）为主键，
    // 同平台内按搜索相似度（标题/艺术家命中关键词的分高排前）→ 标题短 → 字典序。
    const rank = new Map<string, number>()
    if (order) order.forEach((src, i) => rank.set(src, i))
    return out.sort((a, b) => {
        const ra = rank.has(a.source) ? rank.get(a.source)! : order?.length ?? 0
        const rb = rank.has(b.source) ? rank.get(b.source)! : order?.length ?? 0
        if (ra !== rb) return ra - rb
        const sa = songSimilarityScore(keyword, a.name, a.artist)
        const sb = songSimilarityScore(keyword, b.name, b.artist)
        if (sb !== sa) return sb - sa
        if (a.name.length !== b.name.length) return a.name.length - b.name.length
        return a.name.localeCompare(b.name)
    })
}

/** 拉取推荐歌单（多源，全部免登录）。source 指定平台；未知源/失败返回空 */
export async function fetchRecommendedPlaylists(source: PlaylistSource, limit = 150): Promise<RecommendedPlaylist[]> {
    switch (source) {
        case 'netease': {
            const { params, encSecKey } = encryptWeApi(buildRecommendedPlaylistsBody(limit))
            const body = `params=${encodeURIComponent(params)}&encSecKey=${encodeURIComponent(encSecKey)}`
            const res = await httpPost(NETEASE_RECOMMEND_API, body)
            if (!res) return []
            return parseRecommendedPlaylists(new TextDecoder().decode(res.data)).map((p) => ({
                source: 'netease' as const,
                id: p.id,
                name: p.name,
                coverUrl: p.coverUrl,
                playCount: p.playCount,
                trackCount: p.trackCount,
            }))
        }
        case 'qq': {
            const text = await httpGetText(buildQqDissListUrl(0, limit - 1), { Referer: QQ_REFERER })
            const list = parseQqDissList(text)
            // 批量补歌曲数：musicu.fcg 多 req（song_num=1 最小响应）对单次请求的 req 数量有硬上限
            // （实测 >30 个全部返回 code=500000 被拒）→ 分批（每批 30）查询后合并，某批失败不影响其他批
            if (list.length > 0) {
                const ids = list.map((p) => p.id)
                const counts: Record<string, number> = {}
                const BATCH = 30
                for (let i = 0; i < ids.length; i += BATCH) {
                    const chunk = ids.slice(i, i + BATCH)
                    const countsRes = await httpPost(QQ_MUSICU_URL, buildQqDissCountsBody(chunk), {
                        'Content-Type': 'application/json',
                        Origin: 'https://y.qq.com',
                        Referer: 'https://y.qq.com/n/yqq/playsquare/',
                    })
                    if (countsRes) {
                        Object.assign(counts, parseQqDissCounts(new TextDecoder().decode(countsRes.data), chunk))
                    }
                }
                if (Object.keys(counts).length > 0) {
                    return list.map((p) => ({ source: 'qq' as const, ...p, trackCount: counts[p.id] ?? undefined }))
                }
            }
            return list.map((p) => ({ source: 'qq' as const, ...p }))
        }
        case 'kugou': {
            const text = await httpGetText(buildKugouSpecialListUrl(1, limit), {
                'User-Agent': KUGOU_MOBILE_UA,
                Referer: KUGOU_MOBILE_REFERER,
            })
            return parseKugouSpecialList(text).map((p) => ({ source: 'kugou' as const, ...p }))
        }
        case 'kuwo': {
            const text = await httpGetText(buildKuwoRcmPlaylistUrl(1, limit), { Referer: 'http://www.kuwo.cn/' })
            return parseKuwoRcmPlaylist(text).map((p) => ({ source: 'kuwo' as const, ...p }))
        }
        default:
            return []
    }
}

/** 拉取某平台歌单全部歌曲（全部免登录），映射为统一 DownloadSong 供逐首下载 */
export async function fetchPlaylistSongs(source: PlaylistSource, playlistId: string): Promise<DownloadSong[]> {
    switch (source) {
        case 'netease': return fetchNeteasePlaylistSongs(playlistId)
        case 'qq': {
            // 优先 fcg_ucc_getcdinfo（官方歌单）；它对部分用户歌单返回空 cdlist，回退 musicu.fcg uniform_get_Dissinfo
            let songs = parseQqDissDetail(await httpGetText(buildQqDissDetailUrl(playlistId), { Referer: QQ_REFERER }))
            if (songs.length === 0) {
                const v2Res = await httpPost(QQ_MUSICU_URL, buildQqDissDetailV2Body(playlistId), {
                    'Content-Type': 'application/json',
                    Origin: 'https://y.qq.com',
                    Referer: `https://y.qq.com/n/yqq/playsquare/${playlistId}.html`,
                })
                if (v2Res) songs = parseQqDissDetailV2(new TextDecoder().decode(v2Res.data))
            }
            return songs.map((s) => ({
                source: 'qq' as const,
                id: s.songmid,
                songmid: s.songmid,
                name: s.name,
                artist: s.artist,
                album: s.album,
                coverUrl: s.coverUrl,
                duration: s.duration,
                size: s.size,
                bitrate: s.bitrate,
                needsCookie: true,
                vip: s.vipOnly,
                ext: s.ext,
            }))
        }
        case 'kugou': {
            const text = await httpGetText(buildKugouSpecialDetailUrl(playlistId, 1, 100), {
                'User-Agent': KUGOU_MOBILE_UA,
                Referer: KUGOU_MOBILE_REFERER,
            })
            return parseKugouSpecialDetail(text).map((s) => ({
                source: 'kugou' as const,
                id: s.hash,
                name: s.name,
                artist: s.artist,
                duration: s.duration,
                size: s.size,
                bitrate: s.bitrate,
                vip: s.privilege === 10,
                ext: 'mp3' as const,
            }))
        }
        case 'kuwo': {
            const text = await httpGetText(buildKuwoPlaylistDetailUrl(playlistId), { Referer: 'http://www.kuwo.cn/' })
            return parseKuwoPlaylistDetail(text).map((s) => ({
                source: 'kuwo' as const,
                id: s.rid,
                kuwoRid: s.rid,
                name: s.name,
                artist: s.artist,
                album: s.album,
                coverUrl: s.coverUrl,
                duration: s.duration,
                size: s.size,
                bitrate: s.bitrate,
                ext: s.format === 'flac' ? 'flac' as const : s.format === 'aac' ? 'm4a' as const : 'mp3' as const,
            }))
        }
        default:
            return []
    }
}

/** 网易云歌单全部歌曲：详情拿 trackIds → 分批歌曲详情（每批 100）→ DownloadSong[] */
async function fetchNeteasePlaylistSongs(playlistId: string): Promise<DownloadSong[]> {
    const detailReq = encryptWeApi(buildPlaylistDetailBody(playlistId))
    const detailBody = `params=${encodeURIComponent(detailReq.params)}&encSecKey=${encodeURIComponent(detailReq.encSecKey)}`
    const detailRes = await httpPost(NETEASE_PLAYLIST_DETAIL_API, detailBody)
    if (!detailRes) return []
    const trackIds = parsePlaylistTrackIds(new TextDecoder().decode(detailRes.data))
    if (trackIds.length === 0) return []
    const out: DownloadSong[] = []
    for (let i = 0; i < trackIds.length; i += 100) {
        const batch = trackIds.slice(i, i + 100)
        const songReq = encryptWeApi(buildSongDetailBody(batch))
        const songBody = `params=${encodeURIComponent(songReq.params)}&encSecKey=${encodeURIComponent(songReq.encSecKey)}`
        const songRes = await httpPost(NETEASE_SONG_DETAIL_API, songBody)
        if (!songRes) continue
        const songs = parseSongDetailSongs(new TextDecoder().decode(songRes.data))
        for (const s of songs) {
            out.push({
                source: 'netease',
                id: String(s.id),
                neteaseId: s.id,
                name: s.name,
                artist: s.artist,
                album: s.album,
                coverUrl: s.coverUrl,
                duration: s.duration,
                size: s.size,
                bitrate: s.bitrate,
                vip: !isNeteaseDownloadable(s.fee),
                ext: 'mp3' as const,
            })
        }
    }
    return out
}

/**
 * 测试平台 Cookie 是否有效（设置页「测试连接」按钮调用）。
 * netease：weapi/nuser/account/get（code===200 且 vipType≠0 为有效会员，普通账号也提示有效）；
 * qq：musicu.fcg GetUserInfo（req_1.code===0 有效）；kugou：vip roleinfo（errno===0 有效）；
 * kuwo：免登录即可下载，Cookie 非必需，返回提示。
 */
export async function testPlatformConnection(
    source: string,
    cookie: string,
): Promise<{ ok: boolean; message: string }> {
    const c = (cookie ?? '').trim()
    if (source === 'netease') {
        if (!c) return { ok: false, message: '未粘贴网易云 Cookie' }
        const { params, encSecKey } = encryptWeApi(JSON.stringify({ csrf_token: '' }))
        const body = `params=${encodeURIComponent(params)}&encSecKey=${encodeURIComponent(encSecKey)}`
        const res = await httpPost(NETEASE_ACCOUNT_API, body, { 'Cookie': c })
        if (!res) return { ok: false, message: '请求失败（网络或接口变更）' }
        const info = parseVipAccountResponse(new TextDecoder().decode(res.data))
        if (!info.ok) return { ok: false, message: '网易云 Cookie 无效或已过期，请重新登录复制' }
        return { ok: true, message: info.vipType !== 0 ? '网易云 Cookie 有效（会员）' : '网易云 Cookie 有效（普通账号）' }
    }
    if (source === 'qq') {
        if (!c) return { ok: false, message: '未粘贴 QQ Cookie' }
        const uin = extractQqUin(c)
        const res = await httpGet(buildQqUserInfoUrl(uin), 0, undefined, { 'Referer': QQ_REFERER, 'Cookie': c })
        if (!res) return { ok: false, message: '请求失败（网络或接口变更）' }
        const info = parseQqUserInfo(new TextDecoder().decode(res.data))
        return info.ok
            ? { ok: true, message: 'QQ Cookie 有效' }
            : { ok: false, message: `QQ Cookie 无效或已过期（code=${info.code}），请重新登录复制` }
    }
    if (source === 'kugou') {
        if (!c) return { ok: false, message: '未粘贴酷狗 Cookie' }
        const res = await httpGet(KUGOU_VIP_ROLEINFO_URL, 0, undefined, {
            'User-Agent': UA,
            'Accept': '*/*',
            'Host': 'vip.kugou.com',
            'Cookie': c,
        })
        if (!res) return { ok: false, message: '请求失败（网络或接口变更）' }
        const info = parseKugouRoleinfo(new TextDecoder().decode(res.data))
        return info.ok
            ? { ok: true, message: '酷狗 Cookie 有效' }
            : { ok: false, message: `酷狗 Cookie 无效或已过期（errno=${info.errno}），请重新登录复制` }
    }
    if (source === 'kuwo') {
        return { ok: true, message: '酷我免登录即可下载，Cookie 非必需（预留）' }
    }
    return { ok: false, message: `未知平台：${source}` }
}

/** 按来源分发下载（onProgress 上报阶段/百分比）；一次失败自动重试（网络抖动友好，写盘失败重试安全：备份-校验-还原） */
export async function downloadSong(
    plugin: LyricsPlugin,
    song: DownloadSong,
    cookies: Record<string, string>,
    onProgress?: DownloadProgressCallback,
): Promise<{ ok: boolean; message: string }> {
    const attempt = async (): Promise<{ ok: boolean; message: string }> => {
        if (song.source === 'netease') {
            const netease: NetEaseSong = {
                id: song.neteaseId ?? 0,
                name: song.name,
                artists: song.artist ? song.artist.split('/') : [],
                album: song.album,
                coverUrl: song.coverUrl,
            }
            return downloadNetEase(plugin, netease, cookies, onProgress)
        }
        if (song.source === 'qq') {
            return downloadQq(plugin, song, cookies, onProgress)
        }
        if (song.source === 'kugou') {
            return downloadKugou(plugin, song, onProgress)
        }
        if (song.source === 'kuwo') {
            return downloadKuwo(plugin, song, onProgress)
        }
        return { ok: false, message: `不支持的来源：${song.source}` }
    }
    const first = await attempt()
    if (first.ok) return first
    // 首次失败自动重试一次（如网络抖动/瞬时限流）；VIP 受限等确定性失败重试也会返回原错误，无害
    onProgress?.(null, '重试中…')
    return attempt()
}

/** 试听结果：ok=false 时 message 为失败原因；ok=true 时 data 为音频字节、ext 为标准档扩展名 */
export interface PreviewAudioResult {
    ok: boolean
    message: string
    /** 音频字节（标准档，不写盘，供 Blob 播放） */
    data?: Uint8Array
    /** 扩展名：mp3 / m4a / flac */
    ext?: 'mp3' | 'm4a' | 'flac'
    /** 本次是否命中缓存（true=未重新拉取，直接返回缓存字节） */
    fromCache?: boolean
}

/** 试听音频会话内缓存（v1.4.1）：key=`${source}:${id}`，命中直接播放不重新拉取；模块级存活至 Obsidian 重启 */
const previewCache = new Map<string, { data: Uint8Array; ext: 'mp3' | 'm4a' | 'flac' }>()

/** 试听缓存条目数 */
export function getPreviewCacheCount(): number {
    return previewCache.size
}

/** 试听缓存总字节数 */
export function getPreviewCacheSize(): number {
    let total = 0
    for (const v of previewCache.values()) total += v.data.byteLength
    return total
}

/** 一键清除试听缓存（设置页「歌单」分组「释放缓存」按钮调用） */
export function clearPreviewCache(): void {
    previewCache.clear()
}

/**
 * 试听歌曲（v1.4.1）：按来源拉取标准档音频字节（**不写盘**），供下载弹窗「试听」按钮转 Blob 播放。
 * 各平台复用下载同款 URL 构造与请求头；网易云有会员 Cookie 走 VIP 链路、否则外链 128k。
 * 返回 { ok, message, data, ext }；失败（VIP 受限/无 Cookie/网络错误）返回原因。
 */
export async function previewAudio(
    song: DownloadSong,
    cookies: Record<string, string>,
    onProgress?: (percent: number | null, label: string) => void,
): Promise<PreviewAudioResult> {
    const toExt = (b: Uint8Array): 'mp3' | 'm4a' | 'flac' =>
        looksLikeFlac(b) ? 'flac' : looksLikeM4a(b) ? 'm4a' : 'mp3'
    const bytesProgress = (label: string) =>
        (received: number, total: number | null) => {
            onProgress?.(total && total > 0 ? Math.min(100, Math.round((received / total) * 100)) : null, label)
        }
    // 试听缓存：命中直接返回，不重新拉取（不触发下载）
    const cacheKey = `${song.source}:${song.id}`
    const cached = previewCache.get(cacheKey)
    if (cached) {
        return { ok: true, message: '已从缓存播放', data: cached.data, ext: cached.ext, fromCache: true }
    }
    try {
        // 网易云：有会员 Cookie 走 VIP 链路（试听真实音质），否则外链 128k
        if (song.source === 'netease' && song.neteaseId) {
            const cookie = (cookies.netease ?? '').trim()
            let audio: Uint8Array | null = null
            if (cookie) {
                audio = await downloadNeteaseVipBytes(song.neteaseId, cookie, (r, t, label) => bytesProgress(label)(r, t))
            }
            if (!audio) {
                onProgress?.(null, `正在试听 ${song.name}…`)
                audio = await downloadAudioBytes(song.neteaseId, bytesProgress(`正在试听 ${song.name}`))
            }
            if (!audio) return { ok: false, message: '试听失败（可能 VIP 受限或接口变更）' }
            previewCache.set(cacheKey, { data: audio, ext: toExt(audio) })
            return { ok: true, message: '', data: audio, ext: toExt(audio) }
        }
        // QQ：需登录 Cookie 拿 vkey
        if (song.source === 'qq') {
            const qqCookie = (cookies.qq ?? '').trim()
            if (!qqCookie) {
                return { ok: false, message: '试听 QQ 歌曲需在设置 → 多平台 Cookie 粘贴 QQ 音乐登录 Cookie' }
            }
            onProgress?.(null, `正在试听 ${song.name}…`)
            const guid = makeGuid()
            const uin = extractQqUin(qqCookie)
            const vkeyRes = await httpGet(buildQqVkeyUrl(buildQqVkeyBody(song.songmid ?? '', guid, uin)), 0, undefined, { 'Referer': QQ_REFERER, 'Cookie': qqCookie })
            if (!vkeyRes) return { ok: false, message: '获取 QQ 播放地址失败' }
            const purl = parseQqPurl(new TextDecoder().decode(vkeyRes.data))
            if (!purl) return { ok: false, message: 'QQ Cookie 无效或已过期，请到 y.qq.com 重新登录复制' }
            const audioUrl = /^https?:\/\//i.test(purl) ? purl : `https://dl.stream.qqmusic.qq.com/${purl}`
            const audioRes = await httpGet(audioUrl, 0, bytesProgress(`正在试听 ${song.name}`), { 'Referer': QQ_REFERER, 'Cookie': qqCookie })
            const audio = audioRes?.data
            if (!audio || audio.byteLength < MIN_AUDIO_BYTES) return { ok: false, message: '试听失败（可能付费受限或 Cookie 权限不足）' }
            previewCache.set(cacheKey, { data: audio, ext: toExt(audio) })
            return { ok: true, message: '', data: audio, ext: toExt(audio) }
        }
        // 酷狗：免登录，getSongInfo → trackercdn 兜底
        if (song.source === 'kugou' && song.id) {
            onProgress?.(null, `正在试听 ${song.name}…`)
            let info = { url: '' }
            const songInfoRes = await httpGet(buildKugouSongInfoUrl(song.id), 0, undefined, {
                'User-Agent': KUGOU_MOBILE_UA,
                'Referer': KUGOU_MOBILE_REFERER,
            })
            if (songInfoRes) info = parseKugouSongInfoResponse(new TextDecoder().decode(songInfoRes.data))
            if (!info.url) {
                const trRes = await httpGet(buildKugouTrackercdnUrl(song.id), 0, undefined, { 'User-Agent': UA, 'Referer': KUGOU_PC_REFERER })
                if (trRes) info = parseKugouTrackercdnResponse(new TextDecoder().decode(trRes.data))
            }
            if (!info.url) return { ok: false, message: '获取酷狗播放地址失败（可能 VIP 受限或接口变更）' }
            const audioRes = await httpGet(info.url, 0, bytesProgress(`正在试听 ${song.name}`), { 'User-Agent': UA, 'Referer': KUGOU_PC_REFERER })
            const audio = audioRes?.data
            if (!audio || audio.byteLength < MIN_AUDIO_BYTES) return { ok: false, message: '试听失败（可能受限或接口变更）' }
            previewCache.set(cacheKey, { data: audio, ext: toExt(audio) })
            return { ok: true, message: '', data: audio, ext: toExt(audio) }
        }
        // 酷我：免登录，mobi.s 128→320→flac 取首个可用
        if (song.source === 'kuwo' && (song.kuwoRid || song.id)) {
            onProgress?.(null, `正在试听 ${song.name}…`)
            const rid = song.kuwoRid || song.id
            let audioUrl = ''
            for (const br of KUWO_QUALITIES) {
                const res = await httpGet(buildKuwoMobiUrl(rid, br, makeKuwoUser()), 0, undefined, { 'User-Agent': KUWO_UA })
                if (!res) continue
                const info = parseKuwoMobiResponse(new TextDecoder().decode(res.data))
                if (info.url) { audioUrl = info.url; break }
            }
            if (!audioUrl) return { ok: false, message: '获取酷我播放地址失败（可能版权受限）' }
            const audioRes = await httpGet(audioUrl, 0, bytesProgress(`正在试听 ${song.name}`), { 'User-Agent': KUWO_UA })
            const audio = audioRes?.data
            if (!audio || audio.byteLength < MIN_AUDIO_BYTES) return { ok: false, message: '试听失败（可能版权受限）' }
            previewCache.set(cacheKey, { data: audio, ext: toExt(audio) })
            return { ok: true, message: '', data: audio, ext: toExt(audio) }
        }
        return { ok: false, message: `不支持的来源：${song.source}` }
    } catch (e) {
        return { ok: false, message: `试听出错：${e instanceof Error ? e.message : String(e)}` }
    }
}

// --- 网易云 ---

/** 下载网易云歌曲音频字节（外链标准音质，带 Referer，跟随重定向）；失败返回 null */
async function downloadAudioBytes(
    songId: number,
    onProgress?: (received: number, total: number | null) => void,
): Promise<Uint8Array | null> {
    const url = `https://music.163.com/song/media/outer/url?id=${songId}.mp3`
    const res = await httpGet(url, 0, onProgress)
    // 仅按字节数门槛校验（CDN 常返回 application/octet-stream，content-type 不可靠）
    if (!res || res.data.byteLength < MIN_AUDIO_BYTES) return null
    return res.data
}

/**
 * 下载网易云歌曲到 vault（歌词+封面内嵌）；onProgress 上报阶段/百分比。
 * VIP 链路：配置了网易云 Cookie 时先 `weapi/nuser/account/get` 校验会员，
 * 是会员则走 weapi（320k）/ eapi（无损）拿 VIP 直链下载；非会员/无 Cookie/接口失败 → 外链 128k 回退。
 */
export async function downloadNetEase(
    plugin: LyricsPlugin,
    song: NetEaseSong,
    cookies?: Record<string, string>,
    onProgress?: DownloadProgressCallback,
): Promise<{ ok: boolean; message: string }> {
    const cookie = (cookies?.netease ?? '').trim()
    let audio: Uint8Array | null = null
    let qualityNote = ''

    if (cookie) {
        // 会员校验 + VIP 直链（weapi→eapi 逐级降级）
        audio = await downloadNeteaseVipBytes(song.id, cookie, (received, total, label) => {
            onProgress?.(total && total > 0 ? Math.min(100, Math.round((received / total) * 100)) : null, label)
        })
        if (audio) qualityNote = '（VIP 高音质）'
    }

    if (!audio) {
        // 外链 128k 回退（免登录）
        onProgress?.(null, '正在下载音频…')
        audio = await downloadAudioBytes(song.id, (received, total) => {
            if (total && total > 0) {
                onProgress?.(Math.min(100, Math.round((received / total) * 100)), '正在下载音频')
            } else {
                onProgress?.(null, '正在下载音频…')
            }
        })
    }

    if (!audio) {
        return { ok: false, message: '下载失败（可能 VIP 受限、区域限制或接口变更）' }
    }
    onProgress?.(null, '正在获取歌词与封面…')
    const [lyric, cover] = await Promise.all([
        fetchLyric(song.id).catch(() => null),
        song.coverUrl ? downloadImage(song.coverUrl).catch(() => null) : Promise.resolve(null),
    ])
    onProgress?.(null, '正在内嵌标签并写入…')
    const tags: Mp3Tags = {
        title: song.name,
        artist: song.artists.join('/'),
        album: song.album,
        lyrics: lyric ?? undefined,
        cover: cover ?? undefined,
    }
    const enriched = embedTagsIntoBytes(audio, tags)
    const data = enriched ?? audio
    // 按真实音频格式定扩展名：VIP 无损可能是 FLAC，避免存成 .mp3
    const ext = looksLikeFlac(audio) ? 'flac' : looksLikeMp3(audio) ? 'mp3' : looksLikeM4a(audio) ? 'm4a' : 'mp3'
    const artist = song.artists.join('/')
    const targetPath = await resolveDownloadTargetUnique(plugin, buildSongFilename(artist, song.name, ext), 'netease')
    const ok = await writeAudioToVault(plugin.app, targetPath, data)
    if (!ok) return { ok: false, message: '写入失败，已还原原文件' }
    void plugin.scanLyricSongs()
    // 只有 enrich 真正成功（enriched 非 null）才声称内嵌；嵌入失败（如 FLAC 不支持内嵌）如实提示
    const metaNote = enriched ? (lyric && cover ? '（已内嵌歌词+封面）' : lyric ? '（已内嵌歌词）' : cover ? '（已内嵌封面）' : '') : '（未内嵌标签）'
    return { ok: true, message: `已下载 ${formatBytes(data.byteLength)}：${targetPath}${qualityNote}${metaNote}` }
}

/**
 * VIP 下载链路：先 weapi 校验会员，再尝试 eapi（无损）→ weapi（320k）拿直链并下载。
 * 返回音频字节；非会员/接口失败返回 null（由调用方回退外链）。
 */
async function downloadNeteaseVipBytes(
    songId: number,
    cookie: string,
    onProgress: (received: number, total: number | null, label: string) => void,
): Promise<Uint8Array | null> {
    // 1. 校验会员：weapi/nuser/account/get
    const { params, encSecKey } = encryptWeApi(JSON.stringify({ csrf_token: '' }))
    const accountBody = `params=${encodeURIComponent(params)}&encSecKey=${encodeURIComponent(encSecKey)}`
    const accountRes = await httpPost(NETEASE_ACCOUNT_API, accountBody, { 'Cookie': cookie })
    if (!accountRes) return null
    const vip = parseVipAccountResponse(new TextDecoder().decode(accountRes.data))
    // 需登录有效（ok）且为会员（vipType!==0）才走 VIP 直链；普通账号/登录失效均回退外链
    if (!vip.ok || vip.vipType === 0) return null

    // 2. 尝试 eapi 无损（quality=lossless→hires→exhigh 逐级降级）
    const eapiPayload = (level: string) => JSON.stringify({
        ids: [songId],
        level,
        encodeType: 'flac',
        header: JSON.stringify({ os: 'pc', appver: '', osver: '', deviceId: 'pyncm!', requestId: String(Date.now()) }),
    })
    for (const level of ['lossless', 'hires', 'exhigh']) {
        const eapiParams = encryptEApi('/eapi/song/enhance/player/url/v1', eapiPayload(level))
        const eapiRes = await httpPost(NETEASE_EAPI_URL, `params=${encodeURIComponent(eapiParams)}`, { 'Cookie': cookie })
        if (!eapiRes) continue
        const url = parseNeteasePlayUrl(new TextDecoder().decode(eapiRes.data))
        if (url) {
            const audio = await downloadAudioFrom(url, onProgress, '正在下载无损音频')
            if (audio) return audio
        }
    }

    // 3. weapi 320k
    const weapiReq = JSON.stringify({ ids: [String(songId)], br: 320000 })
    const weapi = encryptWeApi(weapiReq)
    const weapiBody = `params=${encodeURIComponent(weapi.params)}&encSecKey=${encodeURIComponent(weapi.encSecKey)}`
    const weapiRes = await httpPost(NETEASE_WEAPI_URL, weapiBody, { 'Cookie': cookie })
    if (!weapiRes) return null
    const weapiUrl = parseNeteasePlayUrl(new TextDecoder().decode(weapiRes.data))
    if (!weapiUrl) return null
    return downloadAudioFrom(weapiUrl, onProgress, '正在下载 VIP 音频')
}

/** 解析网易云播放 URL 响应：`data[0].url` 空串/非 200 → 无权限 */
function parseNeteasePlayUrl(raw: string): string {
    try {
        const data = JSON.parse(raw)
        if (Number(data?.code ?? 0) !== 200) return ''
        const url: string = data?.data?.[0]?.url ?? ''
        return /^https?:\/\//i.test(url) ? url : ''
    } catch {
        return ''
    }
}

/** 下载音频字节（带进度回调 label）；校验大小与 content-type */
async function downloadAudioFrom(
    url: string,
    onProgress: (received: number, total: number | null, label: string) => void,
    label: string,
): Promise<Uint8Array | null> {
    const res = await httpGet(url, 0, (received, total) => onProgress(received, total, label))
    if (!res || res.data.byteLength < MIN_AUDIO_BYTES) return null
    const ct = res.headers['content-type'] ?? ''
    if (ct && !ct.startsWith('audio/')) return null
    return res.data
}

/**
 * 下载后内嵌标签（QQ/酷狗/酷我共用）：并行拉取歌词（各平台接口）+ 封面，
 * 连同标题/歌手/专辑一并内嵌（mp3→node-id3，m4a→writeMp4Tags）。
 * 返回内嵌后字节 + 是否真正内嵌 + 歌词/封面是否取得（供结果消息如实标注）。
 */
async function enrichDownloadTags(
    song: DownloadSong,
    audio: Uint8Array,
    onProgress?: DownloadProgressCallback,
): Promise<{ data: Uint8Array; embedded: boolean; lyric: string | null; cover: { mime: string; data: Uint8Array } | null }> {
    onProgress?.(null, '正在获取歌词与封面…')
    const [lyric, cover] = await Promise.all([
        fetchSongLyrics(song).catch(() => null),
        song.coverUrl ? downloadImage(song.coverUrl).catch(() => null) : Promise.resolve(null),
    ])
    onProgress?.(null, '正在内嵌标签…')
    const tags: Mp3Tags = {
        title: song.name,
        artist: song.artist,
        album: song.album,
        lyrics: lyric ?? undefined,
        cover: cover ?? undefined,
    }
    const enriched = embedTagsIntoBytes(audio, tags)
    return { data: enriched ?? audio, embedded: !!enriched, lyric, cover }
}

// --- QQ 音乐 ---

/** 下载 QQ 歌曲到 vault（需登录 Cookie）；m4a 无法用 node-id3 内嵌标签，按实际格式决定扩展名 */
async function downloadQq(
    plugin: LyricsPlugin,
    song: DownloadSong,
    cookies: Record<string, string>,
    onProgress?: DownloadProgressCallback,
): Promise<{ ok: boolean; message: string }> {
    const qqCookie = (cookies.qq ?? '').trim()
    if (!qqCookie) {
        return { ok: false, message: '下载 QQ 歌曲需在设置 → 多平台 Cookie 粘贴 QQ 音乐登录 Cookie' }
    }
    onProgress?.(null, '正在获取 QQ 播放地址…')
    const guid = makeGuid()
    const uin = extractQqUin(qqCookie)
    const vkeyUrl = buildQqVkeyUrl(buildQqVkeyBody(song.songmid ?? '', guid, uin))
    const vkeyRes = await httpGet(vkeyUrl, 0, undefined, { 'Referer': QQ_REFERER, 'Cookie': qqCookie })
    if (!vkeyRes) return { ok: false, message: '获取 QQ 播放地址失败' }
    const purl = parseQqPurl(new TextDecoder().decode(vkeyRes.data))
    if (!purl) return { ok: false, message: 'QQ Cookie 无效或已过期，请到 y.qq.com 重新登录复制' }
    const audioUrl = /^https?:\/\//i.test(purl) ? purl : `https://dl.stream.qqmusic.qq.com/${purl}`
    onProgress?.(null, '正在下载 QQ 音频…')
    const audioRes = await httpGet(audioUrl, 0, (received, total) => {
        if (total && total > 0) onProgress?.(Math.min(100, Math.round((received / total) * 100)), '正在下载 QQ 音频')
        else onProgress?.(null, '正在下载 QQ 音频…')
    }, { 'Referer': QQ_REFERER, 'Cookie': qqCookie })
    const audio = audioRes?.data
    if (!audio || audio.byteLength < MIN_AUDIO_BYTES) return { ok: false, message: '下载失败（可能付费受限或 Cookie 权限不足）' }
    const isMp3 = looksLikeMp3(audio)
    const isM4a = looksLikeM4a(audio)
    const ext = isMp3 ? 'mp3' : isM4a ? 'm4a' : 'mp3'
    let data = audio
    let metaNote = ''
    if (isMp3 || isM4a) {
        const enriched = await enrichDownloadTags(song, audio, onProgress)
        data = enriched.data
        metaNote = enriched.embedded
            ? (enriched.lyric && enriched.cover ? '（已内嵌歌词+封面）' : enriched.lyric ? '（已内嵌歌词）' : enriched.cover ? '（已内嵌封面）' : '')
            : '（未内嵌标签）'
    }
    const targetPath = await resolveDownloadTargetUnique(plugin, buildSongFilename(song.artist, song.name, ext), 'qq')
    const ok = await writeAudioToVault(plugin.app, targetPath, data)
    if (!ok) return { ok: false, message: '写入失败，已还原原文件' }
    void plugin.scanLyricSongs()
    return { ok: true, message: `已下载 QQ（${ext}）${formatBytes(data.byteLength)}：${targetPath}${metaNote}` }
}

// --- 酷狗 ---

/** 下载酷狗歌曲到 vault（免登录，免费通道）：getSongInfo.php → trackercdn v2 兜底 */
async function downloadKugou(
    plugin: LyricsPlugin,
    song: DownloadSong,
    onProgress?: DownloadProgressCallback,
): Promise<{ ok: boolean; message: string }> {
    if (song.vip) {
        return { ok: false, message: '该酷狗歌曲为 VIP 付费曲目，无法免费下载' }
    }
    const hash = song.id || ''
    if (!hash) return { ok: false, message: '缺少酷狗歌曲 hash' }

    onProgress?.(null, '正在获取酷狗播放地址…')
    // 优先移动端 getSongInfo.php；VIP/失败则 trackercdn 兜底
    let info = { url: '' }
    const songInfoRes = await httpGet(buildKugouSongInfoUrl(hash), 0, undefined, {
        'User-Agent': KUGOU_MOBILE_UA,
        'Referer': KUGOU_MOBILE_REFERER,
    })
    if (songInfoRes) {
        info = parseKugouSongInfoResponse(new TextDecoder().decode(songInfoRes.data))
    }
    if (!info.url) {
        const trRes = await httpGet(buildKugouTrackercdnUrl(hash), 0, undefined, {
            'User-Agent': UA,
            'Referer': KUGOU_PC_REFERER,
        })
        if (trRes) info = parseKugouTrackercdnResponse(new TextDecoder().decode(trRes.data))
    }
    if (!info.url) return { ok: false, message: '获取酷狗播放地址失败（可能 VIP 受限或接口变更）' }

    onProgress?.(null, '正在下载酷狗音频…')
    const audioRes = await httpGet(info.url, 0, (received, total) => {
        if (total && total > 0) onProgress?.(Math.min(100, Math.round((received / total) * 100)), '正在下载酷狗音频')
        else onProgress?.(null, '正在下载酷狗音频…')
    }, { 'User-Agent': UA, 'Referer': KUGOU_PC_REFERER })
    const audio = audioRes?.data
    if (!audio || audio.byteLength < MIN_AUDIO_BYTES) return { ok: false, message: '下载失败（可能受限或接口变更）' }

    const isMp3 = looksLikeMp3(audio)
    const isM4a = looksLikeM4a(audio)
    const ext = isMp3 ? 'mp3' : isM4a ? 'm4a' : 'mp3'
    let data = audio
    let metaNote = ''
    if (isMp3 || isM4a) {
        const enriched = await enrichDownloadTags(song, audio, onProgress)
        data = enriched.data
        metaNote = enriched.embedded
            ? (enriched.lyric && enriched.cover ? '（已内嵌歌词+封面）' : enriched.lyric ? '（已内嵌歌词）' : enriched.cover ? '（已内嵌封面）' : '')
            : '（未内嵌标签）'
    }
    const targetPath = await resolveDownloadTargetUnique(plugin, buildSongFilename(song.artist, song.name, ext), 'kugou')
    const ok = await writeAudioToVault(plugin.app, targetPath, data)
    if (!ok) return { ok: false, message: '写入失败，已还原原文件' }
    void plugin.scanLyricSongs()
    return { ok: true, message: `已下载酷狗（${ext}）${formatBytes(data.byteLength)}：${targetPath}${metaNote}` }
}

// --- 酷我 ---

/** 下载酷我歌曲到 vault（免登录，mobi.s 车载通道）：按 128→320→flac 逐级降级取首个可用直链 */
async function downloadKuwo(
    plugin: LyricsPlugin,
    song: DownloadSong,
    onProgress?: DownloadProgressCallback,
): Promise<{ ok: boolean; message: string }> {
    const rid = song.kuwoRid || song.id || ''
    if (!rid) return { ok: false, message: '缺少酷我歌曲 rid' }

    onProgress?.(null, '正在获取酷我播放地址…')
    let audioUrl = ''
    let quality = ''
    for (const br of KUWO_QUALITIES) {
        const res = await httpGet(buildKuwoMobiUrl(rid, br, makeKuwoUser()), 0, undefined, { 'User-Agent': KUWO_UA })
        if (!res) continue
        const info = parseKuwoMobiResponse(new TextDecoder().decode(res.data))
        if (info.url) {
            audioUrl = info.url
            quality = br
            break
        }
    }
    if (!audioUrl) return { ok: false, message: '获取酷我播放地址失败（可能版权受限）' }

    onProgress?.(null, '正在下载酷我音频…')
    const audioRes = await httpGet(audioUrl, 0, (received, total) => {
        if (total && total > 0) onProgress?.(Math.min(100, Math.round((received / total) * 100)), '正在下载酷我音频')
        else onProgress?.(null, '正在下载酷我音频…')
    }, { 'User-Agent': KUWO_UA })
    const audio = audioRes?.data
    if (!audio || audio.byteLength < MIN_AUDIO_BYTES) return { ok: false, message: '下载失败（可能版权受限）' }

    const isMp3 = looksLikeMp3(audio)
    const isM4a = looksLikeM4a(audio)
    const ext = isMp3 ? 'mp3' : isM4a ? 'm4a' : 'mp3'
    let data = audio
    let metaNote = ''
    if (isMp3 || isM4a) {
        const enriched = await enrichDownloadTags(song, audio, onProgress)
        data = enriched.data
        metaNote = enriched.embedded
            ? (enriched.lyric && enriched.cover ? '（已内嵌歌词+封面）' : enriched.lyric ? '（已内嵌歌词）' : enriched.cover ? '（已内嵌封面）' : '')
            : '（未内嵌标签）'
    }
    const targetPath = await resolveDownloadTargetUnique(plugin, buildSongFilename(song.artist, song.name, ext), 'kuwo')
    const ok = await writeAudioToVault(plugin.app, targetPath, data)
    if (!ok) return { ok: false, message: '写入失败，已还原原文件' }
    void plugin.scanLyricSongs()
    return { ok: true, message: `已下载酷我（${quality}→${ext}）${formatBytes(data.byteLength)}：${targetPath}${metaNote}` }
}

/** MP3 判别：ID3 头 或 MPEG 帧同步；m4a 判别：ftyp box；flac 判别：`fLaC` 魔数（VIP 无损） */
function looksLikeMp3(b: Uint8Array): boolean {
    if (b.length < 2) return false
    if (b[0] === 0x49 && b[1] === 0x44) return true // 'ID'
    return b[0] === 0xff && (b[1] & 0xe0) === 0xe0
}
function looksLikeM4a(b: Uint8Array): boolean {
    return b.length >= 8 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70 // 'ftyp'
}
function looksLikeFlac(b: Uint8Array): boolean {
    return b.length >= 4 && b[0] === 0x66 && b[1] === 0x4c && b[2] === 0x61 && b[3] === 0x43 // 'fLaC'
}

// --- 通用 HTTP ---

/** keep-alive agent 池（http/https 各一）：复用 TCP+TLS 连接，减少连续请求（搜索/歌单）的握手延迟 */
const keepAliveAgents: Record<string, any> = {}
function getKeepAliveAgent(isHttps: boolean): any {
    const key = isHttps ? 'https' : 'http'
    if (!keepAliveAgents[key]) {
        try {
            const mod = (window as any).require(isHttps ? 'https' : 'http')
            keepAliveAgents[key] = new mod.Agent({ keepAlive: true, maxSockets: 8 })
        } catch {
            keepAliveAgents[key] = undefined
        }
    }
    return keepAliveAgents[key]
}

// --- 在线翻译（v1.4.2）：主 Google、失败降级 MyMemory，可选 DeepSeek（API Key） ---

/**
 * 翻译一段文本到目标语言（默认中文）。先 Google translate_a/single，失败降级 MyMemory。
 * 显式指定 DeepSeek 时走 chat/completions（需 API Key），失败降级 MyMemory。
 * 都失败返回 null（调用方提示网络错误）。
 */
export async function translateText(
    text: string,
    target: string = 'zh-CN',
    provider: TranslateProvider = 'auto',
    apiKey?: string,
    prompt?: string,
    signal?: AbortSignal,
): Promise<string | null> {
    const textTrim = text.trim()
    if (!textTrim) return null
    // 显式指定 provider 时只试该源；auto 时按 Google → MyMemory 降级
    if (provider === 'google') return await translateGoogle(textTrim, target, signal) ?? await translateMyMemory(textTrim, target, signal)
    if (provider === 'mymemory') return await translateMyMemory(textTrim, target, signal)
    if (provider === 'deepseek') return await translateDeepseek(textTrim, target, apiKey ?? '', prompt) ?? await translateMyMemory(textTrim, target, signal)
    // auto：Google 优先，失败降级 MyMemory
    return await translateGoogle(textTrim, target, signal) ?? await translateMyMemory(textTrim, target, signal)
}

/**
 * 测试翻译源是否可用（设置页翻译「测试连接」按钮调用）。
 * 用固定测试词「测试」试译到英文；返回 { ok, message }（含测试耗时）。
 * DeepSeek **只测该源本身**（不降级 MyMemory），避免填错 API Key 被免 key 兜底误报「可用」。
 */
export async function testTranslateConnection(
    provider: TranslateProvider,
    apiKey?: string,
    prompt?: string,
): Promise<{ ok: boolean; message: string }> {
    const started = Date.now()
    const cost = () => `${Date.now() - started}ms`
    const label = provider === 'google' ? 'Google' : provider === 'deepseek' ? 'DeepSeek' : 'MyMemory'
    // DeepSeek 需 API Key 才可用：未配置直接提示，避免误报「可用」
    if (provider === 'deepseek' && !(apiKey && apiKey.trim())) {
        return { ok: false, message: `${label} 未配置 API Key：请先填入 Key 再测试` }
    }
    // DeepSeek 只调源本身：填错 Key → DeepSeek 请求失败 → 直接判不可用，绝不降级 MyMemory
    if (provider === 'deepseek') {
        const result = await translateDeepseek('测试', 'en', apiKey ?? '', prompt)
        if (result) return { ok: true, message: `${label} 翻译可用（示例：测试 → ${result}，耗时 ${cost()}）` }
        return { ok: false, message: `${label} 请求失败（网络或 Key 无效或接口变更，耗时 ${cost()}）` }
    }
    // Google/MyMemory/auto：显式源直接试译（Google 失败自动降级 MyMemory 属源本身不可达）；auto 用 Google→MyMemory 链路
    const p = provider === 'auto' ? 'auto' : provider
    const result = await translateText('测试', 'en', p, apiKey, prompt)
    if (result) return { ok: true, message: `${label} 翻译可用（示例：测试 → ${result}，耗时 ${cost()}）` }
    return { ok: false, message: `${label} 请求失败（网络或接口变更，耗时 ${cost()}）` }
}

/** Google 翻译（translate_a/single；国内可能不可达） */
async function translateGoogle(text: string, target: string, signal?: AbortSignal): Promise<string | null> {
    try {
        const res = await httpGetTextChecked(buildGoogleTranslateUrl(text, target), { Referer: 'https://translate.google.com/' }, signal)
        if (!res.failed) {
            const parsed = parseGoogleTranslateResponse(res.text)
            if (parsed) return parsed
        }
    } catch { /* 降级 */ }
    return null
}

/** MyMemory 翻译（国内可达，免 key） */
async function translateMyMemory(text: string, target: string, signal?: AbortSignal): Promise<string | null> {
    try {
        const res = await httpGetTextChecked(buildMyMemoryUrl(text, target), undefined, signal)
        if (!res.failed) {
            const parsed = parseMyMemoryResponse(res.text)
            if (parsed) return parsed
        }
    } catch { /* 返回 null */ }
    return null
}

/** DeepSeek 翻译（chat/completions；未配置 API Key 视为不可用，失败降级 MyMemory） */
async function translateDeepseek(text: string, target: string, apiKey: string, prompt?: string): Promise<string | null> {
    if (!apiKey || !apiKey.trim()) return null
    try {
        const req = buildDeepseekRequest(text, apiKey, prompt ?? '', target)
        const res = await httpPost(req.url, req.body, req.headers)
        if (res) {
            const parsed = parseDeepseekResponse(new TextDecoder().decode(res.data))
            if (parsed) return parsed
        }
    } catch { /* 降级 */ }
    return null
}

/** 逐行翻译歌词并拼成 `原文 | 译文` 双语 LRC；单行失败保留原文；全部失败返回 null。
 *  onProgress(done,total) 每批完成后回调供 UI 显示进度；isCancelled 回调返回 true / signal.aborted 时立即中断（保留已翻译部分）。
 *  apiKey/prompt 传给需要 Key 的翻译源（DeepSeek）；signal 用于中止在途 DeepSeek 请求（取消立即生效，不再等超时）。
 *  onReasoning 透传给 DeepSeek 流式请求：每收到新增思考文本（reasoning_content）即回调供 UI 实时显示。
 *  DeepSeek 走**整首一次翻译**（分批 ≤10 行），避免逐行请求时模型把每行当独立对话、回复「请提供歌词」等废话。
 *  元数据标签行（[ti:][ar:] 等）拆分后原样保留不翻译；DeepSeek 自定义提示词导致整首拒绝/垃圾输出时用默认提示词自动重试一次。 */
export async function translateLyricText(
    lrc: string,
    target: string = 'zh-CN',
    onProgress?: (done: number, total: number) => void,
    provider: TranslateProvider = 'auto',
    isCancelled?: () => boolean,
    apiKey?: string,
    prompt?: string,
    signal?: AbortSignal,
    onReasoning?: (text: string) => void,
): Promise<string | null> {
    const lines = parseLyricLines(lrc)
    if (lines.length === 0) return null
    // 拆分可翻译行与元数据标签行（[ti:][ar:] 等原样保留不翻译）
    const { content, meta } = splitLyricLines(lines)
    const contentLines = content.map((c) => c.line)
    if (contentLines.length === 0) return null
    onProgress?.(0, contentLines.length)

    // DeepSeek：整首一次请求传完所有行（不分批），每行带编号、要求每行仅输出译文
    if (provider === 'deepseek') {
        if (!apiKey || !apiKey.trim()) return null
        let translations = await translateDeepseekLyricsStreaming(contentLines, target, apiKey, prompt ?? '', signal, onReasoning)
        // 自定义提示词导致模型整首未按格式返回（全部拒绝/垃圾输出）：用默认提示词自动重试一次（用户已取消则跳过）
        if (prompt && prompt.trim() && isAllRejected(translations) && !signal?.aborted) {
            translations = await translateDeepseekLyricsStreaming(contentLines, target, apiKey, '', signal, onReasoning)
        }
        const translated = content.map((c, i) => ({
            time: c.line.time,
            text: c.line.text,
            translation: translations[i] ?? undefined,
        }))
        if (!translated.some((t) => t.translation)) return null
        return buildBilingualLrc(mergeTranslatedRows(lines, meta, translated))
    }

    // 其他源（Google/MyMemory/auto）：逐行并发翻译（控制并发避免限流）
    const translated: Array<{ time: string; text: string; translation?: string }> = []
    const CHUNK = 5
    for (let i = 0; i < contentLines.length; i += CHUNK) {
        if (isCancelled?.() || signal?.aborted) break // 中断：保留已翻译部分
        const chunk = contentLines.slice(i, i + CHUNK)
        const results = await Promise.all(chunk.map(async (l) => ({
            time: l.time,
            text: l.text,
            translation: (await translateText(l.text, target, provider, apiKey, prompt, signal)) ?? undefined,
        })))
        translated.push(...results)
        onProgress?.(Math.min(i + chunk.length, contentLines.length), contentLines.length)
    }
    // 全部中断且无任何翻译结果时返回 null；有部分结果则返回（未翻译行原样保留）
    return translated.some((t) => t.translation) ? buildBilingualLrc(mergeTranslatedRows(lines, meta, translated)) : null
}

/**
 * DeepSeek 整首歌词翻译（流式版，v1.4.3）：`stream: true` 实时返回 reasoning_content/content 分片，
 * onReasoning 每收到新增思考文本即回调（供 UI 实时显示）；结束用累计 content 走既有逐行解析。
 * 模型不返回思考过程时 onReasoning 不触发（UI 保持隐藏，无副作用）。
 */
async function translateDeepseekLyricsStreaming(
    contentLines: Array<{ time: string; text: string }>,
    target: string,
    apiKey: string,
    prompt: string,
    signal?: AbortSignal,
    onReasoning?: (text: string) => void,
): Promise<Array<string | null>> {
    if (signal?.aborted) return contentLines.map(() => null)
    const numbered = contentLines.map((l, i) => `${i + 1}. ${l.text}`).join('\n')
    const req = buildDeepseekRequest(numbered, apiKey, prompt, target, true)
    try {
        const acc = new DeepseekSseAccumulator()
        const res = await httpPost(req.url, req.body, req.headers, signal, 120000, (chunk) => {
            const added = acc.push(chunk)
            if (added && onReasoning) onReasoning(added)
        })
        if (res && acc.content.trim()) {
            return splitDeepseekLyricsResponse(acc.content, contentLines.length)
        }
    } catch { /* 失败 → 全部判 null，保留原文 */ }
    return contentLines.map(() => null)
}

// --- 在线歌词（v1.4.1）：四平台歌词获取（编辑标签「获取歌词」/ 翻译用） ---

/**
 * 按来源拉取歌词（LRC 文本）：网易云 song/lyric、QQ fcg_query_lyric_new、
 * 酷狗 lyrics.kugou.com search+download、酷我 songinfoandlrc。
 * 均免登录；各平台接口偶发限流/空响应，酷狗做候选遍历 + 一次重试。
 */
export async function fetchSongLyrics(song: DownloadSong): Promise<string | null> {
    try {
        switch (song.source) {
            case 'netease': {
                if (!song.neteaseId) return null
                return await fetchLyric(song.neteaseId).catch(() => null)
            }
            case 'qq': {
                const text = await httpGetText(buildQqLyricUrl(song.songmid ?? ''), { Referer: QQ_REFERER })
                return parseQqLyricResponse(text)
            }
            case 'kugou': {
                return await fetchKugouLyrics(song)
            }
            case 'kuwo': {
                const text = await httpGetText(buildKuwoLyricUrl(song.kuwoRid ?? song.id), { Referer: 'http://www.kuwo.cn/' })
                return parseKuwoLyricResponse(text)
            }
            default:
                return null
        }
    } catch {
        return null
    }
}

/** 酷狗歌词：search 拿候选（多次遍历不同 keyword）→ download 取内容；接口偶发空响应，一次重试 */
async function fetchKugouLyrics(song: DownloadSong): Promise<string | null> {
    const keywords = [song.name, `${song.name} ${song.artist}`, `${song.name}-${song.artist}`].filter(Boolean)
    for (let attempt = 0; attempt < 2; attempt++) {
        for (const kw of keywords) {
            try {
                const searchText = await httpGetText(buildKugouLyricSearchUrl(kw), { Referer: KUGOU_PC_REFERER })
                const cands = parseKugouLyricSearch(searchText)
                for (const c of cands) {
                    const dlText = await httpGetText(buildKugouLyricDownloadUrl(c.id, c.accesskey), { Referer: KUGOU_PC_REFERER })
                    const lrc = parseKugouLyricDownload(dlText)
                    if (lrc) return lrc
                }
            } catch { /* 单候选失败继续 */ }
        }
    }
    return null
}

/** GET 拿字节+响应头：Node http/https（绕过 CSP、可带 Referer/Cookie）优先，失败回退浏览器 fetch */
async function httpGet(
    url: string,
    depth: number,
    onProgress?: (received: number, total: number | null) => void,
    extraHeaders?: Record<string, string>,
    signal?: AbortSignal,
    timeoutMs = 60000,
): Promise<HttpResult | null> {
    try {
        const r = (window as any).require
        if (typeof r === 'function' && (r('https')?.request || r('http')?.request)) {
            return await nodeGet(url, depth, onProgress, extraHeaders, signal, timeoutMs)
        }
    } catch { /* 回退 fetch */ }
    return fetchGet(url, onProgress, extraHeaders, signal, timeoutMs)
}

async function httpGetText(url: string, extraHeaders?: Record<string, string>, signal?: AbortSignal): Promise<string> {
    const res = await httpGet(url, 0, undefined, extraHeaders, signal)
    return res ? new TextDecoder('utf-8').decode(res.data) : ''
}

/** GET 文本 + 失败标记：网络/HTTP 层失败（res 为 null）置 failed=true，供调用方区分「请求失败」与「返回空结果」 */
async function httpGetTextChecked(url: string, extraHeaders?: Record<string, string>, signal?: AbortSignal): Promise<{ text: string; failed: boolean }> {
    const res = await httpGet(url, 0, undefined, extraHeaders, signal)
    if (!res) return { text: '', failed: true }
    return { text: new TextDecoder('utf-8').decode(res.data), failed: false }
}

function nodeGet(
    url: string,
    depth: number,
    onProgress?: (received: number, total: number | null) => void,
    extraHeaders?: Record<string, string>,
    signal?: AbortSignal,
    timeoutMs = 60000,
): Promise<HttpResult | null> {
    return new Promise((resolve) => {
        if (depth > 6) { resolve(null); return }
        let u: URL
        try { u = new URL(url) } catch { resolve(null); return }
        const isHttps = u.protocol === 'https:'
        const mod = (window as any).require(isHttps ? 'https' : 'http')
        const req = mod.request({
            hostname: u.hostname,
            port: u.port || (isHttps ? 443 : 80),
            path: u.pathname + u.search,
            method: 'GET',
            agent: getKeepAliveAgent(isHttps),
            headers: { 'User-Agent': UA, Referer: REFERER, ...extraHeaders },
        }, (res: any) => {
            const status = res.statusCode ?? 0
            const loc = res.headers?.location
            if (status >= 300 && status < 400 && loc) {
                res.resume()
                const next = /^https?:\/\//i.test(loc) ? loc : new URL(loc, url).toString()
                resolve(nodeGet(next, depth + 1, onProgress, extraHeaders, signal, timeoutMs))
                return
            }
            if (status !== 200) { res.resume(); resolve(null); return }
            let total: number | null = null
            const cr = res.headers?.['content-range']
            if (typeof cr === 'string') {
                const m = /\/\s*(\d+)\s*$/.exec(cr)
                if (m) total = Number(m[1])
            }
            if (total === null) {
                const cl = res.headers?.['content-length']
                if (typeof cl === 'string' && cl) total = Number(cl)
            }
            if (total === null || !Number.isFinite(total)) total = null
            const headers: Record<string, string> = {}
            for (const k of Object.keys(res.headers ?? {})) {
                const v = res.headers[k]
                if (typeof v === 'string') headers[k.toLowerCase()] = v
                else if (Array.isArray(v)) headers[k.toLowerCase()] = v.join(',')
            }
            const chunks: Buffer[] = []
            let received = 0
            res.on('data', (c: Buffer) => {
                chunks.push(c)
                received += c.length
                onProgress?.(received, total)
            })
            res.on('end', () => resolve({ status, data: new Uint8Array(Buffer.concat(chunks)), headers }))
            res.on('aborted', () => resolve(null))
            res.on('error', () => resolve(null))
            res.on('close', () => resolve(null))
        })
        req.setTimeout(timeoutMs, () => req.destroy())
        if (signal) {
            if (signal.aborted) { req.destroy(); resolve(null); return }
            signal.addEventListener('abort', () => req.destroy(), { once: true })
        }
        req.on('error', () => resolve(null))
        req.end()
    })
}

async function fetchGet(
    url: string,
    onProgress?: (received: number, total: number | null) => void,
    extraHeaders?: Record<string, string>,
    signal?: AbortSignal,
    timeoutMs = 60000,
): Promise<HttpResult | null> {
    try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeoutMs)
        if (signal) {
            if (signal.aborted) { clearTimeout(timer); return null }
            signal.addEventListener('abort', () => controller.abort(), { once: true })
        }
        try {
            const res = await fetch(url, { signal: controller.signal, headers: extraHeaders })
            if (!res.ok) return null
            const headers: Record<string, string> = {}
            res.headers.forEach((v, k) => { headers[k.toLowerCase()] = v })
            const totalStr = res.headers.get('content-length')
            const total = totalStr ? Number(totalStr) : null
            if (!res.body) return { status: res.status, data: new Uint8Array(await res.arrayBuffer()), headers }
            const reader = res.body.getReader()
            const parts: Uint8Array[] = []
            let received = 0
            for (;;) {
                const { done, value } = await reader.read()
                if (done) break
                if (value) {
                    parts.push(value)
                    received += value.byteLength
                    onProgress?.(received, Number.isFinite(total) ? total : null)
                }
            }
            const merged = new Uint8Array(received)
            let off = 0
            for (const p of parts) { merged.set(p, off); off += p.byteLength }
            return { status: res.status, data: merged, headers }
        } finally { clearTimeout(timer) }
    } catch {
        return null
    }
}

/**
 * POST 表单/JSON 拿响应字节：Node http/https 优先（绕过 CSP、可带 Referer/Cookie），失败回退浏览器 fetch。
 * 供网易云 weapi/eapi（VIP 下载）使用。
 */
async function httpPost(
    url: string,
    body: string,
    extraHeaders?: Record<string, string>,
    signal?: AbortSignal,
    timeoutMs = 60000,
    onChunk?: (text: string) => void,
): Promise<HttpResult | null> {
    try {
        const r = (window as any).require
        if (typeof r === 'function' && (r('https')?.request || r('http')?.request)) {
            return await nodePost(url, body, extraHeaders, signal, timeoutMs, onChunk)
        }
    } catch { /* 回退 fetch */ }
    return fetchPost(url, body, extraHeaders, signal, timeoutMs, onChunk)
}

function nodePost(
    url: string,
    body: string,
    extraHeaders?: Record<string, string>,
    signal?: AbortSignal,
    timeoutMs = 60000,
    onChunk?: (text: string) => void,
): Promise<HttpResult | null> {
    return new Promise((resolve) => {
        let u: URL
        try { u = new URL(url) } catch { resolve(null); return }
        const isHttps = u.protocol === 'https:'
        const mod = (window as any).require(isHttps ? 'https' : 'http')
        const sseDecoder = new TextDecoder('utf-8')
        const req = mod.request({
            hostname: u.hostname,
            port: u.port || (isHttps ? 443 : 80),
            path: u.pathname + u.search,
            method: 'POST',
            agent: getKeepAliveAgent(isHttps),
            headers: {
                'User-Agent': UA,
                Referer: REFERER,
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(body),
                ...extraHeaders,
            },
        }, (res: any) => {
            const status = res.statusCode ?? 0
            const loc = res.headers?.location
            if (status >= 300 && status < 400 && loc) {
                res.resume()
                resolve(null) // POST 重定向（如登录跳转）直接视为失败，不跟随
                return
            }
            if (status !== 200) { res.resume(); resolve(null); return }
            const headers: Record<string, string> = {}
            for (const k of Object.keys(res.headers ?? {})) {
                const v = res.headers[k]
                if (typeof v === 'string') headers[k.toLowerCase()] = v
                else if (Array.isArray(v)) headers[k.toLowerCase()] = v.join(',')
            }
            const chunks: Buffer[] = []
            res.on('data', (c: Buffer) => {
                chunks.push(c)
                if (onChunk) onChunk(sseDecoder.decode(c, { stream: true }))
            })
            res.on('end', () => {
                if (onChunk) onChunk(sseDecoder.decode()) // 冲刷尾部未完整多字节字符
                resolve({ status, data: new Uint8Array(Buffer.concat(chunks)), headers })
            })
            res.on('aborted', () => resolve(null))
            res.on('error', () => resolve(null))
            res.on('close', () => resolve(null))
        })
        req.setTimeout(timeoutMs, () => req.destroy())
        // 外部取消：abort → destroy 请求（触发 error → resolve(null)），立即中断等待
        if (signal) {
            if (signal.aborted) { req.destroy(); resolve(null); return }
            signal.addEventListener('abort', () => req.destroy(), { once: true })
        }
        req.on('error', () => resolve(null))
        req.end(body)
    })
}

async function fetchPost(
    url: string,
    body: string,
    extraHeaders?: Record<string, string>,
    signal?: AbortSignal,
    timeoutMs = 60000,
    onChunk?: (text: string) => void,
): Promise<HttpResult | null> {
    try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeoutMs)
        // 外部取消：abort → 内部 controller 同步 abort（fetch 抛 AbortError → catch 返回 null）
        if (signal) {
            if (signal.aborted) { clearTimeout(timer); return null }
            signal.addEventListener('abort', () => controller.abort(), { once: true })
        }
        try {
            const res = await fetch(url, {
                method: 'POST',
                body,
                signal: controller.signal,
                headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...extraHeaders },
            })
            if (!res.ok) return null
            const headers: Record<string, string> = {}
            res.headers.forEach((v, k) => { headers[k.toLowerCase()] = v })
            // 流式（SSE）通道：onChunk 提供时逐块解码并实时回调，其余路径保持原逻辑
            if (onChunk) {
                if (!res.body) return null
                const reader = res.body.getReader()
                const decoder = new TextDecoder('utf-8')
                const parts: Uint8Array[] = []
                let received = 0
                for (;;) {
                    const { done, value } = await reader.read()
                    if (done) break
                    if (value) {
                        parts.push(value)
                        received += value.byteLength
                        onChunk(decoder.decode(value, { stream: true }))
                    }
                }
                onChunk(decoder.decode())
                const merged = new Uint8Array(received)
                let off = 0
                for (const p of parts) { merged.set(p, off); off += p.byteLength }
                return { status: res.status, data: merged, headers }
            }
            return { status: res.status, data: new Uint8Array(await res.arrayBuffer()), headers }
        } finally { clearTimeout(timer) }
    } catch {
        return null
    }
}

// --- 写盘 ---

/** 下载目标文件夹：并入「音频文件夹」（裸 MP3 歌单目录），下载即落歌单；为空则写 vault 根。
 *  库外盘符绝对路径的音频文件夹 → 返回盘符绝对目标路径（写盘走 fs 直写）；否则 vault 内相对路径。 */
async function resolveDownloadTarget(plugin: LyricsPlugin, filename: string): Promise<string> {
    const folder = (plugin.getSettings().audioFolder || '').trim()
    if (folder) {
        if (isWindowsAbsolutePath(folder)) {
            // 库外目录：确保存在（fs.mkdir recursive）
            try {
                const fs = (window as any).require('fs')
                await fs.promises.mkdir(folder, { recursive: true })
            } catch { /* 目录创建失败不阻断写入（写入时还会再试） */ }
            return `${folder.replace(/[\\/]+$/, '')}\\${filename}`
        }
        await ensureFolder(plugin.app, folder)
        return `${folder}/${filename}`
    }
    return filename
}

/** 来源 → 文件名冲突后缀（跨源同名歌曲避免互相覆盖） */
const SOURCE_SUFFIX: Record<string, string> = { netease: '网易云', qq: 'QQ', kugou: '酷狗', kuwo: '酷我' }

/** 目标文件是否已存在（vault 内 / 库外 fs） */
async function fileExists(plugin: LyricsPlugin, targetPath: string): Promise<boolean> {
    if (isWindowsAbsolutePath(targetPath)) {
        try {
            const fs = (window as any).require('fs')
            await fs.promises.access(targetPath)
            return true
        } catch {
            return false
        }
    }
    return plugin.app.vault.getAbstractFileByPath(targetPath) instanceof TFile
}

/** 解析下载目标：同名文件已存在时追加来源后缀（`artist - name (QQ).mp3`），仍冲突则递增 `(2) (3)…` 直到可用，避免覆盖已有文件 */
async function resolveDownloadTargetUnique(plugin: LyricsPlugin, filename: string, source: string): Promise<string> {
    const dot = filename.lastIndexOf('.')
    const base = dot > 0 ? filename.slice(0, dot) : filename
    const ext = dot > 0 ? filename.slice(dot) : ''
    const suffix = SOURCE_SUFFIX[source] ?? source
    let target = await resolveDownloadTarget(plugin, filename)
    for (let n = 1; await fileExists(plugin, target); n++) {
        // 首次冲突带来源后缀（晴天 (QQ).mp3），再次冲突递增序号（晴天 (QQ) (2).mp3）
        target = await resolveDownloadTarget(plugin, n === 1 ? `${base} (${suffix})${ext}` : `${base} (${suffix}) (${n})${ext}`)
    }
    return target
}

/** 写入音频字节：库外盘符绝对路径走 fs 直写；vault 内走 vault API。均带覆盖升级（备份→写入→校验→失败还原） */
export async function writeAudioToVault(
    app: App,
    targetPath: string,
    data: Uint8Array,
): Promise<boolean> {
    if (isWindowsAbsolutePath(targetPath)) {
        return writeAudioExternal(targetPath, data)
    }
    const existing = app.vault.getAbstractFileByPath(targetPath)
    let backup: ArrayBuffer | null = null
    if (existing instanceof TFile) {
        try { backup = await app.vault.readBinary(existing) } catch { /* 备份失败不阻断写入（仍有校验兜底） */ }
    }
    try {
        if (existing instanceof TFile) {
            await app.vault.modifyBinary(existing, data)
        } else {
            await app.vault.createBinary(targetPath, data)
        }
        const verify = app.vault.getAbstractFileByPath(targetPath)
        if (verify instanceof TFile) {
            const check = await app.vault.readBinary(verify)
            if (check.byteLength === data.byteLength) return true
        }
        await rollback(app, existing, backup)
        return false
    } catch {
        await rollback(app, existing, backup)
        return false
    }
}

/** 库外文件写盘：备份 → fs.writeFile → 回读校验长度 → 失败还原（覆盖升级语义） */
async function writeAudioExternal(targetPath: string, data: Uint8Array): Promise<boolean> {
    try {
        const fs = (window as any).require('fs')
        const buf = Buffer.from(data)
        let backup: Buffer | null = null
        try { backup = await fs.promises.readFile(targetPath) } catch { /* 新文件无旧内容 */ }
        try {
            await fs.promises.writeFile(targetPath, buf)
            const check = await fs.promises.readFile(targetPath)
            if (check.byteLength === buf.byteLength) return true
        } catch { /* 写失败走还原 */ }
        if (backup) { try { await fs.promises.writeFile(targetPath, backup) } catch { /* 还原失败忽略 */ } }
        return false
    } catch {
        return false
    }
}

async function rollback(app: App, existing: TAbstractFile | null, backup: ArrayBuffer | null): Promise<void> {
    try {
        if (existing instanceof TFile && backup) {
            await app.vault.modifyBinary(existing, backup)
        }
    } catch { /* 还原失败忽略（新文件无旧内容可还原） */ }
}
