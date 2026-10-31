/* global Buffer, module */
// Original, redistributable PGS test images: tiny indexed rectangles, never external artwork.
const word = (value) => {
    const bytes = Buffer.alloc(2);
    bytes.writeUInt16BE(value);
    return bytes;
};
const triple = (value) => Buffer.from([value >> 16, value >> 8, value]);
const segment = (type, payload) => Buffer.concat([Buffer.from([type]), word(payload.length), payload]);
const pcs = (number, objects, state = 0) =>
    segment(
        0x16,
        Buffer.concat([
            word(16),
            word(16),
            Buffer.from([0x10]),
            word(number),
            Buffer.from([state, 0, 2, objects.length]),
            ...objects.map(({ id = 0, x = 2, y = 10, crop }) =>
                Buffer.concat([
                    word(id),
                    Buffer.from([0, crop ? 0x80 : 0]),
                    word(x),
                    word(y),
                    ...(crop ? [word(crop.x), word(crop.y), word(crop.width), word(crop.height)] : []),
                ])
            ),
        ])
    );
const palette = (entries) =>
    segment(0x14, Buffer.concat([Buffer.from([2, 0]), ...entries.map((entry) => Buffer.from(entry))]));
const ods = (id, width, height, data, split = false) => {
    const header = Buffer.concat([
        word(id),
        Buffer.from([0, split ? 0x80 : 0xc0]),
        triple(data.length + 4),
        word(width),
        word(height),
    ]);
    return split
        ? [
              segment(0x15, Buffer.concat([header, data.subarray(0, 3)])),
              segment(0x15, Buffer.concat([word(id), Buffer.from([0, 0x40]), data.subarray(3)])),
          ]
        : [segment(0x15, Buffer.concat([header, data]))];
};
const end = segment(0x80, Buffer.alloc(0));
const windows = segment(0x17, Buffer.concat([Buffer.from([1, 0]), word(0), word(0), word(16), word(16)]));
const pgsDisplaySets = [
    {
        timestamp: 90000,
        segments: [
            pcs(0, [{}, { id: 1, x: 6, y: 10 }], 0x80),
            windows,
            palette([
                [0, 16, 128, 128, 0],
                [7, 235, 128, 128, 255],
                [13, 16, 128, 128, 255],
            ]),
            ...ods(0, 2, 2, Buffer.from([7, 7, 0, 0, 0, 1, 7, 0, 0]), true),
            ...ods(1, 1, 1, Buffer.from([13, 0, 0])),
            end,
        ],
    },
    { timestamp: 180000, segments: [pcs(1, [{}, { id: 1, x: 6, y: 10 }]), palette([[7, 16, 128, 128, 255]]), end] },
    { timestamp: 270000, segments: [pcs(2, [{ x: 4, crop: { x: 1, y: 0, width: 1, height: 2 } }]), end] },
    { timestamp: 360000, segments: [pcs(3, []), end] },
    {
        timestamp: 450000,
        segments: [
            pcs(4, [{}], 0x80),
            windows,
            palette([[7, 235, 128, 128, 255]]),
            ...ods(0, 1, 1, Buffer.from([7, 0, 0])),
            end,
        ],
    },
];
const makeSup = (sets) =>
    Buffer.concat(
        sets.flatMap(({ timestamp, segments }) =>
            segments.map((bytes) => {
                const header = Buffer.alloc(10);
                header.write('PG');
                header.writeUInt32BE(timestamp >>> 0, 2);
                return Buffer.concat([header, bytes]);
            })
        )
    );
const pgsWrapSets = [
    { ...pgsDisplaySets[0], timestamp: 2 ** 32 - 90000 },
    { ...pgsDisplaySets[1], timestamp: 2 ** 32 + 90000 },
    { ...pgsDisplaySets[3], timestamp: 2 ** 32 + 180000 },
];

module.exports = { makeSup, pgsDisplaySets, pgsWrapSets };
