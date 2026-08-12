import { PluginSettingTab, Setting, type App, Notice, TFolder } from 'obsidian'
import LyrcisPlugin from 'main'
import type { PlayMode } from 'shared'
import {
    testPlatformConnection, testTranslateConnection,
    getPreviewCacheSize, getPreviewCacheCount, clearPreviewCache,
} from 'downloadManager'
import { formatBytes } from 'tagSize'

export interface Settings {
    autoScroll: boolean
    sentenceMode: boolean
    onlyShowMarked: boolean
    karaoke: boolean
    lyricsFolder: string
    /** 裸 MP3 音频文件夹（v1.5.0 新增）：无 LRC 笔记的音频也进歌单 */
    audioFolder: string
    /** 歌单来源二选一：'notes'=LRC 笔记路径，'audio'=音频文件路径（v1.5.0，选中的显示另一个隐藏） */
    songSource: 'notes' | 'audio'
    playMode: PlayMode
    flashSwitch: boolean
    /** 播放倍速，持久化，重启不丢失（v1.4.0 巩固） */
    playbackRate: number
    /** 音量百分比 0-100，持久化，重启不丢失（v1.4.0 巩固） */
    volume: number
    /** 多平台下载 Cookie（v1.4.1）：各平台登录 Cookie，仅存本地 data.json */
    platformCookies: Record<string, string>
    /** 下载搜索启用的平台（v1.4.2）：勾选的控制搜索结果是否包含该平台；key 对应 DownloadSong.source */
    downloadSources: Record<string, boolean>
    /** 歌词翻译服务商（v1.4.1）：'google' / 'mymemory'（免 key 国内可达）/ 'baidu' / 'youdao'；'auto' 保留兼容旧配置 = Google→MyMemory 降级 */
    translateProvider: 'auto' | 'google' | 'baidu' | 'youdao' | 'mymemory'
    /** 百度翻译 Cookie（v1.4.1）：选中百度翻译源时可选粘贴，仅存本地 data.json */
    translateBaiduCookie: string
    /** 有道翻译 Cookie（v1.4.1）：选中有道翻译源时可选粘贴，仅存本地 data.json */
    translateYoudaoCookie: string
}
export const DEFAULT_SETTINGS: Settings = {
    autoScroll: true,
    sentenceMode: false,
    onlyShowMarked: false,
    karaoke: false,
    lyricsFolder: '',
    audioFolder: '',
    songSource: 'notes',
    playMode: 'off',
    flashSwitch: false,
    playbackRate: 1,
    volume: 75,
    platformCookies: {},
    downloadSources: { netease: true, qq: true, kugou: true, kuwo: true },
    translateProvider: 'google',
    translateBaiduCookie: '',
    translateYoudaoCookie: '',
}

export default class LyricsSettings extends PluginSettingTab {
    private settings: Settings
    private plugin: LyrcisPlugin

    constructor(plugin: LyrcisPlugin, settings: Settings) {
        super(plugin.app, plugin)
        this.plugin = plugin
        this.settings = settings
    }

    public async updateSettings(newSettings: Partial<Settings>) {
        this.settings = { ...this.settings, ...newSettings }
        await this.plugin.saveData(this.settings)
    }

