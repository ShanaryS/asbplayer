/** @jest-environment node */
import type { EmbeddedSubtitleTrack } from '@project/common/media-probe/subtitle-probe';
import { TextEncoder } from 'util';
import { mkv, mkvTrack, element, utf8 } from '@project/common/media-probe/test-media';
import {
    EmbeddedSubtitles,
    embeddedDescriptor,
    embeddedSubtitleId,
    plainSrtMimeType,
    pgsMimeType,
} from '@project/common/embedded-subtitles/embedded-subtitles';
import type { SubtitleHost } from '@project/common/embedded-subtitles/embedded-subtitles';
import type { FfmpegRuntime, FfmpegSession } from '@project/ffmpeg';

beforeAll(() => {
    if (!AbortSignal.prototype.throwIfAborted)
        AbortSignal.prototype.throwIfAborted = function () {
            if (this.aborted) throw this.reason;
        };
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
        unsupportedReason: 'unsupported-codec',
    },
    {
        streamIndex: 9,
        codec: 'hdmv_pgs_subtitle',
        outputFormat: 'sup',
    },
];
class Host implements SubtitleHost {
    selections: number[][] = [];
    signals: AbortSignal[] = [];
    disposed = 0;
    createSession({ signal }: { signal: AbortSignal }): FfmpegSession {
        this.signals.push(signal);
        const runtime: FfmpegRuntime = {
            inspect: async () =>
                ({ operations: ['extractSubtitles'] }) as Awaited<ReturnType<FfmpegRuntime['inspect']>>,
            extractSubtitles: async ({ streamIndexes, onChunk }) => {
                this.selections.push(streamIndexes);
                for (const index of streamIndexes)
                    if (index === 2)
                        onChunk(index, new TextEncoder().encode('1\n00:00:02,000 --> 00:00:04,000\n日本語').buffer);
                return streamIndexes.map((streamIndex) =>
                    streamIndex === 9
                        ? {
                              streamIndex,
                              extension: 'sup' as const,
                              mimeType: 'application/x-pgs' as const,
                              timelineOffsetMs: -1000,
                          }
                        : {
                              streamIndex,
                              extension: 'srt',
                              mimeType: plainSrtMimeType,
                          }
                );
            },
            transcodeAudio: async () => {
                throw new Error('audio is not used');
            },
        };
        return {
            load: async () => runtime,
            dispose: () => {
                ++this.disposed;
            },
            state: 'ready',
        };
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
    const catalogs = await Promise.all([service.discover(video), service.discover(video)]);
    expect(catalogs).toEqual([tracks, tracks]);
    expect(catalogs[0]).toBe(catalogs[1]);
    expect(await service.discover(video)).toBe(catalogs[0]);
    expect(host.signals).toHaveLength(0);
});

it('extracts unique streams together, accepts empty outputs, and reuses completed files', async () => {
    const host = new Host();
    const service = new EmbeddedSubtitles(host);
    const video = source();
    const first = embeddedDescriptor(video, tracks[0]);
    const empty = embeddedDescriptor(video, tracks[1]);
    const files = await service.extract(video, [first, first, empty]);
    expect(host.selections).toEqual([[2, 5]]);
    expect(files.size).toBe(2);
    expect(files.get(embeddedSubtitleId(video.id, 2))?.file.name).toBe('episode.jpn.track-1.srt');
    expect(files.get(embeddedSubtitleId(video.id, 5))?.file.size).toBe(0);
    expect(files.get(embeddedSubtitleId(video.id, 5))?.id).not.toBe('-');
    expect(files.get(embeddedSubtitleId(video.id, 2))?.file.type).toBe(plainSrtMimeType);
    const reused = await service.extract(video, [first]);
    expect(reused.get(embeddedSubtitleId(video.id, 2))).toBe(files.get(embeddedSubtitleId(video.id, 2)));
    expect(host.selections).toHaveLength(1);
});

it('does no work for empty selections and rejects changed or unsupported sources', async () => {
    const host = new Host();
    const service = new EmbeddedSubtitles(host);
    const video = source();
    expect(await service.extract(video, [])).toEqual(new Map());
    expect(host.signals).toHaveLength(0);
    await expect(
        service.extract({ ...video, file: new File(['changed'], 'episode.mkv') }, [
            embeddedDescriptor(video, tracks[0]),
        ])
    ).rejects.toThrow('changed');
    await expect(service.extract(video, [embeddedDescriptor(video, tracks[2])])).rejects.toThrow('unavailable');
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
    const pending = service.discover(video);
    service.cancel();
    release();
    await expect(pending).rejects.toThrow();
    video.file.slice = slice;
    expect(await service.discover(video)).toEqual(tracks);
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
    await expect(
        resolveSubtitleSelection(
            [empty, online],
            undefined,
            undefined,
            controller.signal,
            async () => ({ ok: false, status: 500 }) as Response
        )
    ).rejects.toThrow('HTTP 500');
    controller.abort();
    await expect(resolveSubtitleSelection([empty], undefined, undefined, controller.signal)).rejects.toThrow();
});

it('preserves the image format, per-track origin, stable IDs, and empty image outputs in mixed extraction', async () => {
    const host = new Host();
    const service = new EmbeddedSubtitles(host);
    const video = source();
    const image = embeddedDescriptor(video, tracks[3]);
    const files = await service.extract(video, [image, embeddedDescriptor(video, tracks[0]), image]);
    expect(host.selections).toEqual([[9, 2]]);
    const output = files.get(embeddedSubtitleId(video.id, 9))!;
    expect(output.file.name).toBe('episode.track-4.sup');
    expect(output.file.type).toBe(pgsMimeType);
    expect(output.file.size).toBe(0);
    expect(output.embedded).toEqual({ ...image, timelineOffsetMs: -1000 });
    const reused = await service.extract(video, [image]);
    expect(reused.get(output.id)).toBe(output);
    expect(host.selections).toHaveLength(1);
});
