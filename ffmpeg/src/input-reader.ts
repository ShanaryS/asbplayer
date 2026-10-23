// The package also compiles with DOM types for its main-thread session API.
// Declare this worker-only boundary without adding conflicting DOM/WebWorker libraries.
declare const FileReaderSync: { new (): { readAsArrayBuffer(blob: Blob): ArrayBuffer } };

export type InputReader = {
    readonly size: number;
    /** Return at most length bytes; reads at or beyond EOF return an empty array. */
    readAt(offset: number, length: number): Uint8Array;
};

/** Seekable, bounded input for the dedicated worker. Native FFmpeg I/O is added with each media operation. */
export const createInputReader = (
    input: Blob,
    {
        maximumReadBytes = 64 * 1024,
        readAheadBytes = 4 * 1024 * 1024,
        readSlice = (slice: Blob) => new FileReaderSync().readAsArrayBuffer(slice),
    }: {
        maximumReadBytes?: number;
        /** Bounded browser read-ahead; zero disables prefetching. Independent of native request limits. */
        readAheadBytes?: number;
        readSlice?: (slice: Blob) => ArrayBuffer;
    } = {}
): InputReader => {
    const size = input.size;
    if (!Number.isSafeInteger(size) || size < 0) throw new RangeError('Invalid input size');
    if (!Number.isSafeInteger(maximumReadBytes) || maximumReadBytes <= 0) {
        throw new RangeError('Invalid maximum read size');
    }
    if (!Number.isSafeInteger(readAheadBytes) || readAheadBytes < 0) throw new RangeError('Invalid read-ahead size');
    let cacheOffset = 0;
    let cache = new Uint8Array(0);
    return {
        size,
        readAt(offset, length) {
            if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError('Invalid input offset');
            if (!Number.isSafeInteger(length) || length < 0 || length > maximumReadBytes) {
                throw new RangeError('Invalid input read size');
            }
            if (offset >= size || length === 0) return new Uint8Array();
            const count = Math.min(length, size - offset);
            if (offset < cacheOffset || offset - cacheOffset + count > cache.byteLength) {
                // FileReaderSync crosses the browser's file boundary on each call.
                // Reuse a small window while FFmpeg demuxes or skips video packets.
                const readCount = Math.min(Math.max(count, readAheadBytes), size - offset);
                const bytes = new Uint8Array(readSlice(input.slice(offset, offset + readCount)));
                if (bytes.byteLength !== readCount) {
                    throw new Error('Input read returned an unexpected number of bytes');
                }
                cacheOffset = offset;
                cache = bytes;
            }
            return cache.subarray(offset - cacheOffset, offset - cacheOffset + count);
        },
    };
};
