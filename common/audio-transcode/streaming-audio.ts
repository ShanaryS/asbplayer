import { opusAudioMimeType } from '@project/common/audio-transcode/audio-transcoder';
import { asbError, asbTrace } from '@project/common/util/log';

export type AudioSeekableRange = { readonly start: number; readonly end: number };

/** Only seek inside audio the browser has actually accepted, leaving one Opus frame at the end. */
export const clampAudioSeek = (seconds: number, range: AudioSeekableRange | undefined) => {
    if (range === undefined) return Math.max(0, seconds);
    return Math.max(range.start, Math.min(seconds, Math.max(range.start, range.end - 0.02)));
};

export const audioBufferedRange = (buffered: TimeRanges): AudioSeekableRange =>
    buffered.length === 0 ? { start: 0, end: 0 } : { start: buffered.start(0), end: buffered.end(buffered.length - 1) };

/**
 * Owns MSE in the playback document (including pop-outs). A cumulative, immutable WebM Blob
 * lets a newly opened player replay the stream without restarting the native conversion.
 * Keep about two minutes ahead in MSE; the complete output becomes an ordinary Blob source.
 */
export const createStreamingAudio = ({
    currentTime,
    onBuffered,
    onError,
}: {
    currentTime: () => number;
    onBuffered: (range: AudioSeekableRange) => void;
    onError: (error: unknown) => void;
}) => {
    const mediaSource = new MediaSource();
    const url = URL.createObjectURL(mediaSource);
    let sourceBuffer: SourceBuffer | undefined;
    let available: Blob | undefined;
    let consumed = 0;
    let reading = false;
    let disposed = false;
    let quotaExceeded = false;

    const fail = (error: unknown) => {
        if (disposed) return;
        asbError('audio/streaming', 'Streamed audio playback failed', { consumedBytes: consumed, error });
        dispose();
        onError(error);
    };
    const pump = () => {
        if (disposed || reading || sourceBuffer === undefined || sourceBuffer.updating || available === undefined)
            return;
        if (mediaSource.readyState !== 'open') return;
        const range = audioBufferedRange(sourceBuffer.buffered);
        if (quotaExceeded) {
            // Browser audio quotas vary. Keep recent audio and retry after playback advances.
            const end = currentTime() - 30;
            if (end > range.start) {
                asbTrace('audio/streaming', 'Evicting played audio after the buffer quota was reached', {
                    bufferedStart: range.start,
                    bufferedEnd: range.end,
                    evictBefore: end,
                });
                quotaExceeded = false;
                sourceBuffer.remove(0, end);
            }
            return;
        }
        if (range.end > currentTime() + 120 || consumed >= available.size) return;
        reading = true;
        const end = Math.min(available.size, consumed + 64 * 1024);
        void available
            .slice(consumed, end)
            .arrayBuffer()
            .then((bytes) => {
                reading = false;
                if (disposed || mediaSource.readyState !== 'open') return;
                try {
                    sourceBuffer!.appendBuffer(bytes);
                    consumed = end;
                } catch (error) {
                    if (error instanceof DOMException && error.name === 'QuotaExceededError') {
                        asbTrace('audio/streaming', 'Buffer quota reached; waiting for playback to advance', {
                            currentTime: currentTime(),
                            consumedBytes: consumed,
                        });
                        quotaExceeded = true;
                    } else fail(error);
                }
            }, fail);
    };
    const updated = () => {
        if (disposed || sourceBuffer === undefined) return;
        onBuffered(audioBufferedRange(sourceBuffer.buffered));
        pump();
    };
    const failed = () => fail(new Error('The browser could not decode the streamed Opus audio'));
    const opened = () => {
        if (disposed || sourceBuffer !== undefined) return;
        try {
            sourceBuffer = mediaSource.addSourceBuffer(opusAudioMimeType);
            asbTrace('audio/streaming', 'Opened streamed audio buffer', { availableBytes: available?.size ?? 0 });
            sourceBuffer.addEventListener('updateend', updated);
            sourceBuffer.addEventListener('error', failed);
            pump();
        } catch (error) {
            fail(error);
        }
    };
    const dispose = () => {
        if (disposed) return;
        disposed = true;
        clearInterval(interval);
        mediaSource.removeEventListener('sourceopen', opened);
        sourceBuffer?.removeEventListener('updateend', updated);
        sourceBuffer?.removeEventListener('error', failed);
        if (mediaSource.readyState === 'open' && sourceBuffer?.updating) sourceBuffer.abort();
        available = undefined;
        URL.revokeObjectURL(url);
    };
    mediaSource.addEventListener('sourceopen', opened);
    const interval = setInterval(pump, 250);
    return {
        url,
        append(blob: Blob) {
            if (disposed) return;
            available = blob;
            pump();
        },
        dispose,
    };
};
