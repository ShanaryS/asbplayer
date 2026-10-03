/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
const { execFile } = require('node:child_process');
const { copyFile, mkdir, mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { resolve } = require('node:path');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

it('installs the generated standalone workspace with the pinned package manager and frozen lockfile', async () => {
    const stage = await mkdtemp(resolve(tmpdir(), 'asbplayer-ffmpeg-source-test-'));
    try {
        await mkdir(resolve(stage, 'ffmpeg'));
        await copyFile(resolve(__dirname, '../package.json'), resolve(stage, 'ffmpeg/package.json'));
        await copyFile(resolve(__dirname, '../source-pnpm-lock.yaml'), resolve(stage, 'pnpm-lock.yaml'));
        await execFileAsync(process.execPath, [
            resolve(__dirname, '../scripts/prepare-standalone-workspaces.mjs'),
            stage,
        ]);
        await execFileAsync('pnpm', ['install', '--frozen-lockfile', '--offline'], {
            cwd: stage,
            env: { ...process.env, CI: 'true' },
            timeout: 30_000,
        });
    } finally {
        await rm(stage, { recursive: true, force: true });
    }
}, 40_000);
