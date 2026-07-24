import { PluginSettingTab, Setting, type App } from 'obsidian'
import LyrcisPlugin from 'main'

export interface Settings {
    autoScroll: boolean
    sentenceMode: boolean
    onlyShowMarked: boolean
    karaoke: boolean
    lyricsFolder: string
}
export const DEFAULT_SETTINGS: Settings = {
    autoScroll: true,
    sentenceMode: false,
    onlyShowMarked: false,
    karaoke: false,
    lyricsFolder: '',
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
            .setDesc('播放时 LRC 笔记页自动跟随当前歌词行滚动（侧边栏始终自动滚动，不受此项控制）')
            .addToggle((toggle) => {
                toggle.setValue(this.settings.autoScroll)
                toggle.onChange((value) => {
                    this.updateSettings({ autoScroll: value })
                })
            })

        new Setting(containerEl)
            .setName('逐句模式')
            .setDesc('启用后每句结束自动暂停（适合跟读/学习）')
            .addToggle((toggle) => {
                toggle.setValue(this.settings.sentenceMode)
                toggle.onChange((value) => {
                    this.updateSettings({ sentenceMode: value })
                })
            })

        new Setting(containerEl)
            .setName('逐字高亮')
            .setDesc('开启为卡拉OK级逐字高亮，关闭则为逐行高亮。支持中/日/韩/英/俄/阿拉伯/印地/泰/藏等多语言')
            .addToggle((toggle) => {
                toggle.setValue(this.settings.karaoke)
                toggle.onChange((value) => {
                    this.updateSettings({ karaoke: value })
                })
            })

        const folderSetting = new Setting(containerEl)
            .setName('LRC笔记文件夹')
            .setDesc('设定 LRC 歌词文件的存储目录（支持相对路径）')

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

        const renderSuggestions = (folders: string[]) => {
            suggestionsEl.empty()
            folders.forEach((folder) => {
                const item = suggestionsEl.createDiv({ cls: 'lyrics-folder-suggestion-item' })
                // Highlight matching part
                const query = textInput.value.toLowerCase()
                if (query) {
                    const idx = folder.toLowerCase().indexOf(query)
                    if (idx >= 0) {
                        const before = folder.slice(0, idx)
                        const match = folder.slice(idx, idx + query.length)
                        const after = folder.slice(idx + query.length)
                        item.createSpan({ text: before })
                        item.createSpan({ cls: 'lyrics-folder-suggestion-highlight', text: match })
                        item.createSpan({ text: after })
                    } else {
                        item.setText(folder)
                    }
                } else {
                    item.setText(folder)
                }

                item.addEventListener('click', () => {
                    textInput.value = folder
                    this.updateSettings({ lyricsFolder: folder })
                    suggestionsEl.style.display = 'none'
                })
            })
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
        })
    }

    public getSettings(): Settings {
        return this.settings
    }
}
