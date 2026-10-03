import type { FfmpegAssetUrls, FfmpegDownloadProgress } from '@project/ffmpeg';
import artifactLock from '@project/ffmpeg/artifact-lock.json';
import { LocalizedError } from '@project/common/app/components/localized-error';
import { asbError, asbInfo, asbTrace, asbWarn } from '@project/common/util/log';

declare const __ASB_FFMPEG_RUNTIME_HASHES__: Record<string, string> | undefined;
declare const __ASB_FFMPEG_RUNTIME_SIZES__: Record<string, number> | undefined;

const runtimeHashes =
    typeof __ASB_FFMPEG_RUNTIME_HASHES__ === 'undefined' ? artifactLock.runtimeFiles : __ASB_FFMPEG_RUNTIME_HASHES__;
const runtimeSizes = typeof __ASB_FFMPEG_RUNTIME_SIZES__ === 'undefined' ? {} : __ASB_FFMPEG_RUNTIME_SIZES__;
const runtimeFiles = ['ffmpeg-worker.js', 'ffmpeg-core.js', 'ffmpeg-core.wasm'];
const cacheNamePrefix = 'asbplayer-ffmpeg-runtime-';
const verificationHeader = 'X-Asbplayer-FFmpeg-SHA256';

export const ffmpegRuntimeCacheName = (assetUrl: string) => `${cacheNamePrefix}${new URL('.', assetUrl).href}`;

export class FfmpegUpdateRequiredError extends LocalizedError {
    readonly code = 'update-required';

    constructor() {
        super('error.ffmpegUpdateRequired');
        this.name = 'FfmpegUpdateRequiredError';
    }
}

const isHtml = (response: Response) => response.headers.get('Content-Type')?.toLowerCase().includes('text/html');

const hasVerifiedHash = (response: Response, expectedHash?: string) => {
    const verifiedHash = response.headers.get(verificationHeader);
    return (
        response.ok &&
        !isHtml(response) &&
        (expectedHash ? verifiedHash === expectedHash : /^[a-f0-9]{64}$/.test(verifiedHash ?? ''))
    );
};

const verifyResponse = (response: Response) => {
    // Static hosts can return the app's HTML fallback for a retired asset URL.
    if (response.status === 404 || response.status === 410 || (response.ok && isHtml(response))) {
        throw new FfmpegUpdateRequiredError();
    }
    if (!response.ok) throw new Error(`Could not download FFmpeg (HTTP ${response.status}).`);
    return response;
};

const verifyHash = async (
    response: Response,
    bytes: Uint8Array<ArrayBuffer>,
    expectedHash: string,
    filename: string
) => {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const actualHash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
    if (actualHash !== expectedHash) throw new Error(`FFmpeg integrity check failed for ${filename}. Please retry.`);
    const headers = new Headers(response.headers);
    headers.set(verificationHeader, expectedHash);
    // The response body has already been decoded by fetch.
    headers.delete('Content-Encoding');
    headers.delete('Content-Length');
    return new Response(bytes, { status: response.status, statusText: response.statusText, headers });
};

const outdatedCacheNames = async (cacheStorage: CacheStorage, currentWorkerUrl: string) => {
    const current = ffmpegRuntimeCacheName(currentWorkerUrl);
    const prefix = `${cacheNamePrefix}${new URL('../', currentWorkerUrl).href}`;
    return (await cacheStorage.keys()).filter((name) => name.startsWith(prefix) && name !== current);
};

const hasCompleteRuntime = async (
    cacheStorage: CacheStorage,
    workerUrl: string,
    expectedHashes?: Record<string, string>
) => {
    const name = ffmpegRuntimeCacheName(workerUrl);
    if (!(await cacheStorage.has(name))) return false;
    const cache = await cacheStorage.open(name);
    const responses = await Promise.all(runtimeFiles.map((filename) => cache.match(new URL(filename, workerUrl).href)));
    return responses.every((response, index) =>
        response && (expectedHashes === undefined || expectedHashes[runtimeFiles[index]] !== undefined)
            ? hasVerifiedHash(response, expectedHashes?.[runtimeFiles[index]])
            : false
    );
};

/** Check installation without fetching assets or starting a worker. */
export const hasCachedFfmpegRuntime = async (
    assets: FfmpegAssetUrls,
    cacheStorage: CacheStorage | undefined,
    expectedHashes: Record<string, string> = runtimeHashes
) => {
    if (cacheStorage === undefined) return false;
    try {
        return await hasCompleteRuntime(cacheStorage, assets.workerURL, expectedHashes);
    } catch (error) {
        asbWarn('ffmpeg/cache', 'Could not check whether the runtime is installed', {
            workerUrl: assets.workerURL,
            error,
        });
        return false;
    }
};

