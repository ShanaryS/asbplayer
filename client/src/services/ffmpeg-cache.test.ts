/** @jest-environment node */
import type { FfmpegAssetUrls, FfmpegDownloadProgress } from '@project/ffmpeg';
import { createHash } from 'node:crypto';
import { createInstance } from 'i18next';
import { LocalizedError } from '@project/common/app/components/localized-error';
import english from '@project/common/locales/en.json';
import {
    prepareFfmpegRuntime,
    deleteOutdatedFfmpegCaches,
    ffmpegRuntimeCacheName,
    FfmpegUpdateRequiredError,
    prepareFfmpegUpdate,
} from '@project/client/src/services/ffmpeg-cache';

const assets = (version: string): FfmpegAssetUrls => ({
    workerURL: `https://app.test/player/ffmpeg/${version}/ffmpeg-worker.js`,
    coreURL: `https://app.test/player/ffmpeg/${version}/ffmpeg-core.js`,
    wasmURL: `https://app.test/player/ffmpeg/${version}/ffmpeg-core.wasm`,
});
const online: typeof fetch = async (request) => new Response((request as Request).url);
const hash = (body: string) => createHash('sha256').update(body).digest('hex');
const hashes = (urls: FfmpegAssetUrls) =>
    Object.fromEntries(Object.values(urls).map((url) => [new URL(url).pathname.split('/').pop()!, hash(url)]));
const sizes = (urls: FfmpegAssetUrls) =>
    Object.fromEntries(
        Object.values(urls).map((url) => [new URL(url).pathname.split('/').pop()!, Buffer.byteLength(url)])
    );
const options = (urls: FfmpegAssetUrls, fetcher: typeof fetch = online) => ({
    fetcher,
    expectedHashes: hashes(urls),
    expectedSizes: sizes(urls),
});
const prepare = (
    urls: FfmpegAssetUrls,
    storage: CacheStorage | undefined,
    abortSignal: AbortSignal,
    fetcher: typeof fetch
) => prepareFfmpegRuntime(urls, storage, abortSignal, options(urls, fetcher));
const expectRuntime = async (responses: Awaited<ReturnType<typeof prepareFfmpegRuntime>>, urls: FfmpegAssetUrls) => {
    expect(await responses.worker.text()).toBe(urls.workerURL);
    expect(await responses.core.text()).toBe(urls.coreURL);
    expect(await responses.wasm.text()).toBe(urls.wasmURL);
};
const offline: typeof fetch = async () => {
    throw new TypeError('Offline');
};
const signal = () => new AbortController().signal;
const i18n = createInstance();
beforeAll(async () => {
    await i18n.init({ lng: 'en', resources: { en: { translation: english } } });
});

// CacheStorage is a browser boundary; retain its public read, write, and deletion behavior.
const memoryCaches = () => {
    const caches = new Map<string, Cache>();
    return {
        async open(name: string) {
            let cache = caches.get(name);
            if (cache !== undefined) return cache;
            const entries = new Map<string, Response>();
            const key = (request: RequestInfo) => (typeof request === 'string' ? request : request.url);
            cache = {
                async match(request: RequestInfo) {
                    return entries.get(key(request))?.clone();
                },
                async put(request: RequestInfo, response: Response) {
                    entries.set(key(request), response.clone());
                },
                async delete(request: RequestInfo) {
                    return entries.delete(key(request));
                },
            } as Cache;
            caches.set(name, cache);
            return cache;
        },
        async keys() {
            return [...caches.keys()];
        },
        async has(name: string) {
            return caches.has(name);
        },
        async delete(name: string) {
            return caches.delete(name);
        },
    } as CacheStorage;
};

it('caches the whole runtime on first use and reuses it offline', async () => {
    const storage = memoryCaches();
    const urls = assets('0.1.0');
    await prepare(urls, storage, signal(), online);
    await expectRuntime(await prepare(urls, storage, signal(), offline), urls);
});

