import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { download, packageRoot, readJson } from './lib.mjs';

const lock = await readJson(resolve(packageRoot, 'artifact-lock.json'));
if (!lock.runtimeArchive.sha256 || !lock.sourceArchive.sha256) {
    throw new Error('Published FFmpeg artifact hashes have not been recorded; build the 0.1.0 candidate locally.');
}

const release = resolve(packageRoot, 'release');
const runtimeArchive = resolve(release, lock.runtimeArchive.name);
const sourceArchive = resolve(release, lock.sourceArchive.name);
await Promise.all([
    download(`${lock.releaseBaseUrl}/${lock.runtimeArchive.name}`, runtimeArchive, lock.runtimeArchive.sha256),
    download(`${lock.releaseBaseUrl}/${lock.sourceArchive.name}`, sourceArchive, lock.sourceArchive.sha256),
]);

const destination = resolve(packageRoot, 'dist', lock.coreVersion);
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await new Promise((resolvePromise, reject) => {
    const child = spawn('tar', ['-xzf', runtimeArchive, '--strip-components=1', '-C', destination], {
        stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code) => (code === 0 ? resolvePromise() : reject(new Error(`tar exited with ${code}`))));
});

await import('./verify-artifacts.mjs');
