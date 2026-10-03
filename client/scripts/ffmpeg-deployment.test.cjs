/** @jest-environment node */
/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
const { mkdtemp, mkdir, readFile, readdir, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { clonePreviousDeployment, prepareFfmpegDeployment } = require('./ffmpeg-deployment.cjs');

const execFileAsync = promisify(execFile);

const repository = async () => {
    const path = join(directory, 'repository');
    await execFileAsync('git', ['init', '--initial-branch=main', path]);
    await writeFile(join(path, 'index.html'), 'previous app');
    await commit(path);
    return path;
};

const commit = async (path) => {
    await execFileAsync('git', ['-C', path, 'add', '.']);
    await execFileAsync('git', [
        '-C',
        path,
        '-c',
        'user.name=Deployment test',
        '-c',
        'user.email=deployment@example.test',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-m',
        'Prepare deployment fixture',
    ]);
};

let directory;
beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'asbplayer-ffmpeg-deployment-test-'));
});
afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
});

const runtime = async (root, version, contents = version) => {
    await mkdir(join(root, version), { recursive: true });
    await writeFile(join(root, version, 'ffmpeg-worker.js'), contents);
    return {
        runtimeVersion: version,
        runtimeFiles: { 'ffmpeg-worker.js': createHash('sha256').update(contents).digest('hex') },
    };
};

it('allows a first deployment containing only the selected runtime', async () => {
    const destination = join(directory, 'dist');
    const selected = await runtime(destination, '0.3.0');
    const previous = join(directory, 'previous');
    await clonePreviousDeployment(await repository(), previous);
    await prepareFfmpegDeployment(destination, join(previous, 'ffmpeg'), selected);
    expect(await readdir(destination)).toEqual(['0.3.0']);
});

it('rejects repository access failures instead of treating them as a first deployment', async () => {
    await expect(
        clonePreviousDeployment(join(directory, 'missing-repository'), join(directory, 'previous'))
    ).rejects.toThrow();
});

it('does not restore retired runtimes from the previous deployment', async () => {
    const destination = join(directory, 'dist');
    const previous = join(directory, 'previous');
    const selected = await runtime(destination, '0.3.0');
    await runtime(previous, '0.1.0');
    await runtime(previous, '0.2.0');
    await prepareFfmpegDeployment(destination, previous, selected);
    expect(await readdir(destination)).toEqual(['0.3.0']);
});

it('rejects corrupted selected files before deployment', async () => {
    const destination = join(directory, 'dist');
    const selected = await runtime(destination, '0.2.0');
    await writeFile(join(destination, '0.2.0', 'ffmpeg-worker.js'), 'corrupted');
    await expect(prepareFfmpegDeployment(destination, join(directory, 'missing'), selected)).rejects.toThrow(
        /artifact lock/
    );
});

it('refuses to replace an already deployed version with different bytes', async () => {
    const destination = join(directory, 'dist');
    const previous = join(directory, 'previous');
    const selected = await runtime(destination, '0.1.0', 'outgoing');
    const remote = await repository();
    await execFileAsync('git', ['-C', remote, 'checkout', '-b', 'gh-pages']);
    await runtime(join(remote, 'ffmpeg'), '0.1.0', 'deployed');
    await commit(remote);
    await clonePreviousDeployment(remote, previous);
    await expect(prepareFfmpegDeployment(destination, join(previous, 'ffmpeg'), selected)).rejects.toThrow(
        /Refusing to overwrite/
    );
    expect(await readFile(join(previous, 'ffmpeg', '0.1.0', 'ffmpeg-worker.js'), 'utf8')).toBe('deployed');
});

it('rejects unverified candidate directories in the outgoing build', async () => {
    const destination = join(directory, 'dist');
    const selected = await runtime(destination, '0.1.0');
    await runtime(destination, '0.2.0');
    await expect(prepareFfmpegDeployment(destination, join(directory, 'missing'), selected)).rejects.toThrow(
        /only the selected/
    );
});
