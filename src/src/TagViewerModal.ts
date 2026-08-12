import { App, Modal, Notice, Setting } from 'obsidian'
import { readGenericTags, type AudioSource, type Mp3Tags } from 'tags'

/**
 * 只读查看非 MP3 音频标签（FLAC/M4A/OGG/WAV/AAC 等）。
 * 仅展示标题/艺术家/专辑/年份/歌词/封面，不提供编辑；入口在歌单弹窗的「查看标签」按钮。
 */
export default class TagViewerModal extends Modal {
    private source: AudioSource | null = null

    constructor(app: App, source: AudioSource) {
        super(app)
        this.source = source
    }

    async onOpen() {
        this.contentEl.empty()
        this.contentEl.addClass('lyrics-tag-editor')
        this.titleEl.setText('查看标签')
        this.contentEl.createDiv({ cls: 'lyrics-tag-loading', text: '正在读取标签…' })

        if (!this.source) {
            new Notice('未找到音频文件')
            this.close()
            return
        }

        // 读原始字节（vault / 库外）
        let bytes: Uint8Array | null = null
        try {
            if (this.source.type === 'vault' && this.source.file) {
                bytes = new Uint8Array(await this.app.vault.readBinary(this.source.file))
            } else if (this.source.type === 'external' && this.source.path) {
                const fs = (window as any).require('fs')
                bytes = new Uint8Array(await fs.promises.readFile(this.source.path))
            }
        } catch { /* fallthrough */ }
        if (!bytes) {
            new Notice('读取标签失败', 4000)
            this.close()
            return
        }

        const tags = await readGenericTags(bytes)
        this.contentEl.empty()
        this.render(tags)
    }

    private render(tags: Mp3Tags | null) {
        const t = tags ?? {}
        new Setting(this.contentEl).setName('标题').setDesc(t.title || '（无）')
        new Setting(this.contentEl).setName('艺术家').setDesc(t.artist || '（无）')
        new Setting(this.contentEl).setName('专辑').setDesc(t.album || '（无）')

        new Setting(this.contentEl).setName('歌词').setDesc('只读展示，如需修改请用外部工具编辑标签')
        const lyricsArea = this.contentEl.createEl('textarea', {
            cls: 'lyrics-tag-lyrics',
        }) as HTMLTextAreaElement
        lyricsArea.value = t.lyrics || ''
        lyricsArea.readOnly = true

        new Setting(this.contentEl).setName('封面')
        if (t.cover) {
            const url = URL.createObjectURL(new Blob([t.cover.data], { type: t.cover.mime }))
            const img = this.contentEl.createEl('img', { cls: 'lyrics-tag-cover-img' })
            img.src = url
            const revoke = () => URL.revokeObjectURL(url)
            img.onload = revoke
            img.onerror = revoke
        } else {
            this.contentEl.createDiv({ cls: 'lyrics-tag-cover-preview', text: '（无封面）' })
        }

        const actions = this.contentEl.createDiv({ cls: 'lyrics-tag-actions' })
        actions.createEl('button', { text: '关闭', cls: 'mod-cta lyrics-tag-cancel' })
            .addEventListener('click', () => this.close())
    }

    onClose() {
        this.contentEl.empty()
    }
}
