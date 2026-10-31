/** @jest-environment node */
import { decodePgs } from '@project/common/subtitle-reader/pgs-decoder';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { makeSup, pgsDisplaySets, pgsWrapSets } = require('../../ffmpeg/scripts/pgs-test-data.cjs');
const imageSup = (): Buffer => makeSup(pgsDisplaySets);
const stream = (bytes: Uint8Array, chunkSize = 17) =>
    new ReadableStream<Uint8Array>({
        start(controller) {
            for (let p = 0; p < bytes.length; p += chunkSize) controller.enqueue(bytes.subarray(p, p + chunkSize));
            controller.close();
        },
    });
const decode = async (bytes: Uint8Array, chunkSize?: number) => {
    const images = [];
    for await (const image of decodePgs(stream(bytes, chunkSize))) images.push(image);
    return images;
};
it.each([1, 17, 65536])(
    'composes objects, sparse palettes, fragments, updates, crops, clears, and EOF across %s-byte chunks',
    async (size) => {
        const images = await decode(imageSup(), size);
        expect(images.map((image) => [image.start, image.end, image.width, image.height])).toEqual([
            [1000, 2000, 5, 2],
            [2000, 3000, 5, 2],
            [3000, 4000, 1, 2],
            [5000, 10000, 1, 1],
        ]);
        const white = [255, 255, 255, 255],
            black = [0, 0, 0, 255],
            transparent = [0, 0, 0, 0];
        expect([...images[0].pixels]).toEqual([
            ...white,
            ...white,
            ...transparent,
            ...transparent,
            ...black,
            ...transparent,
            ...white,
            ...transparent,
            ...transparent,
            ...transparent,
        ]);
        expect([...images[1].pixels.subarray(0, 4)]).toEqual(black);
        // The partial palette update did not remove the second object's sparse entry.
        expect([...images[1].pixels.subarray(16, 20)]).toEqual(black);
        expect([...images[2].pixels]).toEqual([...black, ...black]);
        expect([...images[3].pixels]).toEqual(white);
        expect(images[0].screen).toEqual({ width: 16, height: 16 });
    }
);
it('unwraps the SUP clock across 2^32 ticks', async () => {
    const images = await decode(makeSup(pgsWrapSets));
    expect(images.map((image) => [image.start, image.end])).toEqual([
        [(2 ** 32 - 90000) / 90, (2 ** 32 + 90000) / 90],
        [(2 ** 32 + 90000) / 90, (2 ** 32 + 180000) / 90],
    ]);
});
it('accepts empty tracks and rejects truncated headers, segments, and unfinished compositions', async () => {
    expect(await decode(new Uint8Array())).toEqual([]);
    const bytes = imageSup();
    await expect(decode(bytes.subarray(0, 8))).rejects.toThrow('truncated SUP');
    await expect(decode(bytes.subarray(0, 15))).rejects.toThrow('truncated SUP');
    await expect(decode(bytes.subarray(0, bytes.length - 13))).rejects.toThrow('incomplete display set');
    const broken = bytes.slice();
    broken[0] = 0;
    await expect(decode(broken)).rejects.toThrow('missing SUP header');
});
it('rejects excessive dimensions before allocating bitmap buffers', async () => {
    const bytes = imageSup().slice();
    bytes[13] = 0xff;
    bytes[14] = 0xff;
    await expect(decode(bytes)).rejects.toThrow('dimensions');
});

it('alpha-composites overlapping objects and respects window clipping', async () => {
    const bytes = imageSup().slice();
    // In the first PCS move the second object over the first; make its black palette entry half opaque.
    bytes.writeUInt16BE(2, 13 + 23);
    for (let position = 0; position < bytes.length; ) {
        const length = bytes.readUInt16BE(position + 11);
        if (bytes[position + 10] === 0x14) {
            bytes[position + 13 + 2 + 2 * 5 + 4] = 128;
            break;
        }
        position += 13 + length;
    }
    const images = await decode(bytes);
    expect([...images[0].pixels.subarray(0, 4)]).toEqual([127, 127, 127, 255]);
    const clipped = imageSup().slice();
    for (let position = 0; position < clipped.length; ) {
        const length = clipped.readUInt16BE(position + 11);
        if (clipped[position + 10] === 0x17) {
            const payload = position + 13;
            clipped.writeUInt16BE(3, payload + 2);
            clipped.writeUInt16BE(10, payload + 4);
            clipped.writeUInt16BE(2, payload + 6);
            clipped.writeUInt16BE(1, payload + 8);
            break;
        }
        position += 13 + length;
    }
    const cropped = await decode(clipped);
    expect([cropped[0].width, cropped[0].height]).toEqual([1, 1]);
    expect([...cropped[0].pixels]).toEqual([255, 255, 255, 255]);
});

it('rejects corrupt run lengths instead of writing beyond an image', async () => {
    const bytes = imageSup().slice();
    for (let position = 0; position < bytes.length; ) {
        const length = bytes.readUInt16BE(position + 11);
        if (bytes[position + 10] === 0x15) {
            const data = position + 13 + 11;
            bytes[data] = 0;
            bytes[data + 1] = 0xff;
            bytes[data + 2] = 0xff;
            break;
        }
        position += 13 + length;
    }
    await expect(decode(bytes)).rejects.toThrow('run exceeds bitmap');
});

it('advances the SUP clock through resource-only display sets between widely separated compositions', async () => {
    const bytes = imageSup();
    const sets: Buffer[][] = [[]];
    for (let position = 0; position < bytes.length; ) {
        const length = 13 + bytes.readUInt16BE(position + 11);
        const segment = Buffer.from(bytes.subarray(position, position + length));
        sets[sets.length - 1].push(segment);
        position += length;
        if (segment[10] === 0x80) sets.push([]);
    }
    const resourceUpdates = [1e9, 2e9, 3e9].map((timestamp) => {
        const end = Buffer.from(sets[0][sets[0].length - 1]);
        end.writeUInt32BE(timestamp, 2);
        return end;
    });
    const clear = sets[3].map((segment) => {
        segment.writeUInt32BE(4e9, 2);
        return segment;
    });
    const images = await decode(Buffer.concat([...sets[0], ...resourceUpdates, ...clear]));
    expect(images.map((image) => [image.start, image.end])).toEqual([[1000, 4e9 / 90]]);
});
