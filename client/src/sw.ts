/// <reference lib="webworker" />

import { clientsClaim } from 'workbox-core';
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { ffmpegAssetUrls } from '@project/ffmpeg';
import { deleteOutdatedFfmpegCaches, prepareFfmpegUpdate } from '@project/client/src/services/ffmpeg-cache';
import { asbError, asbInfo, asbWarn } from '@project/common/util/log';
import type { FfmpegUpdateStatus } from '@project/common/app/services/ffmpeg-update-status';

declare const self: ServiceWorkerGlobalScope & {
    __WB_MANIFEST: Array<{ url: string; revision: string | null }>;
};

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();
clientsClaim();

const configuredAssetBase = import.meta.env.VITE_FFMPEG_ASSET_BASE_URL as string | undefined;
const assetBaseUrl = new URL(configuredAssetBase ?? `${import.meta.env.BASE_URL}ffmpeg/`, self.location.origin).href;
const currentAssets = ffmpegAssetUrls(assetBaseUrl);
const assetBasePath = new URL(assetBaseUrl).pathname.replace(/\/?$/, '/');
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

registerRoute(
    new NavigationRoute(createHandlerBoundToURL('index.html'), {
        denylist: [/\/ffmpeg\//, new RegExp(`^${escapeRegex(assetBasePath)}`)],
    })
);

let ffmpegUpdateStatus: FfmpegUpdateStatus = { type: 'FFMPEG_DOWNLOAD_FINISHED' };
const ffmpegUpdateClients = new Map<string, Client>();
const reportFfmpegUpdate = (status: FfmpegUpdateStatus) => {
    ffmpegUpdateStatus = status;
    for (const client of ffmpegUpdateClients.values()) client.postMessage(status);
};

const prepareInstalledRuntime = async () => {
    asbInfo('ffmpeg/update', 'Checking installed runtime before app update', { workerUrl: currentAssets.workerURL });
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clients) ffmpegUpdateClients.set(client.id, client);
    try {
        await prepareFfmpegUpdate(currentAssets, self.caches, new AbortController().signal, {
            onProgress: (progress) => {
                reportFfmpegUpdate({ type: 'FFMPEG_DOWNLOAD_PROGRESS', progress });
            },
        });
        reportFfmpegUpdate({ type: 'FFMPEG_DOWNLOAD_FINISHED' });
    } catch (error) {
        asbError('ffmpeg/update', 'App update runtime preparation failed', error);
        reportFfmpegUpdate({
            type: 'FFMPEG_DOWNLOAD_FAILED',
            error: error instanceof Error ? error.message : String(error),
        });
        throw error;
    }
};

// Previously installed FFmpeg follows an app update. First installations remain lazy.
self.addEventListener('install', (event: ExtendableEvent) => {
    event.waitUntil(prepareInstalledRuntime());
});

// A waiting update leaves the running app's cache intact. Only a complete replacement permits retirement.
self.addEventListener('activate', (event: ExtendableEvent) => {
    event.waitUntil(
        deleteOutdatedFfmpegCaches(self.caches, currentAssets).catch((error: unknown) => {
            asbWarn('ffmpeg/update', 'Could not retire outdated runtime caches', error);
        })
    );
});

// Updates remain opt-in.
self.addEventListener('message', (event: ExtendableMessageEvent) => {
    if (event.data?.type === 'FFMPEG_GET_UPDATE_STATUS') {
        if (event.source && 'id' in event.source) ffmpegUpdateClients.set(event.source.id, event.source);
        event.source?.postMessage(ffmpegUpdateStatus);
        return;
    }
    if (event.data?.type === 'SKIP_WAITING') {
        asbInfo('ffmpeg/update', 'App update accepted; rechecking installed runtime');
        // FFmpeg may have been installed by the running app while this update was waiting.
        event.waitUntil(prepareInstalledRuntime().then(() => self.skipWaiting()));
    }
});
