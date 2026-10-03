import type { FfmpegDownloadProgress } from '@project/ffmpeg';

export type FfmpegUpdateStatus =
    | { type: 'FFMPEG_DOWNLOAD_PROGRESS'; progress: FfmpegDownloadProgress }
    | { type: 'FFMPEG_DOWNLOAD_FINISHED' }
    | { type: 'FFMPEG_DOWNLOAD_FAILED'; error: string };

/** Recover progress when a page joins an update that has already started. */
export const watchFfmpegUpdates = (
    serviceWorker: ServiceWorkerContainer,
    onProgress: (progress: FfmpegDownloadProgress | undefined) => void,
    onError: (error: string) => void
) => {
    let stopWatchingRegistration: (() => void) | undefined;
    let stopped = false;
    const onMessage = (event: MessageEvent<FfmpegUpdateStatus>) => {
        if (event.data?.type === 'FFMPEG_DOWNLOAD_PROGRESS') {
            onProgress(event.data.progress.stage === 'complete' ? undefined : event.data.progress);
        } else if (event.data?.type === 'FFMPEG_DOWNLOAD_FINISHED') {
            onProgress(undefined);
        } else if (event.data?.type === 'FFMPEG_DOWNLOAD_FAILED') {
            onProgress(undefined);
            onError(event.data.error);
        }
    };
    serviceWorker.addEventListener('message', onMessage);
    return {
        watchRegistration: (registration: ServiceWorkerRegistration) => {
            if (stopped) return;
            stopWatchingRegistration?.();
            const requestStatus = () => {
                // A running worker belongs to the current app; installation/waiting belongs to its update.
                (registration.installing ?? registration.waiting)?.postMessage({ type: 'FFMPEG_GET_UPDATE_STATUS' });
            };
            registration.addEventListener('updatefound', requestStatus);
            stopWatchingRegistration = () => registration.removeEventListener('updatefound', requestStatus);
            requestStatus();
        },
        stop: () => {
            stopped = true;
            stopWatchingRegistration?.();
            serviceWorker.removeEventListener('message', onMessage);
        },
    };
};
