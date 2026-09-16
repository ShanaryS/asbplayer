import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { fileInfo, packageRoot, readJson } from './lib.mjs';

const execFileAsync = promisify(execFile);
const packageJson = await readJson(resolve(packageRoot, 'package.json'));
const version = packageJson.version;
const release = resolve(packageRoot, 'release');
const runtimeName = `asbplayer-ffmpeg-${version}-runtime.tar.gz`;
const sourceName = `asbplayer-ffmpeg-${version}-source.tar.xz`;
await mkdir(release, { recursive: true });
await Promise.all(
    ['build-report.json', 'build-evidence.tar.xz'].map((name) => rm(resolve(release, name), { force: true }))
);
await execFileAsync('tar', [
    '--sort=name',
    '--mtime=UTC 2020-01-01',
    '--owner=0',
    '--group=0',
    '--numeric-owner',
    '--mode=a+rX,u+w,go-w',
    '-czf',
    resolve(release, runtimeName),
    '-C',
    resolve(packageRoot, 'dist'),
    version,
]);
const runtime = await fileInfo(resolve(release, runtimeName));
const source = await fileInfo(resolve(release, sourceName));
const manifestPath = resolve(packageRoot, 'dist', version, 'manifest.json');
await writeFile(resolve(release, 'manifest.json'), await readFile(manifestPath));
const releaseManifest = await fileInfo(resolve(release, 'manifest.json'));
await writeFile(
    resolve(release, 'SHA256SUMS'),
    `${[runtime, source, releaseManifest].map((entry) => `${entry.sha256}  ${entry.filename}`).join('\n')}\n`
);
process.stdout.write('Candidate release materials generated; artifact-lock.json was not modified.\n');
