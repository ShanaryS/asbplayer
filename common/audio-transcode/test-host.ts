import { createFfmpegSession, ffmpegMetadata } from '@project/ffmpeg';
import type { FfmpegTranscodeProgress, FfmpegWorker, WorkerRequest } from '@project/ffmpeg';
import type { WorkerReply } from '@project/ffmpeg/protocol';
import type { AudioTranscodeHost } from '@project/common/audio-transcode/audio-transcoder';

// A worker is the native execution boundary. Sessions and feature orchestration remain real.
export class TestWorker implements FfmpegWorker {
    readonly target = new EventTarget();
    active = true;
    input?: Blob;
    pending?: WorkerRequest;
    readonly started: Promise<void>;
    private start!: () => void;

    constructor(private readonly host: TestHost) {
        this.started = new Promise((resolve) => {
            this.start = resolve;
        });
    }

    postMessage(request: WorkerRequest) {
        this.pending = request;
        if (request.operation === 'transcodeAudio') {
            this.input = request.input;
            this.start();
            if (!this.host.autoComplete) return;
        }
        if (request.operation === 'initialize' && !this.host.autoInitialize) {
            this.start();
            return;
        }
        queueMicrotask(() => this.complete());
    }

    complete() {
        const request = this.pending!;
        let reply: WorkerReply;
        if (request.operation === 'transcodeAudio') {
            reply = this.host.error
                ? { ...request, ok: false, error: { code: 'native', message: this.host.error } }
                : { ...request, ok: true, result: new Uint8Array([1, 2, 3]).buffer };
        } else {
            reply = {
                ...request,
                ok: true,
                result: {
                    ...ffmpegMetadata,
                    ffmpegConfiguration: '',
                    ffmpegLicense: '',
                    libraries: [],
                    linkedLibraries: [],
                    operations: ['inspect', 'transcodeAudio'],
                },
            };
        }
        this.target.dispatchEvent(new MessageEvent('message', { data: reply }));
    }

    progress(progress: FfmpegTranscodeProgress) {
        const request = this.pending!;
        this.target.dispatchEvent(
            new MessageEvent('message', {
                data: { sessionId: request.sessionId, requestId: request.requestId, type: 'progress', progress },
            })
        );
    }

    terminate() {
        this.active = false;
    }
    addEventListener(type: 'message' | 'error' | 'messageerror', listener: EventListener) {
        this.target.addEventListener(type, listener);
    }
    removeEventListener(type: 'message' | 'error' | 'messageerror', listener: EventListener) {
        this.target.removeEventListener(type, listener);
    }
}

export class TestHost implements AudioTranscodeHost {
    available = true;
    autoInitialize = true;
    autoComplete = true;
    error?: string;
    readonly workers: TestWorker[] = [];
    isAvailable = async () => this.available;
    createSession: AudioTranscodeHost['createSession'] = ({ signal, onDownloadProgress }) =>
        createFfmpegSession({
            assetBaseUrl: 'https://app.test/ffmpeg/',
            signal,
            workerFactory: () => {
                const worker = new TestWorker(this);
                this.workers.push(worker);
                return worker;
            },
            prepareAssets: async () => {
                onDownloadProgress({
                    stage: 'downloading',
                    downloadedBytes: 10,
                    totalBytes: 20,
                    bytesPerSecond: 10,
                    etaSeconds: 1,
                });
                return {
                    workerURL: 'blob:worker',
                    coreURL: 'blob:core',
                    wasmURL: 'blob:wasm',
                    dispose() {},
                };
            },
        });
}
