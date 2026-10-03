import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { randomUUID } from 'node:crypto';
import type { FileWithId } from '@project/common/file-selector';
import { isActiveBlobUrl } from '@project/common/blob-url';
import { TestHost } from '@project/common/audio-transcode/test-host';
import { useTranscodedAudio } from '@project/common/app/hooks/use-transcoded-audio';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const Harness = ({ file, host }: { file?: FileWithId; host: TestHost }) => {
    const conversion = useTranscodedAudio(file, host);
    return (
        <>
            <output data-state={conversion.state} data-url={conversion.url}>
                {conversion.codecName}
            </output>
            <button onClick={conversion.start}>Convert</button>
            <button onClick={conversion.dismiss}>Cancel</button>
        </>
    );
};

let container: HTMLDivElement;
let root: Root;
let nextUrl = 0;
// Only the track header is needed to exercise the real codec probe.
const box = (type: string, ...parts: Uint8Array[]) => {
    const bytes = new Uint8Array(8 + parts.reduce((size, part) => size + part.length, 0));
    new DataView(bytes.buffer).setUint32(0, bytes.length);
    bytes.set(
        [...type].map((character) => character.charCodeAt(0)),
        4
    );
    let offset = 8;
    for (const part of parts) {
        bytes.set(part, offset);
        offset += part.length;
    }
    return bytes;
};
const audioHeader = box(
    'moov',
    box(
        'trak',
        box(
            'mdia',
            box('hdlr', new Uint8Array(8), new Uint8Array([115, 111, 117, 110])), // soun
            box('minf', box('stbl', box('stsd', new Uint8Array([0, 0, 0, 0, 0, 0, 0, 1]), box('ac-3'))))
        )
    )
);
const file = (id: string): FileWithId => ({
    id,
    file: new File([audioHeader], `${id}.mp4`),
});
const state = () => container.querySelector('output')!.getAttribute('data-state');
const render = async (file: FileWithId | undefined, host: TestHost) => {
    await act(async () => root.render(<Harness file={file} host={host} />));
};
const click = async (index: number) => {
    await act(async () => container.querySelectorAll('button')[index].click());
};
const waitForState = async (expected: string) => {
    const deadline = Date.now() + 2000;
    while (state() !== expected && Date.now() < deadline) {
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 5));
        });
    }
    expect(state()).toBe(expected);
};

beforeAll(() => {
    crypto.randomUUID = randomUUID;
    // jsdom predates this standard AbortSignal method.
    if (AbortSignal.prototype.throwIfAborted === undefined) {
        AbortSignal.prototype.throwIfAborted = function () {
            if (this.aborted) throw this.reason;
        };
    }
    if (Blob.prototype.arrayBuffer === undefined) {
        Blob.prototype.arrayBuffer = function () {
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result as ArrayBuffer);
                reader.onerror = () => reject(reader.error);
                reader.readAsArrayBuffer(this);
            });
        };
    }
});
beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    // Browser codec support and Blob URLs are the external boundaries.
    jest.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockImplementation((mime) =>
        mime === 'video/mp4' ? 'probably' : ''
    );
    URL.createObjectURL = jest.fn(() => `blob:converted-${++nextUrl}`);
    URL.revokeObjectURL = jest.fn();
});
afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    jest.restoreAllMocks();
});

it('prompts without downloading or creating a worker and leaves dismissal lazy', async () => {
    const host = new TestHost();
    await render(file('a'), host);
    await waitForState('prompting');
    expect(container.querySelector('output')!.textContent).toBe('AC-3');
    expect(host.workers).toHaveLength(0);
    await click(1);
    expect(state()).toBe('idle');
    expect(host.workers).toHaveLength(0);
});

it('converts through the host and releases playback URLs when the file changes', async () => {
    const host = new TestHost();
    await render(file('a'), host);
    await waitForState('prompting');
    await click(0);
    await waitForState('ready');
    const url = container.querySelector('output')!.getAttribute('data-url')!;
    expect(isActiveBlobUrl(url)).toBe(true);
    expect(host.workers[0].active).toBe(false);
    await render(undefined, host);
    expect(state()).toBe('idle');
    expect(isActiveBlobUrl(url)).toBe(false);
});

it.each(['cancel', 'file change', 'unmount'])('terminates a native conversion on %s', async (action) => {
    const host = new TestHost();
    host.autoComplete = false;
    await render(file('a'), host);
    await waitForState('prompting');
    await click(0);
    await waitForState('transcoding');
    await host.workers[0].started;
    if (action === 'cancel') await click(1);
    else if (action === 'file change') await render(file('b'), host);
    else {
        await act(async () => root.unmount());
        root = createRoot(container);
    }
    expect(host.workers[0].active).toBe(false);
    await act(async () => host.workers[0].complete());
    expect(container.querySelector('output')?.getAttribute('data-url')).toBeFalsy();
    if (action === 'file change') await waitForState('prompting');
});

it('suppresses the prompt when the runtime is unavailable offline', async () => {
    const host = new TestHost();
    host.available = false;
    const isAvailable = jest.spyOn(host, 'isAvailable');
    await render(file('a'), host);
    const deadline = Date.now() + 2000;
    while (isAvailable.mock.calls.length === 0 && Date.now() < deadline) {
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 5));
        });
    }
    expect(isAvailable).toHaveBeenCalled();
    expect(state()).toBe('idle');
    expect(host.workers).toHaveLength(0);
});

it('retries a failure with a fresh session', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const host = new TestHost();
    host.error = 'Invalid media';
    await render(file('a'), host);
    await waitForState('prompting');
    await click(0);
    await waitForState('failed');
    expect(host.workers[0].active).toBe(false);
    host.error = undefined;
    await click(0);
    await waitForState('ready');
    expect(host.workers).toHaveLength(2);
});
