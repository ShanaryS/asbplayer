import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { useExternalAudioTrack } from '@project/common/app/hooks/use-external-audio-track';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
let video: HTMLVideoElement;
let audio: HTMLAudioElement;
let videoPaused: boolean;
let audioPaused: boolean;
let ready: number;
let end: number;
let duration: number;
const Harness = ({ source = 'blob:stream', active = true, streaming = true, onError = () => {} }) => {
    useExternalAudioTrack({ video, audio, source, active, streaming, onError });
    return null;
};
beforeEach(() => {
    container = document.createElement('div');
    root = createRoot(container);
    video = document.createElement('video');
    audio = document.createElement('audio');
    videoPaused = false;
    audioPaused = true;
    ready = 0;
    end = 0;
    duration = NaN;
    Object.defineProperties(video, { paused: { get: () => videoPaused }, readyState: { value: 4 } });
    Object.defineProperties(audio, {
        paused: { get: () => audioPaused },
        readyState: { get: () => ready },
        duration: { get: () => duration },
        buffered: { get: () => ({ length: end > 0 ? 1 : 0, start: () => 0, end: () => end }) },
    });
    jest.spyOn(video, 'play').mockImplementation(async () => {
        videoPaused = false;
        video.dispatchEvent(new Event('play'));
    });
    jest.spyOn(video, 'pause').mockImplementation(() => {
        if (videoPaused) return;
        videoPaused = true;
        queueMicrotask(() => video.dispatchEvent(new Event('pause')));
    });
    jest.spyOn(audio, 'play').mockImplementation(async () => {
        audioPaused = false;
    });
    jest.spyOn(audio, 'pause').mockImplementation(() => {
        audioPaused = true;
    });
});
afterEach(async () => {
    await act(async () => root.unmount());
    jest.restoreAllMocks();
    jest.useRealTimers();
});
const render = async (props = {}) => {
    await act(async () => root.render(<Harness {...props} />));
};
const available = async (seconds: number) => {
    end = seconds;
    ready = 3;
    await act(async () => audio.dispatchEvent(new Event('canplay')));
};

it('holds video during startup, resumes with audio, and holds both during an audio stall', async () => {
    await render();
    expect(videoPaused).toBe(true);
    expect(video.muted).toBe(true);
    await available(10);
    expect(videoPaused).toBe(false);
    expect(audioPaused).toBe(false);
    ready = 2;
    await act(async () => audio.dispatchEvent(new Event('waiting')));
    expect(videoPaused).toBe(true);
    expect(audioPaused).toBe(true);
    await available(20);
    expect(videoPaused).toBe(false);
    expect(audioPaused).toBe(false);
});

it('resumes after a seek makes both video and audio wait for data', async () => {
    await render();
    await available(10);
    await act(async () => {
        video.dispatchEvent(new Event('waiting'));
        ready = 2;
        audio.dispatchEvent(new Event('waiting'));
    });
    expect(videoPaused).toBe(true);
    await available(20);
    expect(videoPaused).toBe(false);
    expect(audioPaused).toBe(false);
});

it('respects an explicit pause while buffering instead of resuming playback later', async () => {
    await render();
    video.dispatchEvent(new Event('asb-user-pause'));
    await available(10);
    expect(videoPaused).toBe(true);
    expect(audioPaused).toBe(true);
});

it('guards seeks at the media element even when they bypass application controls', async () => {
    await render();
    await available(10);
    video.currentTime = 500;
    video.dispatchEvent(new Event('seeking'));
    expect(video.currentTime).toBeCloseTo(9.98);
    expect(audio.currentTime).toBeCloseTo(9.98);
    video.currentTime = 5;
    video.dispatchEvent(new Event('seeked'));
    expect(audio.currentTime).toBe(5);
});

it('retains a nonzero position while reconstructed audio buffers up to it', async () => {
    video.currentTime = 60;
    await render();
    expect(video.currentTime).toBe(60);
    expect(videoPaused).toBe(true);
    await available(5);
    expect(video.currentTime).toBe(60);
    expect(videoPaused).toBe(true);
    await available(70);
    expect(video.currentTime).toBe(60);
    expect(audio.currentTime).toBe(60);
    expect(videoPaused).toBe(false);
    expect(audioPaused).toBe(false);
});

