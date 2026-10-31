import { useEffect, useState } from 'react';
import { asbTrace } from '@project/common/util/log';

const videoLoadNoticeDelayMs = 3_000;
const conversionNoticeLimitMs = 10_000;
const delayedNoticeMinimumDurationMs = 7_000;

/**
 * Detect slow startup at 3s and retain its notice until both the first frame and the 7s minimum.
 * Conversion notices appear after 3s and end at completion or 10s, independently of video readiness.
 */
export const useVideoLoadNotifications = ({
    video,
    source,
    conversionActive,
    conversionReady = false,
}: {
    video: HTMLVideoElement | undefined;
    source: string;
    conversionActive: boolean;
    conversionReady?: boolean;
}) => {
    const [conversionSource, setConversionSource] = useState<string>();
    useEffect(() => {
        setConversionSource(undefined);
        if (!source || !conversionActive || conversionReady) return;
        const delay = setTimeout(() => setConversionSource(source), videoLoadNoticeDelayMs);
        const deadline = setTimeout(() => setConversionSource(undefined), conversionNoticeLimitMs);
        return () => {
            clearTimeout(delay);
            clearTimeout(deadline);
        };
    }, [source, conversionActive, conversionReady]);
    const [load, setLoad] = useState<{
        video: HTMLVideoElement;
        source: string;
        delayed: boolean;
        ready: boolean;
        failed: boolean;
        noticeDeadlineReached: boolean;
    }>();

    useEffect(() => {
        if (!video || !source) {
            setLoad(undefined);
            return;
        }
        let delayTimer: ReturnType<typeof setTimeout> | undefined;
        let noticeTimer: ReturnType<typeof setTimeout> | undefined;
        let delayed = false;
        let ready = false;
        let noticeDeadlineReached = false;
        const update = () => {
            // Once the first frame has loaded, later buffering is not a startup delay.
            ready ||= video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
            const failed = video.error !== null;
            if (ready || failed) clearTimeout(delayTimer);
            if (failed) clearTimeout(noticeTimer);
            setLoad({ video, source, delayed, ready, failed, noticeDeadlineReached });
        };
        const expireNotices = () => {
            noticeDeadlineReached = true;
            update();
        };
        const loading = () => {
            clearTimeout(delayTimer);
            clearTimeout(noticeTimer);
            delayed = false;
            ready = false;
            noticeDeadlineReached = false;
            update();
            if (video.error) return;
            if (ready) return;
            delayTimer = setTimeout(() => {
                if (video.error || video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
                    update();
                    return;
                }
                delayed = true;
                clearTimeout(noticeTimer);
                noticeTimer = setTimeout(expireNotices, delayedNoticeMinimumDurationMs);
                asbTrace('playback/video-player', 'Waiting for the browser to load the original video', {
                    readyState: video.readyState,
                    networkState: video.networkState,
                    videoWidth: video.videoWidth,
                    videoHeight: video.videoHeight,
                });
                update();
            }, videoLoadNoticeDelayMs);
        };
        loading();
        video.addEventListener('loadstart', loading);
        video.addEventListener('loadeddata', update);
        video.addEventListener('canplay', update);
        video.addEventListener('error', update);
        return () => {
            clearTimeout(delayTimer);
            clearTimeout(noticeTimer);
            video.removeEventListener('loadstart', loading);
            video.removeEventListener('loadeddata', update);
            video.removeEventListener('canplay', update);
            video.removeEventListener('error', update);
        };
    }, [video, source]);

    const current = load?.video === video && load?.source === source && !load?.failed;
    return {
        loading: Boolean(current && load?.delayed && (!load.ready || !load.noticeDeadlineReached)),
        conversion: Boolean(
            conversionSource === source &&
                conversionActive &&
                !conversionReady &&
                !(load?.video === video && load?.source === source && load?.failed)
        ),
    };
};
