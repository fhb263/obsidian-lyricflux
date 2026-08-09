<script lang="ts">
export let src: string
export let timeupdate: (time: number) => void
let player: HTMLAudioElement
export let onended: () => void = () => {}
export let time: number
export let onPlay: () => void
export function seek(t: number) {
    time = t
    play()
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

const _ended = () => {
    if (onended) {
        onended()
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
        on:ended={_ended}
    ></audio>
</div>

<style>
</style>