    public display() {
        const { containerEl } = this
        containerEl.empty()

        new Setting(containerEl).setName('基本设置').setHeading()

        new Setting(containerEl)
            .setName('自动滚动')
            .setDesc('默认关闭，LRC笔记页随播放进度滚动')
            .addToggle((toggle) => {
                toggle.setValue(this.settings.autoScroll)
                toggle.onChange((value) => {
                    this.updateSettings({ autoScroll: value })
                })
            })

        new Setting(containerEl)
            .setName('逐句模式')
            .setDesc('默认关闭，每句结束后自动暂停，适合跟读')
            .addToggle((toggle) => {
                toggle.setValue(this.settings.sentenceMode)
                toggle.onChange((value) => {
                    this.updateSettings({ sentenceMode: value })
                })
            })

        new Setting(containerEl)
            .setName('逐字高亮')
            .setDesc('默认关闭，每句均分逐字高亮。支持精确逐字高亮：如<00:12.167>沧<00:13.000>海')
            .addToggle((toggle) => {
                toggle.setValue(this.settings.karaoke)
                toggle.onChange((value) => {
                    this.updateSettings({ karaoke: value })
                })
            })

        new Setting(containerEl)
            .setName('后台播放')
            .setDesc('默认关闭，开启后最小化可继续播放，但注意在LRC笔记路径下切歌时会闪现弹窗')
            .addToggle((toggle) => {
                toggle.setValue(this.settings.flashSwitch)
                toggle.onChange((value) => {
                    this.updateSettings({ flashSwitch: value })
                })
            })

        new Setting(containerEl).setName('歌单').setHeading()

        // 歌单来源二选一：选中的显示对应路径选择器，另一个隐藏
        new Setting(containerEl)
            .setName('歌单来源')
            .setDesc('选择歌单数据来源：LRC 笔记路径 或 音频文件路径')
            .addDropdown((dropdown) => {
                dropdown.addOption('notes', 'LRC 笔记路径')
                    .addOption('audio', '音频文件路径')
                    .setValue(this.settings.songSource)
                    .onChange(async (value) => {
                        await this.updateSettings({ songSource: value as 'notes' | 'audio' })
                        await this.plugin.stopAllPlayback() // 先停止所有播放，避免新旧来源双播
                        await this.plugin.scanLyricSongs() // 立即按新来源重扫歌单
                        this.display() // 重绘设置页，切换显示的路径选择器
                    })
            })

        if (this.settings.songSource === 'notes') {
            this.createFolderPicker(containerEl, {
                name: 'LRC笔记文件夹',
                desc: '指定笔记路径，用于在侧边栏渲染歌单列表',
                placeholder: '输入文件夹/',
                value: this.settings.lyricsFolder,
                onChange: (folder) => { this.updateSettings({ lyricsFolder: folder }) },
            })
        } else {
            this.createFolderPicker(containerEl, {
                name: '音频文件夹',
                desc: '指定音频路径（同下载路径），用于在侧边栏渲染歌单列表',
                placeholder: '例如：Music',
                value: this.settings.audioFolder,
                onChange: (folder) => { this.updateSettings({ audioFolder: folder }) },
            })
        }

        // 试听缓存（v1.4.1）：显示试听播放拉取的会话内缓存大小，一键清除；清除后再点试听会重新拉取
        const previewCacheSetting = new Setting(containerEl)
            .setName('试听缓存')
            .setDesc('「试听」播放拉取的音频字节缓存（会话内，重启 Obsidian 自动清空）')
        previewCacheSetting.addButton((btn) => {
            btn.setClass('lyrics-clear-cache-btn')
            btn.setButtonText(`清除缓存（${formatBytes(getPreviewCacheSize())}）`)
                .onClick(async () => {
                    clearPreviewCache()
                    btn.setButtonText('清除缓存（0 B）')
                    new Notice(`已清除试听缓存（${getPreviewCacheCount()} 条）`)
                })
        })

        new Setting(containerEl).setName('下载').setHeading()

        // 四个平台：勾选控制搜索结果是否展示；未勾选行变灰且不参与搜索。网易云 Cookie 用于 VIP 下载（可选）
        const sourcePlatforms: Array<{ key: string; name: string; site: string }> = [
            { key: 'netease', name: '网易云音乐', site: 'music.163.com' },
            { key: 'qq', name: 'QQ 音乐', site: 'y.qq.com' },
            { key: 'kugou', name: '酷狗音乐', site: 'kugou.com' },
            { key: 'kuwo', name: '酷我音乐', site: 'kuwo.cn' },
        ]
        for (const p of sourcePlatforms) {
            this.createCookieRow(containerEl, p.key, p.name, p.site)
        }

        // 「翻译」分组：歌词翻译服务商选择（编辑标签「翻译歌词」按钮用）
        new Setting(containerEl).setName('翻译').setHeading()
        // 百度/有道已禁用（v1.4.1）：旧配置若选中它们，回退到 Google，避免高亮落在禁用行上
        if (this.settings.translateProvider === 'baidu' || this.settings.translateProvider === 'youdao') {
            this.settings.translateProvider = 'google'
            void this.plugin.saveData(this.settings)
        }
        // 单选行：MyMemory/Google/百度/有道，勾选置于行首（对齐「下载」分组样式），选中的行高亮、未选中的整行变灰
        // 百度/有道已禁用（disabled=true）：整行灰显、radio 不可点、无 cookie 面板可展开
        const translateProviderContainer = containerEl.createDiv({ cls: 'lyrics-translate-providers' })
        this.createTranslateProviderRow(translateProviderContainer, 'mymemory', 'MyMemory')
        this.createTranslateProviderRow(translateProviderContainer, 'google', 'Google')
        this.createTranslateProviderRow(translateProviderContainer, 'baidu', '百度翻译', 'fanyi.baidu.com', true)
        this.createTranslateProviderRow(translateProviderContainer, 'youdao', '有道翻译', 'fanyi.youdao.com', true)

        new Setting(containerEl).setName('关于').setHeading()

        // 支持卡片：左侧文字 + 右侧按钮（仿「支持 YOLO」banner 布局）
        const about = containerEl.createDiv({ cls: 'lyrics-about' })
        const aboutText = about.createDiv({ cls: 'lyrics-about-text' })
        aboutText.createDiv({ cls: 'lyrics-about-title', text: '支持作者' })
        aboutText.createDiv({ cls: 'lyrics-about-desc', text: '如果你觉得 LyricFlux 有价值，请考虑支持它的开发！' })
        const aboutBtns = about.createDiv({ cls: 'lyrics-about-buttons' })
        const githubBtn = aboutBtns.createEl('button', { cls: 'lyrics-about-btn', text: 'Github' })
        const afdianBtn = aboutBtns.createEl('button', { cls: 'lyrics-about-btn lyrics-about-btn-accent', text: '爱发电' })
        githubBtn.addEventListener('click', () => window.open('https://github.com/fhb263/obsidian-lyricflux', '_blank'))
        afdianBtn.addEventListener('click', () => window.open('https://ifdian.net/a/fhb263', '_blank'))
    }

