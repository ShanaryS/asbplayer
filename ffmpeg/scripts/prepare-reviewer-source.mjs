import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { packageRoot, readJson, verifyFile } from './lib.mjs';

const lock = await readJson(resolve(packageRoot, 'artifact-lock.json'));
const archive = resolve(packageRoot, 'release', lock.sourceArchive.name);
await verifyFile(archive, lock.sourceArchive.sha256);
const destination = resolve(packageRoot, 'reviewer-source');
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await new Promise((resolvePromise, reject) => {
    const child = spawn('tar', ['-xJf', archive, '--strip-components=1', '-C', destination], { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => (code === 0 ? resolvePromise() : reject(new Error(`tar exited with ${code}`))));
});