export const deleteOutdatedFfmpegCaches = async (
    cacheStorage: CacheStorage,
    assets: FfmpegAssetUrls,
    expectedHashes: Record<string, string> = runtimeHashes
) => {
    // Never retire an installed runtime unless its replacement is available offline.
    if (!(await hasCompleteRuntime(cacheStorage, assets.workerURL, expectedHashes))) {
        asbInfo('ffmpeg/cache', 'Keeping older runtime caches: replacement is incomplete', {
            workerUrl: assets.workerURL,
        });
        return;
    }
    await Promise.all(
        (await outdatedCacheNames(cacheStorage, assets.workerURL)).map(async (name) => {
            const deleted = await cacheStorage.delete(name);
            asbInfo('ffmpeg/cache', 'Retired runtime cache', { cacheName: name, deleted });
        })
    );
};

export type FfmpegDownloadOptions = {
    fetcher?: typeof fetch;
    expectedHashes?: Record<string, string>;
    expectedSizes?: Record<string, number>;
    onProgress?: (progress: FfmpegDownloadProgress) => void;
    /** Monotonic milliseconds; injectable at the clock boundary for progress estimates. */
    now?: () => number;
};

/** Verify assets once before caching; subsequent loads trust the stored hashes without reading the bodies. */
export const prepareFfmpegRuntime = async (
    assets: FfmpegAssetUrls,
    cacheStorage: CacheStorage | undefined,
    signal: AbortSignal,
    {
        fetcher = fetch,
        expectedHashes = runtimeHashes,
        expectedSizes = runtimeSizes,
        onProgress,
        now = () => performance.now(),
    }: FfmpegDownloadOptions = {}
) => {
    signal.throwIfAborted();
    const cacheName = ffmpegRuntimeCacheName(assets.workerURL);
    let cache: Cache | undefined;
    try {
        cache = await cacheStorage?.open(cacheName);
        if (cacheStorage === undefined) {
            asbTrace('ffmpeg/cache', 'Cache storage is unsupported; using downloaded assets', { cacheName });
        }
    } catch (error) {
        // Availability checks still work when browser storage is unavailable.
        asbWarn('ffmpeg/cache', 'Could not open runtime cache; using downloaded assets', { cacheName, error });
    }
    const urls = [assets.workerURL, assets.coreURL, assets.wasmURL];
    const filenames = urls.map((url) => new URL(url).pathname.split('/').pop()!);
    const sizes = filenames.map((filename) => {
        if (!/^[a-f0-9]{64}$/.test(expectedHashes[filename] ?? ''))
            throw new Error(`Missing FFmpeg hash for ${filename}`);
        const size = expectedSizes[filename];
        if (!Number.isSafeInteger(size) || size <= 0) throw new Error(`Missing FFmpeg size for ${filename}`);
        return size;
    });
    const totalBytes = sizes.reduce((sum, size) => sum + size, 0);
    const cached =
        cache === undefined
            ? []
            : await Promise.all(urls.map((url) => cache.match(url))).catch((error: unknown) => {
                  asbWarn('ffmpeg/cache', 'Could not read runtime cache; downloading assets', { cacheName, error });
                  return [];
              });
    signal.throwIfAborted();
    const downloaded = sizes.map((size, index) =>
        cached[index] && hasVerifiedHash(cached[index], expectedHashes[filenames[index]]) ? size : 0
    );
    const reusedBytes = downloaded.reduce((sum, size) => sum + size, 0);
    asbTrace('ffmpeg/download', 'Preparing runtime assets', { cacheName, totalBytes, reusedBytes });
    const start = now();
    const report = (stage: FfmpegDownloadProgress['stage']) => {
        const downloadedBytes = downloaded.reduce((sum, size) => sum + size, 0);
        const elapsed = (now() - start) / 1000;
        const bytesPerSecond = elapsed > 0 ? (downloadedBytes - reusedBytes) / elapsed : 0;
        onProgress?.({
            stage,
            downloadedBytes,
            totalBytes,
            bytesPerSecond,
            etaSeconds:
                downloadedBytes === totalBytes
                    ? 0
                    : bytesPerSecond > 0
                      ? (totalBytes - downloadedBytes) / bytesPerSecond
                      : undefined,
        });
    };
    const downloads = new AbortController();
    const abort = () => downloads.abort(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    const downloadSignal = downloads.signal;
    try {
        report('downloading');
        const responses = await Promise.all(
            urls.map(async (url, index) => {
                const filename = filenames[index];
                const expectedHash = expectedHashes[filename];
                const existing = cached[index];
                if (existing !== undefined) {
                    if (hasVerifiedHash(existing, expectedHash)) {
                        asbTrace('ffmpeg/cache', 'Reusing verified runtime asset', { filename, cacheName });
                        return existing;
                    }
                    asbTrace('ffmpeg/cache', 'Replacing an unverified runtime asset', { filename, cacheName });
                    await cache?.delete(url).catch((error: unknown) => {
                        asbWarn('ffmpeg/cache', 'Could not delete unverified runtime asset', { filename, error });
                    });
                }
                downloadSignal.throwIfAborted();
                asbTrace('ffmpeg/download', 'Downloading runtime asset', { url, expectedBytes: sizes[index] });
                const response = verifyResponse(
                    await fetcher(new Request(url, { signal: downloadSignal, cache: 'reload' }))
                );
                const reader = response.body?.getReader();
                if (!reader) throw new Error(`Empty FFmpeg response for ${filename}`);
                const bytes = new Uint8Array(sizes[index]);
                const cancelRead = () => {
                    void reader.cancel(downloadSignal.reason).catch(() => {});
                };
                downloadSignal.addEventListener('abort', cancelRead, { once: true });
                try {
                    while (true) {
                        downloadSignal.throwIfAborted();
                        const { done, value } = await reader.read();
                        downloadSignal.throwIfAborted();
                        if (done) break;
                        if (downloaded[index] + value.byteLength > bytes.byteLength) {
                            throw new Error(`FFmpeg size check failed for ${filename}`);
                        }
                        bytes.set(value, downloaded[index]);
                        downloaded[index] += value.byteLength;
                        report('downloading');
                    }
                    if (downloaded[index] !== bytes.byteLength)
                        throw new Error(`FFmpeg size check failed for ${filename}`);
                } finally {
                    downloadSignal.removeEventListener('abort', cancelRead);
                    await reader.cancel().catch(() => {});
                }
                if (downloaded.every((size, index) => size === sizes[index])) report('verifying');
                const verified = await verifyHash(response, bytes, expectedHash, filename);
                downloadSignal.throwIfAborted();
                asbTrace('ffmpeg/download', 'Verified runtime asset', { filename, bytes: bytes.byteLength });
                return verified;
            })
        );
        signal.throwIfAborted();
        report('verifying');
        // Check all downloads before writing. Storage failures can leave a partial cache, repaired on the next load.
        await Promise.all(
            urls.map(async (url, index) => {
                if (responses[index] !== cached[index]) await cache?.put(url, responses[index].clone());
            })
        ).catch((error: unknown) => {
            asbWarn('ffmpeg/cache', 'Could not persist runtime assets; offline use may be unavailable', {
                cacheName,
                error,
            });
        });
        signal.throwIfAborted();
        report('complete');
        asbTrace('ffmpeg/download', 'Runtime assets ready', {
            cacheName,
            totalBytes,
            reusedBytes,
            elapsedMs: now() - start,
        });
        return { worker: responses[0], core: responses[1], wasm: responses[2] };
    } catch (error) {
        if (signal.aborted) {
            asbTrace('ffmpeg/download', 'Runtime preparation cancelled', { cacheName });
        } else {
            asbError('ffmpeg/download', 'Runtime preparation failed', { cacheName, error });
        }
        downloads.abort(error);
        throw error;
    } finally {
        signal.removeEventListener('abort', abort);
    }
};

/** Warm an installed optional dependency during update installation, before activation retires it. */
export const prepareFfmpegUpdate = async (
    assets: FfmpegAssetUrls,
    cacheStorage: CacheStorage,
    signal: AbortSignal,
    options: FfmpegDownloadOptions = {}
) => {
    const expectedHashes = options.expectedHashes ?? runtimeHashes;
    let installed: boolean[];
    try {
        if (await hasCompleteRuntime(cacheStorage, assets.workerURL, expectedHashes)) {
            asbInfo('ffmpeg/update', 'Replacement runtime is already cached', { workerUrl: assets.workerURL });
            return;
        }
        const older = await outdatedCacheNames(cacheStorage, assets.workerURL);
        installed = await Promise.all(
            older.map((name) =>
                hasCompleteRuntime(cacheStorage, new URL('ffmpeg-worker.js', name.slice(cacheNamePrefix.length)).href)
            )
        );
    } catch (error) {
        // Unavailable storage must not make an unused optional dependency block app updates.
        asbWarn('ffmpeg/update', 'Skipping optional runtime preparation: cache storage is unavailable', error);
        return;
    }
    if (!installed.some(Boolean)) {
        asbInfo('ffmpeg/update', 'Skipping runtime download: no complete older runtime is installed');
        return;
    }
    asbInfo('ffmpeg/update', 'Preparing replacement for installed runtime', { workerUrl: assets.workerURL });
    await prepareFfmpegRuntime(assets, cacheStorage, signal, options);
    if (!(await hasCompleteRuntime(cacheStorage, assets.workerURL, expectedHashes))) {
        throw new Error('Could not store the replacement FFmpeg runtime. The current app remains installed.');
    }
    asbInfo('ffmpeg/update', 'Replacement runtime is available offline', { workerUrl: assets.workerURL });
};
