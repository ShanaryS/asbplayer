import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { packageRoot, readJson } from './lib.mjs';

const config = await readJson(resolve(packageRoot, 'build-config.json'));
const packageJson = await readJson(resolve(packageRoot, 'package.json'));
const buildDirectory = resolve(packageRoot, '.cache', 'build');
const positiveInteger = (name, value) => {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
    return value;
};

const ffmpegConfigureArguments = [
    '--target-os=none',
    '--arch=wasm32',
    '--enable-cross-compile',
    '--disable-asm',
    '--disable-stripping',
    '--disable-everything',
    '--disable-autodetect',
    '--disable-programs',
    '--disable-doc',
    '--disable-debug',
    '--disable-network',
    '--disable-runtime-cpudetect',
    '--disable-pthreads',
    '--disable-w32threads',
    '--disable-os2threads',
    '--disable-gpl',
    '--disable-nonfree',
    '--disable-version3',
    '--enable-static',
    '--disable-shared',
    '--enable-small',
    '--disable-avcodec',
    '--disable-avformat',
    '--disable-avfilter',
    '--disable-swresample',
    '--disable-swscale',
    '--disable-avdevice',
    '--disable-iconv',
    '--nm=emnm',
    '--ar=emar',
    '--ranlib=emranlib',
    '--cc=emcc',
    '--cxx=em++',
    '--objcc=emcc',
    '--dep-cc=emcc',
];

const header = `#ifndef ASB_BUILD_CONFIG_HPP
#define ASB_BUILD_CONFIG_HPP

#define ASB_RUNTIME_VERSION ${JSON.stringify(String(packageJson.version))}

#endif
`;
const dockerArguments = [
    `ASB_EMSDK_IMAGE=${config.toolchain.container}`,
    `ASB_INITIAL_MEMORY_BYTES=${positiveInteger('limits.initialMemoryBytes', config.limits.initialMemoryBytes)}`,
    `ASB_MAXIMUM_MEMORY_BYTES=${positiveInteger('limits.maximumMemoryBytes', config.limits.maximumMemoryBytes)}`,
    `ASB_STACK_BYTES=${positiveInteger('limits.stackBytes', config.limits.stackBytes)}`,
];

await mkdir(buildDirectory, { recursive: true });
await Promise.all([
    writeFile(resolve(buildDirectory, 'asb-build-config.hpp'), header),
    writeFile(resolve(buildDirectory, 'ffmpeg-configure-args'), `${ffmpegConfigureArguments.join('\n')}\n`),
    writeFile(resolve(buildDirectory, 'docker-build-args'), `${dockerArguments.join('\n')}\n`),
    writeFile(resolve(buildDirectory, 'platform'), `${config.toolchain.platform}\n`),
]);