    /**
     * 创建带手动刷新按钮 + 搜索下拉的文件夹选择器（LRC 笔记文件夹 / 音频文件夹共用）。
     * suggestAudioFiles=true 时建议列表同时含音频文件（选文件取其所在文件夹），供音频文件夹按歌曲名搜索。
     * 选择或输入后调用 onChange 更新对应设置，并重扫歌单。
     */
    private createFolderPicker(
        containerEl: HTMLElement,
        opts: {
            name: string
            desc: string
            placeholder: string
            value: string
            onChange: (folder: string) => void
        },
    ): void {
        const setting = new Setting(containerEl)
            .setName(opts.name)
            .setDesc(opts.desc)

        // 手动刷新按钮
        setting.addButton((btn) => {
            btn.setClass('lyrics-reload-btn')
            btn.setIcon('refresh-cw')
                .setTooltip('刷新歌单列表')
                .onClick(async () => {
                    btn.setDisabled(true)
                    btn.setIcon('loader')
                    await this.plugin.scanLyricSongs()
                    btn.setIcon('check')
                    setTimeout(() => {
                        btn.setIcon('refresh-cw')
                        btn.setDisabled(false)
                    }, 1000)
                    new Notice(`歌单已刷新，共 ${this.plugin.getSongList().length} 首歌曲`)
                })
        })

        // 输入框
        const inputEl = setting.controlEl.createDiv({ cls: 'lyrics-folder-input-wrap' })
        const textInput = inputEl.createEl('input', {
            cls: 'lyrics-folder-input',
            attr: {
                type: 'text',
                placeholder: opts.placeholder,
                value: opts.value,
            },
        })

        // 下拉建议
        const suggestionsEl = inputEl.createDiv({ cls: 'lyrics-folder-suggestions' })
        suggestionsEl.style.display = 'none'

        // 取 vault 全部文件夹路径（直接收集 TFolder，含空文件夹——修复空目录搜不到）
        const getAllFolders = (): string[] => {
            const folders = new Set<string>()
            for (const file of this.app.vault.getAllLoadedFiles()) {
                if (file instanceof TFolder) {
                    folders.add(file.path)
                }
            }
            return Array.from(folders).sort()
        }

        // 建议列表：仅文件夹
        const allFolders = getAllFolders()

        // 应用所选/所输：更新设置 + 重扫歌单
        const applyFolder = (folder: string) => {
            textInput.value = folder
            opts.onChange(folder)
            this.plugin.scanLyricSongs()
            suggestionsEl.style.display = 'none'
        }

        // 过滤并显示建议
        const showSuggestions = (query: string) => {
            suggestionsEl.empty()
            const lowerQuery = query.toLowerCase()
            const filtered = (query
                ? allFolders.filter((f) => f.toLowerCase().includes(lowerQuery))
                : allFolders
            ).slice(0, 20)
            if (filtered.length === 0) {
                suggestionsEl.style.display = 'none'
                return
            }
            renderSuggestions(filtered)
            suggestionsEl.style.display = 'block'
        }

        let activeIndex = -1

        const renderSuggestions = (folders: string[]) => {
            suggestionsEl.empty()
            activeIndex = -1

            folders.forEach((folder, index) => {
                const item = suggestionsEl.createDiv({ cls: 'lyrics-folder-suggestion-item' })
                item.setText(folder)

                item.addEventListener('click', () => applyFolder(folder))
                item.addEventListener('mouseenter', () => {
                    activeIndex = index
                    updateActive()
                })
            })

            const updateActive = () => {
                suggestionsEl.querySelectorAll('.lyrics-folder-suggestion-item').forEach((el, i) => {
                    el.classList.toggle('lyrics-folder-suggestion-active', i === activeIndex)
                })
            }

            textInput.onkeydown = (e: KeyboardEvent) => {
                const items = suggestionsEl.querySelectorAll('.lyrics-folder-suggestion-item')
                if (!items.length) return
                if (e.key === 'ArrowDown') {
                    e.preventDefault()
                    activeIndex = Math.min(activeIndex + 1, items.length - 1)
                    updateActive()
                    items[activeIndex]?.scrollIntoView({ block: 'nearest' })
                } else if (e.key === 'ArrowUp') {
                    e.preventDefault()
                    activeIndex = Math.max(activeIndex - 1, 0)
                    updateActive()
                    items[activeIndex]?.scrollIntoView({ block: 'nearest' })
                } else if (e.key === 'Enter' && activeIndex >= 0) {
                    e.preventDefault()
                    applyFolder(folders[activeIndex])
                } else if (e.key === 'Escape') {
                    suggestionsEl.style.display = 'none'
                    textInput.blur()
                }
            }
        }

        // 输入事件
        textInput.addEventListener('input', () => {
            showSuggestions(textInput.value)
        })
        textInput.addEventListener('focus', () => {
            showSuggestions(textInput.value)
        })

        // 点击外部隐藏建议
        const onBlur = () => {
            setTimeout(() => {
                suggestionsEl.style.display = 'none'
            }, 200)
        }
        textInput.addEventListener('blur', onBlur)

        // 直接输入（未选下拉）也更新
        textInput.addEventListener('change', () => {
            applyFolder(textInput.value)
        })
    }

