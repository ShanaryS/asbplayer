import { createFfmpegSession } from '@project/ffmpeg';
import type { FfmpegSession } from '@project/ffmpeg';
import { clamp } from '@project/common/util';

const outputMimeType = 'audio/mp4; codecs="mp4a.40.2"';

export type AudioTranscodeStage = 'loadingDecoder' | 'transcoding';

export interface AudioTranscodeProgress {
    readonly stage: AudioTranscodeStage;
    readonly ratio: number;
}

export interface TranscodedAudio {
    readonly blob: Blob;
    readonly mimeType: string;
}

let session: FfmpegSession | undefined;

const ffmpegSession = () => {
    if (session === undefined) {
        // document.baseURI preserves the deployment base path (for example /asbplayer/) while
        // keeping the runtime same-origin, which is required by module workers.
        const assetBaseUrl = new URL('ffmpeg/', document.baseURI).href;
        session = createFfmpegSession({ assetBaseUrl });
    }
    return session;
};

/**
 * The runtime is loaded lazily. This check is asynchronous because it also verifies that the
 * selected runtime actually contains the transcode operation; older locked runtimes remain usable
 * for normal playback without showing a prompt that cannot succeed.
 */
export const audioTranscodingAvailable = async () => {
    if (typeof navigator !== 'undefined' && navigator.onLine === false && session === undefined) return false;
    try {
        const runtime = await ffmpegSession().load();
        const info = await runtime.inspect();
        return info.operations.includes('transcodeAudio');
    } catch {
        return false;
    }
};

export const transcodeAudioTrack = async ({
    file,
    trackIndex,
    onProgress,
    signal,
}: {
    file: File;
    trackIndex: number;
    onProgress?: (progress: AudioTranscodeProgress) => void;
    signal?: AbortSignal;
}): Promise<TranscodedAudio> => {
    onProgress?.({ stage: 'loadingDecoder', ratio: 0 });
    const runtime = await ffmpegSession().load({ signal });
    const input = await file.arrayBuffer();
    onProgress?.({ stage: 'transcoding', ratio: 0 });
    const output = await runtime.transcodeAudio({ input, trackIndex, signal });
    onProgress?.({ stage: 'transcoding', ratio: 1 });
    return { blob: new Blob([output], { type: outputMimeType }), mimeType: outputMimeType };
};

export const transcodeProgressRatio = (progress: AudioTranscodeProgress | undefined) =>
    clamp(progress?.ratio ?? 0, 0, 1);
