import type { ConfirmedVideoDataSubtitleTrack } from '@project/common';
import { probeSubtitleTracks } from '@project/common/media-probe/subtitle-probe';
import type { EmbeddedSubtitleTrack } from '@project/common/media-probe/subtitle-probe';
import type { FileWithId } from '@project/common/file-selector';
import type { EmbeddedSubtitleDescriptor, SubtitleHost } from '@project/common/embedded-subtitles/subtitle-source';
import { embeddedSubtitleId, subtitleSourceMatches } from '@project/common/embedded-subtitles/subtitle-source';

/** Catalogs and immutable output Files outlive the short-lived, separately owned subtitle workers. */
export class EmbeddedSubtitles {
    private readonly catalogs = new Map<File, EmbeddedSubtitleTrack[]>();
    private readonly outputs = new Map<File, Map<number, FileWithId>>();
    private readonly probes = new Map<File, { signal: AbortSignal; job: Promise<EmbeddedSubtitleTrack[]> }>();
    private queue: Promise<unknown> = Promise.resolve();

    constructor(private readonly host: SubtitleHost) {}

    retain(sources: FileWithId[]) {
        const files = new Set(sources.map((source) => source.file));
        for (const file of this.catalogs.keys()) if (!files.has(file)) this.catalogs.delete(file);
        for (const file of this.outputs.keys()) if (!files.has(file)) this.outputs.delete(file);
    }

    private run<T>(signal: AbortSignal, operation: () => Promise<T>) {
        const result = this.queue
            .catch(() => {})
            .then(async () => {
                signal.throwIfAborted();
                const value = await operation();
                signal.throwIfAborted();
                return value;
            });
        this.queue = result;
        return result;
    }

    async discover(source: FileWithId, signal: AbortSignal): Promise<EmbeddedSubtitleTrack[]> {
        signal.throwIfAborted();
        const cached = this.catalogs.get(source.file);
        if (cached !== undefined) return cached;
        const pending = this.probes.get(source.file);
        if (pending && pending.signal === signal) return pending.job;
        const job = probeSubtitleTracks(source.file, signal).then((tracks) => {
            signal.throwIfAborted();
            this.catalogs.set(source.file, tracks);
            return tracks;
        });
        this.probes.set(source.file, { signal, job });
        try {
            return await job;
        } finally {
            if (this.probes.get(source.file)?.job === job) this.probes.delete(source.file);
        }
    }

    async extract(
        source: FileWithId,
        descriptors: EmbeddedSubtitleDescriptor[],
        signal: AbortSignal
    ): Promise<Map<string, FileWithId>> {
        signal.throwIfAborted();
        if (descriptors.length === 0) return new Map();
        if (descriptors.some((d) => !subtitleSourceMatches(source, d) || d.format !== 'srt')) {
            throw new Error('The embedded subtitle source has changed');
        }
        const tracks = await this.discover(source, signal);
        signal.throwIfAborted();
        for (const descriptor of descriptors) {
            if (
                !tracks.some(
                    (track) =>
                        track.streamIndex === descriptor.streamIndex &&
                        track.outputFormat === descriptor.format &&
                        track.codec === descriptor.codec
                )
            ) {
                throw new Error('The embedded subtitle track is unavailable');
            }
        }
        const previous = this.outputs.get(source.file);
        const cached =
            previous && [...previous.values()].every((file) => file.embedded?.videoId === source.id)
                ? previous
                : new Map<number, FileWithId>();
        const indexes = [...new Set(descriptors.map((d) => d.streamIndex))];
        const missing = indexes.filter((index) => !cached.has(index));
        if (missing.length > 0) {
            const completed = await this.run(signal, async () => {
                const results = await this.host.extractSubtitles({
                    file: source.file,
                    fileId: source.id,
                    streamIndexes: missing,
                    signal,
                });
                signal.throwIfAborted();
                if (
                    results.length !== missing.length ||
                    new Set(results.map((result) => result.streamIndex)).size !== missing.length
                ) {
                    throw new Error('Incomplete embedded subtitle output');
                }
                return results.map((result): FileWithId => {
                    const descriptor = descriptors.find((d) => d.streamIndex === result.streamIndex);
                    if (!missing.includes(result.streamIndex) || !descriptor || result.format !== descriptor.format) {
                        throw new Error('Unexpected subtitle output format');
                    }
                    const subtitleIndex = tracks.findIndex((track) => track.streamIndex === result.streamIndex);
                    const language = tracks[subtitleIndex].language;
                    const base = source.file.name.replace(/\.[^.]+$/, '');
                    const suffix = language?.replace(/[^\p{L}\p{N}_-]/gu, '').slice(0, 30);
                    return {
                        id: embeddedSubtitleId(source.id, result.streamIndex),
                        embedded: descriptor,
                        file: new File(
                            [result.blob],
                            `${base}${suffix ? '.' + suffix : ''}.track-${subtitleIndex + 1}.${result.format}`,
                            { type: result.blob.type }
                        ),
                    };
                });
            });
            for (const file of completed) cached.set(file.embedded!.streamIndex, file);
            this.outputs.set(source.file, cached);
        }
        return new Map(
            indexes.map((index) => {
                const file = cached.get(index)!;
                return [file.id, file];
            })
        );
    }
}

/** Resolve the whole draft before the caller commits any playback sources. */
export const resolveSubtitleSelection = async (
    tracks: ConfirmedVideoDataSubtitleTrack[],
    source: FileWithId | undefined,
    service: EmbeddedSubtitles,
    signal: AbortSignal,
    fetcher: typeof fetch = (...args) => fetch(...args)
): Promise<FileWithId[]> => {
    signal.throwIfAborted();
    if (tracks.some((track) => track.disabledReason)) throw new Error('Unsupported subtitle selection');
    const descriptors = tracks.flatMap((track) => (track.embedded ? [track.embedded] : []));
    if (descriptors.length > 0 && !source) throw new Error('Missing embedded subtitle source');
    const extracted =
        descriptors.length > 0 ? await service.extract(source!, descriptors, signal) : new Map<string, FileWithId>();
    const downloaded = new Map<string, FileWithId>();
    const files: FileWithId[] = [];
    for (const track of tracks) {
        signal.throwIfAborted();
        if (track.embedded) {
            const file = extracted.get(track.id);
            if (!file) throw new Error('Unresolved embedded subtitle');
            files.push(file);
        } else if (track.id === '-') {
            files.push({ id: '-', file: new File([''], '.srt') });
        } else if (track.file) {
            files.push({ id: track.id, file: track.file });
        } else {
            if (typeof track.url !== 'string') throw new Error('Invalid subtitle URL');
            let file = downloaded.get(track.id);
            if (!file) {
                const response = await fetcher(track.url, { signal });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                file = { id: track.id, file: new File([await response.blob()], `${track.name}.${track.extension}`) };
                downloaded.set(track.id, file);
            }
            files.push(file);
        }
    }
    signal.throwIfAborted();
    return files;
};
