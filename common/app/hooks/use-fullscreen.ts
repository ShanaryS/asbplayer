import { useCallback, useEffect, useState } from 'react';

const isFullscreenSupported = () =>
    typeof document.documentElement.requestFullscreen === 'function' && document.fullscreenEnabled !== false;

export const useFullscreen = () => {
    const [fullscreen, setFullscreen] = useState<boolean>(document.fullscreenElement != null);
    const supported = isFullscreenSupported();
    useEffect(() => {
        const listener = () => {
            setFullscreen(document.fullscreenElement != null);
        };
        document.addEventListener('fullscreenchange', listener);
        return () => document.removeEventListener('fullscreenchange', listener);
    }, []);
    const requestFullscreen = useCallback((newFullscreen: boolean) => {
        if (newFullscreen && !document.fullscreenElement) {
            if (typeof document.documentElement.requestFullscreen === 'function') {
                void document.documentElement.requestFullscreen();
            }
        } else if (!newFullscreen && document.fullscreenElement) {
            if (typeof document.exitFullscreen === 'function') {
                void document.exitFullscreen();
            }
        }
    }, []);
    return { fullscreen, requestFullscreen, supported };
};
