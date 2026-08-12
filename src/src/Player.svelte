<script lang="ts">
export let src: string
export let timeupdate: (time: number) => void
let player: HTMLAudioElement
export let onended: () => void = () => {}
export let onError: () => void = () => {}
export let time: number
export let onPlay: () => void
export let onPause: () => void = () => {}
export function seek(t: number) {
    // 仅跳转位置，不强制播放：暂停状态下点击歌词保持暂停（v1.4.0 巩固）
    time = t
}

export function getTimeStamp(): number {
    return time
}

export function play(): void {
    if (player.paused) {
        player.play()
    }
}

export function paused(): boolean {
    return player.paused
}

export function pause(): void {
    if (!player.paused) {
        player.pause()
    }
}

export function getDuration(): number {
    return player?.duration || 0
}

export function setRate(rate: number): void {
    if (player) {
        player.playbackRate = rate
    }
}

export function getRate(): number {
    return player?.playbackRate || 1
}

export function setVolume(vol: number) {
    if (player) {
        player.volume = Math.max(0, Math.min(1, vol))
    }
}

export function isReady(): boolean {
    return player && player.readyState >= 2 // HAVE_CURRENT_DATA
}

export function getVolume(): number {
    return player?.volume ?? 1
}

const _timeupdate = () => {
    if (timeupdate) {
        timeupdate(time)
    }
}

const _play = () => {
    if (onPlay) {
        onPlay()
    }
}

const _pause = () => {
    if (onPause) {
        onPause()
    }
}

const _ended = () => {
    if (onended) {
        onended()
    }
}

const _error = () => {
    if (onError) {
        onError()
    }
}
</script>

<div class="audio-wrapper">
    <audio
        bind:this={player}
        controlslist="nodownload"
        {src}
        controls
        bind:currentTime={time}
        on:timeupdate={_timeupdate}
        on:play={_play}
        on:pause={_pause}
        on:ended={_ended}
        on:error={_error}
    ></audio>
</div>

<style>
</style>