import { ffmpegAssetUrls, prepareFfmpegAssets } from '@project/ffmpeg';

const filenames = ['ffmpeg-wrapper.js', 'ffmpeg-worker.js', 'ffmpeg-core.js', 'ffmpeg-core.wasm'];
const bodies = Object.fromEntries(filenames.map((filename) => [filename, `contents:${filename}`]));
const hashes = {
    'ffmpeg-wrapper.js': '88eac210966e8127455d75e32db3e7e825672fa3da869757975217f135538474',
    'ffmpeg-worker.js': 'aa528290f14207458f45981cc5bb36da3c077a502a470cf1f6b517797a68c04a',
    'ffmpeg-core.js': '870b8b8199e97e93c55552ad1277394ef58d27400a9cbbdc8ccd3cdca03c37e8',
    'ffmpeg-core.wasm': '30f653ca97c7a70377c3ecfe3bf9aec149506f2d2aad64f557e89007186c5eee',
};

class MemoryCache {
    readonly entries = new Map<string, Response>();

    async match(url: string) {
        return this.entries.get(url)?.clone();
    }

    async put(url: string, response: Response) {
        this.entries.set(url, response.clone());
    }

    async delete(url: string) {
        return this.entries.delete(url);
    }
}

describe('FFmpeg web asset preparation', () => {
    it('verifies and reuses one complete immutable cache entry set', async () => {
        const cache = new MemoryCache();
        const fetcher = jest.fn(async (url: string | URL | Request) => {
            const filename = new URL(url.toString()).pathname.split('/').at(-1)!;
            return new Response(bodies[filename]);
        });
        const options = {
            assetBaseUrl: 'https://example.test/ffmpeg/',
            cacheStorage: { open: async () => cache } as unknown as CacheStorage,
            fetcher: fetcher as typeof fetch,
            expectedHashes: hashes,
        };

        await prepareFfmpegAssets(options);
        await prepareFfmpegAssets(options);

        expect(fetcher).toHaveBeenCalledTimes(4);
        expect(cache.entries.size).toBe(4);
    });

    it('does not persist a partial download when any asset fails integrity', async () => {
        const cache = new MemoryCache();
        const urls = ffmpegAssetUrls('https://example.test/ffmpeg/');
        const fetcher = jest.fn(async (url: string | URL | Request) => {
            const filename = new URL(url.toString()).pathname.split('/').at(-1)!;
            const body = url.toString() === urls.coreURL ? 'tampered' : bodies[filename];
            return new Response(body);
        });

        await expect(
            prepareFfmpegAssets({
                assetBaseUrl: 'https://example.test/ffmpeg/',
                cacheStorage: { open: async () => cache } as unknown as CacheStorage,
                fetcher: fetcher as typeof fetch,
                expectedHashes: hashes,
            })
        ).rejects.toThrow('integrity check failed');
        expect(cache.entries.size).toBe(0);
    });
});