it('isolates runtime versions while an update is still waiting', async () => {
    const storage = memoryCaches();
    for (const version of ['0.1.0', '0.2.0']) await prepare(assets(version), storage, signal(), online);
    expect(await storage.keys()).toHaveLength(2);
    for (const version of ['0.1.0', '0.2.0']) {
        await expectRuntime(await prepare(assets(version), storage, signal(), offline), assets(version));
    }
});

it.each([0, 1, 2])(
    'deletes %i outdated caches when activating a runtime and preserves other app storage',
    async (count) => {
        const storage = memoryCaches();
        const current = assets('0.3.0');
        await prepare(current, storage, signal(), online);
        for (const version of ['0.1.0', '0.2.0'].slice(0, count))
            await prepare(assets(version), storage, signal(), online);
        const unrelated = [
            'app-precache',
            ffmpegRuntimeCacheName('https://app.test/staging/ffmpeg/0.1.0/ffmpeg-worker.js'),
        ];
        for (const name of unrelated) await storage.open(name);
        await deleteOutdatedFfmpegCaches(storage, current, hashes(current));
        expect((await storage.keys()).sort()).toEqual([ffmpegRuntimeCacheName(current.workerURL), ...unrelated].sort());
        await prepare(current, storage, signal(), offline);
    }
);

it('repairs a partial runtime cache', async () => {
    const storage = memoryCaches();
    const urls = assets('0.1.0');
    const cache = await storage.open(ffmpegRuntimeCacheName(urls.workerURL));
    await cache.put(urls.workerURL, new Response('partial'));
    await prepare(urls, storage, signal(), online);
    for (const url of Object.values(urls)) expect(await (await cache.match(url))?.text()).toBe(url);
});

it('does not hash or download verified assets again on later loads', async () => {
    const storage = memoryCaches();
    const urls = assets('0.1.0');
    await prepare(urls, storage, signal(), online);
    const digest = jest.spyOn(crypto.subtle, 'digest').mockRejectedValue(new Error('Unexpected repeated hashing'));
    try {
        await expectRuntime(await prepare(urls, storage, signal(), offline), urls);
    } finally {
        digest.mockRestore();
    }
});

it('downloads unmarked cached assets instead of trusting them', async () => {
    const storage = memoryCaches();
    const urls = assets('0.1.0');
    const cache = await storage.open(ffmpegRuntimeCacheName(urls.workerURL));
    for (const url of Object.values(urls)) await cache.put(url, new Response(url));
    const fetcher = jest.fn(online);
    await prepare(urls, storage, signal(), fetcher);
    expect(fetcher).toHaveBeenCalledTimes(3);
    await prepare(urls, storage, signal(), offline);
});

it.each(['workerURL', 'coreURL', 'wasmURL'] as const)(
    'rejects a corrupt HTTP-200 %s without caching it, then recovers after the server is repaired',
    async (asset) => {
        const storage = memoryCaches();
        const urls = assets('0.1.0');
        const corrupt: typeof fetch = async (request) =>
            new Response(
                (request as Request).url === urls[asset] ? 'x'.repeat(urls[asset].length) : (request as Request).url
            );
        await expect(prepare(urls, storage, signal(), corrupt)).rejects.toThrow('integrity check failed');
        const cache = await storage.open(ffmpegRuntimeCacheName(urls.workerURL));
        for (const url of Object.values(urls)) expect(await cache.match(url)).toBeUndefined();
        await prepare(urls, storage, signal(), online);
        await expectRuntime(await prepare(urls, storage, signal(), offline), urls);
    }
);

it('downloads an asset again when its expected hash changes', async () => {
    const storage = memoryCaches();
    const urls = assets('0.1.0');
    await prepare(urls, storage, signal(), online);
    const nextWasm = 'next candidate WASM';
    const nextHashes = { ...hashes(urls), 'ffmpeg-core.wasm': hash(nextWasm) };
    const nextSizes = { ...sizes(urls), 'ffmpeg-core.wasm': Buffer.byteLength(nextWasm) };
    const nextDownload: typeof fetch = async (request) => {
        if ((request as Request).url !== urls.wasmURL) throw new Error('Unchanged assets should stay cached');
        return new Response(nextWasm);
    };
    const digest = jest.spyOn(crypto.subtle, 'digest');
    try {
        await prepareFfmpegRuntime(urls, storage, signal(), {
            fetcher: nextDownload,
            expectedHashes: nextHashes,
            expectedSizes: nextSizes,
        });
        const cached = await prepareFfmpegRuntime(urls, storage, signal(), {
            fetcher: offline,
            expectedHashes: nextHashes,
            expectedSizes: nextSizes,
        });
        expect(await cached.wasm.text()).toBe(nextWasm);
        expect(digest).toHaveBeenCalledTimes(1);
    } finally {
        digest.mockRestore();
    }
});

