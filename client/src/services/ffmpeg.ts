import { createFfmpegObjectUrls, createFfmpegSession } from '@project/ffmpeg';
import type { FfmpegDownloadProgress } from '@project/ffmpeg';
import { prepareFfmpegRuntime } from '@project/client/src/services/ffmpeg-cache';
import { asbError, asbTrace } from '@project/common/util/log';

const assetBaseUrl = () => {
    const configured = import.meta.env.VITE_FFMPEG_ASSET_BASE_URL as string | undefined;
    return new URL(configured ?? `${import.meta.env.BASE_URL}ffmpeg/`, window.location.origin).href;
};

export const createWebFfmpegSession = ({
    signal,
    onDownloadProgress,
}: { signal?: AbortSignal; onDownloadProgress?: (progress: FfmpegDownloadProgress) => void } = {}) => {
    const baseUrl = assetBaseUrl();
    if (new URL(baseUrl).origin !== window.location.origin) {
        throw new Error('FFmpeg runtime assets must be served from the application origin');
    }
    return createFfmpegSession({
        assetBaseUrl: baseUrl,
        signal,
        workerFactory: (workerUrl) => {
            asbTrace('ffmpeg/session', 'Starting worker from verified assets', { assetBaseUrl: baseUrl });
            const worker = new Worker(workerUrl, { type: 'module', name: 'asbplayer-ffmpeg' });
            worker.addEventListener('error', (event) => {
                asbError('ffmpeg/session', 'Worker failed', {
                    message: event.message,
                    filename: event.filename,
                    lineno: event.lineno,
                    colno: event.colno,
                    error: event.error,
                });
            });
            worker.addEventListener('messageerror', () => {
                asbError('ffmpeg/session', 'Could not deserialize worker reply');
            });
            return worker;
        },
        prepareAssets: async (assets, signal) => {
            const responses = await prepareFfmpegRuntime(
                assets,
                typeof caches === 'undefined' ? undefined : caches,
                signal,
                {
                    onProgress: onDownloadProgress,
                }
            );
            const [worker, core, wasm] = await Promise.all([
                responses.worker.blob(),
                responses.core.blob(),
                responses.wasm.blob(),
            ]);
            signal.throwIfAborted();
            // Execute the bytes we verified, including on uncontrolled pages or when storage is unavailable.
            return createFfmpegObjectUrls({ worker, core, wasm });
        },
    });
};
