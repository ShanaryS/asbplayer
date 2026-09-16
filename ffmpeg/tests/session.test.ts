import { createFfmpegSession, ffmpegAssetUrls, ffmpegMetadata } from '@project/ffmpeg';
import type { FfmpegRuntimeInfo, FfmpegWorker, WorkerRequest } from '@project/ffmpeg';

const runtimeInfo = (overrides: Partial<FfmpegRuntimeInfo> = {}): FfmpegRuntimeInfo => ({
    runtimeVersion: ffmpegMetadata.runtimeVersion,
    ffmpegVersion: ffmpegMetadata.ffmpegVersion,
    ffmpegConfiguration: '--disable-everything',
    ffmpegLicense: 'LGPL version 2.1 or later',
    linkedLibraries: ['libavutil'],
    libraries: [
        { name: 'libavutil', version: 1, configuration: '--disable-everything', license: 'LGPL version 2.1 or later' },
    ],
    operations: ['inspect'],
    ...overrides,
});

class FakeWorker implements FfmpegWorker {
    readonly target = new EventTarget();
    readonly messages: WorkerRequest[] = [];
    readonly terminate = jest.fn();
    responseInfo = runtimeInfo();
    autoReply = true;

    postMessage(message: WorkerRequest) {
        this.messages.push(message);
        if (!this.autoReply) return;
        queueMicrotask(() =>
            this.target.dispatchEvent(
                new MessageEvent('message', {
                    data: {
                        sessionId: message.sessionId,
                        requestId: message.requestId,
                        ok: true,
                        result: this.responseInfo,
                    },
                })
            )
        );
    }

    addEventListener(type: 'message' | 'error' | 'messageerror', listener: EventListener) {
        this.target.addEventListener(type, listener);
    }

    removeEventListener(type: 'message' | 'error' | 'messageerror', listener: EventListener) {
        this.target.removeEventListener(type, listener);
    }
}

describe('FFmpeg session', () => {
    it('is lazy, loads one versioned worker, and exposes runtime inspection', async () => {
        const worker = new FakeWorker();
        const factory = jest.fn(() => worker);
        const session = createFfmpegSession({ assetBaseUrl: 'https://example.test/ffmpeg/', workerFactory: factory });
        expect(factory).not.toHaveBeenCalled();

        const [first, second] = await Promise.all([session.load(), session.load()]);
        expect(first).toBe(second);
        expect(factory).toHaveBeenCalledWith(ffmpegAssetUrls('https://example.test/ffmpeg/').workerURL);
        const controller = new AbortController();
        await expect(first.inspect({ signal: controller.signal })).resolves.toEqual(runtimeInfo());
        controller.abort();
        expect(worker.messages.map(({ operation }) => operation)).toEqual(['initialize', 'inspect']);
        expect(session.state).toBe('ready');
        expect(worker.terminate).not.toHaveBeenCalled();
    });

    it('rejects an already-aborted load without creating a worker', async () => {
        const controller = new AbortController();
        controller.abort();
        const factory = jest.fn();
        const session = createFfmpegSession({ assetBaseUrl: 'https://example.test/ffmpeg/', workerFactory: factory });
        await expect(session.load({ signal: controller.signal })).rejects.toMatchObject({ code: 'aborted' });
        expect(factory).not.toHaveBeenCalled();
        expect(session.state).toBe('disposed');
    });

    it('makes a mismatched runtime terminal', async () => {
        const worker = new FakeWorker();
        worker.responseInfo = runtimeInfo({ runtimeVersion: 'mismatch' });
        const session = createFfmpegSession({
            assetBaseUrl: 'https://example.test/ffmpeg/',
            workerFactory: () => worker,
        });
        await expect(session.load()).rejects.toMatchObject({ code: 'protocol' });
        expect(session.state).toBe('failed');
        expect(worker.terminate).toHaveBeenCalledTimes(1);
    });

    it('rejects FFmpeg versions that only share the expected version prefix', async () => {
        const worker = new FakeWorker();
        worker.responseInfo = runtimeInfo({ ffmpegVersion: `${ffmpegMetadata.ffmpegVersion}0` });
        const session = createFfmpegSession({
            assetBaseUrl: 'https://example.test/ffmpeg/',
            workerFactory: () => worker,
        });
        await expect(session.load()).rejects.toMatchObject({ code: 'protocol' });
        expect(session.state).toBe('failed');
        expect(worker.terminate).toHaveBeenCalledTimes(1);
    });

    it('hard-cancels an unresponsive request', async () => {
        const worker = new FakeWorker();
        const session = createFfmpegSession({
            assetBaseUrl: 'https://example.test/ffmpeg/',
            workerFactory: () => worker,
        });
        const runtime = await session.load();
        worker.autoReply = false;
        const controller = new AbortController();
        const inspection = runtime.inspect({ signal: controller.signal });
        controller.abort();
        await expect(inspection).rejects.toMatchObject({ code: 'aborted' });
        expect(session.state).toBe('disposed');
        expect(worker.terminate).toHaveBeenCalledTimes(1);
    });

    it('terminates initialization that never replies', async () => {
        const worker = new FakeWorker();
        worker.autoReply = false;
        const session = createFfmpegSession({
            assetBaseUrl: 'https://example.test/ffmpeg/',
            workerFactory: () => worker,
            initializationTimeoutMs: 1,
        });
        await expect(session.load()).rejects.toMatchObject({ code: 'timeout' });
        expect(session.state).toBe('failed');
    });

    it('fails all work on malformed or stale replies', async () => {
        for (const data of [
            { malformed: true },
            { sessionId: 'stale', requestId: 2, ok: true, result: runtimeInfo() },
        ]) {
            const worker = new FakeWorker();
            const session = createFfmpegSession({
                assetBaseUrl: 'https://example.test/ffmpeg/',
                workerFactory: () => worker,
            });
            const runtime = await session.load();
            worker.autoReply = false;
            const inspection = runtime.inspect();
            worker.target.dispatchEvent(new MessageEvent('message', { data }));
            await expect(inspection).rejects.toMatchObject({ code: 'protocol' });
            expect(session.state).toBe('failed');
        }
    });

    it('terminates exactly once when disposed', async () => {
        const worker = new FakeWorker();
        const session = createFfmpegSession({
            assetBaseUrl: 'https://example.test/ffmpeg/',
            workerFactory: () => worker,
        });
        await session.load();
        session.dispose();
        session.dispose();
        expect(worker.terminate).toHaveBeenCalledTimes(1);
    });
});
