import { ffmpegAssetUrls } from '@project/ffmpeg/assets';
import { ffmpegMetadata } from '@project/ffmpeg/metadata';
import { isWorkerReply } from '@project/ffmpeg/protocol';
import type { FfmpegErrorCode, FfmpegRuntimeInfo, WorkerRequest, WorkerRequestBody } from '@project/ffmpeg/protocol';

export type FfmpegWorker = {
    postMessage(message: WorkerRequest): void;
    terminate(): void;
    addEventListener(type: 'message' | 'error' | 'messageerror', listener: (event: any) => void): void;
    removeEventListener(type: 'message' | 'error' | 'messageerror', listener: (event: any) => void): void;
};

export class FfmpegError extends Error {
    constructor(
        readonly code: FfmpegErrorCode,
        message: string
    ) {
        super(message);
        this.name = 'FfmpegError';
    }
}

export type FfmpegRuntime = {
    inspect(options?: { signal?: AbortSignal }): Promise<FfmpegRuntimeInfo>;
};

export type CreateFfmpegSessionOptions = {
    assetBaseUrl: string;
    workerFactory?: (workerURL: string) => FfmpegWorker;
    initializationTimeoutMs?: number;
    expectedRuntimeVersion?: string;
};

export type FfmpegSessionState = 'new' | 'loading' | 'ready' | 'failed' | 'disposed';

export type FfmpegSession = {
    load(options?: { signal?: AbortSignal }): Promise<FfmpegRuntime>;
    dispose(): void;
    readonly state: FfmpegSessionState;
};

type Pending = { resolve(value: unknown): void; reject(error: unknown): void };
const abortError = () => new FfmpegError('aborted', 'The FFmpeg session was aborted');
const defaultWorkerFactory = (url: string): FfmpegWorker =>
    new Worker(url, { type: 'module', name: 'asbplayer-ffmpeg' });

export const createFfmpegSession = ({
    assetBaseUrl,
    workerFactory = defaultWorkerFactory,
    initializationTimeoutMs = 30_000,
    expectedRuntimeVersion = ffmpegMetadata.runtimeVersion,
}: CreateFfmpegSessionOptions): FfmpegSession => {
    const sessionId = crypto.randomUUID();
    const pending = new Map<number, Pending>();
    let state: FfmpegSessionState = 'new';
    let worker: FfmpegWorker | undefined;
    let loadPromise: Promise<FfmpegRuntime> | undefined;
    let requestId = 0;

    const settleAll = (error: unknown) => {
        for (const request of pending.values()) request.reject(error);
        pending.clear();
    };

    const removeListeners = () => {
        worker?.removeEventListener('message', onMessage);
        worker?.removeEventListener('error', onWorkerError);
        worker?.removeEventListener('messageerror', onWorkerError);
    };

    const terminate = (nextState: 'failed' | 'disposed', error: FfmpegError) => {
        if (state === 'disposed' || state === 'failed') return;
        state = nextState;
        removeListeners();
        worker?.terminate();
        worker = undefined;
        settleAll(error);
    };

    function onWorkerError() {
        terminate('failed', new FfmpegError('initialization', 'The FFmpeg worker failed'));
    }

    function onMessage(event: MessageEvent<unknown>) {
        if (!isWorkerReply(event.data)) {
            terminate('failed', new FfmpegError('protocol', 'The FFmpeg worker sent a malformed reply'));
            return;
        }
        const reply = event.data;
        if (reply.sessionId !== sessionId || !pending.has(reply.requestId)) {
            terminate('failed', new FfmpegError('protocol', 'The FFmpeg worker sent an incompatible or stale reply'));
            return;
        }
        const pendingRequest = pending.get(reply.requestId)!;
        pending.delete(reply.requestId);
        if (reply.ok) pendingRequest.resolve(reply.result);
        else pendingRequest.reject(new FfmpegError(reply.error.code, reply.error.message));
    }

    const request = <T>(operation: WorkerRequestBody): Promise<T> => {
        if (worker === undefined || state === 'disposed' || state === 'failed') {
            return Promise.reject(new FfmpegError('disposed', 'The FFmpeg session is not available'));
        }
        const id = ++requestId;
        const message = { sessionId, requestId: id, ...operation } as WorkerRequest;
        return new Promise<T>((resolve, reject) => {
            pending.set(id, { resolve, reject });
            try {
                worker!.postMessage(message);
            } catch (error) {
                pending.delete(id);
                reject(error);
            }
        });
    };

    const withSignal = <T>(signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> => {
        if (signal?.aborted) {
            const error = abortError();
            terminate('disposed', error);
            return Promise.reject(error);
        }
        if (signal === undefined) return operation();
        return new Promise<T>((resolve, reject) => {
            const abort = () => {
                const error = abortError();
                terminate('disposed', error);
                reject(error);
            };
            const settle = (callback: (value: T | PromiseLike<T>) => void, value: T) => {
                signal.removeEventListener('abort', abort);
                callback(value);
            };
            const fail = (error: unknown) => {
                signal.removeEventListener('abort', abort);
                reject(error);
            };
            signal.addEventListener('abort', abort, { once: true });
            try {
                operation().then((value) => settle(resolve, value), fail);
            } catch (error) {
                fail(error);
            }
        });
    };

    const runtime: FfmpegRuntime = {
        inspect: ({ signal } = {}) => {
            if (state !== 'ready') {
                return Promise.reject(new FfmpegError('disposed', 'The FFmpeg session is not ready'));
            }
            return withSignal(signal, () => request({ operation: 'inspect' }));
        },
    };

    const load = (options: { signal?: AbortSignal } = {}) => {
        if (state === 'disposed' || state === 'failed') {
            return Promise.reject(new FfmpegError('disposed', 'The FFmpeg session is terminal; create a new session'));
        }
        if (loadPromise !== undefined) return withSignal(options.signal, () => loadPromise!);
        state = 'loading';
        loadPromise = withSignal(options.signal, async () => {
            const timeout = setTimeout(
                () => terminate('failed', new FfmpegError('timeout', 'FFmpeg initialization timed out')),
                initializationTimeoutMs
            );
            try {
                const assets = ffmpegAssetUrls(assetBaseUrl);
                worker = workerFactory(assets.workerURL);
                worker.addEventListener('message', onMessage);
                worker.addEventListener('error', onWorkerError);
                worker.addEventListener('messageerror', onWorkerError);
                const info = await request<FfmpegRuntimeInfo>({
                    operation: 'initialize',
                    coreURL: assets.coreURL,
                    wasmURL: assets.wasmURL,
                });
                if (
                    info.runtimeVersion !== expectedRuntimeVersion ||
                    info.ffmpegVersion !== ffmpegMetadata.ffmpegVersion
                ) {
                    throw new FfmpegError('protocol', 'FFmpeg runtime identity does not match the selected build');
                }
                state = 'ready';
                return runtime;
            } catch (error) {
                if (state !== 'disposed' && state !== 'failed') {
                    terminate(
                        'failed',
                        error instanceof FfmpegError
                            ? error
                            : new FfmpegError(
                                  'initialization',
                                  error instanceof Error ? error.message : 'Initialization failed'
                              )
                    );
                }
                throw error;
            } finally {
                clearTimeout(timeout);
            }
        });
        return loadPromise;
    };

    return {
        load,
        dispose: () => terminate('disposed', new FfmpegError('disposed', 'The FFmpeg session was disposed')),
        get state() {
            return state;
        },
    };
};
