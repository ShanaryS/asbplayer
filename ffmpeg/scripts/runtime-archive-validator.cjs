/* eslint-disable @typescript-eslint/no-require-imports, no-undef */

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const MAX_ARCHIVE_LISTING_BYTES = 64 * 1024 * 1024;

const archivePathIsSafe = (path, expectedRoot) => {
    const components = path.split('/');
    return (
        (path === expectedRoot || path.startsWith(`${expectedRoot}/`)) &&
        !path.startsWith('/') &&
        !path.includes('\\') &&
        components.every((component) => component !== '' && component !== '.' && component !== '..')
    );
};

const validateArchivePaths = (paths, expectedRoot) => {
    if (!/^[A-Za-z0-9._-]+$/.test(expectedRoot)) {
        throw new Error('Runtime archive has an invalid expected root');
    }
    if (paths.some((listedPath) => !archivePathIsSafe(listedPath.replace(/\/$/, ''), expectedRoot))) {
        throw new Error('Runtime archive contains an unsafe or unexpected path');
    }
};

const validateSingleArchiveRoot = (paths, archiveDescription) => {
    const normalizedPaths = paths.map((listedPath) => listedPath.replace(/\/$/, ''));
    if (
        normalizedPaths.some((path) => {
            const components = path.split('/');
            return (
                path === '' ||
                path.startsWith('/') ||
                path.includes('\\') ||
                components.some((component) => component === '' || component === '.' || component === '..')
            );
        })
    ) {
        throw new Error(archiveDescription + ' contains an unsafe path');
    }

    const roots = new Set(normalizedPaths.map((path) => path.split('/')[0]));
    if (roots.size !== 1) throw new Error(archiveDescription + ' must contain exactly one archive root');
    const [root] = roots;
    if (!/^[A-Za-z0-9._-]+$/.test(root)) {
        throw new Error(archiveDescription + ' has an invalid archive root');
    }
    if (!paths.some((listedPath) => listedPath === root || listedPath === `${root}/`)) {
        throw new Error(archiveDescription + ' has no root directory');
    }
    return root;
};

const archiveHasPath = (paths, archiveRoot, relativePath) => {
    const target = `${archiveRoot}/${relativePath.replace(/\/$/, '')}`;
    const normalizedPaths = paths.map((listedPath) => listedPath.replace(/\/$/, ''));
    return relativePath.endsWith('/')
        ? normalizedPaths.some((path) => path === target || path.startsWith(`${target}/`))
        : normalizedPaths.includes(target);
};

const verifyArchiveEntryTypes = (listing, archiveDescription) => {
    const entries = listing.trim().split('\n').filter(Boolean);
    if (entries.some((entry) => !['d', '-'].includes(entry[0]))) {
        throw new Error(archiveDescription + ' contains a link or special file');
    }
};

const verifyRuntimeArchive = async (archivePath, expectedRoot) => {
    const { stdout: listing } = await execFileAsync('tar', ['-tzf', archivePath], {
        maxBuffer: MAX_ARCHIVE_LISTING_BYTES,
    });
    const paths = listing.trim().split('\n').filter(Boolean);
    validateArchivePaths(paths, expectedRoot);

    const { stdout: verboseListing } = await execFileAsync('tar', ['-tvzf', archivePath], {
        maxBuffer: MAX_ARCHIVE_LISTING_BYTES,
    });
    verifyArchiveEntryTypes(verboseListing, 'Runtime archive');
    return paths;
};

module.exports = { archiveHasPath, validateSingleArchiveRoot, verifyArchiveEntryTypes, verifyRuntimeArchive };
