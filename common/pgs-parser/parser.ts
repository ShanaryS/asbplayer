import type { BufferAdapter } from '@project/common/pgs-parser/buffer';
import { BufferReader, CompositeBuffer, CompositeBufferReader } from '@project/common/pgs-parser/buffer';
import type {
    ObjectDefinitionSegment,
    PaletteDefinitionSegment,
    PaletteEntry,
    PresentationCompositionSegment,
    Segment,
    SegmentHeader,
    WindowDefinitionSegment,
    WindowDefinition,
    CompositionObject,
} from '@project/common/pgs-parser/segment';
import {
    CompositionState,
    compositionStateFromByte,
    LastInSequenceFlag,
    lastInSequenceFlagFromByte,
    objectCroppedFlagFromByte,
    paletteUpdateFlagFromByte,
    SegmentType,
    segmentTypeFromByte,
} from '@project/common/pgs-parser/segment';

const pgMagicNumber = 20551; // 0x5047
const maximumCacheBytes = 64 * 1024 * 1024;
function validateDimensions(width: number, height: number) {
    if (width < 1 || height < 1 || width > 4096 || height > 2160)
        throw new Error('Invalid PGS: image dimensions exceed the supported limit');
}

export function parseDisplaySets(): TransformStream<Uint8Array, DisplaySet> {
    const parser = new DisplaySetParser();
    const accumulatedBuffer = new CompositeBufferReader();
    let requestedBytes = 13;

    return new TransformStream({
        transform(chunk, controller) {
            accumulatedBuffer.add(chunk);

            while (accumulatedBuffer.length >= requestedBytes) {
                requestedBytes = parser.consume(accumulatedBuffer.read(requestedBytes));

                if (parser.ready) {
                    controller.enqueue(parser.next());
                }
            }
        },
        flush(controller) {
            if (accumulatedBuffer.length !== 0 || parser.awaitingPayload)
                throw new Error('Invalid PGS: truncated SUP file');
            parser.finish();
            if (parser.ready) {
                controller.enqueue(parser.next());
            }
        },
    });
}

function rleDecode(
    encodedBuffer: BufferAdapter,
    width: number,
    height: number,
    callback: (x: number, y: number, color: number) => void
) {
    let encodedIndex = 0;
    let decodedLineIndex = 0;
    let currentLine = 0;
    const encodedLength = encodedBuffer.length;

    while (encodedIndex < encodedLength) {
        const firstByte = encodedBuffer.at(encodedIndex);
        let runLength;
        let color;
        let increment;

        // Deal with each possible code
        if (firstByte > 0) {
            // CCCCCCCC	- One pixel in color C
            color = firstByte;
            runLength = 1;
            increment = 1;
        } else {
            const secondByte = encodedBuffer.at(encodedIndex + 1);

            if (secondByte === 0) {
                // 00000000 00000000 - End of line
                color = 0;
                runLength = 0;
                increment = 2;
                decodedLineIndex = 0;
                if (++currentLine > height) throw new Error('Invalid PGS: too many bitmap rows');
            } else if (secondByte < 64) {
                // 00000000 00LLLLLL - L pixels in color 0 (L between 1 and 63)
                color = 0;
                runLength = secondByte;
                increment = 2;
            } else if (secondByte < 128) {
                // 00000000 01LLLLLL LLLLLLLL - L pixels in color 0 (L between 64 and 16383)
                const thirdByte = encodedBuffer.at(encodedIndex + 2);
                color = 0;
                runLength = ((secondByte - 64) << 8) + thirdByte;
                increment = 3;
            } else if (secondByte < 192) {
                // 00000000 10LLLLLL CCCCCCCC - L pixels in color C (L between 3 and 63)
                const thirdByte = encodedBuffer.at(encodedIndex + 2);
                color = thirdByte;
                runLength = secondByte - 128;
                increment = 3;
            } else {
                // 00000000 11LLLLLL LLLLLLLL CCCCCCCC - L pixels in color C (L between 64 and 16383)
                const thirdByte = encodedBuffer.at(encodedIndex + 2);
                const fourthByte = encodedBuffer.at(encodedIndex + 3);
                color = fourthByte;
                runLength = ((secondByte - 192) << 8) + thirdByte;
                increment = 4;
            }
        }

        if (runLength === 0 && increment !== 2) throw new Error('Invalid PGS: empty run');
        if (runLength > 0) {
            if (currentLine >= height || decodedLineIndex + runLength > width)
                throw new Error('Invalid PGS: run exceeds bitmap dimensions');
            for (let x = decodedLineIndex; x < decodedLineIndex + runLength; ++x) {
                callback(x, currentLine, color);
            }

            decodedLineIndex += runLength;
        }

        encodedIndex += increment;
    }
    if (currentLine !== height && !(currentLine === height - 1 && decodedLineIndex === width))
        throw new Error('Invalid PGS: incomplete bitmap');
}

