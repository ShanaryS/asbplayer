import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { publish } from 'gh-pages';

const execFileAsync = promisify(execFile);
const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const treeHashes = async (root) => {
    const hashes = {};
    const visit = async (directory, prefix = '') => {
        for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
            a.name.localeCompare(b.name)
        )) {
            const relative = join(prefix, entry.name);
            if (entry.isDirectory()) await visit(join(directory, entry.name), relative);
            else
                hashes[relative] = createHash('sha256')
                    .update(await readFile(join(directory, entry.name)))
                    .digest('hex');
        }
    };
    await visit(root);
    return hashes;
};
const temporary = await mkdtemp(join(tmpdir(), 'asbplayer-gh-pages-'));
try {
    await execFileAsync(process.execPath, [resolve(clientRoot, '../ffmpeg/scripts/verify-artifacts.mjs')]);
    const { stdout: repository } = await execFileAsync('git', ['remote', 'get-url', 'origin']);
    await execFileAsync('git', ['clone', '--depth=1', '--branch=gh-pages', repository.trim(), temporary]);
    const previousFfmpeg = resolve(temporary, 'ffmpeg');
    const destination = resolve(clientRoot, 'dist', 'ffmpeg');
    for (const version of await readdir(previousFfmpeg).catch((error) => {
        if (error.code === 'ENOENT') return [];
        throw error;
    })) {
        const previous = resolve(previousFfmpeg, version);
        if (!(await stat(previous)).isDirectory()) continue;
        const selected = resolve(destination, version);
        try {
            if ((await stat(selected)).isDirectory()) {
                if (JSON.stringify(await treeHashes(previous)) !== JSON.stringify(await treeHashes(selected))) {
                    throw new Error(`Refusing to overwrite FFmpeg runtime ${version} with different bytes`);
                }
                continue;
            }
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
        await cp(previous, selected, {
            recursive: true,
            force: false,
            errorOnExist: true,
        });
    }
    await new Promise((resolvePromise, reject) => {
        publish(resolve(clientRoot, 'dist'), (error) => (error ? reject(error) : resolvePromise()));
    });
} finally {
    await rm(temporary, { recursive: true, force: true });
}
