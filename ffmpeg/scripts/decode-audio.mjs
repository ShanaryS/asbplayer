import { Buffer } from 'node:buffer';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import process from 'node:process';

const [root, fixtureRoot] = process.argv.slice(2);
const { NativeBridge } = await import(pathToFileURL(resolve(root, 'native-bridge.mjs')));
const { default: createRuntime } = await import(pathToFileURL(resolve(root, 'ffmpeg-core.js')));
const wasm = new WebAssembly.Module(await readFile(resolve(root, 'ffmpeg-core.wasm')));
const module = await createRuntime({
    instantiateWasm(imports, receive) {
        receive(new WebAssembly.Instance(wasm, imports));
        return {};
    },
});
const bridge = NativeBridge.create(module);
const exec = promisify(execFile);
const reader = (bytes) => ({ size: bytes.length, readAt: (offset, length) => bytes.subarray(offset, offset + length) });
const pcm = async (output) => {
    const path = resolve(root, 'decode.webm');
    await writeFile(path, new Uint8Array(output));
    try {
        const { stdout } = await exec(
            'ffmpeg',
            ['-hide_banner', '-loglevel', 'error', '-i', path, '-ar', '48000', '-ac', '2', '-f', 'f32le', '-'],
            { encoding: 'buffer', maxBuffer: 128 * 1024 * 1024 }
        );
        return new Float32Array(stdout.buffer.slice(stdout.byteOffset, stdout.byteOffset + stdout.byteLength));
    } finally {
        await rm(path, { force: true });
    }
};
const silence = (samples, start, end) => {
    let squared = 0;
    for (let i = Math.round(start * 48000) * 2; i < Math.round(end * 48000) * 2; i++) squared += samples[i] ** 2;
    return Math.sqrt(squared / ((end - start) * 48000 * 2));
};
for (const [name, expectedSeconds] of [
    ['ac3.mp4', 0.209],
    ['eac3-surround.mkv', 0.224],
    ['eac3-attachment.mkv', 0.224],
    ['ac3-resample.mkv', 0.24],
    ['dts.mkv', 0.203],
    ['truehd.mkv', 0.2],
    ['mlp.mkv', 0.2],
    ['audio-offset.mp4', 0.519],
    ['audio-gap.mkv', 0.8],
]) {
    const bytes = new Uint8Array(await readFile(resolve(fixtureRoot, name)));
    const chunks = [];
    bridge.transcodeAudio(
        reader(bytes),
        0,
        () => {},
        (chunk) => chunks.push(Buffer.from(chunk))
    );
    const decoded = await pcm(Buffer.concat(chunks));
    const format = 'opus';
    assert.ok(decoded.length > 0, `${name}/${format}: output fully decodes`);
    assert.equal(decoded.length % 2, 0, `${name}/${format}: complete stereo frames`);
    const duration = decoded.length / 2 / 48000;
    assert.ok(Math.abs(duration - expectedSeconds) < 0.05, `${name}/${format}: duration ${duration}`);
    if (name === 'audio-offset.mp4')
        assert.ok(silence(decoded, 0.03, 0.25) < 0.0001, `${format}: leading offset is preserved`);
    if (name === 'audio-gap.mkv')
        assert.ok(silence(decoded, 0.32, 0.5) < 0.0001, `${format}: timestamp gap is preserved`);
}
process.stdout.write('Single-pass WASM decode checks passed: streamed Opus, every decoder, offsets, and gaps\n');