// A flat snapshot replaces previousDisplaySet chains. Old display sets keep their own
// resources while the parser only retains the current object/palette/window cache.
class DisplayResources {
    readonly palettes: Map<number, PaletteDefinitionSegment>;
    readonly objects: Map<number, ObjectDefinitionSegment[]>;
    readonly windows: Map<number, WindowDefinition>;

    constructor(previous?: DisplayResources) {
        this.palettes = new Map(previous?.palettes);
        this.objects = new Map(previous?.objects);
        this.windows = new Map(previous?.windows);
    }

    update(
        windows: WindowDefinitionSegment[],
        palettes: PaletteDefinitionSegment[],
        objects: ObjectDefinitionSegment[]
    ) {
        for (const wds of windows)
            for (const window of wds.windowDefinitions) this.windows.set(window.windowId, window);
        for (const pds of palettes) {
            const entries = new Map(
                this.palettes.get(pds.paletteId)?.paletteEntries.map((entry) => [entry.paletteEntryId, entry])
            );
            for (const entry of pds.paletteEntries) entries.set(entry.paletteEntryId, entry);
            this.palettes.set(pds.paletteId, { ...pds, paletteEntries: [...entries.values()] });
        }
        for (const ods of objects) {
            const first = (ods.lastInSequenceFlag & 0x80) !== 0;
            const previous = this.objects.get(ods.objectId);
            if (
                !first &&
                (!previous ||
                    previous[0].objectVersionNumber !== ods.objectVersionNumber ||
                    previous[previous.length - 1].lastInSequenceFlag & 0x40)
            )
                throw new Error('Invalid PGS: missing object fragment');
            const fragments = first ? [ods] : [...previous!, ods];
            if (fragments.length > 4096) throw new Error('Invalid PGS: object cache exceeds the memory limit');
            const length = fragments.reduce((sum, fragment) => sum + fragment.objectData.length, 0);
            const expected = fragments[0].objectDataLength - 4;
            if (length > expected) throw new Error('Invalid PGS: object data exceeds its declared size');
            if (ods.lastInSequenceFlag & 0x40 && length !== expected) throw new Error('Invalid PGS: incomplete object');
            this.objects.set(ods.objectId, fragments);
        }
        const bytes = [...this.objects.values()].reduce(
            (sum, fragments) => sum + fragments.reduce((size, ods) => size + ods.objectData.length, 0),
            0
        );
        if (bytes > maximumCacheBytes || this.objects.size > 256)
            throw new Error('Invalid PGS: object cache exceeds the memory limit');
    }

    finish() {
        if (
            [...this.objects.values()].some((fragments) => !(fragments[fragments.length - 1].lastInSequenceFlag & 0x40))
        )
            throw new Error('Invalid PGS: incomplete display set');
    }
}

export class DisplaySet {
    readonly presentationCompositionSegment: PresentationCompositionSegment;
    readonly windowDefinitionSegments: WindowDefinitionSegment[];
    readonly paletteDefinitionSegments: PaletteDefinitionSegment[];
    readonly objectDefinitionSegments: ObjectDefinitionSegment[];
    readonly endDefinitionSegment: Segment;
    private readonly resources: DisplayResources;

