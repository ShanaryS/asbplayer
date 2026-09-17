/* eslint-disable @typescript-eslint/no-require-imports, no-undef */

const { createHash } = require('node:crypto');
const { cp, readFile, readdir } = require('node:fs/promises');
const { join } = require('node:path');
const { isDeepStrictEqual } = require('node:util');

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
    // Verify the outgoing files before restoring any previously deployed versions.
    const selected = await treeHashes(join(destination, lock.runtimeVersion));
    if (!isDeepStrictEqual(selected, lock.runtimeFiles)) {
        throw new Error(`Built FFmpeg runtime ${lock.runtimeVersion} differs from artifact-lock.json`);
    }

    const previousEntries = await readdir(previousRoot, { withFileTypes: true }).catch((error) => {
        if (error.code === 'ENOENT') return [];
        throw error;
    });
    const previousVersions = new Set(previousEntries.filter((entry) => entry.isDirectory()).map((entry) => entry.name));
    const outgoingEntries = await readdir(destination, { withFileTypes: true });
    for (const entry of outgoingEntries) {
        if (!entry.isDirectory()) throw new Error(`Unexpected FFmpeg runtime entry: ${entry.name}`);
        if (previousVersions.has(entry.name)) {
            if (
                !isDeepStrictEqual(
                    await treeHashes(join(previousRoot, entry.name)),
                    await treeHashes(join(destination, entry.name))
                )
            ) {
                throw new Error(`Refusing to overwrite FFmpeg runtime ${entry.name} with different bytes`);
            }
        } else if (entry.name !== lock.runtimeVersion) {
            throw new Error(`FFmpeg runtime ${entry.name} is neither selected nor previously deployed`);
        }
    }

    const outgoingVersions = new Set(outgoingEntries.map((entry) => entry.name));
    for (const version of previousVersions) {
        if (outgoingVersions.has(version)) continue;
        await cp(join(previousRoot, version), join(destination, version), {
            recursive: true,
            force: false,
            errorOnExist: true,
        });
    }
};

module.exports = { prepareFfmpegDeployment };
