import type ByteReader from '@project/common/media-probe/byte-reader';

export interface EbmlVarInt {
    value: number;
    length: number;
    unknown: boolean;
}

export interface EbmlElement {
    id: number;
    dataOffset: number;
    dataSize: number;
    end: number;
    unknown: boolean;
}

/**
 * Reads an EBML variable length integer. Element IDs keep their marker bits; sizes drop them.
 */
export const readEbmlVarInt = async (
    reader: ByteReader,
    offset: number,
    keepMarker = false
): Promise<EbmlVarInt | undefined> => {
    const first = await reader.bytes(offset, 1);

    if (first === undefined || first[0] === 0) {
        return undefined;
    }

    let length = 1;
    let marker = 0x80;

    while ((first[0] & marker) === 0) {
        marker >>= 1;
        ++length;
    }

    if (keepMarker && length > 4) return undefined;

    const bytes = await reader.bytes(offset, length);

    if (bytes === undefined) {
        return undefined;
    }

    let value = keepMarker ? bytes[0] : bytes[0] & (marker - 1);
    let unknown = (bytes[0] & (marker - 1)) === marker - 1;

    for (let i = 1; i < length; ++i) {
        value = value * 256 + bytes[i];
        unknown = unknown && bytes[i] === 0xff;
    }

    return { value, length, unknown };
};

export const readEbmlElement = async (
    reader: ByteReader,
    offset: number,
    limit: number
): Promise<EbmlElement | undefined> => {
    const id = await readEbmlVarInt(reader, offset, true);

    if (id === undefined) {
        return undefined;
    }

    const size = await readEbmlVarInt(reader, offset + id.length, false);

    if (size === undefined) {
        return undefined;
    }

    const dataOffset = offset + id.length + size.length;

    // Keep unknown sizes explicit: callers may reject an unfinished streaming cluster.
    const dataSize = size.unknown ? limit - dataOffset : size.value;

    if (dataSize < 0 || !Number.isSafeInteger(dataSize) || dataOffset + dataSize > limit) {
        return undefined;
    }

    return { id: id.value, dataOffset, dataSize, end: dataOffset + dataSize, unknown: size.unknown };
};

export const findEbmlElement = async (
    reader: ByteReader,
    id: number,
    start = 0,
    end = reader.size
): Promise<EbmlElement | undefined> => {
    while (start < end) {
        const element = await readEbmlElement(reader, start, end);
        if (element === undefined) return undefined;
        if (element.id === id) return element;
        start = element.end;
    }
    return undefined;
};
