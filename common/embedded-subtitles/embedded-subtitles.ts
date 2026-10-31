import type { ConfirmedVideoDataSubtitleTrack } from '@project/common';
import type { FfmpegSession } from '@project/ffmpeg';
import { probeSubtitleTracks } from '@project/common/media-probe/subtitle-probe';
import type { EmbeddedSubtitleTrack } from '@project/common/media-probe/subtitle-probe';
import type { FileWithId } from '@project/common/file-selector';
import { asbTrace } from '@project/common/util/log';

export const plainSrtMimeType = 'text/x-asbplayer-plain-srt';
export const pgsMimeType = 'application/x-pgs';
export interface EmbeddedSubtitleDescriptor {
    videoId: string;
    fingerprint: { name: string; size: number; lastModified: number };
    streamIndex: number;
    codec: string;
    format: 'srt' | 'sup';
    timelineOffsetMs?: number;
}
export interface SubtitleHost {
    createSession(options: { signal: AbortSignal }): FfmpegSession;
}
export const subtitleSourceMatches = (source: FileWithId, descriptor: EmbeddedSubtitleDescriptor) =>
    source.id === descriptor.videoId &&
    source.file.name === descriptor.fingerprint.name &&
    source.file.size === descriptor.fingerprint.size &&
    source.file.lastModified === descriptor.fingerprint.lastModified;
export const embeddedSubtitleId = (videoId: string, streamIndex: number) => `embedded:${videoId}:${streamIndex}`;
export const embeddedDescriptor = (source: FileWithId, track: EmbeddedSubtitleTrack): EmbeddedSubtitleDescriptor => ({
    videoId: source.id,
    fingerprint: { name: source.file.name, size: source.file.size, lastModified: source.file.lastModified },
    streamIndex: track.streamIndex,
    codec: track.codec,
    format: track.outputFormat ?? 'srt',
});

/** Catalogs and immutable output Files outlive the short-lived, separately owned subtitle workers. */
export class EmbeddedSubtitles {
    private readonly catalogs = new Map<File, EmbeddedSubtitleTrack[]>();
    private readonly outputs = new Map<File, Map<number, FileWithId>>();
    private readonly probes = new Map<File, Promise<EmbeddedSubtitleTrack[]>>();
    private owner = new AbortController();
    private queue: Promise<unknown> = Promise.resolve();
    constructor(private readonly host: SubtitleHost) {}

    cancel() {
        this.owner.abort();
        this.owner = new AbortController();
        this.probes.clear();
    }

    retain(sources: FileWithId[]) {
        const files = new Set(sources.map((source) => source.file));
        for (const file of this.catalogs.keys()) if (!files.has(file)) this.catalogs.delete(file);
        for (const file of this.outputs.keys()) if (!files.has(file)) this.outputs.delete(file);
    }

    private run<T>(
        operation: (runtime: Awaited<ReturnType<FfmpegSession['load']>>, signal: AbortSignal) => Promise<T>
    ) {
        const signal = this.owner.signal;
        const result = this.queue
            .catch(() => {})
            .then(async () => {
                signal.throwIfAborted();
                const session = this.host.createSession({ signal });
                try {
                    const runtime = await session.load({ signal });
                    signal.throwIfAborted();
                    const value = await operation(runtime, signal);
                    signal.throwIfAborted();
                    return value;
                } finally {
                    session.dispose();
                }
            });
        this.queue = result;
        return result;
    }

    async discover(source: FileWithId): Promise<EmbeddedSubtitleTrack[]> {
        const cached = this.catalogs.get(source.file);
        if (cached !== undefined) return cached;
        const pending = this.probes.get(source.file);
        if (pending) return pending;
        const { signal } = this.owner;
        const job = probeSubtitleTracks(source.file, signal).then((tracks) => {
            signal.throwIfAborted();
            this.catalogs.set(source.file, tracks);
            return tracks;
        });
        this.probes.set(source.file, job);
        try {
            return await job;
        } finally {
            if (this.probes.get(source.file) === job) this.probes.delete(source.file);
        }
    }

