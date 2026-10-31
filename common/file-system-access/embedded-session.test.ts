import 'core-js/stable/structured-clone';
import 'fake-indexeddb/auto';
import { IndexedDBFileSessionRepository } from '@project/common/file-system-access/file-system-access-repository';
import { restoreSessionFiles } from '@project/common/file-system-access/file-system-access';
import {
    embeddedDescriptor,
    embeddedSubtitleId,
    plainSrtMimeType,
    pgsMimeType,
} from '@project/common/embedded-subtitles/embedded-subtitles';
import type { FileSessionRecord } from '@project/common/file-system-access/file-system-access-repository';

const video = { id: 'video', file: new File(['movie'], 'episode.mkv', { lastModified: 1 }) };
const descriptor = embeddedDescriptor(video, {
    streamIndex: 3,
    codec: 'subrip',
    outputFormat: 'srt',
});
const id = embeddedSubtitleId(video.id, 3);
const embedded = { id, embedded: descriptor, file: new File(['subtitle'], 'embedded.srt', { type: plainSrtMimeType }) };
const external = { id: 'external', file: new File(['external'], 'external.srt') };
const record = (): FileSessionRecord => ({
    id: 1,
    timestamp: 1,
    videoHandle: { id: video.id, handle: { name: video.file.name } as FileSystemFileHandle },
    subtitleHandles: [],
    subtitleTrackIds: [id, '-', 'external', id],
    embeddedSubtitles: { [id]: descriptor },
    cachedSubtitleFiles: [external, embedded],
});
beforeEach(async () => {
    await new IndexedDBFileSessionRepository().clear();
});

it('restores mixed source ordering, duplicate selections, empty slots and provenance', async () => {
    const restored = await restoreSessionFiles(record(), [video]);
    expect(restored.map((file) => file.id)).toEqual(['video', id, '-', 'external', id]);
    expect(restored[1].embedded).toEqual(descriptor);
    expect(restored[1].file.type).toBe(plainSrtMimeType);
    expect(restored[4]).toBe(restored[1]);
});
it('re-extracts an evicted embedded file before reconstructing duplicate slots', async () => {
    const session = record();
    session.cachedSubtitleFiles = [external];
    const restored = await restoreSessionFiles(session, [video], async (source, descriptors) => {
        expect(source).toBe(video);
        expect(descriptors).toEqual([descriptor]);
        return new Map([[id, embedded]]);
    });
    expect(restored.map((file) => file.id)).toEqual(['video', id, '-', 'external', id]);
});
it.each([true, false])(
    'prefers current disk contents over cached local subtitles (slot metadata: %s)',
    async (slots) => {
        const session = record();
        const updated = { ...external, file: new File(['corrected subtitles'], 'external.srt', { lastModified: 2 }) };
        if (!slots) delete session.subtitleTrackIds;

        const restored = await restoreSessionFiles(session, [video, updated]);

        expect(restored.find((file) => file.id === external.id)?.file).toBe(updated.file);
        expect(restored.find((file) => file.id === id)?.file).toBe(embedded.file);
        if (slots) expect(restored.map((file) => file.id)).toEqual(['video', id, '-', external.id, id]);
    }
);
it('does not reuse cached subtitles from changed video contents and retains unavailable slot positions', async () => {
    const changed = { ...video, file: new File(['different'], 'episode.mkv', { lastModified: 2 }) };
    const restored = await restoreSessionFiles(record(), [changed], async () => {
        throw new Error('must not extract');
    });
    expect(restored.map((file) => file.file.size)).toEqual([9, 0, 0, 8, 0]);
});
it('preserves descriptors and selected IDs when quota prevents output caching and repository mutations follow', async () => {
    const repository = new IndexedDBFileSessionRepository();
    await repository.merge({ videoHandle: record().videoHandle, subtitleHandles: [] });
    await repository.setCachedSubtitleFiles([embedded], {
        subtitleTrackIds: [id, '-', id],
        embeddedSubtitles: { [id]: descriptor },
    });
    Object.defineProperty(navigator, 'storage', {
        configurable: true,
        value: { estimate: async () => ({ quota: 1, usage: 1 }) },
    });
    try {
        expect(
            await repository.setCachedSubtitleFiles([embedded, embedded, { id: '-', file: new File([''], '.srt') }], {
                subtitleTrackIds: [id, '-', id],
                embeddedSubtitles: { [id]: descriptor },
            })
        ).toBe(false);
        await repository.clearBuffered();
        await repository.retain({ videoId: 'video', subtitleIds: [id, '-', id] });
        const saved = await repository.fetch();
        expect(saved?.cachedSubtitleFiles).toEqual([]);
        expect(saved?.subtitleTrackIds).toEqual([id, '-', id]);
        expect(saved?.embeddedSubtitles).toEqual({ [id]: descriptor });
    } finally {
        Object.defineProperty(navigator, 'storage', { configurable: true, value: undefined });
    }
});
it('continues to restore records without slot metadata', async () => {
    const session = record();
    delete session.subtitleTrackIds;
    expect((await restoreSessionFiles(session, [video])).map((file) => file.id)).toEqual(['video', 'external', id]);
});

