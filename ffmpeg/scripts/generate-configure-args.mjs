import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { packageRoot } from './lib.mjs';

const arguments_ = [
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

const output = resolve(packageRoot, '.cache', 'build', 'ffmpeg-configure-args');
await mkdir(resolve(packageRoot, '.cache', 'build'), { recursive: true });
await writeFile(output, `${arguments_.join('\n')}\n`);
