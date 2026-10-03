import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import process from 'node:process';

const boxes = (bytes, offset = 0, end = bytes.length) => {
    const result = [];
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    while (offset < end) {
        const size = view.getUint32(offset);
        const header = size === 1 ? 16 : 8;
        const length = size === 1 ? Number(view.getBigUint64(offset + 8)) : size || end - offset;
        assert.ok(length >= header && offset + length <= end, 'MP4 box must fit within its parent');
        result.push({
            type: String.fromCharCode(...bytes.subarray(offset + 4, offset + 8)),
            offset,
            data: offset + header,
            end: offset + length,
        });
        offset += length;
    }
    return result;
};

const outputInfo = (bytes) => {
    const child = (parent, type) => {
        const box = boxes(bytes, parent?.data ?? 0, parent?.end ?? bytes.length).find((box) => box.type === type);
        assert.ok(box, `MP4 must contain ${type}`);
        return box;
    };
    const moov = child(undefined, 'moov');
    const mvhd = child(moov, 'mvhd');
    const trak = child(moov, 'trak');
    const mdia = child(trak, 'mdia');
    const stbl = child(child(mdia, 'minf'), 'stbl');
    const stsd = child(stbl, 'stsd');
    const sampleEntry = boxes(bytes, stsd.data + 8, stsd.end)[0];
    const mdat = child(undefined, 'mdat');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    assert.equal(bytes[mvhd.data], 0, 'Short fixtures use a version-0 movie header');
    assert.equal(sampleEntry.type, 'mp4a');
    assert.ok(mdat.end - mdat.data > 32, 'AAC media payload must be present');
    return {
        duration: view.getUint32(mvhd.data + 16) / view.getUint32(mvhd.data + 12),
        channels: view.getUint16(sampleEntry.data + 16),
        sampleRate: view.getUint32(sampleEntry.data + 24) >>> 16,
    };
};

const reader = (bytes) => ({
    size: bytes.length,
    readAt(offset, length) {
        assert.ok(Number.isSafeInteger(offset) && offset >= 0);
        assert.ok(length <= 64 * 1024, 'Native IO must stay bounded');
        return bytes.subarray(offset, Math.min(offset + length, bytes.length));
    },
});

export const testAudioConversion = async (bridge, fixtureRoot) => {
    const fixture = async (name) => new Uint8Array(await readFile(new URL(name, fixtureRoot)));
    const ignoreProgress = () => {};
    for (const [name, expectedDuration, expectedRate] of [
        ['ac3.mp4', 0.209, 44100],
        ['eac3-surround.mkv', 0.224, 48000],
        ['eac3-attachment.mkv', 0.224, 48000],
        ['ac3-resample.mkv', 0.24, 48000],
        ['dts.mkv', 0.203, 48000],
        ['truehd.mkv', 0.2, 48000],
        ['mlp.mkv', 0.2, 48000],
        ['audio-offset.mp4', 0.519, 48000],
        ['audio-gap.mkv', 0.8, 48000],
    ]) {
        const progress = [];
        const output = bridge.transcodeAudio(reader(await fixture(name)), 0, (update) => progress.push(update));
        const info = outputInfo(new Uint8Array(output));
        assert.equal(info.channels, 2, `${name}: downmix to stereo`);
        assert.equal(info.sampleRate, expectedRate, `${name}: output sample rate`);
        assert.ok(Math.abs(info.duration - expectedDuration) < 0.03, `${name}: duration ${info.duration}`);
        assert.equal(progress[0].processedSeconds, 0, `${name}: initial progress`);
        assert.equal(progress.at(-1).stage, 'finalizing', `${name}: finalization is a separate stage`);
        assert.ok(progress[0].totalSeconds > 0, `${name}: known duration`);
        // Audio offsets contribute to the output timeline, while unrelated longer video does not.
        assert.ok(Math.abs(progress[0].totalSeconds - expectedDuration) < 0.05, `${name}: progress duration`);
        for (let index = 1; index < progress.length; index++) {
            assert.ok(
                progress[index].processedSeconds >= progress[index - 1].processedSeconds,
                `${name}: monotonic progress`
            );
        }
    }

    const updates = [];
    let returned = false;
    const longOutput = bridge.transcodeAudio(reader(await fixture('progress.mkv')), 0, (progress) => {
        assert.equal(returned, false, 'Progress is delivered while native conversion is running');
        updates.push(progress);
    });
    returned = true;
    assert.ok(Math.abs(outputInfo(new Uint8Array(longOutput)).duration - 30) < 0.05);
    assert.ok(
        updates.some((progress) => progress.stage === 'transcoding' && progress.processedSeconds > 0),
        'Long conversions report intermediate media progress'
    );
    assert.ok(updates.at(-1).processedSeconds > 29);

    // Insert a sparse 4 GiB free box before a tail moov. Chunk offsets in mdat remain
    // unchanged, while FFmpeg must seek beyond 32-bit offsets to discover the track.
    const bytes = await fixture('ac3.mp4');
    const moov = boxes(bytes).find((box) => box.type === 'moov');
    assert.equal(moov.end, bytes.length);
    const padding = 2 ** 32;
    const free = new Uint8Array(16);
    const freeView = new DataView(free.buffer);
    freeView.setUint32(0, 1);
    free.set([102, 114, 101, 101], 4);
    freeView.setBigUint64(8, BigInt(padding));
    let highestOffset = 0;
    let totalRead = 0;
    const largeReader = {
        size: bytes.length + padding,
        readAt(offset, length) {
            assert.ok(length <= 64 * 1024);
            highestOffset = Math.max(highestOffset, offset);
            const output = new Uint8Array(Math.min(length, this.size - offset));
            totalRead += output.length;
            for (const [start, part] of [
                [0, bytes.subarray(0, moov.offset)],
                [moov.offset, free],
                [moov.offset + padding, bytes.subarray(moov.offset)],
            ]) {
                const from = Math.max(offset, start);
                const end = Math.min(offset + output.length, start + part.length);
                if (end > from) output.set(part.subarray(from - start, end - start), from - offset);
            }
            return output;
        },
    };
    const output = bridge.transcodeAudio(largeReader, 0, ignoreProgress);
    assert.equal(outputInfo(new Uint8Array(output)).channels, 2);
    assert.ok(highestOffset > 2 ** 32, 'Native seeks retain offsets above 4 GiB');
    assert.ok(totalRead < 1024 * 1024, 'Large video input does not require reading the whole file');

    assert.throws(() => bridge.transcodeAudio(reader(bytes), 1, ignoreProgress), /track does not exist/);
    assert.throws(
        () => bridge.transcodeAudio(reader(new Uint8Array([1, 2, 3])), 0, ignoreProgress),
        /Could not open input/
    );
    const readError = new Error('File could not be read');
    assert.throws(
        () =>
            bridge.transcodeAudio(
                {
                    size: 100,
                    readAt() {
                        throw readError;
                    },
                },
                0,
                ignoreProgress
            ),
        (error) => error === readError
    );
    assert.equal(outputInfo(new Uint8Array(bridge.transcodeAudio(reader(bytes), 0, ignoreProgress))).channels, 2);
    const progressError = new Error('Progress consumer failed');
    assert.throws(
        () =>
            bridge.transcodeAudio(reader(bytes), 0, () => {
                throw progressError;
            }),
        (error) => error === progressError
    );
    assert.equal(outputInfo(new Uint8Array(bridge.transcodeAudio(reader(bytes), 0, ignoreProgress))).channels, 2);
    process.stdout.write(
        'WASM audio conversion passed: all codecs, resampling, stereo, offsets, gaps, bounded IO, and retry\n'
    );
};
