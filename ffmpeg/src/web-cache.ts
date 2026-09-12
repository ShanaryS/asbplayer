import { ffmpegAssetUrls } from '@project/ffmpeg/assets';
import { ffmpegMetadata } from '@project/ffmpeg/metadata';

export const ffmpegCacheName = 'asbplayer-ffmpeg-runtime';

export type PrepareFfmpegAssetsOptions = {
    assetBaseUrl: string;
    cacheStorage?: CacheStorage;
    fetcher?: typeof fetch;
    expectedHashes?: Record<string, string>;
};

const sha256 = async (response: Response) => {
    const digest = await crypto.subtle.digest('SHA-256', await response.arrayBuffer());
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

const verifiedResponse = async (response: Response, url: string, expectedHash: string) => {
    if (!response.ok) {
        throw new Error(`Could not load FFmpeg asset ${url}: HTTP ${response.status}`);
    }
    if (!expectedHash) {
        throw new Error(`No pinned SHA-256 is available for FFmpeg asset ${url}`);
    }
    const actualHash = await sha256(response.clone());
    if (actualHash !== expectedHash) {
        throw new Error(`FFmpeg asset integrity check failed for ${url}`);
    }
    return response;
};

export const prepareFfmpegAssets = async ({
    assetBaseUrl,
    cacheStorage = globalThis.caches,
    fetcher = globalThis.fetch,
    expectedHashes = ffmpegMetadata.runtimeHashes,
}: PrepareFfmpegAssetsOptions) => {
    const urls = ffmpegAssetUrls(assetBaseUrl);
    const assets = [
        ['ffmpeg-wrapper.js', urls.wrapperURL],
        ['ffmpeg-worker.js', urls.classWorkerURL],
        ['ffmpeg-core.js', urls.coreURL],
        ['ffmpeg-core.wasm', urls.wasmURL],
    ] as const;

    let cache: Cache | undefined;
    try {
        cache = await cacheStorage?.open(ffmpegCacheName);
    } catch {
        // Execution can continue online when Cache Storage is unavailable.
    }

    const pending: Array<[string, Response]> = [];
    for (const [filename, url] of assets) {
        const expectedHash = expectedHashes[filename];
        let response = await cache?.match(url);
        if (response !== undefined) {
            try {
                await verifiedResponse(response, url, expectedHash);
                continue;
            } catch {
                await cache?.delete(url);
            }
        }
        response = await verifiedResponse(await fetcher(url), url, expectedHash);
        pending.push([url, response]);
    }

    if (cache !== undefined) {
        await Promise.all(pending.map(([url, response]) => cache.put(url, response)));
    }
    return urls;
};
