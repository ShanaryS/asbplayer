import { createInputReader } from '@project/ffmpeg';

// Model the synchronous browser file boundary with bytes, without mocking the reader.
class MemoryBlob extends Blob {
    constructor(readonly contents: Uint8Array<ArrayBuffer>) {
        super([contents]);
    }
    override slice(start = 0, end = this.size) {
        return new MemoryBlob(this.contents.slice(start, end));
    }
}
const readSlice = (blob: Blob) => (blob as MemoryBlob).contents.buffer;

it('reads and seeks bounded file slices, including a short EOF read', () => {
    const reader = createInputReader(new MemoryBlob(new Uint8Array([0, 1, 2, 3, 4, 5])), {
        maximumReadBytes: 3,
        readSlice,
    });
    expect(reader.size).toBe(6);
    expect([...reader.readAt(2, 3)]).toEqual([2, 3, 4]);
    expect([...reader.readAt(0, 2)]).toEqual([0, 1]);
    expect([...reader.readAt(5, 3)]).toEqual([5]);
    expect(reader.readAt(6, 3)).toHaveLength(0);
    expect(reader.readAt(100, 3)).toHaveLength(0);
    expect(reader.readAt(1, 0)).toHaveLength(0);
});

it.each([
    [-1, 1],
    [0.5, 1],
    [Number.MAX_SAFE_INTEGER + 1, 1],
    [0, -1],
    [0, 4],
    [0, Infinity],
    [0, 0.5],
])('rejects invalid read bounds (%s, %s) before touching the file', (offset, length) => {
    const read = jest.fn(readSlice);
    const reader = createInputReader(new MemoryBlob(new Uint8Array([1, 2, 3])), {
        maximumReadBytes: 3,
        readSlice: read,
    });
    expect(() => reader.readAt(offset, length)).toThrow(RangeError);
    expect(read).not.toHaveBeenCalled();
});

it('keeps offsets above 4 GiB precise and reads only the requested range', () => {
    const offset = 2 ** 32 + 1;
    const slice = jest.fn(() => new MemoryBlob(new Uint8Array([7, 8, 9])));
    const file = { size: offset + 3, slice } as unknown as Blob;
    const reader = createInputReader(file, { readSlice });
    expect([...reader.readAt(offset, 64 * 1024)]).toEqual([7, 8, 9]);
    expect(slice).toHaveBeenCalledWith(offset, offset + 3);
    expect(() => reader.readAt(0, 64 * 1024 + 1)).toThrow(RangeError);
    expect(slice).toHaveBeenCalledTimes(1);
});

it('rejects an incomplete host file read', () => {
    const reader = createInputReader(new MemoryBlob(new Uint8Array([1, 2, 3])), {
        readSlice: () => new ArrayBuffer(1),
    });
    expect(() => reader.readAt(0, 3)).toThrow('unexpected number of bytes');
});

it('reuses bounded read-ahead across sequential reads and seeks, including EOF', () => {
    const file = new MemoryBlob(Uint8Array.from({ length: 20 }, (_, index) => index));
    const reads: number[] = [];
    const reader = createInputReader(file, {
        maximumReadBytes: 4,
        readAheadBytes: 8,
        readSlice: (slice) => {
            reads.push(slice.size);
            return readSlice(slice);
        },
    });
    const first = reader.readAt(0, 3);
    expect([...first]).toEqual([0, 1, 2]);
    expect([...reader.readAt(3, 4)]).toEqual([3, 4, 5, 6]);
    expect([...reader.readAt(1, 2)]).toEqual([1, 2]);
    expect(reads).toEqual([8]);
    expect([...reader.readAt(7, 4)]).toEqual([7, 8, 9, 10]);
    expect([...reader.readAt(10, 4)]).toEqual([10, 11, 12, 13]);
    expect(reads).toEqual([8, 8]);
    expect([...reader.readAt(2, 4)]).toEqual([2, 3, 4, 5]);
    expect([...reader.readAt(18, 4)]).toEqual([18, 19]);
    expect(reader.readAt(20, 4)).toHaveLength(0);
    expect(reads).toEqual([8, 8, 8, 2]);
    expect([...first]).toEqual([0, 1, 2]);
});

it('keeps read-ahead bounded and accurate when seeking above 4 GiB', () => {
    const start = 2 ** 32 + 1;
    const slices: [number, number][] = [];
    const file = {
        size: start + 40,
        slice: (offset: number, end: number) => {
            slices.push([offset, end]);
            return new MemoryBlob(Uint8Array.from({ length: end - offset }, (_, index) => (offset + index) % 256));
        },
    } as unknown as Blob;
    const reader = createInputReader(file, { readAheadBytes: 16, readSlice });
    expect([...reader.readAt(start, 2)]).toEqual([1, 2]);
    expect([...reader.readAt(start + 3, 2)]).toEqual([4, 5]);
    expect([...reader.readAt(start + 14, 4)]).toEqual([15, 16, 17, 18]);
    expect(slices).toEqual([
        [start, start + 16],
        [start + 14, start + 30],
    ]);
});

it('can disable prefetching for hosts that prefer reads of the requested size', () => {
    const reads: number[] = [];
    const reader = createInputReader(new MemoryBlob(new Uint8Array([0, 1, 2, 3, 4])), {
        readAheadBytes: 0,
        readSlice: (slice) => {
            reads.push(slice.size);
            return readSlice(slice);
        },
    });
    expect([...reader.readAt(0, 2)]).toEqual([0, 1]);
    expect([...reader.readAt(2, 2)]).toEqual([2, 3]);
    expect(reads).toEqual([2, 2]);
});

it.each([-1, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid read-ahead size %s', (readAheadBytes) => {
    expect(() => createInputReader(new Blob(), { readAheadBytes })).toThrow(RangeError);
});

it.each([0, -1, Infinity, 0.5])('rejects invalid maximum read size %s', (maximumReadBytes) => {
    expect(() => createInputReader(new Blob(), { maximumReadBytes })).toThrow(RangeError);
});
