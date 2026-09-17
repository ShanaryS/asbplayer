import { access, mkdir, rename, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { download, packageRoot, readJson } from './lib.mjs';

const config = await readJson(resolve(packageRoot, 'build-config.json'));
const archives = resolve(packageRoot, '.cache', 'archives');
const sources = resolve(packageRoot, '.cache', 'sources');
const sourceEntries = [['ffmpeg', config.ffmpeg]];

const bundled = async (target) => {
    try {
        await access(resolve(target, '.asb-bundled-source'));
        return true;
    } catch {
        return false;
    }
};
const archiveName = (name, dependency) => {
    const extension = new URL(dependency.source.url).pathname.endsWith('.tar.xz') ? 'tar.xz' : 'tar.gz';
    return `${name}-${dependency.version}.${extension}`;
};
const entries = await Promise.all(
    sourceEntries.map(async ([name, dependency]) => ({
        name,
        dependency,
        archive: resolve(archives, archiveName(name, dependency)),
        destination: resolve(sources, name),
        bundled: await bundled(resolve(sources, name)),
    }))
);
await Promise.all(
    entries
        .filter(({ bundled }) => !bundled)
        .map(({ dependency, archive }) => download(dependency.source.url, archive, dependency.source.sha256))
);

const extract = async (archive, target) => {
    const staged = `${target}.staged`;
    await rm(staged, { recursive: true, force: true });
    await mkdir(staged, { recursive: true });
    await new Promise((resolvePromise, reject) => {
        const child = spawn('tar', ['-xf', archive, '--strip-components=1', '-C', staged], { stdio: 'inherit' });
        child.once('error', reject);
        child.once('exit', (code) => (code === 0 ? resolvePromise() : reject(new Error(`tar exited with ${code}`))));
    });
    await rm(target, { recursive: true, force: true });
    await mkdir(sources, { recursive: true });
    await rename(staged, target);
};

for (const entry of entries) {
    if (!entry.bundled) await extract(entry.archive, entry.destination);
}
