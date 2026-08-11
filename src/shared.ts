/**
 * 共享常量与类型 —— 从 main.ts 抽出，供 LyricsPlugin / LyricsView / Settings 共同引用，
 * 避免主文件拆分后产生循环依赖。
 */

export const LYRICS_VIEW_TYPE = 'lyrics-sidebar'

export type PlayMode = 'off' | 'single' | 'sequential' | 'shuffle'
export const PLAY_MODES: PlayMode[] = ['off', 'single', 'sequential', 'shuffle']

export const SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2]
export const VOLUME_OPTIONS = [0, 25, 50, 75, 100]
