import { readEbmlElement, readEbmlVarInt } from '@project/common/media-probe/ebml';
import type { EbmlElement } from '@project/common/media-probe/ebml';
import type { FileModel } from '@project/common';
import ByteReader from '@project/common/media-probe/byte-reader';
import { createBlobUrl } from '@project/common/blob-url';
import { finalizeWebmAudio, readWebmAudioDuration } from '@project/common/audio-transcode/webm-audio';

export type MiningAudioSource = Pick<FileModel, 'transcodedAudioBlobUrl' | 'transcodedAudioDurationMs'>;

/** Shared across documents; each document gives the immutable audio its own URL. */
export type MiningAudioSnapshot = {
    readonly audio?: Blob;
    readonly durationMs?: number;
};

/** Snapshot the single-track WebM our muxer produces, excluding an unfinished cluster. */
export const snapshotWebmAudio = async (audio: Blob): Promise<{ blob: Blob; durationMs: number } | undefined> => {
    // Only timestamps and element headers are needed; avoid prefetching encoded packet payloads.
    const reader = new ByteReader(audio, 256);
    let offset = 0,
        limit = audio.size,
        scale = 1e6,
        codecDelay = 0;
    let headerEnd = 0,
        snapshotEnd = 0,
        lastCluster: EbmlElement | undefined;
    // Master elements needed for timestamps; skip encoded packet payloads and other metadata.
    const masters = new Set([0x1549a966, 0x1654ae6b, 0xae]);
    const metadata = async (start: number, end: number): Promise<void> => {
        while (start < end) {
            const child = await readEbmlElement(reader, start, end);
            if (child === undefined) throw new Error('Invalid WebM snapshot metadata');
            if (masters.has(child.id)) await metadata(child.dataOffset, child.end);
            else if (child.id === 0x2ad7b1)
                scale = (await reader.unsignedInt(child.dataOffset, child.end - child.dataOffset))!;
            else if (child.id === 0x56aa)
                codecDelay = (await reader.unsignedInt(child.dataOffset, child.end - child.dataOffset))!;
            start = child.end;
        }
    };
    while (offset < limit) {
        const entry = await readEbmlElement(reader, offset, limit);
        if (entry === undefined) break;
        if (entry.id === 0x18538067) {
            offset = entry.dataOffset;
            limit = entry.end;
            continue;
        }
        if (entry.id === 0x1f43b675) {
            // FFmpeg writes finite-sized clusters. An unknown-sized cluster cannot be sealed yet.
            if (entry.unknown) break;
            if (headerEnd === 0) headerEnd = offset;
            lastCluster = entry;
            snapshotEnd = entry.end;
        } else if (masters.has(entry.id)) await metadata(entry.dataOffset, entry.end);
        offset = entry.end;
    }
    if (lastCluster === undefined) return undefined;
    let timestamp = 0,
        lastBlock = -Infinity;
    const blocks = async (start: number, end: number): Promise<void> => {
        while (start < end) {
            const child = await readEbmlElement(reader, start, end);
            if (child === undefined) throw new Error('Invalid WebM snapshot cluster');
            if (child.id === 0xe7)
                timestamp = (await reader.unsignedInt(child.dataOffset, child.end - child.dataOffset))!;
            else if (child.id === 0xa0) await blocks(child.dataOffset, child.end);
            else if (child.id === 0xa3 || child.id === 0xa1) {
                const track = await readEbmlVarInt(reader, child.dataOffset);
                if (track === undefined || child.dataOffset + track.length + 3 > child.end)
                    throw new Error('Invalid WebM snapshot block');
                const bytes = (await reader.bytes(child.dataOffset + track.length, 2))!;
                lastBlock = Math.max(lastBlock, new DataView(bytes.buffer, bytes.byteOffset, 2).getInt16(0));
            }
            start = child.end;
        }
    };
    await blocks(lastCluster.dataOffset, lastCluster.end);
    // Stop at the start of the last complete packet: conservatively leave one Opus frame unused.
    const durationMs = ((timestamp + lastBlock) * scale - codecDelay) / 1e6;
    if (!Number.isFinite(durationMs) || durationMs <= 0) return undefined;
    const blob = await finalizeWebmAudio(
        [audio.slice(0, headerEnd, audio.type), audio.slice(headerEnd, snapshotEnd, audio.type)],
        durationMs / 1000
    );
    return { blob, durationMs };
};

/** Capture one audio boundary for the history card and dialog created by a mining action. */
export const snapshotMiningAudio = async ({
    audio,
    required,
    complete,
}: {
    audio?: Blob;
    required: boolean;
    complete: boolean;
}): Promise<MiningAudioSnapshot> => {
    if (!required) return {};
    if (audio !== undefined && complete) return { audio, durationMs: (await readWebmAudioDuration(audio)) * 1000 };
    const snapshot = audio === undefined ? undefined : await snapshotWebmAudio(audio);
    if (snapshot === undefined) return { durationMs: 0 };
    return { audio: snapshot.blob, durationMs: snapshot.durationMs };
};

/** Each card owns a document-local source URL, independent of the playback MSE URL. */
export const createMiningAudioSource = ({ audio, durationMs }: MiningAudioSnapshot): MiningAudioSource => {
    return {
        ...(audio === undefined ? {} : { transcodedAudioBlobUrl: createBlobUrl(audio) }),
        ...(durationMs === undefined ? {} : { transcodedAudioDurationMs: durationMs }),
    };
};
