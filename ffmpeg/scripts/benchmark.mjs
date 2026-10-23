import { Buffer } from 'node:buffer';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import { performance } from 'node:perf_hooks';
const [root, fixture, resultPath] = process.argv.slice(2);
const { NativeBridge } = await import(pathToFileURL(resolve(root, 'native-bridge.mjs')));
const { default: createRuntime } = await import(pathToFileURL(resolve(root, 'ffmpeg-core.js')));
const wasmBytes = await readFile(resolve(root, 'ffmpeg-core.wasm'));
const wasm = new WebAssembly.Module(wasmBytes);
const module = await createRuntime({
    instantiateWasm(imports, receive) {
        receive(new WebAssembly.Instance(wasm, imports));
        return {};
    },
});
const bridge = NativeBridge.create(module);
const bytes = await readFile(fixture);
const reader = {
    size: bytes.length,
    readAt(offset, length) {
        return bytes.subarray(offset, offset + length);
    },
};

const samples = [];
let output;
for (let i = 0; i < 4; i++) {
    const start = performance.now();
    const chunks = [];
    bridge.transcodeAudio(
        reader,
        0,
        () => {},
        (chunk) => chunks.push(Buffer.from(chunk))
    );
    output = Buffer.concat(chunks);
    const seconds = (performance.now() - start) / 1000;
    if (i > 0) samples.push(seconds);
}
const result = {
    format: 'opus',
    fixture,
    seconds: samples,
    medianSeconds: [...samples].sort((a, b) => a - b)[1],
    outputBytes: output.byteLength,
    wasmBytes: wasmBytes.length,
};
process.stdout.write(JSON.stringify(result, null, 2) + '\n');
if (resultPath) await writeFile(resultPath, JSON.stringify(result, null, 2) + '\n');

if (resultPath) await writeFile(resultPath + '.webm', new Uint8Array(output));
