import { createWriteStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { isDeepStrictEqual, promisify } from 'node:util';
import { pipeline } from 'node:stream/promises';
import { packageRoot, readJson, runtimeFiles, sha256 } from './lib.mjs';

const execFileAsync = promisify(execFile);

const fetchAsset = async (baseUrl, filename, destination) => {
    const url = `${baseUrl}/${filename}`;
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok || response.body === null) throw new Error(`Could not download ${url}: HTTP ${response.status}`);
    await pipeline(response.body, createWriteStream(destination, { flags: 'wx' }));
};

const parseChecksums = (text, filenames) => {
    const checksums = new Map();
    for (const line of text.trim().split('\n')) {
        const match = /^([a-f0-9]{64}) {2}([A-Za-z0-9._-]+)$/.exec(line);
        if (!match || checksums.has(match[2]))
            throw new Error('Published SHA256SUMS has an invalid or duplicate entry');
        checksums.set(match[2], match[1]);
    }
    if (checksums.size !== filenames.length || filenames.some((filename) => !checksums.has(filename))) {
        throw new Error('Published SHA256SUMS does not cover exactly the release assets');
    }
    return checksums;
};

const verifyArchivePaths = (paths, expectedRoot) => {
    for (const listedPath of paths) {
        const path = listedPath.replace(/\/$/, '');
        const components = path.split('/');
        if (
            !path ||
            path.startsWith('/') ||
            path.includes('\\') ||
            components.some((component) => component === '' || component === '..') ||
            !(path === expectedRoot || path.startsWith(`${expectedRoot}/`))
        ) {
            throw new Error('Published runtime archive contains an unsafe or unexpected path');
        }
    }
};

const verifyRuntimeArchive = async (archivePath, extractionRoot, version, publishedManifestPath) => {
    const { stdout: listing } = await execFileAsync('tar', ['-tzf', archivePath], { maxBuffer: 64 * 1024 * 1024 });
    const paths = listing.trim().split('\n').filter(Boolean);
    verifyArchivePaths(paths, version);
    const { stdout: verboseListing } = await execFileAsync('tar', ['-tvzf', archivePath], {
        maxBuffer: 64 * 1024 * 1024,
    });
    if (
        verboseListing
            .trim()
            .split('\n')
            .some((entry) => !/^[d-]/.test(entry))
    ) {
        throw new Error('Published runtime archive contains a link or special file');
    }
    await mkdir(extractionRoot, { recursive: true });
    await execFileAsync('tar', ['-xzf', archivePath, '-C', extractionRoot]);

    const runtimeRoot = resolve(extractionRoot, version);
    const rootStat = await lstat(runtimeRoot);
    if (!rootStat.isDirectory()) throw new Error('Published runtime archive has no version directory');
    const manifestPath = resolve(runtimeRoot, 'manifest.json');
    const manifestHash = await sha256(manifestPath);
    if (manifestHash !== (await sha256(publishedManifestPath))) {
        throw new Error('Runtime archive manifest differs from the published manifest asset');
    }

    const manifest = await readJson(manifestPath);
    if (
        manifest.schemaVersion !== 1 ||
        manifest.runtimeVersion !== version ||
        typeof manifest.ffmpeg?.version !== 'string' ||
        typeof manifest.ffmpeg.configuration !== 'string' ||
        !Array.isArray(manifest.runtime)
    ) {
        throw new Error('Published runtime manifest has an invalid identity or inventory');
    }
    if (manifest.ffmpeg.configuration.split(' ').some((argument) => argument.startsWith('--extra-version='))) {
        throw new Error('Published runtime overrides the upstream FFmpeg version identity');
    }

    const declaredFiles = manifest.runtime.map(({ filename }) => filename);
    if (
        declaredFiles.some(
            (filename) =>
                typeof filename !== 'string' ||
                filename === 'manifest.json' ||
                filename.startsWith('/') ||
                filename.includes('\\') ||
                filename.split('/').some((component) => component === '' || component === '..')
        ) ||
        new Set(declaredFiles).size !== declaredFiles.length
    ) {
        throw new Error('Published runtime manifest contains an unsafe or duplicate file path');
    }

    const actualFiles = await runtimeFiles(runtimeRoot);
    const expectedFiles = [...declaredFiles].sort();
    if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
        throw new Error('Published runtime archive does not match its manifest inventory');
    }
    for (const entry of manifest.runtime) {
        const path = resolve(runtimeRoot, entry.filename);
        const fileStat = await lstat(path);
        if (!fileStat.isFile() || fileStat.size !== entry.bytes || (await sha256(path)) !== entry.sha256) {
            throw new Error(`Published runtime hash or size mismatch for ${entry.filename}`);
        }
    }
    return manifest;
};

