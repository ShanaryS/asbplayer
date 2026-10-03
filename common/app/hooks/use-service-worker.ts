import { registerSW } from 'virtual:pwa-register';
import { useEffect, useState } from 'react';
import { watchServiceWorkerUpdates } from '@project/common/app/services/service-worker-updates';
import { watchFfmpegUpdates } from '@project/common/app/services/ffmpeg-update-status';
import type { FfmpegDownloadProgress } from '@project/ffmpeg';

interface Params {
    onNeedRefresh: () => void;
    onOfflineReady: () => void;
    onFfmpegUpdateError: (error: string) => void;
}

interface FunctionWrapper {
    fn: () => void;
}

export const useServiceWorker = ({ onNeedRefresh, onOfflineReady, onFfmpegUpdateError }: Params) => {
    const [updateFunction, setUpdateFunction] = useState<FunctionWrapper>({ fn: () => {} });
    const [ffmpegDownloadProgress, setFfmpegDownloadProgress] = useState<FfmpegDownloadProgress>();

    useEffect(() => {
        let reloading = false;
        const reload = () => {
            if (reloading) return;
            reloading = true;
            window.location.reload();
        };
        const stopWatching = navigator.serviceWorker
            ? watchServiceWorkerUpdates(navigator.serviceWorker, reload)
            : undefined;
        const ffmpegUpdates = navigator.serviceWorker
            ? watchFfmpegUpdates(navigator.serviceWorker, setFfmpegDownloadProgress, onFfmpegUpdateError)
            : undefined;
        const updateSW = registerSW({
            onNeedRefresh() {
                onNeedRefresh();
            },
            onOfflineReady() {
                onOfflineReady();
            },
            onNeedReload: reload,
            onRegisteredSW(_url, registration) {
                if (registration) ffmpegUpdates?.watchRegistration(registration);
            },
        });
        setUpdateFunction({ fn: updateSW });
        return () => {
            stopWatching?.();
            ffmpegUpdates?.stop();
        };
    }, [onNeedRefresh, onOfflineReady, onFfmpegUpdateError]);

    return { doUpdate: updateFunction.fn, ffmpegDownloadProgress };
};
