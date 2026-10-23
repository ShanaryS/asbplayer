import { useEffect, useRef } from 'react';
import { audioBufferedRange, clampAudioSeek } from '@project/common/audio-transcode/streaming-audio';
import { asbError, asbWarn } from '@project/common/util/log';

const driftToleranceSeconds = 0.15;
const resyncThresholdSeconds = 0.5;

/** Keep video and external audio together, including startup, streaming stalls and all seek paths. */
export const useExternalAudioTrack = ({
    video,
    audio,
    source,
    active,
    streaming,
    onError,
}: {
    video: HTMLVideoElement | undefined;
    audio: HTMLAudioElement | null;
    source: string | undefined;
    active: boolean;
    streaming: boolean;
    onError?: () => void;
}) => {
    // Preserve play intent when changing from MSE to the completed Blob, or replacing the audio element.
    const resumeAfterBuffering = useRef(false);
    const internallyPausing = useRef(false);
    const onErrorRef = useRef(onError);
    onErrorRef.current = onError;
    useEffect(() => {
        if (!video || !active) {
            resumeAfterBuffering.current = false;
            return;
        }
        const originalMuted = video.muted;
        video.muted = true;
        let videoWaiting = false;
        let playbackFailureLogged = false;
        let disposed = false;
        // Rebuilding MSE must buffer up to the existing position before enforcing user seeks.
        let pendingPosition = streaming ? video.currentTime : undefined;
        const audioFinished = () =>
            !streaming &&
            audio !== null &&
            Number.isFinite(audio.duration) &&
            (video.currentTime >= audio.duration ||
                (audio.ended && video.currentTime >= audio.duration - driftToleranceSeconds));
        const pauseForAudio = () => {
            if (!video.paused) {
                resumeAfterBuffering.current = true;
                internallyPausing.current = true;
                video.pause();
            }
            audio?.pause();
        };
        const playable = () => {
            if (audioFinished()) return true;
            if (!audio || !source || audio.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) return false;
            if (!streaming) return true;
            const range = audioBufferedRange(audio.buffered);
            return range.end > video.currentTime + 0.05 && range.start <= video.currentTime + 0.02;
        };
        const synchronizeTime = () => {
            if (!audio) return;
            if (audioFinished()) {
                audio.pause();
                return;
            }
            if (streaming) {
                const range = audioBufferedRange(audio.buffered);
                if (range.start > video.currentTime || range.end <= video.currentTime) return;
                pendingPosition = undefined;
            }
            if (
                audio.readyState >= HTMLMediaElement.HAVE_METADATA &&
                Math.abs(audio.currentTime - video.currentTime) > driftToleranceSeconds
            ) {
                audio.currentTime = video.currentTime;
            }
        };
        const seeking = () => {
            if (!audio) return;
            if (streaming && pendingPosition !== video.currentTime) {
                const target = clampAudioSeek(video.currentTime, audioBufferedRange(audio.buffered));
                if (Math.abs(target - video.currentTime) > 0.025) video.currentTime = target;
                pendingPosition = undefined;
            }
            synchronizeTime();
        };
        const restorePosition = (event: Event) => {
            if (streaming) pendingPosition = (event as CustomEvent<number>).detail;
        };
        const playAudio = () => {
            if (!audio || audioFinished()) return;
            void audio.play().then(
                () => {
                    playbackFailureLogged = false;
                },
                (error: unknown) => {
                    // Pausing or replacing a source can interrupt a pending play without a media failure.
                    if (disposed || (error instanceof DOMException && error.name === 'AbortError')) return;
                    pauseForAudio();
                    // Buffering recovery must not resume muted video after playback was rejected.
                    resumeAfterBuffering.current = false;
                    if (playbackFailureLogged) return;
                    playbackFailureLogged = true;
                    asbWarn('audio/playback', 'Could not play converted audio', { error });
                    onErrorRef.current?.();
                }
            );
        };
        const play = () => {
            videoWaiting = false;
            synchronizeTime();
            if (!playable()) {
                pauseForAudio();
                return;
            }
            resumeAfterBuffering.current = false;
            playAudio();
        };
        const pause = () => {
            audio?.pause();
            if (internallyPausing.current) internallyPausing.current = false;
            else resumeAfterBuffering.current = false;
        };
        const userPause = () => {
            resumeAfterBuffering.current = false;
        };
        const waiting = () => {
            videoWaiting = true;
            audio?.pause();
        };
        const audioWaiting = () => {
            if (!audioFinished()) pauseForAudio();
        };
        const canPlay = () => {
            if (video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) videoWaiting = false;
            synchronizeTime();
            if (resumeAfterBuffering.current && playable() && !videoWaiting) {
                resumeAfterBuffering.current = false;
                void video
                    .play()
                    .catch((error: unknown) => asbWarn('audio/playback', 'Could not resume video', { error }));
            } else if (!video.paused && playable() && !videoWaiting) playAudio();
        };
        const videoCanPlay = () => {
            videoWaiting = false;
            canPlay();
        };
        const seeked = () => {
            synchronizeTime();
            if (!video.paused) play();
        };
        const rate = () => {
            if (!audio) return;
            audio.playbackRate = video.playbackRate;
            audio.preservesPitch = video.preservesPitch;
        };
        const error = () => {
            pauseForAudio();
            // A fatal media error needs an explicit retry, rather than a timer resuming silent video.
            resumeAfterBuffering.current = false;
            onErrorRef.current?.();
            asbError('audio/playback', 'Converted audio media error', {
                code: audio?.error?.code,
                message: audio?.error?.message,
            });
        };
        const correctDrift = () => {
            if (resumeAfterBuffering.current) {
                canPlay();
                return;
            }
            if (video.paused || videoWaiting) return;
            if (!playable()) {
                pauseForAudio();
                return;
            }
            const drift = Math.abs((audio?.currentTime ?? 0) - video.currentTime);
            if (drift > driftToleranceSeconds) synchronizeTime();
            if (drift > resyncThresholdSeconds || audio?.paused) playAudio();
        };
        rate();
        if (audio) audio.volume = video.volume;
        synchronizeTime();
        if (!video.paused) play();
        else if (resumeAfterBuffering.current) canPlay();
        video.addEventListener('asb-user-pause', userPause);
        video.addEventListener('asb-restore-playback-position', restorePosition);
        video.addEventListener('play', play);
        video.addEventListener('playing', play);
        video.addEventListener('pause', pause);
        video.addEventListener('seeking', seeking);
        video.addEventListener('seeked', seeked);
        video.addEventListener('ratechange', rate);
        video.addEventListener('waiting', waiting);
        video.addEventListener('canplay', videoCanPlay);
        video.addEventListener('ended', pause);
        audio?.addEventListener('waiting', audioWaiting);
        audio?.addEventListener('ended', canPlay);
        audio?.addEventListener('canplay', canPlay);
        audio?.addEventListener('progress', canPlay);
        audio?.addEventListener('error', error);
        const interval = setInterval(correctDrift, 250);
        return () => {
            disposed = true;
            clearInterval(interval);
            video.removeEventListener('asb-user-pause', userPause);
            video.removeEventListener('asb-restore-playback-position', restorePosition);
            video.removeEventListener('play', play);
            video.removeEventListener('playing', play);
            video.removeEventListener('pause', pause);
            video.removeEventListener('seeking', seeking);
            video.removeEventListener('seeked', seeked);
            video.removeEventListener('ratechange', rate);
            video.removeEventListener('waiting', waiting);
            video.removeEventListener('canplay', videoCanPlay);
            video.removeEventListener('ended', pause);
            audio?.removeEventListener('waiting', audioWaiting);
            audio?.removeEventListener('ended', canPlay);
            audio?.removeEventListener('canplay', canPlay);
            audio?.removeEventListener('progress', canPlay);
            audio?.removeEventListener('error', error);
            audio?.pause();
            video.muted = originalMuted;
        };
    }, [video, audio, source, active, streaming]);
};
