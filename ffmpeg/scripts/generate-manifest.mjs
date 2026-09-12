import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileInfo, packageRoot, readJson } from './lib.mjs';

const versions = await readJson(resolve(packageRoot, 'versions.json'));
const capabilities = await readJson(resolve(packageRoot, 'capabilities.json'));
const destination = resolve(packageRoot, 'dist', versions.coreVersion);
await mkdir(destination, { recursive: true });

const runtimeNames = ['ffmpeg-wrapper.js', 'ffmpeg-worker.js', 'ffmpeg-core.js', 'ffmpeg-core.wasm'];
const runtime = await Promise.all(runtimeNames.map((name) => fileInfo(resolve(destination, name))));
const sourceArchive = await fileInfo(
    resolve(packageRoot, 'release', `asbplayer-ffmpeg-${versions.coreVersion}-source.tar.xz`)
);
const config = await readFile(resolve(packageRoot, '.cache', 'docker-output', 'config.mak'), 'utf8');
const manifest = {
    schemaVersion: 1,
    coreVersion: versions.coreVersion,
    wrapperVersion: versions.wrapperVersion,
    bindingsRevision: versions.bindingsRevision,
    ffmpegVersion: versions.ffmpegVersion,
    emscriptenVersion: versions.emscriptenVersion,
    container: versions.container,
    platform: versions.platform,
    bundler: versions.bundler,
    license: 'LGPL-2.1-or-later',
    frameworkLibraries: ['libavutil', 'libavcodec', 'libavformat', 'libavfilter'],
    capabilities,
    runtime,
    correspondingSource: sourceArchive,
    configure: config
        .split('\n')
        .find((line) => line.startsWith('FFMPEG_CONFIGURATION='))
        ?.slice('FFMPEG_CONFIGURATION='.length),
    notices: ['FFmpeg', 'ffmpeg.wasm bindings', '@ffmpeg/ffmpeg', 'Emscripten'],
};
await writeFile(resolve(destination, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