    constructor(
        presentationCompositionSegment: PresentationCompositionSegment,
        windowDefinitionSegments: WindowDefinitionSegment[],
        paletteDefinitionSegments: PaletteDefinitionSegment[],
        objectDefinitionSegments: ObjectDefinitionSegment[],
        endDefinitionSegment: Segment,
        resources?: DisplayResources
    ) {
        this.presentationCompositionSegment = presentationCompositionSegment;
        this.windowDefinitionSegments = windowDefinitionSegments;
        this.paletteDefinitionSegments = paletteDefinitionSegments;
        this.objectDefinitionSegments = objectDefinitionSegments;
        this.endDefinitionSegment = endDefinitionSegment;
        this.resources = resources ?? new DisplayResources();
        if (!resources)
            this.resources.update(windowDefinitionSegments, paletteDefinitionSegments, objectDefinitionSegments);
    }

    get firstOds() {
        return this.objectDefinitionSegments.find(
            (ods) =>
                ods.lastInSequenceFlag === LastInSequenceFlag.firstInSequence ||
                ods.lastInSequenceFlag === LastInSequenceFlag.firstAndLastInSequence
        );
    }

    protected paletteDefinitionSegment(paletteId: number): PaletteDefinitionSegment | undefined {
        return this.resources.palettes.get(paletteId);
    }

    // Returns pixel data without depending on a browser ImageData constructor.
    imageBuffer(buffer?: Uint8ClampedArray): { data: Uint8ClampedArray; width: number; height: number } | undefined {
        const pcs = this.presentationCompositionSegment;
        if (pcs.compositionObjects.length === 0) return;
        const pds = this.paletteDefinitionSegment(pcs.paletteId);
        if (!pds) throw new Error('Invalid PGS: missing palette');
        const rgbaPalette = new Map(
            pds.paletteEntries.map((palette) => [palette.paletteEntryId, this.ycrcbToRgba(palette)])
        );
        const rectangles = pcs.compositionObjects.flatMap((object) => {
            const fragments = this.resources.objects.get(object.objectId);
            const firstOds = fragments?.[0];
            if (
                !fragments ||
                !firstOds?.width ||
                !firstOds.height ||
                !(fragments[fragments.length - 1].lastInSequenceFlag & 0x40)
            )
                throw new Error('Invalid PGS: missing image object');
            const cropX = object.objectCroppedFlag ? object.objectCroppingHorizontalPosition : 0;
            const cropY = object.objectCroppedFlag ? object.objectCroppingVerticalPosition : 0;
            const cropWidth = object.objectCroppedFlag ? object.objectCroppingWidth : firstOds.width;
            const cropHeight = object.objectCroppedFlag ? object.objectCroppingHeightPosition : firstOds.height;
            if (cropX + cropWidth > firstOds.width || cropY + cropHeight > firstOds.height)
                throw new Error('Invalid PGS: crop exceeds image dimensions');
            const window = this.resources.windows.get(object.windowId);
            const x = Math.max(object.objectHorizontalPosition, window?.windowHorizontalPosition ?? 0);
            const y = Math.max(object.objectVerticalPosition, window?.windowVerticalPosition ?? 0);
            const right = Math.min(
                object.objectHorizontalPosition + cropWidth,
                pcs.width,
                window ? window.windowHorizontalPosition + window.windowWidth : pcs.width
            );
            const bottom = Math.min(
                object.objectVerticalPosition + cropHeight,
                pcs.height,
                window ? window.windowVerticalPosition + window.windowHeight : pcs.height
            );
            return right > x && bottom > y ? [{ object, fragments, firstOds, cropX, cropY, x, y, right, bottom }] : [];
        });
        if (!rectangles.length) return;
        const left = Math.min(...rectangles.map((rect) => rect.x));
        const top = Math.min(...rectangles.map((rect) => rect.y));
        const width = Math.max(...rectangles.map((rect) => rect.right)) - left;
        const height = Math.max(...rectangles.map((rect) => rect.bottom)) - top;
        const length = width * height * 4;
        const imageDataArray =
            buffer && buffer.length >= length ? buffer.subarray(0, length) : new Uint8ClampedArray(length);
        imageDataArray.fill(0);
        let visible = false;
        for (const rect of rectangles) {
            rleDecode(
                new CompositeBuffer(rect.fragments.map((ods) => ods.objectData)),
                rect.firstOds.width!,
                rect.firstOds.height!,
                (x, y, paletteIndex) => {
                    const destX = x - rect.cropX + rect.object.objectHorizontalPosition;
                    const destY = y - rect.cropY + rect.object.objectVerticalPosition;
                    if (destX < rect.x || destX >= rect.right || destY < rect.y || destY >= rect.bottom) return;
                    const color = rgbaPalette.get(paletteIndex);
                    if (!color?.a) return;
                    const position = ((destY - top) * width + destX - left) * 4;
                    const sourceAlpha = color.a / 255;
                    const destinationAlpha = imageDataArray[position + 3] / 255;
                    const alpha = sourceAlpha + destinationAlpha * (1 - sourceAlpha);
                    for (const [channel, value] of [color.r, color.g, color.b].entries())
                        imageDataArray[position + channel] =
                            (value * sourceAlpha +
                                imageDataArray[position + channel] * destinationAlpha * (1 - sourceAlpha)) /
                            alpha;
                    imageDataArray[position + 3] = alpha * 255;
                    visible = true;
                }
            );
        }
        return visible ? { data: imageDataArray, width, height } : undefined;
    }