it('does not cache a runtime if any asset download fails', async () => {
    const storage = memoryCaches();
    const urls = assets('0.1.0');
    const fetcher: typeof fetch = async (request) =>
        new Response((request as Request).url, {
            status: (request as Request).url.endsWith('.wasm') ? 503 : 200,
            headers: { 'Content-Type': (request as Request).url.endsWith('.wasm') ? 'text/html' : 'text/javascript' },
        });
    await expect(prepare(urls, storage, signal(), fetcher)).rejects.toThrow('HTTP 503');
    const cache = await storage.open(ffmpegRuntimeCacheName(urls.workerURL));
    for (const url of Object.values(urls)) expect(await cache.match(url)).toBeUndefined();
});

it('reports downloaded bytes, known total, average speed and ETA from streamed bytes', async () => {
    const urls = assets('0.1.0');
    const streams = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
    const fetcher: typeof fetch = async (request) =>
        new Response(
            new ReadableStream({
                start(controller) {
                    streams.set((request as Request).url, controller);
                },
            })
        );
    let time = 0;
    const reports: FfmpegDownloadProgress[] = [];
    const downloading = prepareFfmpegRuntime(urls, memoryCaches(), signal(), {
        ...options(urls, fetcher),
        now: () => time,
        onProgress: (progress) => reports.push(progress),
    });
    await new Promise(setImmediate);
    const total = Object.values(sizes(urls)).reduce((sum, size) => sum + size, 0);
    expect(reports[0]).toMatchObject({
        downloadedBytes: 0,
        totalBytes: total,
        bytesPerSecond: 0,
        etaSeconds: undefined,
    });
    time = 1000;
    streams.get(urls.workerURL)!.enqueue(new TextEncoder().encode(urls.workerURL.slice(0, 5)));
    await new Promise(setImmediate);
    expect(reports.at(-1)).toMatchObject({
        downloadedBytes: 5,
        totalBytes: total,
        bytesPerSecond: 5,
        etaSeconds: (total - 5) / 5,
    });
    time = 2000;
    for (const url of Object.values(urls)) {
        streams.get(url)!.enqueue(new TextEncoder().encode(url === urls.workerURL ? url.slice(5) : url));
        streams.get(url)!.close();
    }
    await downloading;
    expect(reports.at(-1)).toEqual({
        stage: 'complete',
        downloadedBytes: total,
        totalBytes: total,
        bytesPerSecond: total / 2,
        etaSeconds: 0,
    });
    const cachedReports: FfmpegDownloadProgress[] = [];
    const storage = memoryCaches();
    await prepare(urls, storage, signal(), online);
    await prepareFfmpegRuntime(urls, storage, signal(), {
        ...options(urls, offline),
        onProgress: (progress) => cachedReports.push(progress),
    });
    expect(cachedReports.at(-1)).toMatchObject({
        stage: 'complete',
        downloadedBytes: total,
        totalBytes: total,
        bytesPerSecond: 0,
        etaSeconds: 0,
    });
});

it('cancels all response streams promptly when the owner aborts', async () => {
    const urls = assets('0.1.0');
    const cancelled = jest.fn();
    const fetcher: typeof fetch = async () => new Response(new ReadableStream({ cancel: cancelled }));
    const owner = new AbortController();
    const downloading = prepareFfmpegRuntime(urls, memoryCaches(), owner.signal, options(urls, fetcher));
    await new Promise(setImmediate);
    owner.abort();
    await expect(downloading).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancelled).toHaveBeenCalledTimes(3);
});

