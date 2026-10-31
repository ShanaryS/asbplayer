import type ByteReader from '@project/common/media-probe/byte-reader';

const boxSizeBytes = 4;
export const isoBmffBoxTypeOffset = boxSizeBytes;
export const isoBmffBoxTypeBytes = 4;
const boxHeaderBytes = boxSizeBytes + isoBmffBoxTypeBytes;
const extendedSizeBytes = 8;
const extendedSizeMarker = 1;
const extendsToParentEndMarker = 0;
const fullBoxVersionAndFlagsBytes = 4;
const handlerPredefinedBytes = 4;
const sampleEntryCountBytes = 4;

const maxBoxes = 4096; // Guards against walking forever through a file that isn't shaped the way we expect.

interface Box {
    type: string;
    dataOffset: number;
    end: number;
}

const readBox = async (reader: ByteReader, offset: number, limit: number): Promise<Box | undefined> => {
    const size = await reader.unsignedInt(offset, boxSizeBytes);
    const type = await reader.ascii(offset + isoBmffBoxTypeOffset, isoBmffBoxTypeBytes);
    if (size === undefined || type === undefined) return;

    let dataOffset = offset + boxHeaderBytes;
    let end: number;
    if (size === extendedSizeMarker) {
        const largeSize = await reader.unsignedInt(dataOffset, extendedSizeBytes);
        if (largeSize === undefined || largeSize < boxHeaderBytes + extendedSizeBytes) return;
        dataOffset += extendedSizeBytes;
        end = offset + largeSize;
    } else if (size === extendsToParentEndMarker) {
        end = limit; // A zero size means the box runs to the end of the enclosing box.
    } else if (size < boxHeaderBytes) {
        return;
    } else {
        end = offset + size;
    }
    if (!Number.isSafeInteger(end) || dataOffset > end || end > limit) return;

    return { type, dataOffset, end };
};

/**
 * Walks the boxes between offset and limit, handing each to the visitor. The visitor returning a
 * value stops the walk.
 */
const forEachBox = async <T>(
    reader: ByteReader,
    offset: number,
    limit: number,
    visit: (box: Box) => Promise<T | undefined>
): Promise<T | undefined> => {
    let boxes = 0;
    while (offset < limit && ++boxes <= maxBoxes) {
        const box = await readBox(reader, offset, limit);
        if (box === undefined) throw new Error('Invalid MP4 metadata');
        const result = await visit(box);
        if (result !== undefined) return result;
        offset = box.end;
    }
    if (offset < limit) throw new Error('Too many MP4 metadata boxes');
    return;
};

const findBox = (reader: ByteReader, type: string, offset: number, limit: number) =>
    forEachBox(reader, offset, limit, async (box) => (box.type === type ? box : undefined));

const sampleEntryFormat = async (reader: ByteReader, mdia: Box) => {
    const minf = await findBox(reader, 'minf', mdia.dataOffset, mdia.end);
    const stbl = minf && (await findBox(reader, 'stbl', minf.dataOffset, minf.end));
    const stsd = stbl && (await findBox(reader, 'stsd', stbl.dataOffset, stbl.end));
    if (!stsd) return;

    const entry = await readBox(
        reader,
        stsd.dataOffset + fullBoxVersionAndFlagsBytes + sampleEntryCountBytes,
        stsd.end
    ); // FullBox version/flags, then entry_count, then the first sample entry.
    return entry?.type;
};

interface IsoBmffTrack {
    id?: number;
    chapter?: boolean;
    handler: string;
    format?: string;
    language?: string;
    title?: string;
}

/** Walk track headers by box size, including a moov after a large media payload. */
export const isoBmffTracks = async (reader: ByteReader): Promise<IsoBmffTrack[] | undefined> => {
    const moov = await findBox(reader, 'moov', 0, reader.size);
    if (!moov) return;
    const tracks: IsoBmffTrack[] = [];
    const chapterIds = new Set<number>();
    await forEachBox(reader, moov.dataOffset, moov.end, async (trak) => {
        if (trak.type !== 'trak') return;
        const tkhd = await findBox(reader, 'tkhd', trak.dataOffset, trak.end);
        let id: number | undefined;
        if (tkhd) {
            const version = await reader.unsignedInt(tkhd.dataOffset, 1);
            const idOffset = tkhd.dataOffset + (version === 1 ? 20 : 12);
            if ((version !== 0 && version !== 1) || idOffset + 4 > tkhd.end)
                throw new Error('Invalid MP4 track header');
            id = await reader.unsignedInt(idOffset, 4);
        }
        const tref = await findBox(reader, 'tref', trak.dataOffset, trak.end);
        const chap = tref && (await findBox(reader, 'chap', tref.dataOffset, tref.end));
        if (chap) {
            if ((chap.end - chap.dataOffset) % 4 || chap.end - chap.dataOffset > maxBoxes * 4)
                throw new Error('Invalid MP4 chapter references');
            for (let offset = chap.dataOffset; offset < chap.end; offset += 4) {
                const chapterId = await reader.unsignedInt(offset, 4);
                if (chapterId === undefined) throw new Error('Truncated MP4 chapter reference');
                chapterIds.add(chapterId);
            }
        }
        const mdia = await findBox(reader, 'mdia', trak.dataOffset, trak.end);
        const hdlr = mdia && (await findBox(reader, 'hdlr', mdia.dataOffset, mdia.end));
        if (!mdia || !hdlr || hdlr.dataOffset + 12 > hdlr.end) throw new Error('Incomplete MP4 track metadata');
        const handler = await reader.ascii(
            hdlr.dataOffset + fullBoxVersionAndFlagsBytes + handlerPredefinedBytes,
            isoBmffBoxTypeBytes
        );
        if (!handler) throw new Error('Missing MP4 track handler');
        const mdhd = await findBox(reader, 'mdhd', mdia.dataOffset, mdia.end);
        let language: string | undefined;
        if (mdhd) {
            const version = await reader.unsignedInt(mdhd.dataOffset, 1);
            if (version !== 0 && version !== 1) throw new Error('Unsupported MP4 media header');
            const languageOffset = mdhd.dataOffset + (version === 1 ? 32 : 20);
            if (languageOffset + 2 > mdhd.end) throw new Error('Truncated MP4 language');
            const packed = await reader.unsignedInt(languageOffset, 2);
            if (packed !== undefined && packed >= 0x400 && packed < 0x8000) {
                language = String.fromCharCode(
                    ((packed >> 10) & 31) + 96,
                    ((packed >> 5) & 31) + 96,
                    (packed & 31) + 96
                );
            }
        }
        // hdlr's UTF-8 name follows its full header. Real muxers use this as the track label.
        const nameOffset = hdlr.dataOffset + 24;
        const title = nameOffset < hdlr.end ? await reader.utf8(nameOffset, hdlr.end - nameOffset) : undefined;
        tracks.push({ id, handler, format: await sampleEntryFormat(reader, mdia), language, title });
    });
    for (const track of tracks) track.chapter = track.id !== undefined && chapterIds.has(track.id);
    return tracks;
};

export const isoBmffAudioSampleFormats = async (reader: ByteReader): Promise<string[] | undefined> =>
    (await isoBmffTracks(reader))
        ?.filter((track) => track.handler === 'soun')
        .flatMap((track) => (track.format ? [track.format] : []));
