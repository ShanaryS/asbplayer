import { ffmpegMetadata } from '@project/ffmpeg/metadata';

export type FfmpegAssetUrls = {
    wrapperURL: string;
    classWorkerURL: string;
    coreURL: string;
    wasmURL: string;
};

const ensureTrailingSlash = (url: string) => (url.endsWith('/') ? url : `${url}/`);

export const ffmpegVersionBaseUrl = (assetBaseUrl: string) =>
    new URL(`${ffmpegMetadata.coreVersion}/`, ensureTrailingSlash(assetBaseUrl)).href;

export const ffmpegAssetUrls = (assetBaseUrl: string): FfmpegAssetUrls => {
    const versionBaseUrl = ffmpegVersionBaseUrl(assetBaseUrl);
    return {
        wrapperURL: new URL('ffmpeg-wrapper.js', versionBaseUrl).href,
        classWorkerURL: new URL('ffmpeg-worker.js', versionBaseUrl).href,
        coreURL: new URL('ffmpeg-core.js', versionBaseUrl).href,
        wasmURL: new URL('ffmpeg-core.wasm', versionBaseUrl).href,
    };
};
