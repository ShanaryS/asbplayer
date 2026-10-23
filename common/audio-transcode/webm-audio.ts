import ByteReader from '@project/common/media-probe/byte-reader';
import { findEbmlElement } from '@project/common/media-probe/ebml';

const durationMetadata = async (audio: Blob) => {
    const reader = new ByteReader(audio);
    const find = async (id: number, start = 0, end = reader.size) => {
        const element = await findEbmlElement(reader, id, start, end);
        if (element === undefined) throw new Error('Missing WebM initialization metadata');
        return element;
    };
    const segment = await find(0x18538067);
    const info = await find(0x1549a966, segment.dataOffset, segment.end);
    const scale = await find(0x2ad7b1, info.dataOffset, info.end);
    const nanoseconds = (await reader.unsignedInt(scale.dataOffset, scale.dataSize))!;
    const duration = await find(0x4489, info.dataOffset, info.end);
    if (nanoseconds <= 0 || duration.dataSize !== 8) throw new Error('Invalid WebM duration metadata');
    return { reader, nanoseconds, duration };
};

/** Read the exact sample duration patched into our completed WebM, using bounded header reads. */
export const readWebmAudioDuration = async (audio: Blob): Promise<number> => {
    const { reader, nanoseconds, duration } = await durationMetadata(audio);
    const bytes = (await reader.bytes(duration.dataOffset, duration.dataSize))!;
    const seconds = (new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat64(0) * nanoseconds) / 1e9;
    if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('Invalid Opus output duration');
    return seconds;
};

/** Give the completed, unseekable-muxed WebM its exact duration so ordinary audio playback can seek. */
export const finalizeWebmAudio = async (chunks: readonly Blob[], seconds: number): Promise<Blob> => {
    if (chunks.length === 0 || !Number.isFinite(seconds) || seconds <= 0)
        throw new Error('Invalid Opus output duration');
    // The native muxer flushes the complete initialization header before writing any media.
    const { reader, nanoseconds, duration } = await durationMetadata(chunks[0]);
    const bytes = (await reader.bytes(0, reader.size))!;
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setFloat64(
        duration.dataOffset,
        (seconds * 1e9) / nanoseconds
    );
    return new Blob([bytes, ...chunks.slice(1)], { type: chunks[0].type });
};
