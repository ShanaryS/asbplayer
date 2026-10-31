/** @jest-environment node */
import { parseDisplaySets, SegmentType } from '@project/common/pgs-parser';
import type { DisplaySet } from '@project/common/pgs-parser';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { makeSup, pgsDisplaySets } = require('../../ffmpeg/scripts/pgs-test-data.cjs');
const imageSup = (): Buffer => makeSup(pgsDisplaySets);
const parse = async (bytes: Uint8Array) => {
    const sets: DisplaySet[] = [];
    await new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(bytes);
            controller.close();
        },
    })
        .pipeThrough(parseDisplaySets())
        .pipeTo(
            new WritableStream({
                write: (set) => {
                    sets.push(set);
                },
            })
        );
    return sets;
};

it('keeps earlier images renderable after later palette updates and epoch resets', async () => {
    const sets = await parse(imageSup());
    expect(sets).toHaveLength(5);
    expect(sets[0].presentationCompositionSegment.compositionObjects).toHaveLength(2);
    expect([...sets[0].imageBuffer()!.data.subarray(0, 4)]).toEqual([255, 255, 255, 255]);
    expect([...sets[1].imageBuffer()!.data.subarray(0, 4)]).toEqual([0, 0, 0, 255]);
    expect(sets[3].imageBuffer()).toBeUndefined();
    expect([...sets[4].imageBuffer()!.data]).toEqual([255, 255, 255, 255]);
});

it('retains resource-only preroll for the first composition without emitting a phantom display', async () => {
    const bytes = imageSup();
    const segments: Buffer[] = [];
    for (let offset = 0; offset < bytes.length; ) {
        const length = 13 + bytes.readUInt16BE(offset + 11);
        const segment = Buffer.from(bytes.subarray(offset, offset + length));
        segments.push(segment);
        offset += length;
        if (segment[10] === SegmentType.end) break;
    }
    const pcs = segments.find((segment) => segment[10] === SegmentType.pcs)!;
    pcs[13 + 7] = 0; // Normal composition uses the resources loaded by preroll.
    const resources = segments.filter((segment) => segment[10] !== SegmentType.pcs && segment[10] !== SegmentType.end);
    const end = segments[segments.length - 1];
    const sets = await parse(Buffer.concat([...resources, end, pcs, end]));
    expect(sets).toHaveLength(1);
    const image = sets[0].imageBuffer()!;
    expect([image.width, image.height]).toEqual([5, 2]);
    expect([...image.data.subarray(0, 4)]).toEqual([255, 255, 255, 255]);
});

it('accepts middle fragments and a forced-display flag without interpreting it as cropping', async () => {
    const bytes = imageSup();
    const segments: Buffer[] = [];
    let fragmented = false;
    for (let offset = 0; offset < bytes.length; ) {
        const length = 13 + bytes.readUInt16BE(offset + 11);
        const segment = Buffer.from(bytes.subarray(offset, offset + length));
        offset += length;
        if (segment[10] === SegmentType.pcs) segment[13 + 14] = 0x40;
        if (!fragmented && segment[10] === SegmentType.ods && segment[13 + 3] === 0x40) {
            const middle = Buffer.from(segment.subarray(0, 13 + 4 + 2));
            middle.writeUInt16BE(middle.length - 13, 11);
            middle[13 + 3] = 0;
            const last = Buffer.concat([segment.subarray(0, 13 + 4), segment.subarray(13 + 4 + 2)]);
            last.writeUInt16BE(last.length - 13, 11);
            segments.push(middle, last);
            fragmented = true;
        } else segments.push(segment);
        if (segment[10] === SegmentType.end) break;
    }
    const sets = await parse(Buffer.concat(segments));
    expect(sets).toHaveLength(1);
    expect([...sets[0].imageBuffer()!.data.subarray(0, 4)]).toEqual([255, 255, 255, 255]);
});

it('bounds fragment metadata even when a stream supplies empty continuation fragments', async () => {
    const bytes = imageSup();
    const prefix: Buffer[] = [];
    let middle: Buffer | undefined;
    for (let offset = 0; offset < bytes.length; ) {
        const length = 13 + bytes.readUInt16BE(offset + 11);
        const segment = Buffer.from(bytes.subarray(offset, offset + length));
        prefix.push(segment);
        offset += length;
        if (segment[10] === SegmentType.ods) {
            middle = Buffer.from(segment.subarray(0, 13 + 4));
            middle.writeUInt16BE(4, 11);
            middle[13 + 3] = 0;
            break;
        }
    }
    const end = Buffer.alloc(13);
    end.write('PG');
    end[10] = SegmentType.end;
    const malformed = Buffer.concat([...prefix, ...Array<Buffer>(4096).fill(middle!), end]);
    await expect(parse(malformed)).rejects.toThrow('object cache exceeds the memory limit');
});
