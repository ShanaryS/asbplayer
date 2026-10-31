import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { useVideoLoadNotifications } from '@project/common/app/hooks/use-video-load-notifications';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
let video: HTMLVideoElement | undefined;
let readyState: number;
let error: MediaError | null;

const Harness = ({ source = 'blob:video', conversionActive = false, conversionReady = false }) => {
    const notices = useVideoLoadNotifications({ video, source, conversionActive, conversionReady });
    return <output data-loading={notices.loading} data-conversion={notices.conversion} />;
};
const render = async (props = {}) => {
    await act(async () => root.render(<Harness {...props} />));
};
const advance = async (ms: number) => {
    await act(async () => jest.advanceTimersByTime(ms));
};
const notices = () => {
    const output = container.querySelector('output')!;
    return { loading: output.dataset.loading === 'true', conversion: output.dataset.conversion === 'true' };
};
const event = async (type: string) => {
    await act(async () => video!.dispatchEvent(new Event(type)));
};
const ready = async () => {
    readyState = HTMLMediaElement.HAVE_CURRENT_DATA;
    await event('loadeddata');
};

beforeEach(() => {
    jest.useFakeTimers();
    container = document.createElement('div');
    root = createRoot(container);
    video = document.createElement('video');
    readyState = 0;
    error = null;
    Object.defineProperties(video, {
        readyState: { get: () => readyState },
        error: { get: () => error },
    });
});
afterEach(async () => {
    await act(async () => root.unmount());
    jest.useRealTimers();
});

it('detects slow video without audio conversion after three seconds and waits for its first frame', async () => {
    await render();
    await advance(2_999);
    expect(notices()).toEqual({ loading: false, conversion: false });
    await advance(1);
    expect(notices()).toEqual({ loading: true, conversion: false });
    readyState = HTMLMediaElement.HAVE_METADATA;
    await event('loadedmetadata');
    await advance(12_000);
    expect(notices()).toEqual({ loading: true, conversion: false });
    await ready();
    expect(notices()).toEqual({ loading: false, conversion: false });
});

it.each([false, true])(
    'keeps delayed notices until t=10s when the video is ready at t=4s (conversion: %s)',
    async (conversionActive) => {
        await render({ conversionActive });
        await advance(3_000);
        expect(notices()).toEqual({ loading: true, conversion: conversionActive });
        await advance(1_000);
        await ready();
        await advance(5_999);
        expect(notices()).toEqual({ loading: true, conversion: conversionActive });
        await advance(1);
        expect(notices()).toEqual({ loading: false, conversion: false });
    }
);

it('hides conversion at t=10s even when the video remains unready until t=15s', async () => {
    await render({ conversionActive: true });
    await advance(9_999);
    expect(notices()).toEqual({ loading: true, conversion: true });
    await advance(1);
    expect(notices()).toEqual({ loading: true, conversion: false });
    await advance(5_000);
    await ready();
    expect(notices()).toEqual({ loading: false, conversion: false });
});

it.each([0, 2_999])('delays conversion notices even when video is ready after %s ms', async (ms) => {
    await render({ conversionActive: true });
    expect(notices()).toEqual({ loading: false, conversion: false });
    await advance(ms);
    await ready();
    await advance(2_999 - ms);
    expect(notices().conversion).toBe(false);
    await advance(1);
    expect(notices().conversion).toBe(true);
    await advance(6_999);
    expect(notices().conversion).toBe(true);
    await advance(1);
    expect(notices().conversion).toBe(false);
});

it('times conversion from its actual start without resetting the video load deadline', async () => {
    await render();
    await advance(2_000);
    await render({ conversionActive: true });
    await advance(1_000);
    expect(notices()).toEqual({ loading: true, conversion: false });
    await advance(2_000);
    expect(notices().conversion).toBe(true);
    await render({ conversionActive: true });
    await advance(6_999);
    expect(notices().conversion).toBe(true);
    await advance(1);
    expect(notices().conversion).toBe(false);
});

it.each([2_000, 4_000])('hides a completed conversion at %s ms and cancels remaining timers', async (ms) => {
    await render({ conversionActive: true });
    await advance(ms);
    expect(notices().conversion).toBe(ms >= 3_000);
    await render({ conversionActive: true, conversionReady: true });
    expect(notices().conversion).toBe(false);
    await advance(10_000);
    expect(notices().conversion).toBe(false);
});

it('can remove a failed conversion notice without hiding the delayed video notice', async () => {
    await render({ conversionActive: true });
    await advance(3_000);
    await render({ conversionActive: false });
    expect(notices()).toEqual({ loading: true, conversion: false });
    await ready();
    await advance(7_000);
    expect(notices()).toEqual({ loading: false, conversion: false });
});

it('gives a new file its own deadlines and cancels the previous file timers', async () => {
    await render({ conversionActive: true });
    await advance(4_000);
    await render({ source: 'blob:next-video' });
    expect(notices()).toEqual({ loading: false, conversion: false });
    await advance(2_999);
    expect(notices().loading).toBe(false);
    await advance(1);
    await ready();
    await advance(3_000);
    expect(notices().loading).toBe(true); // The previous file's t=10s must not close this notice.
    await advance(3_999);
    expect(notices().loading).toBe(true);
    await advance(1);
    expect(notices().loading).toBe(false);
});

it.each([0, 3_000, 10_000])('clears notices on a video error after %s ms', async (ms) => {
    await render({ conversionActive: true });
    await advance(ms);
    error = { code: 4, message: 'Unsupported video' } as MediaError;
    await event('error');
    expect(notices()).toEqual({ loading: false, conversion: false });
    await advance(10_000);
    expect(notices()).toEqual({ loading: false, conversion: false });
});

it('starts a new video load without resetting an already-running conversion', async () => {
    readyState = HTMLMediaElement.HAVE_ENOUGH_DATA;
    await render({ conversionActive: true });
    await advance(5_000);
    expect(notices()).toEqual({ loading: false, conversion: true });
    readyState = HTMLMediaElement.HAVE_NOTHING;
    await event('loadstart');
    expect(notices()).toEqual({ loading: false, conversion: true });
    await advance(3_000);
    expect(notices()).toEqual({ loading: true, conversion: true });
});

it('checks current readiness when a browser has already decoded a frame without delivering its event', async () => {
    await render({ conversionActive: true });
    readyState = HTMLMediaElement.HAVE_CURRENT_DATA;
    await advance(3_000);
    expect(notices()).toEqual({ loading: false, conversion: true });
    await advance(7_000);
    expect(notices()).toEqual({ loading: false, conversion: false });
});

it('does not treat later buffering as an initial load delay', async () => {
    await render();
    await advance(3_000);
    await ready();
    readyState = HTMLMediaElement.HAVE_METADATA;
    await event('waiting');
    await advance(7_000);
    expect(notices()).toEqual({ loading: false, conversion: false });
});

it('can show conversion feedback without a video element and waits for the element to time video loading', async () => {
    const element = video;
    video = undefined;
    await render({ conversionActive: true });
    await advance(3_000);
    expect(notices()).toEqual({ loading: false, conversion: true });
    await advance(7_000);
    expect(notices()).toEqual({ loading: false, conversion: false });
    video = element;
    await render({ conversionActive: true });
    await advance(3_000);
    expect(notices()).toEqual({ loading: true, conversion: false });
});
