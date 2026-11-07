import type { FileWithId } from '@project/common/file-selector';
import type { EmbeddedSubtitleTrack } from '@project/common/media-probe/subtitle-probe';

export const plainSrtMimeType = 'text/x-asbplayer-plain-srt';

export interface EmbeddedSubtitleDescriptor {
    videoId: string;
    fingerprint: { name: string; size: number; lastModified: number };
    streamIndex: number;
    codec: string;
    format: 'srt';
}

export interface SubtitleExtractionOptions {
    file: File;
    fileId: string;
    streamIndexes: number[];
    signal: AbortSignal;
}

export interface ExtractedSubtitleFile {
    streamIndex: number;
    blob: Blob;
    format: 'srt';
}

/** Shared code requests subtitle data; the website supplies the FFmpeg implementation. */
export interface SubtitleHost {
    extractSubtitles(options: SubtitleExtractionOptions): Promise<ExtractedSubtitleFile[]>;
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
