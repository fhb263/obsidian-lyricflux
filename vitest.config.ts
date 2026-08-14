import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
    resolve: {
        alias: {
            // 渲染器使用的 obsidian 模块 → 测试替身（renderer 在 Node 下不可用）
            obsidian: resolve(__dirname, 'tests/mocks/obsidian.ts'),
            // src 下 baseUrl 裸导入：renderers 路由 / wordSplitter 等
            renderers: resolve(__dirname, 'src/renderers'),
            // tags.ts 等被测试直接导入的 src 顶层模块（tsconfig baseUrl 裸导入）
            mp3Duration: resolve(__dirname, 'src/mp3Duration.ts'),
            tags: resolve(__dirname, 'src/tags.ts'),
            // tags.ts 直接 import 的容器判别；测试 import tags.ts 时需可解析（与 tags 同理）
            songScanner: resolve(__dirname, 'src/songScanner.ts'),
            // downloadManager 的其余 src 裸导入（Node 通道为整模块真实导入，需全部可解析）
            onlineLyrics: resolve(__dirname, 'src/onlineLyrics.ts'),
            downloadUtils: resolve(__dirname, 'src/downloadUtils.ts'),
            translate: resolve(__dirname, 'src/translate.ts'),
            tagSize: resolve(__dirname, 'src/tagSize.ts'),
            neteaseCrypto: resolve(__dirname, 'src/neteaseCrypto.ts'),
            qqMusic: resolve(__dirname, 'src/qqMusic.ts'),
            kugouMusic: resolve(__dirname, 'src/kugouMusic.ts'),
            kuwoMusic: resolve(__dirname, 'src/kuwoMusic.ts'),
        },
    },
    test: {
        environment: 'node',
        include: ['tests/**/*.test.ts'],
    },
})
