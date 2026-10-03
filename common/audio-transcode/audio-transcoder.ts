import type { FfmpegDownloadProgress, FfmpegSession, FfmpegTranscodeProgress } from '@project/ffmpeg';
import { asbTrace } from '@project/common/util/log';

const outputMimeType = 'audio/mp4; codecs="mp4a.40.2"';

/** Supplied by the host so the shared UI uses its runtime cache and asset policy. */
export interface AudioTranscodeHost {
    isAvailable(): Promise<boolean>;
    createSession(options: {
        signal: AbortSignal;
        onDownloadProgress: (progress: FfmpegDownloadProgress) => void;
    }): FfmpegSession;
}

export type AudioTranscodeProgress =
    | { readonly stage: 'loadingDecoder'; readonly download?: FfmpegDownloadProgress }
    | (FfmpegTranscodeProgress & {
          readonly elapsedSeconds: number;
          /** Media seconds processed per wall-clock second; unknown during the initial sample. */
          readonly speed: number | undefined;
          readonly etaSeconds: number | undefined;
      });

export interface TranscodedAudio {
    readonly blob: Blob;
    readonly mimeType: string;
}

export const transcodeAudioTrack = async ({
    file,
    trackIndex,
    host,
    onProgress,
    signal,
    now = () => performance.now(),
}: {
    file: File;
    trackIndex: number;
    host: AudioTranscodeHost;
    onProgress: (progress: AudioTranscodeProgress) => void;
    signal: AbortSignal;
    /** Monotonic milliseconds, used only for conversion speed and ETA. */
    now?: () => number;
}): Promise<TranscodedAudio> => {
    signal.throwIfAborted();
    const startedAt = now();
    const context = { inputBytes: file.size, trackIndex };
    let stage: AudioTranscodeProgress['stage'] = 'loadingDecoder';
    asbTrace('audio/transcode', 'Loading audio decoder', context);
    const session = host.createSession({
        signal,
        onDownloadProgress: (download) => onProgress({ stage: 'loadingDecoder', download }),
    });
    try {
        onProgress({ stage: 'loadingDecoder' });
        const runtime = await session.load({ signal });
        signal.throwIfAborted();
        stage = 'transcoding';
        asbTrace('audio/transcode', 'Decoder ready; converting audio to AAC', {
            ...context,
            elapsedMs: now() - startedAt,
        });
        const conversionStartedAt = now();
        onProgress({
            stage: 'transcoding',
            processedSeconds: 0,
            totalSeconds: undefined,
            elapsedSeconds: 0,
            speed: undefined,
            etaSeconds: undefined,
        });
        const output = await runtime.transcodeAudio({
            input: file,
            trackIndex,
            signal,
            onProgress: (progress) => {
                if (signal.aborted) return;
                stage = progress.stage;
                const elapsedSeconds = Math.max(0, (now() - conversionStartedAt) / 1000);
                // Average processing speed stabilizes the estimate; decoder loading is excluded.
                const speed =
                    elapsedSeconds >= 1 && progress.processedSeconds > 0
                        ? progress.processedSeconds / elapsedSeconds
                        : undefined;
                onProgress({
                    ...progress,
                    elapsedSeconds,
                    speed,
                    etaSeconds:
                        progress.stage === 'transcoding' &&
                        progress.totalSeconds !== undefined &&
                        progress.processedSeconds < progress.totalSeconds &&
                        speed !== undefined
                            ? (progress.totalSeconds - progress.processedSeconds) / speed
                            : undefined,
                });
            },
        });
        signal.throwIfAborted();
        asbTrace('audio/transcode', 'Audio conversion completed', {
            ...context,
            outputBytes: output.byteLength,
            elapsedMs: now() - startedAt,
        });
        return { blob: new Blob([output], { type: outputMimeType }), mimeType: outputMimeType };
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
