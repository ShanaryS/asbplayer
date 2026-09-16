import { execFile } from 'node:child_process';
import { access, mkdir, rename, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { download, packageRoot, readJson } from './lib.mjs';

const execFileAsync = promisify(execFile);
const lock = await readJson(resolve(packageRoot, 'artifact-lock.json'));
if (lock.schemaVersion !== 1 || !lock.runtimeArchive.sha256 || !lock.sourceArchive.sha256) {
    throw new Error('No frozen FFmpeg artifact selection is recorded.');
}
const release = resolve(packageRoot, 'release');
const runtimeArchive = resolve(release, lock.runtimeArchive.filename);
await download(`${lock.releaseBaseUrl}/${lock.runtimeArchive.filename}`, runtimeArchive, lock.runtimeArchive.sha256);

const { stdout: listing } = await execFileAsync('tar', ['-tzf', runtimeArchive]);
const paths = listing.trim().split('\n');
const prefix = `${lock.runtimeVersion}/`;
if (
    paths.some(
        (path) =>
            path.startsWith('/') || path.includes('../') || !(path === lock.runtimeVersion || path.startsWith(prefix))
    )
) {
    throw new Error('Runtime archive contains an unsafe or unexpected path');
}
const parent = resolve(packageRoot, 'dist');
const destination = resolve(parent, lock.runtimeVersion);
const stagedRoot = resolve(parent, `.staged-${lock.runtimeVersion}`);
const staged = resolve(stagedRoot, lock.runtimeVersion);
const backup = resolve(parent, `.backup-${lock.runtimeVersion}`);
await rm(stagedRoot, { recursive: true, force: true });
await mkdir(stagedRoot, { recursive: true });
await execFileAsync('tar', ['-xzf', runtimeArchive, '-C', stagedRoot]);
await rm(backup, { recursive: true, force: true });
try {
    await access(destination);
    await rename(destination, backup);
} catch {
    // There is no previously installed runtime to preserve.
}
await rename(staged, destination);
await rm(stagedRoot, { recursive: true, force: true });
try {
    await import('./verify-artifacts.mjs');
    await rm(backup, { recursive: true, force: true });
} catch (error) {
    await rm(destination, { recursive: true, force: true });
    try {
        await rename(backup, destination);
    } catch {
        // Restoration is impossible when the prior runtime did not exist.
    }
    throw error;
}
