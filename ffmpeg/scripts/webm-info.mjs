import assert from 'node:assert/strict';

// Inspect only container metadata; decoding and sample counts are checked separately on the host.
export const webmInfo = (bytes) => {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const vint = (at, keepMarker = false) => {
        let width = 1;
        while (width <= 8 && !(bytes[at] & (0x80 >> (width - 1)))) width++;
        assert.ok(width <= 8 && at + width <= bytes.length);
        let value = keepMarker ? bytes[at] : bytes[at] & ((0x80 >> (width - 1)) - 1);
        for (let i = 1; i < width; i++) value = value * 256 + bytes[at + i];
        return { width, value };
    };
    const find = (id, start = 0, end = bytes.length) => {
        while (start < end) {
            const tag = vint(start, true);
            const size = vint(start + tag.width);
            const data = start + tag.width + size.width;
            const next = Math.min(end, data + size.value);
            if (tag.value === id) return { data, end: next };
            start = next;
        }
        throw new Error(`Missing WebM element ${id.toString(16)}`);
    };
    const child = (id, parent) => find(id, parent.data, parent.end);
    const integer = ({ data, end }) => {
        let value = 0;
        while (data < end) value = value * 256 + bytes[data++];
        return value;
    };
    const float = ({ data, end }) => (end - data === 4 ? view.getFloat32(data) : view.getFloat64(data));
    const segment = find(0x18538067);
    const info = child(0x1549a966, segment);
    const track = child(0xae, child(0x1654ae6b, segment));
    const audio = child(0xe1, track);
    const codec = child(0x86, track);
    assert.equal(new TextDecoder().decode(bytes.subarray(codec.data, codec.end)), 'A_OPUS');
    return {
        duration: (float(child(0x4489, info)) * integer(child(0x2ad7b1, info))) / 1e9,
        channels: integer(child(0x9f, audio)),
        sampleRate: float(child(0xb5, audio)),
    };
};