    imageData(buffer?: Uint8ClampedArray) {
        const image = this.imageBuffer(buffer);
        return image ? new ImageData(image.data, image.width, image.height) : undefined;
    }

    private ycrcbToRgba(palette: PaletteEntry) {
        const y = 1.164383 * (palette.luminance - 16);
        const cb = palette.colorDifferenceBlue - 128;
        const cr = palette.colorDifferenceRed - 128;
        const hd = this.presentationCompositionSegment.height > 576;
        const r = this.clamp(Math.round(y + (hd ? 1.792741 : 1.596027) * cr), 0, 255);
        const g = this.clamp(Math.round(y - (hd ? 0.213249 : 0.391762) * cb - (hd ? 0.532909 : 0.812968) * cr), 0, 255);
        const b = this.clamp(Math.round(y + (hd ? 2.112402 : 2.017232) * cb), 0, 255);
        return { r, g, b, a: palette.transparency };
    }

    private clamp(number: number, min: number, max: number) {
        return Math.max(min, Math.min(max, number));
    }
}

class DisplaySetParser {
    private header: SegmentHeader | undefined;
    private timestamp: number | undefined;
    private lastDisplaySet: DisplaySet | undefined;
    private resources = new DisplayResources();
    private pendingBytes = 0;

    get awaitingPayload() {
        return this.header !== undefined;
    }

    finish() {
        if (this.presentationCompositionSegment || this.pendingBytes)
            throw new Error('Invalid PGS: incomplete display set');
        this.resources.finish();
    }
    private presentationCompositionSegment: PresentationCompositionSegment | undefined;
    private windowDefinitionSegments: WindowDefinitionSegment[] = [];
    private paletteDefinitionSegments: PaletteDefinitionSegment[] = [];
    private objectDefinitionSegments: ObjectDefinitionSegment[] = [];

    ready: boolean = false;

    next() {
        this.ready = false;
        return this.lastDisplaySet!;
    }

