import { PluginSettingTab, Setting, type App, Notice } from 'obsidian'
import LyrcisPlugin from 'main'
import type { PlayMode } from 'main'

export interface Settings {
    autoScroll: boolean
    sentenceMode: boolean
    onlyShowMarked: boolean
    karaoke: boolean
    lyricsFolder: string
    playMode: PlayMode
    flashSwitch: boolean
}
export const DEFAULT_SETTINGS: Settings = {
    autoScroll: true,
    sentenceMode: false,
    onlyShowMarked: false,
    karaoke: false,
    lyricsFolder: '',
    playMode: 'off',
    flashSwitch: false,
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

        new Setting(containerEl)
            .setName('自动滚动')
            .setDesc('默认关闭，启用后 LRC 笔记页跟随当前歌词行滚动（侧边栏始终滚动，不受此项控制）')
            .addToggle((toggle) => {
                toggle.setValue(this.settings.autoScroll)
                toggle.onChange((value) => {
                    this.updateSettings({ autoScroll: value })
                })
            })

        new Setting(containerEl)
            .setName('逐句模式')
            .setDesc('默认关闭，启用后每句结束自动暂停（适合跟读/学习）')
            .addToggle((toggle) => {
                toggle.setValue(this.settings.sentenceMode)
                toggle.onChange((value) => {
                    this.updateSettings({ sentenceMode: value })
                })
            })

        new Setting(containerEl)
            .setName('逐字高亮')
            .setDesc('默认关闭，启用后显示逐字高亮效果（支持主流 <mm:ss.xx> 逐字时间标记，如 <00:12.167>沧<00:13.000>海）')
            .addToggle((toggle) => {
                toggle.setValue(this.settings.karaoke)
                toggle.onChange((value) => {
                    this.updateSettings({ karaoke: value })
                })
            })

        new Setting(containerEl)
            .setName('后台播放')
            .setDesc('默认关闭，最小化时暂停歌曲；开启后 Obsidian 最小化时会保持播放，但是请注意切歌时会瞬间弹出窗口又最小化')
            .addToggle((toggle) => {
                toggle.setValue(this.settings.flashSwitch)
                toggle.onChange((value) => {
                    this.updateSettings({ flashSwitch: value })
                })
            })

        const folderSetting = new Setting(containerEl)
            .setName('LRC笔记文件夹')
            .setDesc('设置 LRC 笔记的文件夹路径（在侧边栏显示歌单列表）')

        // Reload button
        folderSetting.addButton((btn) => {
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

        // Text input
        const inputEl = folderSetting.controlEl.createDiv({ cls: 'lyrics-folder-input-wrap' })
        const textInput = inputEl.createEl('input', {
            cls: 'lyrics-folder-input',
            attr: {
                type: 'text',
                placeholder: '输入文件夹/',
                value: this.settings.lyricsFolder,
            },
        })

        // Suggestions dropdown
        const suggestionsEl = inputEl.createDiv({ cls: 'lyrics-folder-suggestions' })
        suggestionsEl.style.display = 'none'

        // Get all unique folder paths from vault
        const getAllFolders = (): string[] => {
            const folders = new Set<string>()
            const files = this.app.vault.getMarkdownFiles()
            for (const file of files) {
                const parts = file.path.split('/')
                // Build all parent paths
                for (let i = 1; i < parts.length; i++) {
                    folders.add(parts.slice(0, i).join('/'))
                }
            }
            return Array.from(folders).sort()
        }

        const allFolders = getAllFolders()

        // Filter and show suggestions
        const showSuggestions = (query: string) => {
            suggestionsEl.empty()

            if (!query) {
                // Show all folders when empty
                const filtered = allFolders.slice(0, 20) // Limit to 20
                if (filtered.length === 0) {
                    suggestionsEl.style.display = 'none'
                    return
                }
                renderSuggestions(filtered)
                suggestionsEl.style.display = 'block'
                return
            }

            const lowerQuery = query.toLowerCase()
            const filtered = allFolders.filter(f =>
                f.toLowerCase().includes(lowerQuery)
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

                item.addEventListener('click', () => {
                    textInput.value = folder
                    this.updateSettings({ lyricsFolder: folder })
                    this.plugin.scanLyricSongs()
                    suggestionsEl.style.display = 'none'
                })

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
                    textInput.value = folders[activeIndex]
                    this.updateSettings({ lyricsFolder: folders[activeIndex] })
                    this.plugin.scanLyricSongs()
                    suggestionsEl.style.display = 'none'
                } else if (e.key === 'Escape') {
                    suggestionsEl.style.display = 'none'
                    textInput.blur()
                }
            }
        }

        // Input events
        textInput.addEventListener('input', () => {
            showSuggestions(textInput.value)
        })

        textInput.addEventListener('focus', () => {
            showSuggestions(textInput.value)
        })

        // Hide suggestions when clicking outside
        const onBlur = () => {
            setTimeout(() => {
                suggestionsEl.style.display = 'none'
            }, 200)
        }
        textInput.addEventListener('blur', onBlur)

        // Also update settings on direct input (without selecting from dropdown)
        textInput.addEventListener('change', () => {
            this.updateSettings({ lyricsFolder: textInput.value })
            this.plugin.scanLyricSongs()
        })
    }

    public getSettings(): Settings {
        return this.settings
    }
}
