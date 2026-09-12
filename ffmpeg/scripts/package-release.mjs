import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { fileInfo, packageRoot, readJson } from './lib.mjs';

const execFileAsync = promisify(execFile);
const versions = await readJson(resolve(packageRoot, 'versions.json'));
const version = versions.coreVersion;
const release = resolve(packageRoot, 'release');
const runtimeName = `asbplayer-ffmpeg-${version}-runtime.tar.gz`;
const sourceName = `asbplayer-ffmpeg-${version}-source.tar.xz`;
await mkdir(release, { recursive: true });
await execFileAsync('tar', [
    '--sort=name',
    '--mtime=UTC 2020-01-01',
    '--owner=0',
    '--group=0',
    '--numeric-owner',
    '-czf',
    resolve(release, runtimeName),
    '-C',
    resolve(packageRoot, 'dist'),
    version,
]);

const runtime = await fileInfo(resolve(release, runtimeName));
const source = await fileInfo(resolve(release, sourceName));
const manifest = await readJson(resolve(packageRoot, 'dist', version, 'manifest.json'));
const totalRuntimeBytes = manifest.runtime.reduce((total, entry) => total + entry.bytes, 0);
const buildReport = {
    coreVersion: version,
    generatedAt: new Date().toISOString(),
    reproducibleBuildVerified: false,
    wasmBytes: manifest.runtime.find((entry) => entry.filename === 'ffmpeg-core.wasm').bytes,
    totalRuntimeBytes,
    compressedRuntimeBytes: runtime.bytes,
    runtime,
    source,
};
await writeFile(resolve(release, 'build-report.json'), `${JSON.stringify(buildReport, null, 2)}\n`);
await writeFile(
    resolve(release, 'SHA256SUMS'),
    `${runtime.sha256}  ${runtime.filename}\n${source.sha256}  ${source.filename}\n`
);

const lockPath = resolve(packageRoot, 'artifact-lock.json');
const lock = await readJson(lockPath);
lock.runtimeArchive = { name: runtimeName, sha256: runtime.sha256 };
lock.sourceArchive = { name: sourceName, sha256: source.sha256 };
lock.runtime = Object.fromEntries(manifest.runtime.map((entry) => [entry.filename, entry.sha256]));
await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

// Keep release copies byte-identical to the files consumers inspect.
await writeFile(
    resolve(release, 'manifest.json'),
    await readFile(resolve(packageRoot, 'dist', version, 'manifest.json'))
);
