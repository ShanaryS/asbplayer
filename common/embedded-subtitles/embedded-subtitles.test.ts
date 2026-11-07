/** @jest-environment node */
import { beforeAll, expect, it } from '@jest/globals';
import type { EmbeddedSubtitleTrack } from '@project/common/media-probe/subtitle-probe';
import { TextEncoder } from 'util';
import { mkv, mkvTrack, element, utf8 } from '@project/common/media-probe/test-media';
import {
    embeddedDescriptor,
    embeddedSubtitleId,
    plainSrtMimeType,
} from '@project/common/embedded-subtitles/subtitle-source';
import { EmbeddedSubtitles } from '@project/common/embedded-subtitles/embedded-subtitles';
import type {
    SubtitleHost,
    SubtitleExtractionOptions,
    ExtractedSubtitleFile,
} from '@project/common/embedded-subtitles/subtitle-source';

beforeAll(() => {
    if (!AbortSignal.prototype.throwIfAborted) {
        AbortSignal.prototype.throwIfAborted = function () {
            if (this.aborted) throw this.reason;
        };
    }
});

const tracks: EmbeddedSubtitleTrack[] = [
    {
        streamIndex: 2,
        codec: 'subrip',
        language: 'jpn',
        outputFormat: 'srt',
    },
    { streamIndex: 5, codec: 'ass', outputFormat: 'srt' },
    {
        streamIndex: 8,
        codec: 'dvd_subtitle',
    },
    {
        streamIndex: 9,
        codec: 'hdmv_pgs_subtitle',
    },
];

class Host implements SubtitleHost {
    selections: number[][] = [];
    signals: AbortSignal[] = [];

    async extractSubtitles({ streamIndexes, signal }: SubtitleExtractionOptions): Promise<ExtractedSubtitleFile[]> {
        this.signals.push(signal);
        this.selections.push(streamIndexes);
        return streamIndexes.map((streamIndex) => ({
            streamIndex,
            format: 'srt',
            blob: new Blob(
                streamIndex === 2 ? [new TextEncoder().encode('1\n00:00:02,000 --> 00:00:04,000\n日本語')] : [],
                { type: plainSrtMimeType }
            ),
        }));
    }
}

const source = () => ({
    id: 'video',
    file: new File(
        [
            mkv(
                mkvTrack(1, 'V_VP8'),
                mkvTrack(2, 'A_OPUS'),
                mkvTrack(17, 'S_TEXT/UTF8', element('22b59c', utf8('jpn'))),
                mkvTrack(1, 'V_VP8'),
                mkvTrack(2, 'A_OPUS'),
                mkvTrack(17, 'S_TEXT/ASS', element('22b59c', utf8('und'))),
                mkvTrack(1, 'V_VP8'),
                mkvTrack(2, 'A_OPUS'),
                mkvTrack(17, 'S_VOBSUB', element('22b59c', utf8('und'))),
                mkvTrack(17, 'S_HDMV/PGS', element('22b59c', utf8('und')))
            ),
        ],
        'episode.mkv',
        { lastModified: 10 }
    ),
});

it('discovers and reuses catalogs without starting an FFmpeg session', async () => {
    const host = new Host();
    const service = new EmbeddedSubtitles(host);
    const video = source();
    const signal = new AbortController().signal;
    const catalogs = await Promise.all([service.discover(video, signal), service.discover(video, signal)]);
    expect(catalogs).toEqual([tracks, tracks]);
    expect(catalogs[0]).toBe(catalogs[1]);
    expect(await service.discover(video, signal)).toBe(catalogs[0]);
    expect(host.signals).toHaveLength(0);
});

it('extracts unique streams together, accepts empty outputs, and reuses completed files', async () => {
    const host = new Host();
    const service = new EmbeddedSubtitles(host);
    const video = source();
    const first = embeddedDescriptor(video, tracks[0]);
    const empty = embeddedDescriptor(video, tracks[1]);
    const files = await service.extract(video, [first, first, empty], new AbortController().signal);
    expect(host.selections).toEqual([[2, 5]]);
    expect(files.size).toBe(2);
    expect(files.get(embeddedSubtitleId(video.id, 2))?.file.name).toBe('episode.jpn.track-1.srt');
    expect(files.get(embeddedSubtitleId(video.id, 5))?.file.size).toBe(0);
    expect(files.get(embeddedSubtitleId(video.id, 5))?.id).not.toBe('-');
    expect(files.get(embeddedSubtitleId(video.id, 2))?.file.type).toBe(plainSrtMimeType);
    const reused = await service.extract(video, [first], new AbortController().signal);
    expect(reused.get(embeddedSubtitleId(video.id, 2))).toBe(files.get(embeddedSubtitleId(video.id, 2)));
    expect(host.selections).toHaveLength(1);
});

