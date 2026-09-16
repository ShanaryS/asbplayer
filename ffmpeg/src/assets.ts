import { ffmpegMetadata } from '@project/ffmpeg/metadata';

export type FfmpegAssetUrls = {
    workerURL: string;
    coreURL: string;
    wasmURL: string;
};

const ensureTrailingSlash = (url: string) => (url.endsWith('/') ? url : `${url}/`);

export const ffmpegVersionBaseUrl = (assetBaseUrl: string) =>
    new URL(`${ffmpegMetadata.runtimeVersion}/`, ensureTrailingSlash(assetBaseUrl)).href;

export const ffmpegAssetUrls = (assetBaseUrl: string): FfmpegAssetUrls => {
    const versionBaseUrl = ffmpegVersionBaseUrl(assetBaseUrl);
    return {
        workerURL: new URL('ffmpeg-worker.js', versionBaseUrl).href,
        coreURL: new URL('ffmpeg-core.js', versionBaseUrl).href,
        wasmURL: new URL('ffmpeg-core.wasm', versionBaseUrl).href,
    };
};