    /**
     * 创建可折叠的 Cookie 输入行：头部**勾选框**（控制搜索结果是否包含该平台，未勾选整行变灰且不参与搜索）
     * + 平台名 + 状态徽标（未配置/已配置 N 字符），点击行展开/收起 textarea。
     * 四平台均有 Cookie 输入（网易云为可选，用于 VIP 下载；QQ 必需；酷狗/酷我可选预留）。
     */
    private createCookieRow(containerEl: HTMLElement, key: string, name: string, site: string): void {
        const value = this.settings.platformCookies[key] ?? ''
        const enabled = this.settings.downloadSources[key] !== false
        const row = containerEl.createDiv({ cls: 'lyrics-cookie-row' })
        if (!enabled) row.addClass('lyrics-cookie-row-disabled')
        const header = row.createDiv({ cls: 'lyrics-cookie-header' })

        // 勾选框：控制该平台是否参与搜索（不触发行折叠）
        const checkbox = header.createEl('input', { cls: 'lyrics-cookie-checkbox', attr: { type: 'checkbox' } })
        checkbox.checked = enabled
        checkbox.addEventListener('click', (e) => e.stopPropagation())
        checkbox.addEventListener('change', () => {
            this.updateSettings({ downloadSources: { ...this.settings.downloadSources, [key]: checkbox.checked } })
            row.toggleClass('lyrics-cookie-row-disabled', !checkbox.checked)
        })

        header.createSpan({ cls: 'lyrics-cookie-name', text: name })
        const statusEl = header.createSpan({
            cls: 'lyrics-cookie-status',
            text: value ? `已配置（${value.length} 字符）` : '未配置',
        })
        if (value) statusEl.addClass('lyrics-cookie-status-on')
        header.createSpan({ cls: 'lyrics-cookie-chevron', text: '▸' })

        const body = row.createDiv({ cls: 'lyrics-cookie-body' })
        const textarea = body.createEl('textarea', { cls: 'lyrics-cookie-input' })
        textarea.value = value
        textarea.placeholder = `登录 ${site} 后 F12 → 控制台输入 document.cookie 复制整段`
        textarea.addEventListener('input', () => {
            const v = textarea.value.trim()
            this.updateSettings({ platformCookies: { ...this.settings.platformCookies, [key]: v } })
            statusEl.setText(v ? `已配置（${v.length} 字符）` : '未配置')
            statusEl.toggleClass('lyrics-cookie-status-on', !!v)
        })
        body.createDiv({
            cls: 'lyrics-cookie-hint',
            text: key === 'netease'
                ? `可选（VIP 下载用）：粘贴网易云会员 Cookie 后可下载 VIP 高音质；不填则下载免费标准音质。获取：登录 music.163.com → F12 控制台输入 document.cookie → 复制输出粘贴到上方。仅存本地 data.json。`
                : `获取方式：登录 ${site} → F12 控制台输入 document.cookie → 复制输出粘贴到上方。仅存本地 data.json。`,
        })
        const actions = body.createDiv({ cls: 'lyrics-cookie-body-actions' })
        const testBtn = actions.createEl('button', { text: '测试连接', cls: 'mod-cta' })
        const testResultEl = actions.createSpan({ cls: 'lyrics-cookie-test-result' })
        actions.createEl('button', { text: '清除', cls: 'mod-cta' }).addEventListener('click', () => {
            textarea.value = ''
            this.updateSettings({ platformCookies: { ...this.settings.platformCookies, [key]: '' } })
            statusEl.setText('未配置')
            statusEl.removeClass('lyrics-cookie-status-on')
            testResultEl.setText('')
        })

        // 测试连接：QQ/酷狗发请求验证 Cookie；酷我免登录直接提示
        testBtn.addEventListener('click', async () => {
            testBtn.disabled = true
            testBtn.setText('测试中…')
            testResultEl.setText('')
            const res = await testPlatformConnection(key, textarea.value.trim())
            testBtn.disabled = false
            testBtn.setText('测试连接')
            testResultEl.setText(res.ok ? '✓ ' + res.message : '✗ ' + res.message)
            testResultEl.toggleClass('lyrics-cookie-test-ok', res.ok)
            testResultEl.toggleClass('lyrics-cookie-test-bad', !res.ok)
        })

        header.addEventListener('click', () => {
            const wasCollapsed = body.hasClass('lyrics-cookie-collapsed')
            body.toggleClass('lyrics-cookie-collapsed', !wasCollapsed)
            row.toggleClass('lyrics-cookie-row-expanded', wasCollapsed)
            if (wasCollapsed) textarea.focus()
        })
        // 默认全部收起（安全）：登录凭证不随设置页展开而暴露，需点击平台行才展开
        body.addClass('lyrics-cookie-collapsed')
    }

