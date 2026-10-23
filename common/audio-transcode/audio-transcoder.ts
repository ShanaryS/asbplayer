import type { FfmpegSession, FfmpegTranscodeProgress } from '@project/ffmpeg';
import { finalizeWebmAudio } from '@project/common/audio-transcode/webm-audio';
import { asbTrace } from '@project/common/util/log';

export const opusAudioMimeType = 'audio/webm; codecs="opus"';

/** Supplied by the host so the shared UI uses its runtime cache and asset policy. */
export interface AudioTranscodeHost {
    isAvailable(): Promise<boolean>;
    supportsOpusStreaming(): boolean;
    createSession(options: { signal: AbortSignal }): FfmpegSession;
}

export const transcodeAudioTrack = async ({
    file,
    trackIndex,
    host,
    onAudio,
    signal,
    now = () => performance.now(),
}: {
    file: File;
    trackIndex: number;
    host: AudioTranscodeHost;
    signal: AbortSignal;
    /** Cumulative immutable audio prefix; the coordinator owns chunk accumulation. */
    onAudio: (audio: Blob) => void;
    /** Monotonic milliseconds for trace timings. */
    now?: () => number;
}): Promise<Blob> => {
    signal.throwIfAborted();
    if (!host.supportsOpusStreaming()) throw new Error('Opus streaming is not supported by this browser');
    const chunks: Blob[] = [];
    const startedAt = now();
    const context = { inputBytes: file.size, trackIndex };
    let stage: 'loadingDecoder' | FfmpegTranscodeProgress['stage'] = 'loadingDecoder';
    asbTrace('audio/transcode', 'Loading audio decoder', context);
    const session = host.createSession({ signal });
    try {
        const runtime = await session.load({ signal });
        signal.throwIfAborted();
        stage = 'transcoding';
        asbTrace('audio/transcode', 'Decoder ready; converting audio', {
            ...context,
            elapsedMs: now() - startedAt,
        });
        const duration = await runtime.transcodeAudio({
            input: file,
            trackIndex,
            signal,
            onProgress: (progress) => {
                stage = progress.stage;
            },
            onChunk: (bytes) => {
                signal.throwIfAborted();
                const chunk = new Blob([bytes], { type: opusAudioMimeType });
                chunks.push(chunk);
                onAudio(new Blob(chunks, { type: opusAudioMimeType }));
            },
        });
        signal.throwIfAborted();
        const blob = await finalizeWebmAudio(chunks, duration);
        signal.throwIfAborted();
        asbTrace('audio/transcode', 'Audio conversion completed', {
            ...context,
            outputBytes: blob.size,
            elapsedMs: now() - startedAt,
        });
        return blob;
    } catch (error) {
        asbTrace('audio/transcode', signal.aborted ? 'Audio conversion cancelled' : 'Audio conversion failed', {
            ...context,
            stage,
            elapsedMs: now() - startedAt,
            ...(signal.aborted ? {} : { error }),
        });
        throw error;
    } finally {
        session.dispose();
    }
};
