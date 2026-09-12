import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { packageRoot, readJson, sha256, verifyFile } from './lib.mjs';

const versions = await readJson(resolve(packageRoot, 'versions.json'));
const declaredCapabilities = await readJson(resolve(packageRoot, 'capabilities.json'));
const destination = resolve(packageRoot, 'dist', versions.coreVersion);
const manifestPath = resolve(destination, 'manifest.json');

try {
    await access(manifestPath);
} catch {
    throw new Error(`FFmpeg ${versions.coreVersion} is not prepared. Run yarn fetch:ffmpeg or yarn build:ffmpeg.`);
}

const manifest = await readJson(manifestPath);
if (manifest.coreVersion !== versions.coreVersion || manifest.wrapperVersion !== versions.wrapperVersion) {
    throw new Error('FFmpeg manifest is incompatible with the selected source/wrapper versions');
}
if (JSON.stringify(manifest.capabilities) !== JSON.stringify(declaredCapabilities)) {
    throw new Error('FFmpeg manifest capabilities do not match capabilities.json');
}

for (const component of Object.values(declaredCapabilities.explicit)) {
    if (component.length !== 0) {
        throw new Error('The foundation runtime must not contain explicit media components');
    }
}
for (const entry of manifest.runtime) {
    const path = resolve(destination, entry.filename);
    const actualHash = await sha256(path);
    if (actualHash !== entry.sha256) {
        throw new Error(`Runtime hash mismatch for ${entry.filename}`);
    }
}

if (process.argv.includes('--source')) {
    const lock = await readJson(resolve(packageRoot, 'artifact-lock.json'));
    await verifyFile(resolve(packageRoot, 'release', lock.sourceArchive.name), lock.sourceArchive.sha256);
}

const glue = await readFile(resolve(destination, 'ffmpeg-core.js'), 'utf8');
if (/\bffprobe\b|new Function\s*\(|\beval\s*\(/.test(glue)) {
    throw new Error('Core glue contains ffprobe or dynamic code execution');
}
for (const filename of ['ffmpeg-wrapper.js', 'ffmpeg-worker.js']) {
    const source = await readFile(resolve(destination, filename), 'utf8');
    if (/https?:\/\/|unpkg\.com/.test(source)) {
        throw new Error(`${filename} contains a remote executable fallback`);
    }
}

process.stdout.write(`Verified FFmpeg runtime ${versions.coreVersion}\n`);