it.each(['short', 'long'])('rejects a %s response against the verified manifest size', async (kind) => {
    const urls = assets('0.1.0');
    const fetcher: typeof fetch = async (request) =>
        new Response((request as Request).url + (kind === 'long' ? 'extra' : ''));
    await expect(
        prepareFfmpegRuntime(urls, memoryCaches(), signal(), {
            ...options(urls, fetcher),
            expectedSizes: Object.fromEntries(
                Object.entries(sizes(urls)).map(([file, size]) => [file, size + (kind === 'short' ? 1 : 0)])
            ),
        })
    ).rejects.toThrow('size check failed');
});

it('downloads a replacement for installed FFmpeg before retiring the old cache', async () => {
    const storage = memoryCaches();
    const old = assets('0.1.0');
    const current = assets('0.2.0');
    await prepare(old, storage, signal(), online);
    const fetcher = jest.fn(online);
    await prepareFfmpegUpdate(current, storage, signal(), options(current, fetcher));
    expect(fetcher).toHaveBeenCalledTimes(3);
    // The waiting update must leave the running old app usable offline.
    await prepare(old, storage, signal(), offline);
    await prepare(current, storage, signal(), offline);
    await deleteOutdatedFfmpegCaches(storage, current, hashes(current));
    expect(await storage.keys()).toEqual([ffmpegRuntimeCacheName(current.workerURL)]);
    await prepareFfmpegUpdate(current, storage, signal(), options(current, offline));
    await prepare(current, storage, signal(), offline);
});

it('preserves the cache without downloading when an app update selects the same runtime', async () => {
    const storage = memoryCaches();
    const current = assets('0.1.0');
    await prepare(current, storage, signal(), online);
    await prepareFfmpegUpdate(current, storage, signal(), options(current, offline));
    await deleteOutdatedFfmpegCaches(storage, current, hashes(current));
    await prepare(current, storage, signal(), offline);
    expect(await storage.keys()).toEqual([ffmpegRuntimeCacheName(current.workerURL)]);
});

it('keeps FFmpeg lazy for app updates when it has never been installed', async () => {
    const storage = memoryCaches();
    const current = assets('0.2.0');
    await prepareFfmpegUpdate(current, storage, signal(), options(current, offline));
    expect(await storage.keys()).toEqual([]);
    const partial = await storage.open(ffmpegRuntimeCacheName(assets('0.1.0').workerURL));
    await partial.put(assets('0.1.0').workerURL, new Response('unverified'));
    await prepareFfmpegUpdate(current, storage, signal(), options(current, offline));
    expect(await storage.keys()).toEqual([ffmpegRuntimeCacheName(assets('0.1.0').workerURL)]);
});

it('allows app updates when optional runtime storage is unavailable', async () => {
    const storage = {
        keys: async () => {
            throw new Error('Storage unavailable');
        },
    } as unknown as CacheStorage;
    const current = assets('0.2.0');
    await expect(prepareFfmpegUpdate(current, storage, signal(), options(current, offline))).resolves.toBeUndefined();
});

it.each(['offline', 'corrupt', 'quota'])(
    'preserves installed FFmpeg when its replacement fails (%s)',
    async (failure) => {
        const storage = memoryCaches();
        const old = assets('0.1.0');
        const current = assets('0.2.0');
        await prepare(old, storage, signal(), online);
        const cache = await storage.open(ffmpegRuntimeCacheName(current.workerURL));
        if (failure === 'quota')
            cache.put = async () => {
                throw new Error('Quota exceeded');
            };
        const fetcher =
            failure === 'offline'
                ? offline
                : failure === 'corrupt'
                  ? async (request: RequestInfo | URL) => new Response('x'.repeat((request as Request).url.length))
                  : online;
        await expect(prepareFfmpegUpdate(current, storage, signal(), options(current, fetcher))).rejects.toThrow();
        await deleteOutdatedFfmpegCaches(storage, current, hashes(current));
        await prepare(old, storage, signal(), offline);
        expect(await storage.keys()).toContain(ffmpegRuntimeCacheName(old.workerURL));
    }
);

