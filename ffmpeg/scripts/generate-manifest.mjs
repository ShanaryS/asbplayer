import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileInfo, packageRoot, readJson, runtimeFiles, sha256 } from './lib.mjs';

const packageJson = await readJson(resolve(packageRoot, 'package.json'));
const config = await readJson(resolve(packageRoot, 'build-config.json'));
const version = packageJson.version;
const destination = resolve(packageRoot, 'dist', version);
const dockerOutput = resolve(packageRoot, '.cache', 'docker-output');
const sourceArchive = await fileInfo(resolve(packageRoot, 'release', `asbplayer-ffmpeg-${version}-source.tar.xz`));
const configMakPath = resolve(dockerOutput, 'config.mak');
const configHeaderPath = resolve(dockerOutput, 'config.h');
const configMak = await readFile(configMakPath, 'utf8');
const configHeader = await readFile(configHeaderPath, 'utf8');
const compiler = (await readFile(resolve(dockerOutput, 'compiler-version.txt'), 'utf8')).split('\n')[0];
const configuration = configMak
    .split('\n')
    .find((line) => line.startsWith('FFMPEG_CONFIGURATION='))
    ?.slice(21);
const license = configHeader.match(/^#define FFMPEG_LICENSE "([^"]+)"$/m)?.[1];
if (!configuration || !license) throw new Error('FFmpeg configuration or license was not recorded by configure');

const runtime = await Promise.all(
    (await runtimeFiles(destination)).map(async (filename) => ({
        ...(await fileInfo(resolve(destination, filename))),
        filename,
    }))
);
const manifest = {
    schemaVersion: 1,
    runtimeVersion: version,
    ffmpeg: {
        version: config.ffmpeg.version,
        revision: config.ffmpeg.revision,
        sourceUrl: config.ffmpeg.source.url,
        sourceSha256: config.ffmpeg.source.sha256,
        configuration,
        license,
    },
    toolchain: { ...config.toolchain, compiler },
    license: {
        notices: [
            'notices/asbplayer-MIT.txt',
            'notices/FFmpeg-LGPL-2.1.txt',
            'notices/Emscripten-MIT.txt',
            'notices/musl-COPYRIGHT.txt',
            'notices/compiler-rt-LICENSE.txt',
            'notices/libcxx-Apache-2.0.txt',
            'notices/libcxxabi-LICENSE.txt',
        ],
    },
    linkedLibraries: config.nativeLibraries,
    operations: config.implementedOperations,
    limits: config.limits,
    wasmMemory: {
        initialBytes: config.limits.initialMemoryBytes,
        maximumBytes: config.limits.maximumMemoryBytes,
        stackBytes: config.limits.stackBytes,
        shared: config.policy.sharedMemory,
        pthreads: config.policy.pthreads,
    },
    bridgeCompileArguments: ['-std=c++23', '-O3', '-fno-exceptions', '-fno-rtti'],
    buildEvidence: { configMakSha256: await sha256(configMakPath) },
    runtime,
    correspondingSource: sourceArchive,
};
await writeFile(resolve(destination, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