it('waits for a remembered position while continuing to bound deliberate seeks', async () => {
    await render();
    await available(10);
    await act(async () => {
        video.dispatchEvent(new CustomEvent('asb-restore-playback-position', { detail: 60 }));
        video.currentTime = 60;
        video.dispatchEvent(new Event('seeking'));
        video.dispatchEvent(new Event('seeked'));
    });
    expect(video.currentTime).toBe(60);
    expect(videoPaused).toBe(true);
    await available(30);
    expect(video.currentTime).toBe(60);
    expect(videoPaused).toBe(true);
    await available(70);
    expect(video.currentTime).toBe(60);
    expect(audio.currentTime).toBe(60);
    expect(videoPaused).toBe(false);
    video.currentTime = 500;
    video.dispatchEvent(new Event('seeking'));
    expect(video.currentTime).toBeCloseTo(69.98);
});

it('continues through completed audio EOF and resumes audio after a backward seek', async () => {
    duration = 3;
    video.currentTime = 2;
    ready = 3;
    await render({ streaming: false });
    expect(audio.currentTime).toBe(2);
    expect(audioPaused).toBe(false);
    audio.currentTime = 3;
    video.currentTime = 4;
    ready = 1;
    await act(async () => audio.dispatchEvent(new Event('waiting')));
    await act(async () => audio.dispatchEvent(new Event('ended')));
    expect(videoPaused).toBe(false);
    expect(audioPaused).toBe(true);
    expect(audio.currentTime).toBe(3);
    await act(async () => {
        ready = 3;
        video.currentTime = 1;
        video.dispatchEvent(new Event('seeking'));
        video.dispatchEvent(new Event('seeked'));
    });
    expect(audio.currentTime).toBe(1);
    expect(audioPaused).toBe(false);
    expect(videoPaused).toBe(false);
});

it('preserves play intent across source replacement and restores muting on detach', async () => {
    await render();
    await render({ source: 'blob:finished', streaming: false });
    await available(180);
    expect(videoPaused).toBe(false);
    expect(audioPaused).toBe(false);
    await render({ active: false });
    expect(video.muted).toBe(false);
    expect(audioPaused).toBe(true);
});

it('stops both media elements and reports a fatal audio error for conversion cancellation', async () => {
    const onError = jest.fn();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await render({ onError });
    await available(10);
    await act(async () => audio.dispatchEvent(new Event('error')));
    expect(videoPaused).toBe(true);
    expect(audioPaused).toBe(true);
    expect(onError).toHaveBeenCalledTimes(1);
});

it.each([true, false])('keeps video paused after repeated playback rejection (streaming: %s)', async (streaming) => {
    jest.useFakeTimers();
    const onError = jest.fn();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.mocked(audio.play).mockRejectedValue(new DOMException('Playback denied', 'NotAllowedError'));
    await render({ streaming, onError });
    await available(10);
    expect(videoPaused).toBe(true);
    await available(20);
    await act(async () => jest.advanceTimersByTime(1_000));
    expect(videoPaused).toBe(true);
    expect(audioPaused).toBe(true);
    expect(onError).toHaveBeenCalledTimes(1);

    await act(async () => video.play());
    expect(videoPaused).toBe(true);
    expect(audioPaused).toBe(true);
    expect(onError).toHaveBeenCalledTimes(1);
});

it('does not report an interrupted audio play as a conversion failure', async () => {
    const onError = jest.fn();
    let rejectPlay!: (error: Error) => void;
    jest.mocked(audio.play).mockImplementationOnce(() => new Promise((_, reject) => (rejectPlay = reject)));
    await render({ onError });
    await available(10);
    await act(async () => {
        video.pause();
        rejectPlay(new DOMException('Playback interrupted by pause', 'AbortError'));
    });
    expect(videoPaused).toBe(true);
    expect(audioPaused).toBe(true);
    expect(onError).not.toHaveBeenCalled();
});

it('ignores a pending play rejection from a replaced audio source', async () => {
    const onError = jest.fn();
    let rejectPlay!: (error: Error) => void;
    jest.mocked(audio.play).mockImplementationOnce(() => new Promise((_, reject) => (rejectPlay = reject)));
    await render({ onError });
    await available(10);
    await render({ source: 'blob:finished', streaming: false, onError });
    await act(async () => rejectPlay(new DOMException('Old source failed', 'NotSupportedError')));
    expect(videoPaused).toBe(false);
    expect(audioPaused).toBe(false);
    expect(onError).not.toHaveBeenCalled();
});
