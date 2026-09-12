import { createFfmpegSession, prepareFfmpegAssets } from '@project/ffmpeg';

const assetBaseUrl = () => {
    const configured = import.meta.env.VITE_FFMPEG_ASSET_BASE_URL as string | undefined;
    return new URL(configured ?? `${import.meta.env.BASE_URL}ffmpeg/`, window.location.origin).href;
};

export const createWebFfmpegSession = async () => {
    const baseUrl = assetBaseUrl();
    await prepareFfmpegAssets({ assetBaseUrl: baseUrl });
    return createFfmpegSession({ assetBaseUrl: baseUrl });
};
