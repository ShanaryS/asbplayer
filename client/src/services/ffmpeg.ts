import { createFfmpegSession } from '@project/ffmpeg';

const assetBaseUrl = () => {
    const configured = import.meta.env.VITE_FFMPEG_ASSET_BASE_URL as string | undefined;
    return new URL(configured ?? `${import.meta.env.BASE_URL}ffmpeg/`, window.location.origin).href;
};

export const createWebFfmpegSession = () => {
    const baseUrl = assetBaseUrl();
    if (new URL(baseUrl).origin !== window.location.origin) {
        throw new Error('FFmpeg runtime assets must be served from the application origin');
    }
    return createFfmpegSession({ assetBaseUrl: baseUrl });
};
