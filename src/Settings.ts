import { PluginSettingTab, Setting, type App, Notice, TFolder } from 'obsidian'
import LyrcisPlugin from 'main'
import type { PlayMode } from 'shared'

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
                desc: '指定音频路径，用于在侧边栏渲染歌单列表',
                placeholder: '例如：Music',
                value: this.settings.audioFolder,
                onChange: (folder) => { this.updateSettings({ audioFolder: folder }) },
            })
        }

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

    public getSettings(): Settings {
        return this.settings
    }
}
