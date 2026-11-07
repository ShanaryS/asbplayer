import { afterEach, beforeAll, beforeEach, expect, it, jest } from '@jest/globals';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { TextDecoder } from 'util';
import type { ConfirmedVideoDataSubtitleTrack, LoadableSubtitleTrack } from '@project/common';
import type { FileWithId } from '@project/common/file-selector';
import { EmbeddedSubtitles } from '@project/common/embedded-subtitles/embedded-subtitles';
import {
    embeddedDescriptor,
    embeddedSubtitleId,
    plainSrtMimeType,
} from '@project/common/embedded-subtitles/subtitle-source';
import type { ExtractedSubtitleFile, SubtitleHost } from '@project/common/embedded-subtitles/subtitle-source';
import { mkv, mkvTrack } from '@project/common/media-probe/test-media';
import { MediaSources } from '@project/common/app/services/media-sources';
import { useSubtitleSelection } from '@project/common/app/hooks/use-subtitle-selection';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Object.assign(globalThis, { TextDecoder });

const video = (id: string): FileWithId => {
    const bytes = mkv(mkvTrack(1, 'V_VP8'), mkvTrack(17, 'S_TEXT/UTF8'));
    const file = new File([], `${id}.mkv`);
    Object.defineProperty(file, 'size', { value: bytes.length });
    file.slice = () => ({ arrayBuffer: async () => Uint8Array.from(bytes).buffer }) as Blob;
    return { id, file };
};

const choice = (source: FileWithId): ConfirmedVideoDataSubtitleTrack => ({
    id: embeddedSubtitleId(source.id, 1),
    embedded: embeddedDescriptor(source, { streamIndex: 1, codec: 'subrip', outputFormat: 'srt' }),
    extension: 'srt',
    label: 'English',
    name: 'English',
});

let requests: { signal: AbortSignal; finish: () => void }[];
const host: SubtitleHost = {
    extractSubtitles: ({ streamIndexes, signal }) =>
        new Promise<ExtractedSubtitleFile[]>((resolve) =>
            requests.push({
                signal,
                finish: () =>
                    resolve(
                        streamIndexes.map((streamIndex) => ({
                            streamIndex,
                            format: 'srt',
                            blob: new Blob(['subtitles'], { type: plainSrtMimeType }),
                        }))
                    ),
            })
        ),
};
let source: FileWithId;
let service: EmbeddedSubtitles;
let commit: ReturnType<
    typeof jest.fn<(tracks: LoadableSubtitleTrack<FileWithId>[], signal: AbortSignal) => Promise<void>>
>;
let sources: MediaSources;

function Harness({
    tracks,
    selectedIds = tracks.map(({ id }) => id),
}: {
    tracks: ConfirmedVideoDataSubtitleTrack[];
    selectedIds?: string[];
}) {
    const selection = useSubtitleSelection({ source, service, selectedTrackIds: selectedIds, sources });
    return (
        <>
            <output data-busy={selection.busy} data-error={selection.error} />
            <button data-action="confirm" onClick={() => selection.confirm(tracks, commit)}>
                Confirm
            </button>
            <button data-action="cancel" onClick={selection.cancel}>
                Cancel
            </button>
        </>
    );
}

let container: HTMLDivElement;
let root: Root;

const output = () => container.querySelector('output')!;

const click = async (action: string) =>
    act(async () => container.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)!.click());

const render = async (tracks = [choice(source)], selectedIds?: string[]) =>
    act(async () => root.render(<Harness tracks={tracks} selectedIds={selectedIds} />));

const finish = async (index: number) => act(async () => requests[index].finish());

beforeAll(() => {
    if (!AbortSignal.prototype.throwIfAborted) {
        AbortSignal.prototype.throwIfAborted = function () {
            if (this.aborted) throw this.reason;
        };
    }
});

beforeEach(() => {
    source = video('video');
    requests = [];
    sources = new MediaSources();
    service = new EmbeddedSubtitles(host);
    commit = jest.fn(async () => {});
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
});

it('commits resolved slots together and preserves every part of existing subtitle tracks', async () => {
    const first = { id: 'first', file: new File(['first'], 'first.srt') };
    const second = { id: 'second', file: new File(['second'], 'second.srt') };
    sources = MediaSources.fromFiles([
        { ...first, track: 0 },
        { ...second, track: 0 },
    ]);
    const local = { ...first, name: 'first', label: 'first', extension: 'srt' };
    const empty = { id: '-', name: '-', label: '-', extension: 'srt' };
    await render([local, empty, local]);
    await click('confirm');
    const tracks = commit.mock.calls[0][0];
    expect(tracks[0]).toBe(sources.subtitleTracks[0]);
    expect(tracks[2]).toBe(sources.subtitleTracks[0]);
    expect(tracks[1].fileParts[0].id).toBe('-');
    expect(requests).toHaveLength(0);
});

it('keeps confirmation busy until extraction and the commit finish, and ignores duplicate confirmation', async () => {
    let release!: () => void;
    commit.mockImplementation(
        () =>
            new Promise<void>((resolve) => {
                release = resolve;
            })
    );
    await render();
    await click('confirm');
    await click('confirm');
    expect(requests).toHaveLength(1);
    expect(commit).not.toHaveBeenCalled();
    expect(output().dataset.busy).toBe('true');
    await finish(0);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(output().dataset.busy).toBe('true');
    await act(async () => release());
    expect(output().dataset.busy).toBe('false');
});

it.each(['cancel', 'replace', 'unmount'])('ignores late extraction after %s and aborts its request', async (action) => {
    await render();
    await click('confirm');
    if (action === 'cancel') {
        await click('cancel');
    } else if (action === 'replace') {
        source = video('replacement');
        await render();
    } else {
        await act(async () => root.render(null));
    }
    expect(requests[0].signal.aborted).toBe(true);
    await finish(0);
    expect(commit).not.toHaveBeenCalled();
    if (action !== 'unmount') {
        expect(output().dataset.error).toBe('false');
        await click('confirm');
        await finish(1);
        expect(commit).toHaveBeenCalledTimes(1);
    }
});

it('rejects stale choices and retries a failed commit using the completed extraction', async () => {
    await render(undefined, ['different']);
    await click('confirm');
    expect(output().dataset.error).toBe('true');
    expect(requests).toHaveLength(0);
    await render();
    commit.mockRejectedValueOnce(new Error('Session save failed'));
    await click('confirm');
    await finish(0);
    expect(output().dataset.error).toBe('true');
    expect(output().dataset.busy).toBe('false');
    await click('confirm');
    expect(output().dataset.error).toBe('false');
    expect(output().dataset.busy).toBe('false');
    expect(commit).toHaveBeenCalledTimes(2);
    expect(requests).toHaveLength(1);
});

it('aborts a pending commit without turning cancellation into a failure', async () => {
    let release!: () => void;
    commit.mockImplementation(
        (_tracks, signal) =>
            new Promise<void>((resolve, reject) => {
                release = () => {
                    if (signal.aborted) reject(signal.reason);
                    else resolve();
                };
            })
    );
    await render();
    await click('confirm');
    await finish(0);
    await click('cancel');
    expect(commit.mock.calls[0][1].aborted).toBe(true);
    await act(async () => release());
    expect(output().dataset.busy).toBe('false');
    expect(output().dataset.error).toBe('false');
});
