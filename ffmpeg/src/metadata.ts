import artifactLock from '@project/ffmpeg/artifact-lock.json';

declare const __ASB_FFMPEG_RUNTIME_VERSION__: string | undefined;
declare const __ASB_FFMPEG_VERSION__: string | undefined;
declare const __ASB_FFMPEG_SOURCE_URL__: string | undefined;

export const ffmpegMetadata = {
    runtimeVersion:
        typeof __ASB_FFMPEG_RUNTIME_VERSION__ === 'string'
            ? __ASB_FFMPEG_RUNTIME_VERSION__
            : artifactLock.runtimeVersion,
    ffmpegVersion: typeof __ASB_FFMPEG_VERSION__ === 'string' ? __ASB_FFMPEG_VERSION__ : artifactLock.ffmpegVersion,
    sourceUrl: typeof __ASB_FFMPEG_SOURCE_URL__ === 'string' ? __ASB_FFMPEG_SOURCE_URL__ : artifactLock.releaseUrl,
} as const;

export type FfmpegMetadata = typeof ffmpegMetadata;
