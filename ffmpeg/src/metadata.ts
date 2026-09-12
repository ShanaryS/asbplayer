import artifactLock from '@project/ffmpeg/artifact-lock.json';
import capabilities from '@project/ffmpeg/capabilities.json';
import versions from '@project/ffmpeg/versions.json';

export const ffmpegMetadata = {
    coreVersion: versions.coreVersion,
    wrapperVersion: versions.wrapperVersion,
    ffmpegVersion: versions.ffmpegVersion,
    sourceUrl: `${artifactLock.releaseBaseUrl}/${artifactLock.sourceArchive.name}`,
    runtimeHashes: artifactLock.runtime,
    runtimeFilenames: Object.keys(artifactLock.runtime),
    capabilities,
} as const;

export type FfmpegMetadata = typeof ffmpegMetadata;