    /**
     * 创建翻译服务商单选行（v1.4.1，样式对齐「下载」分组 cookie 行）：
     * 行首为 radio 单选勾选（选中即设为当前翻译源，不触发行折叠）；
     * 百度/有道附带可折叠 Cookie 输入（默认收起，防凭证暴露）+「测试连接」/「清除」按钮；
     * 自动/Google 无 Cookie 输入，点击整行即选中。选中的行高亮、未选中的整行变灰。
     */
    private createTranslateProviderRow(containerEl: HTMLElement, key: Settings['translateProvider'], name: string, site?: string, disabled = false): void {
        const cookieKey = key === 'baidu' ? 'translateBaiduCookie' : key === 'youdao' ? 'translateYoudaoCookie' : null
        const isCurrent = () => !disabled && this.settings.translateProvider === key
        const row = containerEl.createDiv({ cls: 'lyrics-cookie-row' })
        row.dataset.provider = key
        if (disabled) row.addClass('lyrics-cookie-row-disabled')
        row.toggleClass('lyrics-translate-provider-active', isCurrent())
        row.toggleClass('lyrics-translate-provider-off', !isCurrent())
        const header = row.createDiv({ cls: 'lyrics-cookie-header' })

        // 行首 radio 单选勾选：选中即切换当前翻译源（不触发行折叠）；禁用行 radio 不可点
        const radio = header.createEl('input', { cls: 'lyrics-cookie-checkbox', attr: { type: 'radio', name: 'lyrics-translate-provider' } })
        radio.checked = isCurrent()
        if (disabled) radio.disabled = true
        radio.addEventListener('click', (e) => e.stopPropagation())
        radio.addEventListener('change', () => {
            if (disabled || !radio.checked) return
            void this.updateSettings({ translateProvider: key })
            this.refreshTranslateProviderRows(containerEl)
        })

        header.createSpan({ cls: 'lyrics-cookie-name', text: name })

        // 禁用行：整行灰显、radio 不可点、无 cookie body、无展开；状态徽标显示「已禁用」
        if (disabled) {
            header.createSpan({ cls: 'lyrics-cookie-status', text: '已禁用' })
            return
        }

        let statusEl: HTMLElement | null = null
        let body: HTMLElement | null = null
        let textarea: HTMLTextAreaElement | null = null
        if (cookieKey) {
            const value = this.settings[cookieKey] ?? ''
            statusEl = header.createSpan({
                cls: 'lyrics-cookie-status' + (value || isCurrent() ? ' lyrics-cookie-status-on' : ''),
                text: value
                    ? `已配置（${value.length} 字符）${isCurrent() ? ' · 当前源' : ''}`
                    : isCurrent() ? '未配置 · 当前源' : '未配置',
            })
            header.createSpan({ cls: 'lyrics-cookie-chevron', text: '▸' })

            body = row.createDiv({ cls: 'lyrics-cookie-body' })
            textarea = body.createEl('textarea', { cls: 'lyrics-cookie-input' })
            textarea.value = value
            textarea.placeholder = `登录 ${site} → F12 控制台输入 document.cookie 复制整段`
            textarea.addEventListener('input', () => {
                const v = textarea!.value.trim()
                this.updateSettings({ [cookieKey]: v } as Partial<Settings>)
                const isCur = isCurrent()
                statusEl!.setText(v ? `已配置（${v.length} 字符）${isCur ? ' · 当前源' : ''}` : (isCur ? '未配置 · 当前源' : '未配置'))
                statusEl!.toggleClass('lyrics-cookie-status-on', !!v || isCur)
            })
            body.createDiv({
                cls: 'lyrics-cookie-hint',
                text: `可选。粘贴 ${name} 登录 Cookie 后可稳定调用该翻译源。获取：登录 ${site} → F12 控制台输入 document.cookie → 复制输出粘贴到上方。仅存本地 data.json。`,
            })
            const actions = body.createDiv({ cls: 'lyrics-cookie-body-actions' })
            const testBtn = actions.createEl('button', { text: '测试连接', cls: 'mod-cta' })
            const testResultEl = actions.createSpan({ cls: 'lyrics-cookie-test-result' })
            actions.createEl('button', { text: '清除', cls: 'mod-cta' }).addEventListener('click', () => {
                textarea!.value = ''
                this.updateSettings({ [cookieKey]: '' } as Partial<Settings>)
                const isCur = isCurrent()
                statusEl!.setText(isCur ? '未配置 · 当前源' : '未配置')
                statusEl!.toggleClass('lyrics-cookie-status-on', isCur)
                testResultEl.setText('')
            })

            // 测试连接：用该翻译源试译一个词验证可用性（需已配置 cookie）
            testBtn.addEventListener('click', async () => {
                testBtn.disabled = true
                testBtn.setText('测试中…')
                testResultEl.setText('')
                const res = await testTranslateConnection(key, textarea!.value.trim())
                testBtn.disabled = false
                testBtn.setText('测试连接')
                testResultEl.setText(res.ok ? '✓ ' + res.message : '✗ ' + res.message)
                testResultEl.toggleClass('lyrics-cookie-test-ok', res.ok)
                testResultEl.toggleClass('lyrics-cookie-test-bad', !res.ok)
            })

            header.addEventListener('click', () => {
                const wasCollapsed = body!.hasClass('lyrics-cookie-collapsed')
                body!.toggleClass('lyrics-cookie-collapsed', !wasCollapsed)
                row.toggleClass('lyrics-cookie-row-expanded', wasCollapsed)
                if (wasCollapsed) textarea!.focus()
            })
            // 默认收起（安全）：登录凭证不随设置页展开而暴露
            body.addClass('lyrics-cookie-collapsed')
        } else {
            // 自动/Google：无 Cookie 输入，点击整行即选中
            header.addEventListener('click', () => {
                if (!radio.checked) {
                    radio.checked = true
                    void this.updateSettings({ translateProvider: key })
                    this.refreshTranslateProviderRows(containerEl)
                }
            })
        }
    }

