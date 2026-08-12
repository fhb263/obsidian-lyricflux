import type { LyricSong } from './main'

/** 识别的音频扩展名（小写比较） */
const AUDIO_EXTENSIONS = ['mp3', 'flac', 'wav', 'ogg', 'aac', 'm4a']

/** 判断路径是否是音频文件（扩展名大小写不敏感） */
export function isAudioFile(path: string): boolean {
    const ext = path.split('.').pop()?.toLowerCase() ?? ''
    return AUDIO_EXTENSIONS.includes(ext)
}

/** 是否 Windows 盘符绝对路径（`D:\` 或 `D:/`，v1.4.2 库外音频文件夹支持） */
export function isWindowsAbsolutePath(p: string): boolean {
    return p.length >= 3 && /^[A-Za-z]:[\\/]/.test(p)
}

/** 取文件名去扩展名（兼容 `/` 与 `\` 两种分隔符，库外盘符路径用反斜杠） */
function basenameNoExt(path: string): string {
    const name = path.split(/[\\/]/).pop() ?? path
    return name.replace(/\.[^.]+$/, '')
}

/** 从音频路径构造裸 MP3 歌单项（初始 title 用文件名兜底，标签富化后覆盖） */
export function buildMp3Song(path: string): LyricSong {
    return {
        path,
        title: basenameNoExt(path),
        actor: '未知艺术家',
        type: '',
        banner: '',
        kind: 'mp3',
        audioPath: path,
    }
}

/** 去重：若某 MP3 已被 LRC 笔记的 source 引用，从裸 MP3 列表过滤掉 */
export function dedupeMp3ByNote(
    mp3s: LyricSong[],
    noteAudioPaths: Set<string>,
): LyricSong[] {
    return mp3s.filter((s) => !noteAudioPaths.has(s.audioPath ?? ''))
}

/**
 * 解析当前播放裸 MP3 应展示的元数据（无播放/非 mp3/歌单已无此歌 → null）。
 * 供标签编辑后把最新 title/actor 同步到正在播放的渲染器，使状态栏实时刷新。
 */
export function resolvePlayingMp3Metadata(
    state: { sourceKind?: string; filePath?: string } | null,
    songList: Array<{ path: string; title: string; actor: string }>,
): { path: string; title: string; actor: string } | null {
    if (!state || state.sourceKind !== 'mp3' || !state.filePath) return null
    const currentPath = state.filePath.replace(/^mp3:\/\//, '')
    const song = songList.find((s) => s.path === currentPath)
    return song ? { path: song.path, title: song.title, actor: song.actor } : null
}