const verifySourceArchive = async (archivePath) => {
    const { stdout: listing } = await execFileAsync('tar', ['-tJf', archivePath], { maxBuffer: 64 * 1024 * 1024 });
    const paths = listing.trim().split('\n').filter(Boolean);
    if (
        paths.some((listedPath) => {
            const path = listedPath.replace(/\/$/, '');
            return (
                path.startsWith('/') ||
                path.includes('\\') ||
                path.split('/').some((component) => component === '' || component === '..')
            );
        })
    ) {
        throw new Error('Published source archive contains an unsafe path');
    }
    for (const required of ['ffmpeg/build-config.json', 'ffmpeg/native/runtime.cpp', 'ffmpeg/.cache/sources/ffmpeg/']) {
        if (!paths.some((path) => path.includes(required))) {
            throw new Error('Published corresponding-source archive is missing ' + required);
        }
    }
};

const selectRuntime = async () => {
    const packageJson = await readJson(resolve(packageRoot, 'package.json'));
    const version = packageJson.version;
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
        throw new Error('FFmpeg runtime version is invalid: ' + version);
    }

    const runtimeFilename = `asbplayer-ffmpeg-${version}-runtime.tar.gz`;
    const sourceFilename = `asbplayer-ffmpeg-${version}-source.tar.xz`;
    const filenames = [runtimeFilename, sourceFilename, 'manifest.json', 'SHA256SUMS'];
    const releaseBaseUrl = `https://github.com/asbplayer/asbplayer/releases/download/ffmpeg-v${version}`;
    const temporaryRoot = await mkdtemp(resolve(tmpdir(), 'asbplayer-ffmpeg-release-'));
    const downloads = Object.fromEntries(filenames.map((filename) => [filename, resolve(temporaryRoot, filename)]));

    try {
        await Promise.all(filenames.map((filename) => fetchAsset(releaseBaseUrl, filename, downloads[filename])));
        const sums = parseChecksums(await readFile(downloads['SHA256SUMS'], 'utf8'), filenames.slice(0, 3));
        for (const filename of filenames.slice(0, 3)) {
            const actual = await sha256(downloads[filename]);
            if (actual !== sums.get(filename)) throw new Error(`Published SHA-256 mismatch for ${filename}`);
        }

        const manifest = await verifyRuntimeArchive(
            downloads[runtimeFilename],
            resolve(temporaryRoot, 'extracted'),
            version,
            downloads['manifest.json']
        );
        if (
            manifest.correspondingSource?.filename !== sourceFilename ||
            manifest.correspondingSource.sha256 !== sums.get(sourceFilename)
        ) {
            throw new Error('Published source archive does not match the runtime manifest');
        }
        await verifySourceArchive(downloads[sourceFilename]);

        const lock = {
            schemaVersion: 1,
            runtimeVersion: version,
            ffmpegVersion: manifest.ffmpeg.version,
            releaseBaseUrl,
            runtimeArchive: { filename: runtimeFilename, sha256: sums.get(runtimeFilename) },
            sourceArchive: { filename: sourceFilename, sha256: sums.get(sourceFilename) },
            manifestSha256: sums.get('manifest.json'),
            runtimeFiles: Object.fromEntries([
                ...manifest.runtime.map((entry) => [entry.filename, entry.sha256]),
                ['manifest.json', sums.get('manifest.json')],
            ]),
        };

        const lockPath = resolve(packageRoot, 'artifact-lock.json');
        const previous = await readJson(lockPath);
        if (previous.runtimeVersion === version && !isDeepStrictEqual(previous, lock)) {
            throw new Error(
                'Published FFmpeg ' + version + ' bytes are immutable; bump the runtime version before recording'
            );
        }

        const lockTemporary = resolve(packageRoot, `.artifact-lock-${process.pid}.tmp`);
        try {
            await writeFile(lockTemporary, JSON.stringify(lock, null, 4) + '\n');
            await rename(lockTemporary, lockPath);
        } finally {
            await rm(lockTemporary, { force: true });
        }
        process.stdout.write(
            'Selected published FFmpeg runtime ' + version + '; inspect and commit artifact-lock.json explicitly.\n'
        );
    } finally {
        await rm(temporaryRoot, { recursive: true, force: true });
    }
};

await selectRuntime();
