/** @jest-environment node */
import { probeSubtitleTracks } from '@project/common/media-probe/subtitle-probe';
import { box, concat, element, mkv, mkvTrack, mp4Track, utf8 } from '@project/common/media-probe/test-media';

it('reads mixed Matroska track order, UTF-8 metadata and unsupported subtitles', async () => {
    const bytes = mkv(
        mkvTrack(3, 'B_BUTTONS'), // The demuxer skips unsupported track types.
        mkvTrack(1, 'V_MPEG4/ISO/AVC'),
        mkvTrack(2, 'A_EAC3'),
        mkvTrack(17, 'S_VOBSUB'),
        mkvTrack(
            17,
            'S_TEXT/ASS',
            element('22b59c', utf8('jpn')),
            element('22b59d', utf8('ja-JP')),
            element('536e', utf8('日本語'))
        ),
        mkvTrack(17, 'S_HDMV/PGS'),
        mkvTrack(17, 'D_WEBVTT/SUBTITLES'),
        mkvTrack(17, 'S_TEXT/SSA')
    );
    const tracks = await probeSubtitleTracks(new Blob([bytes]));
    expect(tracks.map(({ streamIndex, codec, outputFormat }) => [streamIndex, codec, outputFormat])).toEqual([
        [2, 'dvd_subtitle', undefined],
        [3, 'ass', 'srt'],
        [4, 'hdmv_pgs_subtitle', 'sup'],
        [5, 'webvtt', 'srt'],
        [6, 'ass', 'srt'],
    ]);
    expect(tracks[1]).toMatchObject({ language: 'ja-JP', title: '日本語' });
});

it.each([0, 1])('reads MP4 track indexes and language from version %s media headers', async (version) => {
    const bytes = concat(
        box('ftyp', utf8('isom')),
        box('mdat', Buffer.alloc(32)),
        box(
            'moov',
            mp4Track('vide', 'avc1'),
            mp4Track('soun', 'mp4a'),
            mp4Track('sbtl', 'tx3g', version),
            mp4Track('subt', 'stpp', version)
        )
    );
    expect(await probeSubtitleTracks(new Blob([bytes]))).toEqual([
        { streamIndex: 2, codec: 'mov_text', language: 'jpn', title: '日本語', outputFormat: 'srt' },
        { streamIndex: 3, codec: 'ttml', language: 'jpn', title: '日本語', unsupportedReason: 'unsupported-codec' },
    ]);
});

it('excludes MP4 chapter text tracks without changing subtitle stream indexes', async () => {
    const video = mp4Track('vide', 'avc1');
    const chapterId = Buffer.alloc(4);
    chapterId.writeUInt32BE(7);
    const withChapters = box('trak', video.subarray(8), box('tref', box('chap', chapterId)));
    const bytes = concat(
        box('ftyp'),
        box('moov', withChapters, mp4Track('text', 'text', 0, 7), mp4Track('sbtl', 'tx3g', 0, 9))
    );
    expect((await probeSubtitleTracks(new Blob([bytes]))).map(({ streamIndex }) => streamIndex)).toEqual([2]);
});

it('distinguishes containers without subtitles from unknown or incomplete metadata', async () => {
    expect(await probeSubtitleTracks(new Blob([mkv(mkvTrack(1, 'V_VP8'))]))).toEqual([]);
    expect(await probeSubtitleTracks(new Blob([box('ftyp'), box('moov', mp4Track('vide', 'avc1'))]))).toEqual([]);
    for (const bytes of [
        utf8('not media'),
        element('1a45dfa3'),
        concat(box('ftyp'), box('moov').subarray(0, 5)),
        mkv(mkvTrack(17, '')),
    ]) {
        await expect(probeSubtitleTracks(new Blob([bytes]))).rejects.toThrow();
    }
});

it('seeks to MP4 metadata beyond 4 GiB without reading the intervening payload', async () => {
    const size = 5 * 1024 ** 3;
    const ftyp = box('ftyp', utf8('isom'));
    const moov = box('moov', mp4Track('vide', 'avc1'), mp4Track('sbtl', 'tx3g'));
    const free = Buffer.alloc(16);
    free.writeUInt32BE(1);
    free.write('free', 4);
    free.writeBigUInt64BE(BigInt(size - ftyp.length - moov.length), 8);
    let readBytes = 0;
    const regions = [
        [0, ftyp],
        [ftyp.length, free],
        [size - moov.length, moov],
    ] as const;
    const sparse = {
        size,
        slice(start: number, end: number) {
            readBytes += end - start;
            const bytes = Buffer.alloc(end - start);
            for (const [offset, data] of regions) {
                const from = Math.max(start, offset),
                    to = Math.min(end, offset + data.length);
                if (to > from) data.copy(bytes, from - start, from - offset, to - offset);
            }
            return new Blob([bytes]);
        },
    } as Blob;
    expect((await probeSubtitleTracks(sparse)).map(({ streamIndex }) => streamIndex)).toEqual([1]);
    expect(readBytes).toBeLessThan(1024 * 1024);
});

it('honors cancellation after an outstanding file read', async () => {
    const controller = new AbortController();
    let release!: (bytes: ArrayBuffer) => void;
    const file = {
        size: 20,
        slice: () => ({
            arrayBuffer: () =>
                new Promise<ArrayBuffer>((resolve) => {
                    release = resolve;
                }),
        }),
    } as Blob;
    const discovery = probeSubtitleTracks(file, controller.signal);
    controller.abort(new Error('cancelled'));
    release(new ArrayBuffer(20));
    await expect(discovery).rejects.toThrow('cancelled');
});
