import artifactLock from '@project/ffmpeg/artifact-lock.json';

export const ffmpegMetadata = {
    runtimeVersion: artifactLock.runtimeVersion,
    ffmpegVersion: artifactLock.ffmpegVersion,
    sourceUrl: `${artifactLock.releaseBaseUrl}/${artifactLock.sourceArchive.filename}`,
} as const;

export type FfmpegMetadata = typeof ffmpegMetadata;
