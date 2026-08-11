/** jsmediatags 无内置类型声明，这里声明本插件用到的部分（只读跨格式标签：FLAC/M4A/OGG 等） */
declare module 'jsmediatags' {
    export interface Tags {
        title?: string
        artist?: string
        album?: string
        year?: string | number
        lyrics?: string
        comment?: string
        genre?: string
        picture?: { format?: string; data?: ArrayLike<number> | Uint8Array }
        [key: string]: unknown
    }

    export interface MediaTagResult {
        type: string
        tags: Tags
    }

    export interface Callbacks {
        onSuccess: (result: MediaTagResult) => void
        onError: (error: unknown) => void
    }

    export function read(location: unknown, callbacks: Callbacks): void
}