it.each([404, 410, 'html'] as const)(
    'asks an uncached old app to update when its runtime is retired (%s)',
    async (result) => {
        const storage = memoryCaches();
        const fetcher: typeof fetch = async () =>
            result === 'html'
                ? new Response('<!doctype html>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
                : new Response('Retired', { status: result });
        const error = await prepare(assets('0.1.0'), storage, signal(), fetcher).catch((error: unknown) => error);
        expect(error).toMatchObject({ code: 'update-required' });
        expect(error).toBeInstanceOf(LocalizedError);
        if (!(error instanceof LocalizedError)) throw new Error('Expected a localized FFmpeg error');
        expect(i18n.t(error.locKey, error.locParams)).toBe(english.error.ffmpegUpdateRequired);
        const cache = await storage.open(ffmpegRuntimeCacheName(assets('0.1.0').workerURL));
        for (const url of Object.values(assets('0.1.0'))) expect(await cache.match(url)).toBeUndefined();
    }
);

it('does not mistake an offline failure for a retired runtime', async () => {
    await expect(prepare(assets('0.1.0'), memoryCaches(), signal(), offline)).rejects.toThrow('Offline');
});

it.each(['unsupported', 'blocked'])('detects retired runtimes when cache storage is %s', async (kind) => {
    const storage =
        kind === 'unsupported'
            ? undefined
            : ({
                  open: async () => {
                      throw new Error('Storage unavailable');
                  },
              } as unknown as CacheStorage);
    await expect(
        prepare(assets('0.1.0'), storage, signal(), async () => new Response('Retired', { status: 404 }))
    ).rejects.toBeInstanceOf(FfmpegUpdateRequiredError);
    const responses = await prepare(assets('0.1.0'), storage, signal(), online);
    expect(await responses.worker.text()).toBe(assets('0.1.0').workerURL);
});

describe.each(['unsupported', 'blocked'])('when cache storage is %s', (kind) => {
    it.each([
        ['coreURL', 404],
        ['wasmURL', 410],
        ['coreURL', 'html'],
    ] as const)('asks the app to update when only %s is retired (%s)', async (asset, result) => {
        const storage =
            kind === 'unsupported'
                ? undefined
                : ({
                      open: async () => {
                          throw new Error('Storage unavailable');
                      },
                  } as unknown as CacheStorage);
        const urls = assets('0.1.0');
        const fetcher: typeof fetch = async (request) => {
            if ((request as Request).url !== urls[asset]) return new Response((request as Request).url);
            return result === 'html'
                ? new Response('<!doctype html>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
                : new Response('Retired', { status: result });
        };
        await expect(prepare(urls, storage, signal(), fetcher)).rejects.toBeInstanceOf(FfmpegUpdateRequiredError);
    });
});

it.each(['unsupported', 'blocked'])('still rejects corrupt downloads when cache storage is %s', async (kind) => {
    const storage =
        kind === 'unsupported'
            ? undefined
            : ({
                  open: async () => {
                      throw new Error('Storage unavailable');
                  },
              } as unknown as CacheStorage);
    const urls = assets('0.1.0');
    await expect(
        prepare(urls, storage, signal(), async (request) => new Response('x'.repeat((request as Request).url.length)))
    ).rejects.toThrow('integrity check failed');
});

it('allows online initialization when cache writes fail', async () => {
    const storage = {
        open: async () => ({
            match: async () => undefined,
            put: async () => {
                throw new Error('Quota exceeded');
            },
        }),
    } as unknown as CacheStorage;
    const urls = assets('0.1.0');
    const responses = await prepare(urls, storage, signal(), online);
    expect(await responses.wasm.text()).toBe(urls.wasmURL);
});

it('does not download or create a cache for an already aborted request', async () => {
    const storage = memoryCaches();
    const controller = new AbortController();
    controller.abort();
    await expect(prepare(assets('0.1.0'), storage, controller.signal, online)).rejects.toThrow();
    expect(await storage.keys()).toEqual([]);
});