    async extract(source: FileWithId, descriptors: EmbeddedSubtitleDescriptor[]): Promise<Map<string, FileWithId>> {
        if (descriptors.length === 0) return new Map();
        const signal = this.owner.signal;
        if (descriptors.some((d) => !subtitleSourceMatches(source, d) || (d.format !== 'srt' && d.format !== 'sup')))
            throw new Error('The embedded subtitle source has changed');
        const tracks = await this.discover(source);
        signal.throwIfAborted();
        for (const descriptor of descriptors) {
            if (
                !tracks.some(
                    (track) =>
                        track.streamIndex === descriptor.streamIndex &&
                        track.outputFormat === descriptor.format &&
                        track.codec === descriptor.codec
                )
            )
                throw new Error('The embedded subtitle track is unavailable');
        }
        const previous = this.outputs.get(source.file);
        const cached =
            previous && [...previous.values()].every((file) => file.embedded?.videoId === source.id)
                ? previous
                : new Map<number, FileWithId>();
        const indexes = [...new Set(descriptors.map((d) => d.streamIndex))];
        const missing = indexes.filter((index) => !cached.has(index));
        if (missing.length > 0) {
            const completed = await this.run(async (runtime, signal) => {
                const started = performance.now();
                asbTrace('app/subtitles', 'Starting embedded subtitle extraction', {
                    inputBytes: source.file.size,
                    streamIndexes: missing,
                });
                const chunks = new Map(missing.map((index) => [index, [] as Blob[]]));
                const results = await runtime.extractSubtitles({
                    input: source.file,
                    streamIndexes: missing,
                    signal,
                    onChunk: (index, chunk) => {
                        signal.throwIfAborted();
                        const parts = chunks.get(index);
                        if (!parts) throw new Error('Unexpected embedded subtitle stream');
                        parts.push(new Blob([chunk]));
                    },
                });
                signal.throwIfAborted();
                asbTrace('app/subtitles', 'Finished embedded subtitle extraction', {
                    durationMs: Math.round(performance.now() - started),
                    trackCount: results.length,
                    outputBytes: [...chunks.values()].flat().reduce((total, chunk) => total + chunk.size, 0),
                });
                return results.map((result): FileWithId => {
                    const descriptor = descriptors.find((d) => d.streamIndex === result.streamIndex)!;
                    if (!descriptor || result.extension !== descriptor.format)
                        throw new Error('Unexpected subtitle output format');
                    const subtitleIndex = tracks.findIndex((track) => track.streamIndex === result.streamIndex);
                    const language = tracks[subtitleIndex].language;
                    const base = source.file.name.replace(/\.[^.]+$/, '');
                    const suffix = language?.replace(/[^\p{L}\p{N}_-]/gu, '').slice(0, 30);
                    return {
                        id: embeddedSubtitleId(source.id, result.streamIndex),
                        embedded:
                            result.extension === 'sup'
                                ? { ...descriptor, timelineOffsetMs: result.timelineOffsetMs }
                                : descriptor,
                        file: new File(
                            chunks.get(result.streamIndex)!,
                            `${base}${suffix ? '.' + suffix : ''}.track-${subtitleIndex + 1}.${result.extension}`,
                            { type: result.mimeType }
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
    service: EmbeddedSubtitles | undefined,
    signal: AbortSignal,
    fetcher: typeof fetch = (...args) => fetch(...args)
): Promise<FileWithId[]> => {
    signal.throwIfAborted();
    if (tracks.some((track) => track.disabledReason)) throw new Error('Unsupported subtitle selection');
    const descriptors = tracks.flatMap((track) => (track.embedded ? [track.embedded] : []));
    if (descriptors.length > 0 && (!source || !service)) throw new Error('Missing embedded subtitle source');
    const abort = () => service?.cancel();
    if (descriptors.length > 0) signal.addEventListener('abort', abort, { once: true });
    let extracted: Map<string, FileWithId>;
    try {
        signal.throwIfAborted();
        extracted = descriptors.length > 0 ? await service!.extract(source!, descriptors) : new Map();
    } finally {
        signal.removeEventListener('abort', abort);
    }
    const downloaded = new Map<string, FileWithId>();
    const files: FileWithId[] = [];
    for (const track of tracks) {
        signal.throwIfAborted();
        if (track.embedded) {
            const file = extracted.get(track.id);
            if (!file) throw new Error('Unresolved embedded subtitle');
            files.push(file);
        } else if (track.id === '-') files.push({ id: '-', file: new File([''], '.srt') });
        else if (track.file) files.push({ id: track.id, file: track.file });
        else {
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
