import { ffmpegMetadata } from '@project/ffmpeg/metadata';

export type FfmpegAssetUrls = {
    workerURL: string;
    coreURL: string;
    wasmURL: string;
};

export type PreparedFfmpegAssets = FfmpegAssetUrls & {
    /** Release temporary executable URLs when the session ends. */
    dispose(): void;
};

export type FfmpegDownloadProgress = {
    stage: 'downloading' | 'verifying' | 'complete';
    /** Includes bytes reused from the verified cache. Sizes refer to uncompressed assets. */
    downloadedBytes: number;
    totalBytes: number;
    bytesPerSecond: number;
    etaSeconds: number | undefined;
};

/** Build executable URLs from prepared bytes, independent of service-worker control or storage. */
export const createFfmpegObjectUrls = (blobs: { worker: Blob; core: Blob; wasm: Blob }): PreparedFfmpegAssets => {
    const urls: string[] = [];
    const dispose = () => {
        for (const url of urls.splice(0)) URL.revokeObjectURL(url);
    };
    const create = (blob: Blob, type: string) => {
        const url = URL.createObjectURL(new Blob([blob], { type }));
        urls.push(url);
        return url;
    };
    try {
        return {
            workerURL: create(blobs.worker, 'text/javascript'),
            coreURL: create(blobs.core, 'text/javascript'),
            wasmURL: create(blobs.wasm, 'application/wasm'),
            dispose,
        };
    } catch (error) {
        dispose();
        throw error;
    }
};

export const ffmpegAssetUrls = (assetBaseUrl: string): FfmpegAssetUrls => {
    const baseUrl = assetBaseUrl.endsWith('/') ? assetBaseUrl : `${assetBaseUrl}/`;
    const versionBaseUrl = new URL(`${ffmpegMetadata.runtimeVersion}/`, baseUrl).href;
    return {
        workerURL: new URL('ffmpeg-worker.js', versionBaseUrl).href,
        coreURL: new URL('ffmpeg-core.js', versionBaseUrl).href,
        wasmURL: new URL('ffmpeg-core.wasm', versionBaseUrl).href,
    };
};