it('does no work for empty selections and rejects changed or unsupported sources', async () => {
    const host = new Host();
    const service = new EmbeddedSubtitles(host);
    const video = source();
    expect(await service.extract(video, [], new AbortController().signal)).toEqual(new Map());
    expect(host.signals).toHaveLength(0);
    await expect(
        service.extract(
            { ...video, file: new File(['changed'], 'episode.mkv') },
            [embeddedDescriptor(video, tracks[0])],
            new AbortController().signal
        )
    ).rejects.toThrow('changed');
    for (const track of tracks.slice(2)) {
        await expect(
            service.extract(video, [embeddedDescriptor(video, track)], new AbortController().signal)
        ).rejects.toThrow('unavailable');
    }
    expect(host.selections).toHaveLength(0);
});

it('cancels discovery before caching late results and allows retry', async () => {
    const host = new Host();
    const service = new EmbeddedSubtitles(host);
    const video = source();
    const slice = video.file.slice.bind(video.file);
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
        release = resolve;
    });
    video.file.slice = (...args) => {
        const part = slice(...args);
        const read = part.arrayBuffer.bind(part);
        part.arrayBuffer = async () => {
            await wait;
            return read();
        };
        return part;
    };
    const controller = new AbortController();
    const pending = service.discover(video, controller.signal);
    controller.abort();
    release();
    await expect(pending).rejects.toThrow();
    video.file.slice = slice;
    expect(await service.discover(video, new AbortController().signal)).toEqual(tracks);
    expect(host.signals).toHaveLength(0);
});

it('resolves mixed file, URL, embedded and empty slots without merging duplicate choices', async () => {
    const { resolveSubtitleSelection } = await import('@project/common/embedded-subtitles/embedded-subtitles');
    const host = new Host();
    const service = new EmbeddedSubtitles(host);
    const video = source();
    const descriptor = embeddedDescriptor(video, tracks[0]);
    const choice = {
        id: embeddedSubtitleId(video.id, 2),
        embedded: descriptor,
        extension: 'srt',
        label: 'Embedded',
        name: 'Embedded',
    };
    const online = {
        id: 'online',
        url: 'https://example.test/subtitles',
        extension: 'srt',
        label: 'Online',
        name: 'Online',
    };
    const local = {
        id: 'local',
        file: new File(['local'], 'local.srt'),
        extension: 'srt',
        label: 'Local',
        name: 'Local',
    };
    let requests = 0;
    const files = await resolveSubtitleSelection(
        [choice, online, { id: '-', extension: 'srt', label: '-', name: '-' }, local, choice, online],
        video,
        service,
        new AbortController().signal,
        async (_url, options) => {
            ++requests;
            expect(options?.signal).toBeInstanceOf(AbortSignal);
            return { ok: true, blob: async () => new Blob(['online']) } as Response;
        }
    );
    expect(files.map((file) => file.id)).toEqual([choice.id, 'online', '-', 'local', choice.id, 'online']);
    expect(files[0]).toBe(files[4]);
    expect(files[1]).toBe(files[5]);
    expect(requests).toBe(1);
    expect(host.selections).toEqual([[2]]);
});

it('rejects failed URL loads and cancellation before returning a partial selection', async () => {
    const { resolveSubtitleSelection } = await import('@project/common/embedded-subtitles/embedded-subtitles');
    const online = {
        id: 'online',
        url: 'https://example.test/subtitles',
        extension: 'srt',
        label: 'Online',
        name: 'Online',
    };
    const empty = { id: '-', extension: 'srt', label: '-', name: '-' };
    const controller = new AbortController();
    const service = new EmbeddedSubtitles(new Host());
    await expect(
        resolveSubtitleSelection(
            [empty, online],
            undefined,
            service,
            controller.signal,
            async () => ({ ok: false, status: 500 }) as Response
        )
    ).rejects.toThrow('HTTP 500');
    controller.abort();
    await expect(resolveSubtitleSelection([empty], undefined, service, controller.signal)).rejects.toThrow();
});
