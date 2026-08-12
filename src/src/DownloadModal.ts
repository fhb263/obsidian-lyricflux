import { App, Modal, Notice, setIcon } from 'obsidian'
import type LyricsPlugin from 'main'
import {
    searchCandidates, downloadSong, fetchRecommendedPlaylists, fetchPlaylistSongs, previewAudio,
    type DownloadSong, type RecommendedPlaylist, type PlaylistSource,
} from 'downloadManager'
import { formatDuration, songSimilarityScore } from 'downloadUtils'
import { formatBytes } from 'tagSize'

/** 实时搜索防抖时长（毫秒）：停止输入这么久后才真正发请求 */
const SEARCH_DEBOUNCE_MS = 300

/** 多源来源标签 */
const SOURCE_LABELS: Record<string, string> = {
    netease: '网易云',
    qq: 'QQ',
    kugou: '酷狗',
    kuwo: '酷我',
}

/** 无封面时的占位：灰底方形 + 音符图标 */
function renderCoverPlaceholder(el: HTMLElement): void {
    el.empty()
    el.addClass('lyrics-download-item-cover-placeholder')
    setIcon(el, 'music')
}

/**
 * 下载歌曲弹窗（v1.4.2）：多源（网易云/QQ/酷狗/酷我）。
 * 搜索框**边输入边出结果**（防抖 300ms，输一个字即可触发）：结果下拉在输入框下方，行内标注来源，
 * 点「下载」按来源分发（网易云免登录；QQ 需设置中粘贴 QQ 音乐 Cookie）。
 * **首屏展示推荐歌单**（无预填歌曲时自动加载，默认网易云）：头部四源胶囊点击切换 网易云/QQ/酷狗/酷我，
 * 点歌单查看其歌曲并逐首下载，可返回推荐歌单；「推荐歌单」按钮随时切回。
 * 搜索按钮保留用于强制刷新；下载过程显示进度条 + 阶段状态文字。
 * 歌单弹窗搜索框左侧的「下载」按钮打开。
 */
export default class DownloadModal extends Modal {
    private downloading = false
    private searchInput: HTMLInputElement | null = null
    private resultEl: HTMLElement | null = null
    private progressWrap: HTMLElement | null = null
    private progressFill: HTMLElement | null = null
    private progressText: HTMLElement | null = null
    /** 试听（v1.4.1）：当前播放的 audio 元素与关联行 key（`${source}:${id}`），null=无播放 */
    private previewAudio: HTMLAudioElement | null = null
    private previewKey = ''
    /** 试听 blob URL：停止时显式 revokeObjectURL 立即释放（避免残留未回收的 URL 对象） */
    private previewBlobUrl = ''
    /** 实时搜索防抖定时器 */
    private debounceTimer: number | null = null
    /** 搜索代际令牌：新搜索使在途旧搜索结果作废 */
    private searchSeq = 0
    /** 推荐歌单代际令牌：切换来源/刷新使在途旧歌单请求作废（防慢来源覆盖新选中来源） */
    private playlistSeq = 0
    /** 结果区当前模式：'search' 搜索结果 / 'playlists' 推荐歌单首屏 / 'playlist' 歌单歌曲 */
    private mode: 'search' | 'playlists' | 'playlist' = 'search'
    /** 当前展示的推荐歌单来源（首屏胶囊切换） */
    private currentSource: PlaylistSource = 'netease'
    /** 已加载的推荐歌单（免登录，缓存避免重复请求） */
    private playlists: RecommendedPlaylist[] = []
    /** 推荐歌单缓存（按 source）：切换胶囊/返回首屏命中直接渲染，不重复请求 */
    private playlistCache: Partial<Record<PlaylistSource, RecommendedPlaylist[]>> = {}
    /** 歌单歌曲缓存（key=`${source}:${id}`）：返回/重开命中直接渲染 */
    private playlistSongsCache: Record<string, DownloadSong[]> = {}
    /** 当前打开的歌单（歌单歌曲视图的返回目标） */
    private currentPlaylist: RecommendedPlaylist | null = null
    /** 搜索渐进渲染去重：已渲染的行 key（`${source}:${id}`），每次新搜索清空 */
    private pendingSeen = new Set<string>()
    /** 渐进增量排序：已到达的搜索结果（按相似度有序），每批到达插入正确位置，最终不再重排 */
    private pendingResults: DownloadSong[] = []
    /** 渐进渲染当前关键词（用于增量排序打分） */
    private pendingKeyword = ''

