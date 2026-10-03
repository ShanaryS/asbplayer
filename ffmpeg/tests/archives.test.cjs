/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
const { execFile } = require('node:child_process');
const { mkdir, mkdtemp, rm, symlink, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { promisify } = require('node:util');
const { verifyRuntimeArchive, verifySourceArchive } = require('../scripts/runtime-archive-validator.cjs');

const exec = promisify(execFile);
let temporary;
let source;

beforeEach(async () => {
    temporary = await mkdtemp(join(tmpdir(), 'asbplayer-archives-'));
    source = join(temporary, 'source');
    const files = {
        LICENSE: 'License',
        'pnpm-lock.yaml': 'lockfile',
        'pnpm-workspace.yaml': 'packages: [ffmpeg]',
        'package.json': JSON.stringify({ packageManager: 'pnpm@11.27.0' }),
        'ffmpeg/build-config.json': '{}',
        'ffmpeg/native/runtime.cpp': 'bridge',
        'ffmpeg/.cache/sources/ffmpeg/COPYING.LGPLv2.1': 'Upstream license',
    };
    for (const [path, body] of Object.entries(files)) {
        await mkdir(join(source, path, '..'), { recursive: true });
        await writeFile(join(source, path), body);
    }
});
afterEach(async () => {
    await rm(temporary, { recursive: true, force: true });
});
const packSource = async () => {
    const archive = join(temporary, 'source.tar.xz');
    await exec('tar', ['-cJf', archive, '-C', temporary, 'source']);
    return archive;
};

it('accepts a complete standalone corresponding-source archive', async () => {
    await expect(verifySourceArchive(await packSource())).resolves.toBeUndefined();
});

it.each(['LICENSE', 'ffmpeg/native/runtime.cpp', 'ffmpeg/.cache/sources/ffmpeg'])(
    'rejects a corresponding-source archive missing %s',
    async (path) => {
        await rm(join(source, path), { recursive: true, force: true });
        await expect(verifySourceArchive(await packSource())).rejects.toThrow('missing');
    }
);

it('rejects a source archive containing the consumer artifact lock', async () => {
    await writeFile(join(source, 'ffmpeg/artifact-lock.json'), '{}');
    await expect(verifySourceArchive(await packSource())).rejects.toThrow('artifact-lock.json');
});

it('rejects source archives that do not pin the standalone package manager', async () => {
    await writeFile(join(source, 'package.json'), JSON.stringify({ packageManager: 'pnpm@latest' }));
    await expect(verifySourceArchive(await packSource())).rejects.toThrow('pin pnpm');
});

it('rejects symbolic links in corresponding-source archives', async () => {
    await symlink('LICENSE', join(source, 'license-link'));
    await expect(verifySourceArchive(await packSource())).rejects.toThrow('link or special file');
});

it('rejects multiple roots in corresponding-source archives', async () => {
    await writeFile(join(temporary, 'extra'), 'extra');
    const archive = join(temporary, 'source.tar.xz');
    await exec('tar', ['-cJf', archive, '-C', temporary, 'source', 'extra']);
    await expect(verifySourceArchive(archive)).rejects.toThrow('exactly one archive root');
});

it('accepts only the selected runtime directory', async () => {
    await mkdir(join(temporary, '0.1.0'));
    await writeFile(join(temporary, '0.1.0/ffmpeg-core.wasm'), 'WASM');
    const archive = join(temporary, 'runtime.tar.gz');
    await exec('tar', ['-czf', archive, '-C', temporary, '0.1.0']);
    await expect(verifyRuntimeArchive(archive, '0.1.0')).resolves.toContain('0.1.0/ffmpeg-core.wasm');
    await expect(verifyRuntimeArchive(archive, '0.2.0')).rejects.toThrow('unexpected version directory');
});

it('rejects unsafe archive paths before extraction', async () => {
    const archive = join(temporary, 'runtime.tar.gz');
    await exec('tar', ['-czf', archive, '--transform=s|^source|../source|', '-C', temporary, 'source']);
    await expect(verifyRuntimeArchive(archive, 'source')).rejects.toThrow('unsafe path');
});
