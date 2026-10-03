/* eslint-disable @typescript-eslint/no-require-imports, no-undef */

const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { readFile, readdir } = require('node:fs/promises');
const { join } = require('node:path');
const { isDeepStrictEqual, promisify } = require('node:util');

const execFileAsync = promisify(execFile);

const clonePreviousDeployment = async (repository, destination) => {
    try {
        await execFileAsync('git', ['ls-remote', '--exit-code', '--heads', repository, 'refs/heads/gh-pages']);
    } catch (error) {
        // Git exits with 2 only when no matching branch exists. Access failures must still stop deployment.
        if (error.code === 2) return;
        throw error;
    }
    await execFileAsync('git', ['clone', '--depth=1', '--branch=gh-pages', repository, destination]);
};

const treeHashes = async (root) => {
    const hashes = {};
    const visit = async (directory, prefix = '') => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            const relative = `${prefix}${entry.name}`;
            const path = join(directory, entry.name);
            if (entry.isDirectory()) await visit(path, `${relative}/`);
            else if (entry.isFile())
                hashes[relative] = createHash('sha256')
                    .update(await readFile(path))
                    .digest('hex');
            else throw new Error(`Unexpected FFmpeg runtime file type: ${path}`);
        }
    };
    await visit(root);
    return hashes;
};

const prepareFfmpegDeployment = async (destination, previousRoot, lock) => {
    const outgoingEntries = await readdir(destination, { withFileTypes: true });
    if (
        outgoingEntries.length !== 1 ||
        !outgoingEntries[0].isDirectory() ||
        outgoingEntries[0].name !== lock.runtimeVersion
    ) {
        throw new Error('The deployment must contain only the selected FFmpeg runtime');
    }
    const selected = await treeHashes(join(destination, lock.runtimeVersion));
    if (!isDeepStrictEqual(selected, lock.runtimeFiles)) {
        throw new Error(`Built FFmpeg runtime ${lock.runtimeVersion} differs from its artifact lock`);
    }

    const previousEntries = await readdir(previousRoot, { withFileTypes: true }).catch((error) => {
        if (error.code === 'ENOENT') return [];
        throw error;
    });
    if (previousEntries.some((entry) => entry.isDirectory() && entry.name === lock.runtimeVersion)) {
        if (!isDeepStrictEqual(await treeHashes(join(previousRoot, lock.runtimeVersion)), selected)) {
            throw new Error(`Refusing to overwrite FFmpeg runtime ${lock.runtimeVersion} with different bytes`);
        }
    }
};

module.exports = { clonePreviousDeployment, prepareFfmpegDeployment };