    constructor(app: App, private plugin: LyricsPlugin) {
        super(app)
    }

    async onOpen() {
        this.contentEl.empty()
        this.contentEl.addClass('lyrics-download-modal')
        this.titleEl.setText('下载歌曲')

        const { contentEl } = this

        // 预填当前播放歌曲（歌名 + 艺术家合并为搜索词）
        const state = this.plugin.getLyricsState()
        const preset = [
            state?.title && state.title !== '未知歌曲' ? state.title : '',
            state?.actor && state.actor !== '未知艺术家' ? state.actor : '',
        ].filter(Boolean).join(' ')

        // 搜索框 + 右侧搜索按钮：输入即触发实时搜索（防抖），回车/按钮强制立即搜索
        const searchRow = contentEl.createDiv({ cls: 'lyrics-download-search' })
        this.searchInput = searchRow.createEl('input', {
            cls: 'lyrics-download-search-input',
            attr: { type: 'text', placeholder: '输入歌名 / 歌手，如：晴天 周杰伦' },
        })
        this.searchInput.value = preset
        const searchBtn = searchRow.createEl('button', { text: '搜索', cls: 'mod-cta lyrics-download-search-btn' })
        // 「推荐歌单」按钮：随时切回首屏推荐歌单（输入搜索时自动切回搜索结果）
        const recommendBtn = searchRow.createEl('button', { text: '推荐歌单', cls: 'lyrics-download-recommend-btn' })
        recommendBtn.addEventListener('click', () => {
            if (this.debounceTimer !== null) {
                window.clearTimeout(this.debounceTimer)
                this.debounceTimer = null
            }
            void this.loadRecommendedPlaylists(this.currentSource)
        })
        const searchNow = () => {
            if (this.debounceTimer !== null) {
                window.clearTimeout(this.debounceTimer)
                this.debounceTimer = null
            }
            void this.doSearch()
        }
        searchBtn.addEventListener('click', searchNow)
        this.searchInput.addEventListener('input', () => this.scheduleSearch())
        this.searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') searchNow()
        })

        // 进度条（默认隐藏，下载时显示）
        this.progressWrap = contentEl.createDiv({ cls: 'lyrics-download-progress lyrics-download-progress-hidden' })
        const track = this.progressWrap.createDiv({ cls: 'lyrics-download-progress-track' })
        this.progressFill = track.createDiv({ cls: 'lyrics-download-progress-fill' })
        this.progressText = this.progressWrap.createDiv({ cls: 'lyrics-download-progress-text' })

        // 结果下拉（输入框正下方，实时更新）
        this.resultEl = contentEl.createDiv({ cls: 'lyrics-download-results' })

        // 预填了当前歌曲时自动搜索一次；否则首屏展示网易云推荐歌单
        if (preset) void this.doSearch()
        else void this.loadRecommendedPlaylists('netease')
    }

    /** 停止输入 SEARCH_DEBOUNCE_MS 后触发搜索 */
    private scheduleSearch(): void {
        if (this.debounceTimer !== null) window.clearTimeout(this.debounceTimer)
        this.debounceTimer = window.setTimeout(() => {
            this.debounceTimer = null
            void this.doSearch()
        }, SEARCH_DEBOUNCE_MS)
    }

    /** 用当前输入值实时搜索并渲染结果下拉；代际令牌保证只有最新输入的结果生效 */
    private async doSearch(): Promise<void> {
        this.mode = 'search'
        this.currentPlaylist = null
        const keyword = (this.searchInput?.value ?? '').trim()
        if (!keyword) {
            this.searchSeq++
            this.renderSearching('输入歌名 / 歌手开始搜索')
            return
        }
        const mySeq = ++this.searchSeq
        this.renderSearching('搜索中…')
        this.pendingSeen = new Set() // 渐进渲染去重：新搜索清空
        this.pendingResults = []
        this.pendingKeyword = keyword
        let networkError = false
        await searchCandidates(
            keyword,
            this.plugin.getSettings().downloadSources,
            (partial) => {
                if (mySeq !== this.searchSeq) return
                if (this.mode !== 'search') return
                if ((this.searchInput?.value ?? '').trim() !== keyword) return
                this.appendResultRows(partial)
            },
            (netErr) => { networkError = netErr },
        )
        if (mySeq !== this.searchSeq) return
        if (this.mode !== 'search') return
        if ((this.searchInput?.value ?? '').trim() !== keyword) return
        // 增量渲染已按相似度有序插入，无需再重排；空结果区分「网络错误」与「确实无结果」
        if (this.pendingResults.length === 0) {
            this.renderSearching(networkError ? '网络错误，请检查网络后重试' : '未找到匹配的歌曲')
        }
    }

    /** 渲染结果下拉：每行 歌名/艺术家/专辑 + 来源标签 + 下载按钮。ctx.playlist 时顶部附加返回推荐歌单头（含实际歌曲数 + 刷新） */
    private renderResults(results: DownloadSong[], ctx?: { playlist?: RecommendedPlaylist; count?: number; onRefresh?: () => void }): void {
        if (!this.resultEl) return
        this.stopPreview()
        this.resultEl.empty()
        if (ctx?.playlist) this.appendPlaylistHeader(ctx.playlist, ctx?.count, ctx?.onRefresh)
        if (results.length === 0) {
            this.resultEl.createDiv({ cls: 'lyrics-download-empty', text: ctx?.playlist ? '歌单暂无歌曲' : '未找到匹配的歌曲' })
            return
        }
        for (const song of results) this.renderResultRow(song)
    }

    /** 渲染单行搜索结果（封面 + 歌名/艺术家/专辑 + 元数据胶囊 + 来源标签 + 下载按钮），返回行元素 */
    private renderResultRow(song: DownloadSong): HTMLElement {
        const root = this.resultEl!
        const row = root.createDiv({ cls: 'lyrics-download-item' })
        row.setAttribute('data-dl-key', `${song.source}:${song.id}`)

        // 封面缩略图（无封面用占位符：灰底 + 音乐图标）
        const coverEl = row.createDiv({ cls: 'lyrics-download-item-cover' })
        if (song.coverUrl) {
            const img = coverEl.createEl('img', { cls: 'lyrics-download-item-cover-img' })
            img.addEventListener('error', () => {
                img.remove()
                renderCoverPlaceholder(coverEl)
            })
            img.src = song.coverUrl
        } else {
            renderCoverPlaceholder(coverEl)
        }

        const info = row.createDiv({ cls: 'lyrics-download-item-info' })
        info.createDiv({ cls: 'lyrics-download-item-name', text: song.name })
        const artistLine = song.artist || '未知艺术家'
        info.createDiv({
            cls: 'lyrics-download-item-artist',
            text: song.album ? `${artistLine} · ${song.album}` : artistLine,
        })
        // 元数据胶囊行：VIP 标签 + 时长 + 大小 + 码率（缺项跳过）
        const metaEl = info.createDiv({ cls: 'lyrics-download-item-meta' })
        if (song.vip) {
            metaEl.createSpan({ cls: 'lyrics-download-item-pill lyrics-download-item-pill-vip', text: 'VIP' })
        }
        const durationStr = formatDuration(song.duration)
        if (durationStr) metaEl.createSpan({ cls: 'lyrics-download-item-pill', text: durationStr })
        if (song.size) metaEl.createSpan({ cls: 'lyrics-download-item-pill', text: formatBytes(song.size) })
        if (song.bitrate) metaEl.createSpan({ cls: 'lyrics-download-item-pill', text: `${song.bitrate}kbps` })

        row.createDiv({
            cls: 'lyrics-download-item-tag',
            text: SOURCE_LABELS[song.source] ?? song.source,
        })
        // 试听按钮（v1.4.1）：点击拉取标准档音频转 Blob 播放，再点停止；播放中图标为 stop
        const prevBtn = row.createDiv({ cls: 'lyrics-download-item-btn lyrics-download-item-preview-btn' })
        setIcon(prevBtn, 'play')
        prevBtn.setAttribute('title', '试听（拉取标准档音频，不写入库）')
        prevBtn.addEventListener('click', (e) => {
            e.stopPropagation()
            void this.togglePreview(song, prevBtn)
        })
        const dlBtn = row.createDiv({ cls: 'lyrics-download-item-btn' })
        setIcon(dlBtn, 'download')
        dlBtn.setAttribute('title', song.needsCookie ? '下载（需 QQ 登录 Cookie）' : '下载到音频文件夹')
        dlBtn.addEventListener('click', (e) => {
            e.stopPropagation()
            void this.downloadOne(song, dlBtn)
        })
        return row
    }

    /** 试听：点击播放（拉字节→Blob），再点或切行停止；播放中该行按钮图标变 stop */
    private async togglePreview(song: DownloadSong, btn: HTMLElement): Promise<void> {
        const key = `${song.source}:${song.id}`
        // 正在播这首歌 → 停止
        if (this.previewAudio && this.previewKey === key) {
            this.stopPreview()
            return
        }
        // 播着其他歌 → 先停旧的
        if (this.previewAudio) this.stopPreview()
        this.previewKey = key
        btn.empty()
        setIcon(btn, 'square')
        btn.addClass('lyrics-download-item-btn-previewing')
        this.renderProgress(null, `正在试听 ${song.name}…`)
        this.progressWrap?.removeClass('lyrics-download-progress-hidden')
        try {
            const res = await previewAudio(song, this.plugin.getSettings().platformCookies, (percent, label) => {
                this.renderProgress(percent, label)
            })
            if (this.previewKey !== key) return // 已被新一轮试听/停止打断
            if (!res.ok || !res.data) {
                new Notice(res.message, 6000)
                this.stopPreview()
                return
            }
            // 命中缓存：立即播放，进度条提示「已从缓存」后快速隐藏
            if (res.fromCache) {
                this.renderProgress(100, '已从缓存加载')
            }
            const mime = res.ext === 'm4a' ? 'audio/mp4' : res.ext === 'flac' ? 'audio/flac' : 'audio/mpeg'
            this.previewBlobUrl = URL.createObjectURL(new Blob([res.data], { type: mime }))
            const audio = new Audio(this.previewBlobUrl)
            // 守卫：仅当前正在播放的这个 audio 才能触发 stopPreview。
            // 否则停旧歌时 src='' 会触发旧 audio 的 error 事件 → 二次 stopPreview 误清新试听的 previewKey，
            // 导致新歌拉取完成后因 key 不匹配而不播放、进度条卡住（切歌竞态 bug）。
            audio.addEventListener('ended', () => {
                if (this.previewAudio !== audio) return
                this.stopPreview()
            })
            audio.addEventListener('error', () => {
                if (this.previewAudio !== audio) return
                if (this.previewKey === key) new Notice('试听音频播放失败', 5000)
                this.stopPreview()
            })
            this.previewAudio = audio
            await audio.play()
            this.progressWrap?.addClass('lyrics-download-progress-hidden')
        } catch (e) {
            new Notice(`试听出错：${e instanceof Error ? e.message : String(e)}`, 6000)
            this.stopPreview()
        }
    }

    /** 停止试听并清理 Blob URL、恢复按钮图标 */
    private stopPreview(): void {
        if (this.previewAudio) {
            this.previewAudio.pause()
            this.previewAudio.src = ''
            this.previewAudio = null
        }
        // 显式回收 blob URL，立即释放音频内存（不依赖浏览器 GC）
        if (this.previewBlobUrl) {
            URL.revokeObjectURL(this.previewBlobUrl)
            this.previewBlobUrl = ''
        }
        if (this.previewKey) {
            const prevBtn = this.resultEl?.querySelector(`[data-dl-key="${CSS.escape(this.previewKey)}"] .lyrics-download-item-preview-btn`)
            if (prevBtn) {
                prevBtn.empty()
                prevBtn.setAttribute('title', '试听（拉取标准档音频，不写入库）')
                prevBtn.removeClass('lyrics-download-item-btn-previewing')
                setIcon(prevBtn as HTMLElement, 'play')
            }
            this.previewKey = ''
        }
        this.progressWrap?.addClass('lyrics-download-progress-hidden')
    }

    /** 搜索渐进渲染：把新到达的平台结果按相似度**增量插入**有序位置（首个到达时清掉「搜索中…」占位），最终不再重排 */
    private appendResultRows(songs: DownloadSong[]): void {
        if (!this.resultEl) return
        const keyword = this.pendingKeyword
        const fresh = songs.filter((s) => !this.pendingSeen.has(`${s.source}:${s.id}`))
        if (fresh.length === 0) return
        const wasEmpty = this.pendingSeen.size === 0
        for (const s of fresh) this.pendingSeen.add(`${s.source}:${s.id}`)
        if (wasEmpty) this.resultEl.empty()
        for (const s of fresh) {
            // 与 searchCandidates 最终排序同规则：分高前、同分短名→字典序
            const score = songSimilarityScore(keyword, s.name, s.artist)
            let idx = this.pendingResults.length
            for (let i = 0; i < this.pendingResults.length; i++) {
                const cur = this.pendingResults[i]
                const cs = songSimilarityScore(keyword, cur.name, cur.artist)
                const better = cs < score
                    || (cs === score && (s.name.length < cur.name.length || (s.name.length === cur.name.length && s.name.localeCompare(cur.name) < 0)))
                if (better) { idx = i; break }
            }
            this.pendingResults.splice(idx, 0, s)
            const row = this.renderResultRow(s)
            // DOM 插入到对应有序位置
            if (idx === 0) {
                this.resultEl.insertBefore(row, this.resultEl.firstChild)
            } else {
                const prev = this.pendingResults[idx - 1]
                const prevEl = this.resultEl.querySelector(`[data-dl-key="${prev.source}:${prev.id}"]`)
                if (prevEl) prevEl.after(row)
                else this.resultEl.appendChild(row)
            }
        }
    }

    /** 加载并渲染推荐歌单首屏（多源，全免登录）；命中缓存直接渲染，force=true 强制刷新；被搜索/关闭打断则丢弃结果 */
    private async loadRecommendedPlaylists(source: PlaylistSource = this.currentSource, force = false): Promise<void> {
        this.mode = 'playlists'
        this.currentSource = source
        this.currentPlaylist = null
        this.searchSeq++ // 作废在途搜索结果，避免迟到搜索覆盖歌单视图
        if (!this.resultEl) return
        if (!force && this.playlistCache[source]) {
            this.playlists = this.playlistCache[source] as RecommendedPlaylist[]
            this.renderPlaylists()
            return
        }
        const mySeq = ++this.playlistSeq // 歌单代际令牌：切换来源/刷新使在途旧请求作废
        this.resultEl.empty()
        this.resultEl.createDiv({ cls: 'lyrics-download-empty', text: '加载推荐歌单…' })
        const list = await fetchRecommendedPlaylists(source)
        if (mySeq !== this.playlistSeq || this.currentSource !== source || this.mode !== 'playlists') return
        this.playlistCache[source] = list
        this.playlists = list
        this.renderPlaylists()
    }

    /** 渲染推荐歌单首屏：头部四源胶囊（点击切换）+ 刷新按钮 + 卡片列表，点卡片进入歌单 */
    private renderPlaylists(): void {
        if (!this.resultEl) return
        this.resultEl.empty()
        const head = this.resultEl.createDiv({ cls: 'lyrics-download-playlist-head' })
        head.createDiv({ cls: 'lyrics-download-playlist-head-title', text: '推荐歌单' })
        const refresh = head.createDiv({ cls: 'lyrics-download-playlist-refresh' })
        setIcon(refresh, 'refresh-cw')
        refresh.setAttribute('title', '刷新推荐歌单')
        refresh.addEventListener('click', () => void this.loadRecommendedPlaylists(this.currentSource, true))
        // 来源胶囊行：点击切换当前平台（选中态高亮）
        const sources = this.resultEl.createDiv({ cls: 'lyrics-download-playlist-sources' })
        for (const key of Object.keys(SOURCE_LABELS) as PlaylistSource[]) {
            const tag = sources.createSpan({
                cls: `lyrics-download-item-tag lyrics-download-playlist-source${key === this.currentSource ? ' lyrics-download-item-tag-active' : ''}`,
                text: SOURCE_LABELS[key],
            })
            tag.addEventListener('click', () => {
                if (key !== this.currentSource) void this.loadRecommendedPlaylists(key)
            })
        }
        if (this.playlists.length === 0) {
            this.resultEl.createDiv({ cls: 'lyrics-download-empty', text: '暂无推荐歌单（接口可能变更），可直接在上方搜索' })
            return
        }
        for (const p of this.playlists) {
            const card = this.resultEl.createDiv({ cls: 'lyrics-download-playlist-card' })
            const coverEl = card.createDiv({ cls: 'lyrics-download-playlist-cover' })
            if (p.coverUrl) {
                const img = coverEl.createEl('img', { cls: 'lyrics-download-playlist-cover-img' })
                img.addEventListener('error', () => {
                    img.remove()
                    renderCoverPlaceholder(coverEl)
                })
                img.src = p.coverUrl
            } else {
                renderCoverPlaceholder(coverEl)
            }
            const info = card.createDiv({ cls: 'lyrics-download-playlist-info' })
            info.createDiv({ cls: 'lyrics-download-playlist-name', text: p.name })
            const meta: string[] = []
            if (p.trackCount) meta.push(`${p.trackCount} 首`)
            meta.push(`${this.formatPlayCount(p.playCount)} 次播放`)
            if (p.creator) meta.push(p.creator)
            // 酷狗歌单接口硬限返回前 10 首，卡片明确标注避免「N 首却只 10 首」的误导
            if (p.source === 'kugou') meta.push('限前10首')
            info.createDiv({ cls: 'lyrics-download-playlist-meta', text: meta.join(' · ') })
            card.addEventListener('click', () => void this.openPlaylist(p))
        }
    }

    /** 打开某歌单：加载并渲染其歌曲（复用歌曲结果行）；命中缓存直接渲染；force=true 强制重拉刷新；被搜索/切回打断则丢弃 */
    private async openPlaylist(playlist: RecommendedPlaylist, force = false): Promise<void> {
        this.mode = 'playlist'
        this.currentPlaylist = playlist
        this.searchSeq++ // 作废在途搜索结果，避免迟到搜索覆盖歌单歌曲视图
        if (!this.resultEl) return
        this.resultEl.empty()
        this.appendPlaylistHeader(playlist)
        const cacheKey = `${playlist.source}:${playlist.id}`
        const onRefresh = () => void this.openPlaylist(playlist, true)
        if (!force) {
            const cached = this.playlistSongsCache[cacheKey]
            if (cached) {
                this.renderResults(cached, { playlist, count: cached.length, onRefresh })
                return
            }
        }
        this.resultEl.createDiv({ cls: 'lyrics-download-empty', text: `加载歌单「${playlist.name}」…` })
        const songs = await fetchPlaylistSongs(playlist.source, playlist.id)
        this.playlistSongsCache[cacheKey] = songs
        if (this.mode !== 'playlist' || this.currentPlaylist?.id !== playlist.id) return
        this.renderResults(songs, { playlist, count: songs.length, onRefresh })
    }

    /** 歌单视图顶部：返回推荐歌单按钮 + 歌单名 + 实际歌曲数（count 缺省时不显示）+ 刷新按钮（onRefresh 存在时）+ 来源胶囊 */
    private appendPlaylistHeader(playlist: RecommendedPlaylist, count?: number, onRefresh?: () => void): void {
        if (!this.resultEl) return
        const head = this.resultEl.createDiv({ cls: 'lyrics-download-playlist-head' })
        const back = head.createDiv({ cls: 'lyrics-download-playlist-back' })
        setIcon(back, 'arrow-left')
        back.setAttribute('title', '返回推荐歌单')
        back.addEventListener('click', () => this.goBackToPlaylists())
        head.createDiv({ cls: 'lyrics-download-playlist-head-title', text: playlist.name })
        if (count !== undefined) head.createSpan({ cls: 'lyrics-download-item-tag', text: `共 ${count} 首` })
        if (onRefresh) {
            const refresh = head.createDiv({ cls: 'lyrics-download-playlist-refresh' })
            setIcon(refresh, 'refresh-cw')
            refresh.setAttribute('title', '刷新歌单歌曲')
            refresh.addEventListener('click', () => onRefresh())
        }
        head.createSpan({ cls: 'lyrics-download-item-tag', text: SOURCE_LABELS[playlist.source] ?? playlist.source })
    }

    /** 切回推荐歌单首屏（沿用当前来源） */
    private goBackToPlaylists(): void {
        this.mode = 'playlists'
        this.currentPlaylist = null
        this.renderPlaylists()
    }

    /** 播放次数友好格式化：≥1 亿 → x.x亿；≥1 万 → x.x万；否则原样 */
    private formatPlayCount(n: number): string {
        if (n >= 1e8) return `${(n / 1e8).toFixed(1)}亿`
        if (n >= 1e4) return `${(n / 1e4).toFixed(1)}万`
        return String(n)
    }

    /** 结果区显示提示文字（搜索中 / 空输入） */
    private renderSearching(text: string): void {
        if (!this.resultEl) return
        this.resultEl.empty()
        this.resultEl.createDiv({ cls: 'lyrics-download-empty', text })
    }

    /** 更新进度条：percent 0-100 为字节进度（显示百分比数字），null 为阶段进行中（不定宽滑动动画） */
    private renderProgress(percent: number | null, label: string): void {
        if (!this.progressWrap || !this.progressFill) return
        this.progressWrap.removeClass('lyrics-download-progress-hidden')
        if (percent === null) {
            this.progressFill.addClass('lyrics-download-progress-indeterminate')
            this.progressFill.style.width = ''
            this.progressText?.setText(label)
        } else {
            this.progressFill.removeClass('lyrics-download-progress-indeterminate')
            this.progressFill.style.width = `${percent}%`
            this.progressText?.setText(`${label} ${percent}%`)
        }
    }

    /** 下载单首：按来源分发（QQ 用设置里粘贴的 Cookie）。成功后不关闭弹窗，按钮标 ✓ 可继续下下一首 */
    private async downloadOne(song: DownloadSong, btn: HTMLElement): Promise<void> {
        if (this.downloading) return
        this.downloading = true
        btn.setAttribute('disabled', 'true')
        btn.addClass('lyrics-download-item-btn-loading')
        // 全局下载中：所有行下载按钮禁用（视觉 + 功能，防误点其他行）
        this.resultEl?.addClass('lyrics-download-downloading')
        try {
            const { ok, message } = await downloadSong(
                this.plugin,
                song,
                this.plugin.getSettings().platformCookies,
                (percent, label) => this.renderProgress(percent, label),
            )
            new Notice(message, ok ? 4000 : 7000)
            if (ok) {
                // 成功：按钮标 ✓（保留弹窗，继续点下一首）
                btn.empty()
                setIcon(btn, 'check')
                btn.addClass('lyrics-download-item-btn-done')
                btn.removeClass('lyrics-download-item-btn-loading')
            } else {
                // 失败：恢复按钮，可就地重试
                btn.removeAttribute('disabled')
                btn.removeClass('lyrics-download-item-btn-loading')
            }
        } catch (e) {
            new Notice(`下载出错：${e instanceof Error ? e.message : String(e)}`, 7000)
            btn.removeAttribute('disabled')
            btn.removeClass('lyrics-download-item-btn-loading')
        }
        this.progressWrap?.addClass('lyrics-download-progress-hidden')
        this.resultEl?.removeClass('lyrics-download-downloading')
        this.downloading = false
    }

    onClose() {
        if (this.debounceTimer !== null) window.clearTimeout(this.debounceTimer)
        this.stopPreview()
        this.contentEl.empty()
    }
}
