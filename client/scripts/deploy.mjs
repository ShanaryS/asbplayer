import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { publish } from 'gh-pages';
import { clonePreviousDeployment, prepareFfmpegDeployment } from './ffmpeg-deployment.cjs';

const execFileAsync = promisify(execFile);
const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(join(tmpdir(), 'asbplayer-gh-pages-'));
try {
    await execFileAsync(process.execPath, [resolve(clientRoot, '../ffmpeg/scripts/verify-artifacts.mjs')]);
    const { stdout: repository } = await execFileAsync('git', ['remote', 'get-url', 'origin']);
    await clonePreviousDeployment(repository.trim(), temporary);
    const lock = JSON.parse(await readFile(resolve(clientRoot, '../ffmpeg/artifact-lock.json'), 'utf8'));
    await prepareFfmpegDeployment(resolve(clientRoot, 'dist', 'ffmpeg'), resolve(temporary, 'ffmpeg'), lock);
    await new Promise((resolvePromise, reject) => {
        publish(
            resolve(clientRoot, 'dist'),
            {
                // Replace the deployment, including retired FFmpeg runtime directories.
                remove: ['**/*'],
            },
            (error) => (error ? reject(error) : resolvePromise())
        );
    });
} finally {
    await rm(temporary, { recursive: true, force: true });
}
