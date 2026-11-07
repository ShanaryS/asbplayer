import { beforeEach, expect, it } from '@jest/globals';
import 'core-js/stable/structured-clone';
import 'fake-indexeddb/auto';
import { IndexedDBFileSessionRepository } from '@project/common/file-system-access/file-system-access-repository';
import { restoreSessionFiles } from '@project/common/file-system-access/file-system-access';
import {
    embeddedDescriptor,
    embeddedSubtitleId,
    plainSrtMimeType,
} from '@project/common/embedded-subtitles/subtitle-source';
import type { FileSessionRecord } from '@project/common/file-system-access/file-system-access-repository';
import { MediaSources } from '@project/common/app/services/media-sources';

const unexpectedExtraction = async () => {
    throw new Error('Unexpected embedded subtitle extraction');
};

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
    subtitleTrackIds: [[id], ['-'], ['external'], [id]],
    embeddedSubtitles: { [id]: descriptor },
    cachedSubtitleFiles: [external, embedded],
});
beforeEach(async () => {
    Object.defineProperty(navigator, 'storage', {
        configurable: true,
        value: { estimate: async () => ({ quota: 1024 ** 3, usage: 0 }) },
    });
    await new IndexedDBFileSessionRepository().clear();
});

it.each(['cached', 'regenerated'])(
    'restores repeated %s embedded subtitles into separate playback slots',
    async (kind) => {
        const repository = new IndexedDBFileSessionRepository();
        const selection = [
            { ...embedded, track: 0 },
            { ...embedded, track: 2 },
        ];
        await repository.merge({ videoHandle: record().videoHandle, subtitleHandles: [] });
        await repository.setCachedSubtitleFiles(selection, {
            subtitleTrackIds: [[id], [], [id]],
            embeddedSubtitles: { [id]: descriptor },
        });
        if (kind === 'regenerated') await repository.setCachedSubtitleFiles([]);
        const saved = (await repository.fetch())!;
        const restored = await restoreSessionFiles(
            saved,
            [video],
            kind === 'cached' ? unexpectedExtraction : async () => new Map([[id, embedded]])
        );
        const sources = MediaSources.fromFiles(restored);
        expect(sources.subtitleTracks.map(({ fileParts }) => fileParts.map(({ id }) => id))).toEqual([
            [id],
            ['-'],
            [id],
        ]);
        expect(sources.subtitleSourceFiles.map(({ track }) => track)).toEqual([0, 1, 2]);
        expect(sources.subtitleSourceFiles[0].file).toBe(sources.subtitleSourceFiles[2].file);
        expect(sources.subtitleSourceFiles[2].embedded).toEqual(descriptor);
        expect(saved.cachedSubtitleFiles).toHaveLength(kind === 'cached' ? 1 : 0);
    }
);

it('restores mixed source ordering, duplicate selections, empty slots and provenance', async () => {
    const restored = await restoreSessionFiles(record(), [video], unexpectedExtraction);
    expect(restored.map((file) => file.id)).toEqual(['video', id, '-', 'external', id]);
    expect(restored[1].embedded).toEqual(descriptor);
    expect(restored[1].file.type).toBe(plainSrtMimeType);
    expect(restored[4].file).toBe(restored[1].file);
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

        const restored = await restoreSessionFiles(session, [video, updated], unexpectedExtraction);

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
        subtitleTrackIds: [[id], ['-'], [id]],
        embeddedSubtitles: { [id]: descriptor },
    });
    Object.defineProperty(navigator, 'storage', {
        configurable: true,
        value: { estimate: async () => ({ quota: 1, usage: 1 }) },
    });
    try {
        expect(
            await repository.setCachedSubtitleFiles([embedded, embedded, { id: '-', file: new File([''], '.srt') }], {
                subtitleTrackIds: [[id], ['-'], [id]],
                embeddedSubtitles: { [id]: descriptor },
            })
        ).toBe(false);
        await repository.clearBuffered();
        await repository.retain({ videoId: 'video', subtitleTrackIds: [[id], ['-'], [id]] });
        const saved = await repository.fetch();
        expect(saved?.cachedSubtitleFiles).toEqual([]);
        expect(saved?.subtitleTrackIds).toEqual([[id], ['-'], [id]]);
        expect(saved?.embeddedSubtitles).toEqual({ [id]: descriptor });
    } finally {
        Object.defineProperty(navigator, 'storage', { configurable: true, value: undefined });
    }
});
it('continues to restore records without slot metadata', async () => {
    const session = record();
    delete session.subtitleTrackIds;
    expect((await restoreSessionFiles(session, [video], unexpectedExtraction)).map((file) => file.id)).toEqual([
        'video',
        'external',
        id,
    ]);
});

it('clears cancelled draft handles while preserving the committed embedded selection', async () => {
    const repository = new IndexedDBFileSessionRepository();
    await repository.setCachedSubtitleFiles([embedded], {
        subtitleTrackIds: [[id], ['-'], [id]],
        embeddedSubtitles: { [id]: descriptor },
    });
    await repository.merge({
        subtitleHandles: [],
        bufferedSubtitleHandles: [{ id: 'draft', handle: { name: 'draft.srt' } as FileSystemFileHandle }],
    });
    await repository.clearBuffered();
    const saved = await repository.fetch();
    expect(saved?.bufferedSubtitleHandles).toBeUndefined();
    expect(saved?.subtitleTrackIds).toEqual([[id], ['-'], [id]]);
    expect(saved?.embeddedSubtitles).toEqual({ [id]: descriptor });
    expect(saved?.cachedSubtitleFiles?.map((file) => file.id)).toEqual([id]);
});

it('promotes selected handles once and releases all draft handles without losing selection metadata', async () => {
    const repository = new IndexedDBFileSessionRepository();
    const selected = { id: 'local', handle: { name: 'local.srt' } as FileSystemFileHandle };
    await repository.setCachedSubtitleFiles([embedded], {
        subtitleTrackIds: [[id], ['local'], ['-']],
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
    expect(saved?.subtitleTrackIds).toEqual([[id], ['local'], ['-']]);
    expect(saved?.embeddedSubtitles).toEqual({ [id]: descriptor });
});