it('clears cancelled draft handles while preserving the committed embedded selection', async () => {
    const repository = new IndexedDBFileSessionRepository();
    await repository.setCachedSubtitleFiles([embedded], {
        subtitleTrackIds: [id, '-', id],
        embeddedSubtitles: { [id]: descriptor },
    });
    await repository.merge({
        subtitleHandles: [],
        bufferedSubtitleHandles: [{ id: 'draft', handle: { name: 'draft.srt' } as FileSystemFileHandle }],
    });
    await repository.clearBuffered();
    const saved = await repository.fetch();
    expect(saved?.bufferedSubtitleHandles).toBeUndefined();
    expect(saved?.subtitleTrackIds).toEqual([id, '-', id]);
    expect(saved?.embeddedSubtitles).toEqual({ [id]: descriptor });
    expect(saved?.cachedSubtitleFiles?.map((file) => file.id)).toEqual([id]);
});

it('promotes selected handles once and releases all draft handles without losing selection metadata', async () => {
    const repository = new IndexedDBFileSessionRepository();
    const selected = { id: 'local', handle: { name: 'local.srt' } as FileSystemFileHandle };
    await repository.setCachedSubtitleFiles([embedded], {
        subtitleTrackIds: [id, 'local', '-'],
        embeddedSubtitles: { [id]: descriptor },
    });
    await repository.merge({
        subtitleHandles: [selected],
        bufferedSubtitleHandles: [selected, { id: 'unused', handle: { name: 'unused.srt' } as FileSystemFileHandle }],
    });
    await repository.promoteBuffered(['local']);
    const saved = await repository.fetch();
    expect(saved?.subtitleHandles.map((handle) => handle.id)).toEqual(['local']);
    expect(saved?.bufferedSubtitleHandles).toBeUndefined();
    expect(saved?.subtitleTrackIds).toEqual([id, 'local', '-']);
    expect(saved?.embeddedSubtitles).toEqual({ [id]: descriptor });
});

it('restores cached PGS output with the adjustment intact and regenerates evicted image tracks', async () => {
    const repository = new IndexedDBFileSessionRepository();
    const pgs = { ...descriptor, codec: 'hdmv_pgs_subtitle', format: 'sup' as const, timelineOffsetMs: -1000 };
    const image = { id, embedded: pgs, file: new File(['SUP'], 'image.sup', { type: pgsMimeType }) };
    await repository.merge({ videoHandle: record().videoHandle, subtitleHandles: [] });
    await repository.setCachedSubtitleFiles([image], {
        subtitleTrackIds: [id, '-', id],
        embeddedSubtitles: { [id]: pgs },
    });
    let saved = (await repository.fetch())!;
    const restored = await restoreSessionFiles(saved, [video]);
    expect(restored.map((file) => file.id)).toEqual(['video', id, '-', id]);
    expect(restored[1].file.type).toBe(pgsMimeType);
    expect(restored[1].embedded?.timelineOffsetMs).toBe(-1000);
    await repository.setCachedSubtitleFiles([]);
    saved = (await repository.fetch())!;
    const regenerated = await restoreSessionFiles(saved, [video], async (_source, descriptors) => {
        expect(descriptors).toEqual([pgs]);
        return new Map([[id, image]]);
    });
    expect(regenerated[1].embedded).toEqual(pgs);
    expect(regenerated[3]).toBe(regenerated[1]);
});
