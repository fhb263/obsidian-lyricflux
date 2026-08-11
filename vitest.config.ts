import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
    resolve: {
        alias: {
            // 渲染器使用的 obsidian 模块 → 测试替身（renderer 在 Node 下不可用）
            obsidian: resolve(__dirname, 'tests/mocks/obsidian.ts'),
            // src 下 baseUrl 裸导入：renderers 路由 / wordSplitter 等
            renderers: resolve(__dirname, 'src/renderers'),
        },
    },
    test: {
        environment: 'node',
        include: ['tests/**/*.test.ts'],
    },
})
