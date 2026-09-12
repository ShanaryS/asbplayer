import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { download, packageRoot, readJson } from './lib.mjs';

const versions = await readJson(resolve(packageRoot, 'versions.json'));
const archives = resolve(packageRoot, '.cache', 'archives');
const sources = resolve(packageRoot, '.cache', 'sources');
const ffmpegArchive = resolve(archives, `ffmpeg-${versions.ffmpegVersion}.tar.xz`);
const bindingsArchive = resolve(archives, `ffmpeg.wasm-${versions.wrapperVersion}.tar.gz`);

await Promise.all([
    download(versions.ffmpegSource.url, ffmpegArchive, versions.ffmpegSource.sha256),
    download(versions.bindingsSource.url, bindingsArchive, versions.bindingsSource.sha256),
]);

await rm(sources, { recursive: true, force: true });
await mkdir(resolve(sources, 'ffmpeg'), { recursive: true });
await mkdir(resolve(sources, 'ffmpeg-wasm'), { recursive: true });

const extract = (args) =>
    new Promise((resolvePromise, reject) => {
        const child = spawn('tar', args, { stdio: 'inherit' });
        child.once('error', reject);
        child.once('exit', (code) => (code === 0 ? resolvePromise() : reject(new Error(`tar exited with ${code}`))));
    });

await extract(['-xJf', ffmpegArchive, '--strip-components=1', '-C', resolve(sources, 'ffmpeg')]);
await extract(['-xzf', bindingsArchive, '--strip-components=1', '-C', resolve(sources, 'ffmpeg-wasm')]);
