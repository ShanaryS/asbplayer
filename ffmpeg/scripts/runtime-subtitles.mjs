import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { generateSubtitleMedia } from './subtitle-test-media.mjs';
import { pgsDisplaySets } from './pgs-test-data.cjs';

const runtimeRoot = resolve(process.argv[2] ?? '/output');
const root = await mkdtemp(resolve(tmpdir(), 'asb-runtime-subtitles-'));
try {
    await generateSubtitleMedia(root);
    const wasmBytes = await readFile(resolve(runtimeRoot, 'ffmpeg-core.wasm'));
    const { default: createRuntime } = await import(pathToFileURL(resolve(runtimeRoot, 'ffmpeg-core.js')).href);
    const module = await createRuntime({
        instantiateWasm(imports, receiveInstance) {
            receiveInstance(new WebAssembly.Instance(new WebAssembly.Module(wasmBytes), imports));
            return {};
        },
    });
    let input;
    let outputs = new Map();
    let lastResults;
    module.asbReadInput = (offset, pointer, length) => {
        const bytes = input.subarray(offset, offset + length);
        module.HEAPU8.set(bytes, pointer);
        return bytes.length;
    };
    module.asbWriteSubtitleOutput = (index, pointer, length) => {
        assert.ok(outputs.has(index), 'All chunks must belong to a requested global stream index');
        outputs.get(index).push(Buffer.from(module.HEAPU8.subarray(pointer, pointer + length)));
        return length;
    };
    const json = (pointer) => {
        assert.ok(pointer, module.UTF8ToString(module._asb_last_error()));
        return JSON.parse(module.UTF8ToString(pointer));
    };
    const load = async (name) => {
        input = await readFile(resolve(root, name));
    };
    const extract = (indexes, binary = false) => {
        outputs = new Map(indexes.map((index) => [index, []]));
        const text = indexes.join(',');
        const size = module.lengthBytesUTF8(text) + 1;
        const pointer = module._malloc(size);
        module.stringToUTF8(text, pointer, size);
        try {
            const result = json(module._asb_extract_subtitles(input.length, pointer));
            lastResults = result;
            assert.deepEqual(
                result.map((track) => track.streamIndex),
                indexes
            );
            return new Map(
                [...outputs].map(([index, chunks]) => [
                    index,
                    binary ? Buffer.concat(chunks) : Buffer.concat(chunks).toString('utf8'),
                ])
            );
        } finally {
            module._free(pointer);
        }
    };
    await load('mixed.mkv');
    const mixed = extract([2, 1]);
    assert.match(mixed.get(1), /00:00:02,000 --> 00:00:04,000/);
    assert.match(mixed.get(1), /00:00:03,000 --> 00:00:05,000/);
    assert.match(mixed.get(1), /Final cue/);
    assert.match(mixed.get(2), /日本語 text\nline two end/);
    assert.doesNotMatch(mixed.get(2), /m 0 0|\\h|\\k20/);
    assert.match(mixed.get(2), /<b>literal<\/b> &amp;/);
    // Confirmed extraction must finish even with slow, fragmented input reads.
    const readInput = module.asbReadInput;
    const now = performance.now.bind(performance);
    const clockDescriptor = Object.getOwnPropertyDescriptor(performance, 'now');
    let simulatedDelayMs = 0;
    Object.defineProperty(performance, 'now', { configurable: true, value: () => now() + simulatedDelayMs });
    module.asbReadInput = (offset, pointer, length) => {
        const count = readInput(offset, pointer, Math.min(length, 64));
        simulatedDelayMs += 1100;
        return count;
    };
    try {
        assert.deepEqual([...extract([2, 1])], [...mixed]);
        assert.ok(simulatedDelayMs > 5000, 'Extraction must continue through slow input reads');
    } finally {
        module.asbReadInput = readInput;
        if (clockDescriptor) Object.defineProperty(performance, 'now', clockDescriptor);
        else delete performance.now;
    }
    await load('zlib.mkv');
    assert.match(extract([0]).get(0), /00:00:02,000 --> 00:00:04,000\n日本語 compressed text/);
    await load('timed-text.mp4');
    const mp4 = extract([1]).get(1);
    // mov_text samples cannot overlap: the first sample ends at the next sample.
    assert.match(mp4, /00:00:02,000 --> 00:00:03,000/);
    assert.match(mp4, /Final cue/);
    for (const [name, index, expectedOffset] of [
        ['mixed', 3, 1000],
        ['image-preroll', 1, -1000],
        ['image-long', 0, 50001000],
    ]) {
        await load(`${name}.mkv`);
        const streams = name === 'mixed' ? [index, 1] : [index];
        const files = extract(streams, true);
        const result = lastResults.find((track) => track.streamIndex === index);
        assert.equal(result.extension, 'sup');
        assert.equal(result.mimeType, 'application/x-pgs');
        assert.equal(result.timelineOffsetMs, expectedOffset);
        const bytes = files.get(index);
        const segments = [];
        const timestamps = [];
        for (let position = 0; position < bytes.length; ) {
            assert.equal(bytes.toString('ascii', position, position + 2), 'PG');
            timestamps.push(bytes.readUInt32BE(position + 2));
            const length = bytes.readUInt16BE(position + 11);
            segments.push(bytes.subarray(position + 10, position + 13 + length));
            position += 13 + length;
        }
        // Remuxing must retain every segment payload, including palettes, object fragments and clears.
        const sourceSets = name === 'image-long' ? pgsDisplaySets.slice(0, 4) : pgsDisplaySets;
        assert.deepEqual(Buffer.concat(segments), Buffer.concat(sourceSets.flatMap(({ segments }) => segments)));
        assert.deepEqual(
            timestamps,
            sourceSets.flatMap(({ timestamp, segments }) => segments.map(() => timestamp - sourceSets[0].timestamp))
        );
        if (name === 'mixed') assert.match(files.get(1).toString('utf8'), /Final cue/);
    }
    // Guard against unbounded WASM heap growth across repeated extractions.
    const initialMemory = module.HEAPU8.buffer.byteLength;
    for (let repeat = 0; repeat < 10; ++repeat) extract([0], true);
    assert.equal(module.HEAPU8.buffer.byteLength, initialMemory);
    process.stdout.write(
        'WASM subtitle regressions passed: mixed streams/nonzero origin, text normalization, slow input reads, zlib, PGS preroll/long delay/resource preservation\n'
    );
} finally {
    await rm(root, { recursive: true, force: true });
}
