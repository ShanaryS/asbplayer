import { ffmpegAssetUrls } from '@project/ffmpeg/assets';
import { ffmpegMetadata } from '@project/ffmpeg/metadata';
import type { FfmpegClient, FfmpegConstructor } from '@project/ffmpeg/types';

export type CreateFfmpegSessionOptions = {
    assetBaseUrl: string;
    expectedBuild?: string;
    importWrapper?: (url: string) => Promise<{ FFmpeg: FfmpegConstructor }>;
};

export type FfmpegSession = {
    load(options?: { signal?: AbortSignal }): Promise<FfmpegClient>;
    dispose(): void;
    readonly disposed: boolean;
};

const defaultImportWrapper = async (url: string) =>
    (await import(/* webpackIgnore: true */ /* @vite-ignore */ url)) as { FFmpeg: FfmpegConstructor };

const abortError = () => new DOMException('The FFmpeg session was aborted', 'AbortError');

export const createFfmpegSession = ({
    assetBaseUrl,
    expectedBuild = ffmpegMetadata.coreVersion,
    importWrapper = defaultImportWrapper,
}: CreateFfmpegSessionOptions): FfmpegSession => {
    const assets = ffmpegAssetUrls(assetBaseUrl);
    let client: FfmpegClient | undefined;
    let loadPromise: Promise<FfmpegClient> | undefined;
    let disposed = false;
    let signal: AbortSignal | undefined;

    const terminate = () => {
        signal?.removeEventListener('abort', terminate);
        signal = undefined;
        client?.terminate();
        client = undefined;
        disposed = true;
    };

    const load = (options: { signal?: AbortSignal } = {}) => {
        if (disposed) {
            return Promise.reject(new Error('FFmpeg session has been disposed'));
        }
        if (expectedBuild !== ffmpegMetadata.coreVersion) {
            terminate();
            return Promise.reject(
                new Error(`FFmpeg build ${expectedBuild} is incompatible with ${ffmpegMetadata.coreVersion}`)
            );
        }
        if (options.signal?.aborted) {
            terminate();
            return Promise.reject(abortError());
        }
        if (loadPromise !== undefined) {
            return loadPromise;
        }

        signal = options.signal;
        signal?.addEventListener('abort', terminate, { once: true });
        loadPromise = (async () => {
            try {
                const { FFmpeg } = await importWrapper(assets.wrapperURL);
                if (disposed) {
                    throw abortError();
                }
                const createdClient = new FFmpeg();
                client = createdClient;
                await createdClient.load(
                    {
                        classWorkerURL: assets.classWorkerURL,
                        coreURL: assets.coreURL,
                        wasmURL: assets.wasmURL,
                    },
                    options
                );
                if (disposed) {
                    throw abortError();
                }
                return createdClient;
            } catch (error) {
                terminate();
                throw error;
            }
        })();
        return loadPromise;
    };

    return {
        load,
        dispose: terminate,
        get disposed() {
            return disposed;
        },
    };
};
