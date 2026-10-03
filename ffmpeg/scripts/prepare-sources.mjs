import { access, mkdir, rename, rm } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { download, packageRoot, readJson } from './lib.mjs';

const execFileAsync = promisify(execFile);
const { ffmpeg } = await readJson(resolve(packageRoot, 'build-config.json'));
const destination = resolve(packageRoot, '.cache/sources/ffmpeg');
const bundled = await access(resolve(destination, '.asb-bundled-source')).then(
    () => true,
    () => false
);

// Corresponding-source rebuilds already contain the verified upstream source.
if (!bundled) {
    const archive = resolve(packageRoot, '.cache/archives', basename(new URL(ffmpeg.source.url).pathname));
    await download(ffmpeg.source.url, archive, ffmpeg.source.sha256);
    const staged = `${destination}.staged`;
    await rm(staged, { recursive: true, force: true });
    await mkdir(staged, { recursive: true });
    await execFileAsync('tar', ['-xf', archive, '--strip-components=1', '-C', staged]);
    await rm(destination, { recursive: true, force: true });
    await rename(staged, destination);
}