    consume(buffer: BufferAdapter) {
        const reader = new BufferReader(buffer);

        if (this.header) {
            this.pendingBytes += this.header.segmentSize + 13;
            if (this.pendingBytes > maximumCacheBytes)
                throw new Error('Invalid PGS: display set exceeds the memory limit');
            switch (this.header.segmentType) {
                case SegmentType.pcs:
                    if (this.presentationCompositionSegment !== undefined) {
                        throw new Error(`Invalid PGS: composition without an END segment`);
                    }

                    this.presentationCompositionSegment = parsePcsSegment(reader, this.header);
                    if (this.presentationCompositionSegment.compositionState !== CompositionState.normal)
                        this.resources = new DisplayResources();
                    break;
                case SegmentType.wds:
                    this.windowDefinitionSegments.push(parseWdsSegment(reader, this.header));
                    break;
                case SegmentType.pds:
                    this.paletteDefinitionSegments.push(parsePdsSegment(reader, this.header));
                    break;
                case SegmentType.ods: {
                    const ods = parseOdsSegment(reader, this.header);
                    this.objectDefinitionSegments.push(ods);
                    break;
                }
                case SegmentType.end: {
                    const resources = new DisplayResources(this.resources);
                    resources.update(
                        this.windowDefinitionSegments,
                        this.paletteDefinitionSegments,
                        this.objectDefinitionSegments
                    );
                    this.resources = resources;
                    if (this.presentationCompositionSegment) {
                        this.lastDisplaySet = new DisplaySet(
                            this.presentationCompositionSegment,
                            this.windowDefinitionSegments,
                            this.paletteDefinitionSegments,
                            this.objectDefinitionSegments,
                            { header: this.header },
                            resources
                        );
                        this.ready = true;
                    }
                    this.presentationCompositionSegment = undefined;
                    this.windowDefinitionSegments = [];
                    this.paletteDefinitionSegments = [];
                    this.objectDefinitionSegments = [];
                    this.pendingBytes = 0;
                    break;
                }
                default:
                    throw new Error(`Unknown segment type: ${this.header.segmentType}`);
            }

            if (reader.hasNext) throw new Error('Invalid PGS: unexpected segment data');
            this.header = undefined;
            return 13;
        } else {
            const magicNumber = reader.readHex(2);

            if (magicNumber !== pgMagicNumber) {
                throw new Error('Invalid PGS: missing SUP header');
            }

            let presentationTimestamp = reader.readHex(4);
            // Advance the clock on every segment, including resource-only preroll.
            // Looking only at PCS timestamps can miss a wrap during a long quiet interval.
            const wrap = 2 ** 32;
            if (this.timestamp !== undefined) {
                presentationTimestamp += Math.floor(this.timestamp / wrap) * wrap;
                if (presentationTimestamp - this.timestamp > wrap / 2) presentationTimestamp -= wrap;
                else if (this.timestamp - presentationTimestamp > wrap / 2) presentationTimestamp += wrap;
            }
            this.timestamp = presentationTimestamp;
            const decodingTimestamp = reader.readHex(4);
            const segmentType = segmentTypeFromByte(reader.readHex(1));
            const segmentSize = reader.readHex(2);
            this.header = { presentationTimestamp, decodingTimestamp, segmentType, segmentSize };
            return segmentSize;
        }
    }
}

