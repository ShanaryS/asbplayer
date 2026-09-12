import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));

export const sha256 = async (path) => {
    const hash = createHash('sha256');
    await pipeline(createReadStream(path), hash);
    return hash.digest('hex');
};

export const verifyFile = async (path, expectedHash) => {
    const actualHash = await sha256(path);
    if (!expectedHash || actualHash !== expectedHash) {
        throw new Error(`SHA-256 mismatch for ${path}: expected ${expectedHash || '<missing>'}, got ${actualHash}`);
    }
};

export const download = async (url, destination, expectedHash) => {
    await mkdir(dirname(destination), { recursive: true });
    try {
        await verifyFile(destination, expectedHash);
        return;
    } catch {
        // Missing and invalid cache entries are replaced atomically below.
    }

    const temporary = `${destination}.part`;
    await rm(temporary, { force: true });
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok || response.body === null) {
        throw new Error(`Could not download ${url}: HTTP ${response.status}`);
    }
    await pipeline(response.body, createWriteStream(temporary, { flags: 'wx' }));
    await verifyFile(temporary, expectedHash);
    await rename(temporary, destination);
};

export const fileInfo = async (path) => ({
    filename: basename(path),
    bytes: (await stat(path)).size,
    sha256: await sha256(path),
});