    /** 刷新翻译服务商单选行：radio 勾选态 + 选中高亮/未选中变灰 + 当前源状态徽标（禁用行跳过，保持「已禁用」） */
    private refreshTranslateProviderRows(containerEl: HTMLElement): void {
        containerEl.querySelectorAll<HTMLElement>('.lyrics-cookie-row[data-provider]').forEach((row) => {
            if (row.hasClass('lyrics-cookie-row-disabled')) return
            const key = row.dataset.provider as Settings['translateProvider']
            const radio = row.querySelector<HTMLInputElement>('input[type="radio"][name="lyrics-translate-provider"]')
            if (!radio) return
            const checked = radio.checked
            row.toggleClass('lyrics-translate-provider-active', checked)
            row.toggleClass('lyrics-translate-provider-off', !checked)
            const statusEl = row.querySelector<HTMLElement>('.lyrics-cookie-status')
            if (!statusEl) return
            const cookieKey = key === 'baidu' ? 'translateBaiduCookie' : key === 'youdao' ? 'translateYoudaoCookie' : null
            const value = cookieKey ? (this.settings[cookieKey] ?? '') : ''
            statusEl.setText(value
                ? `已配置（${value.length} 字符）${checked ? ' · 当前源' : ''}`
                : checked ? '未配置 · 当前源' : '未配置')
            statusEl.toggleClass('lyrics-cookie-status-on', !!value || checked)
        })
    }

    public getSettings(): Settings {
        return this.settings
    }
}