function parsePcsSegment(reader: BufferReader, header: SegmentHeader): PresentationCompositionSegment {
    const limit = reader.index + header.segmentSize;
    const width = reader.readHex(2, limit);
    const height = reader.readHex(2, limit);
    validateDimensions(width, height);
    reader.readHex(1); // ignore frame rate
    const compositionNumber = reader.readHex(2, limit);
    const compositionState = compositionStateFromByte(reader.readHex(1, limit));
    const paletteUpdateFlag = paletteUpdateFlagFromByte(reader.readHex(1, limit));
    const paletteId = reader.readHex(1, limit);
    const compositionObjectCount = reader.readHex(1, limit);
    const compositionObjects: CompositionObject[] = [];
    for (let i = 0; i < compositionObjectCount; ++i) {
        const objectId = reader.readHex(2, limit);
        const windowId = reader.readHex(1, limit);
        const objectCroppedFlag = objectCroppedFlagFromByte(reader.readHex(1, limit));
        const objectHorizontalPosition = reader.readHex(2, limit);
        const objectVerticalPosition = reader.readHex(2, limit);
        const objectCroppingHorizontalPosition = objectCroppedFlag ? reader.readHex(2, limit) : 0;
        const objectCroppingVerticalPosition = objectCroppedFlag ? reader.readHex(2, limit) : 0;
        const objectCroppingWidth = objectCroppedFlag ? reader.readHex(2, limit) : 0;
        const objectCroppingHeightPosition = objectCroppedFlag ? reader.readHex(2, limit) : 0;
        compositionObjects.push({
            objectId,
            windowId,
            objectCroppedFlag,
            objectHorizontalPosition,
            objectVerticalPosition,
            objectCroppingHorizontalPosition,
            objectCroppingVerticalPosition,
            objectCroppingWidth,
            objectCroppingHeightPosition,
        });
    }
    return {
        header,
        width,
        height,
        compositionNumber,
        compositionState,
        paletteUpdateFlag,
        paletteId,
        compositionObjectCount,
        compositionObjects,
    };
}

function parseWdsSegment(reader: BufferReader, header: SegmentHeader): WindowDefinitionSegment {
    const limit = reader.index + header.segmentSize;
    const windowCount = reader.readHex(1, limit);
    const windowDefinitions = [];

    for (let i = 0; i < windowCount; ++i) {
        const windowId = reader.readHex(1, limit);
        const windowHorizontalPosition = reader.readHex(2, limit);
        const windowVerticalPosition = reader.readHex(2, limit);
        const windowWidth = reader.readHex(2, limit);
        const windowHeight = reader.readHex(2, limit);

        windowDefinitions.push({
            windowId,
            windowHorizontalPosition,
            windowVerticalPosition,
            windowWidth,
            windowHeight,
        });
    }

    return {
        header,
        windowCount,
        windowDefinitions,
    };
}

function parsePdsSegment(reader: BufferReader, header: SegmentHeader): PaletteDefinitionSegment {
    const limit = reader.index + header.segmentSize;
    const paletteId = reader.readHex(1, limit);
    const paletteVersionNumber = reader.readHex(1, limit);
    const paletteEntries: PaletteEntry[] = [];

    while (reader.index < limit) {
        const paletteEntryId = reader.readHex(1, limit);
        const luminance = reader.readHex(1, limit);
        const colorDifferenceRed = reader.readHex(1, limit);
        const colorDifferenceBlue = reader.readHex(1, limit);
        const transparency = reader.readHex(1, limit);
        paletteEntries.push({ paletteEntryId, luminance, colorDifferenceRed, colorDifferenceBlue, transparency });
    }

    return {
        header,
        paletteId,
        paletteVersionNumber,
        paletteEntries,
    };
}

function parseOdsSegment(reader: BufferReader, header: SegmentHeader): ObjectDefinitionSegment {
    const objectId = reader.readHex(2);
    const objectVersionNumber = reader.readHex(1);
    const lastInSequenceFlag = lastInSequenceFlagFromByte(reader.readHex(1));
    let objectDataLength = 0;
    let width: number | undefined;
    let height: number | undefined;
    let objectData: BufferAdapter;

    if (
        lastInSequenceFlag === LastInSequenceFlag.firstInSequence ||
        lastInSequenceFlag === LastInSequenceFlag.firstAndLastInSequence
    ) {
        objectDataLength = reader.readHex(3);
        width = reader.readHex(2);
        height = reader.readHex(2);
        validateDimensions(width, height);
        if (objectDataLength < 4) throw new Error('Invalid PGS: invalid object data length');
        objectData = reader.readBuffer(header.segmentSize - reader.index);
    } else {
        objectData = reader.readBuffer(header.segmentSize - reader.index);
    }

    return {
        header,
        objectId,
        objectVersionNumber,
        lastInSequenceFlag,
        objectDataLength,
        width,
        height,
        objectData: objectData,
    };
}
