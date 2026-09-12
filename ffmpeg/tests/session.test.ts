import { ffmpegAssetUrls, createFfmpegSession } from '@project/ffmpeg';
import type { FfmpegClient } from '@project/ffmpeg';

class FakeFfmpeg implements FfmpegClient {
    loaded = false;
    load = jest.fn(async () => {
        this.loaded = true;
        return true;
    });
    exec = jest.fn(async () => 0);
    on = jest.fn(() => undefined);
    off = jest.fn(() => undefined);
    createDir = jest.fn(async () => true);
    deleteDir = jest.fn(async () => true);
    deleteFile = jest.fn(async () => true);
    mount = jest.fn(async () => true);
    unmount = jest.fn(async () => true);
    terminate = jest.fn();
}

describe('FFmpeg session', () => {
    it('loads explicit immutable URLs only once', async () => {
        const imported: string[] = [];
        const session = createFfmpegSession({
            assetBaseUrl: 'https://example.test/ffmpeg/',
            importWrapper: async (url: string) => {
                imported.push(url);
                return { FFmpeg: FakeFfmpeg };
            },
        });

        const first = await session.load();
        const second = await session.load();
        const assets = ffmpegAssetUrls('https://example.test/ffmpeg/');

        expect(first).toBe(second);
        expect(imported).toEqual([assets.wrapperURL]);
        expect(first.load).toHaveBeenCalledWith(
            {
                classWorkerURL: assets.classWorkerURL,
                coreURL: assets.coreURL,
                wasmURL: assets.wasmURL,
            },
            {}
        );
    });

    it('rejects an already aborted load without importing executable code', async () => {
        const controller = new AbortController();
        controller.abort();
        const importer = jest.fn(async () => ({ FFmpeg: FakeFfmpeg }));
        const session = createFfmpegSession({
            assetBaseUrl: 'https://example.test/ffmpeg/',
            importWrapper: importer,
        });

        await expect(session.load({ signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
        expect(importer).not.toHaveBeenCalled();
        expect(session.disposed).toBe(true);
    });

    it('rejects incompatible build metadata before importing executable code', async () => {
        const importer = jest.fn(async () => ({ FFmpeg: FakeFfmpeg }));
        const session = createFfmpegSession({
            assetBaseUrl: 'https://example.test/ffmpeg/',
            expectedBuild: '9.9.9',
            importWrapper: importer,
        });

        await expect(session.load()).rejects.toThrow('FFmpeg build 9.9.9 is incompatible with 0.1.0');
        expect(importer).not.toHaveBeenCalled();
    });

    it('terminates once when disposed', async () => {
        const session = createFfmpegSession({
            assetBaseUrl: 'https://example.test/ffmpeg/',
            importWrapper: async () => ({ FFmpeg: FakeFfmpeg }),
        });
        const client = await session.load();
        session.dispose();
        session.dispose();
        expect(client.terminate).toHaveBeenCalledTimes(1);
    });
});
