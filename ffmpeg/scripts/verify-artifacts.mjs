import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { packageRoot, readJson, runtimeFiles, sha256, verifyFile } from './lib.mjs';
import { archiveHasPath, validateSingleArchiveRoot, verifyArchiveEntryTypes } from './runtime-archive-validator.cjs';

const execFileAsync = promisify(execFile);
const candidate = process.argv.includes('--candidate');
const verifySource = process.argv.includes('--source');
const packageJson = candidate ? await readJson(resolve(packageRoot, 'package.json')) : undefined;
const config = candidate ? await readJson(resolve(packageRoot, 'build-config.json')) : undefined;
const lock = candidate ? undefined : await readJson(resolve(packageRoot, 'artifact-lock.json'));
const version = candidate ? packageJson.version : lock.runtimeVersion;
if (typeof version !== 'string' || version.length === 0) throw new Error('FFmpeg runtime version is missing');

const destination = resolve(packageRoot, 'dist', version);
const manifestPath = resolve(destination, 'manifest.json');
let manifest;
try {
    manifest = await readJson(manifestPath);
} catch {
    throw new Error(
        'FFmpeg ' + version + ' is not prepared. Run yarn fetch:ffmpeg:runtime or yarn build:ffmpeg:candidate.'
    );
}

const equalSet = (actual, expected) =>
    Array.isArray(actual) && JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
const equalRecord = (actual, expected) =>
    actual !== null &&
    typeof actual === 'object' &&
    expected !== null &&
    typeof expected === 'object' &&
    JSON.stringify(Object.entries(actual).sort(([a], [b]) => a.localeCompare(b))) ===
        JSON.stringify(Object.entries(expected).sort(([a], [b]) => a.localeCompare(b)));

if (manifest.schemaVersion !== 1 || manifest.runtimeVersion !== version || !manifest.ffmpeg) {
    throw new Error('FFmpeg manifest does not match the selected runtime version');
}

if (candidate) {
    if (
        manifest.ffmpeg.version !== config.ffmpeg.version ||
        manifest.ffmpeg.revision !== config.ffmpeg.revision ||
        manifest.ffmpeg.sourceSha256 !== config.ffmpeg.source.sha256
    ) {
        throw new Error('FFmpeg manifest does not match package.json and build-config.json');
    }
    if (
        manifest.toolchain?.emscriptenVersion !== config.toolchain.emscriptenVersion ||
        manifest.toolchain.container !== config.toolchain.container ||
        manifest.toolchain.platform !== config.toolchain.platform ||
        JSON.stringify(manifest.toolchain.bundler) !== JSON.stringify(config.toolchain.bundler)
    ) {
        throw new Error('Manifest toolchain does not match build-config.json');
    }
    if (!equalSet(manifest.linkedLibraries, config.nativeLibraries)) {
        throw new Error('Linked libraries do not match build-config.json');
    }
    if (!equalSet(manifest.operations, config.implementedOperations)) {
        throw new Error('Implemented operations do not match build-config.json');
    }
    if (JSON.stringify(manifest.limits) !== JSON.stringify(config.limits)) {
        throw new Error('Runtime limits do not match build-config.json');
    }
} else if (
    lock.schemaVersion !== 1 ||
    lock.runtimeVersion !== version ||
    lock.ffmpegVersion !== manifest.ffmpeg.version
) {
    throw new Error('Selected FFmpeg runtime does not match artifact-lock.json');
}

if (
    !Array.isArray(manifest.license?.notices) ||
    manifest.license.notices.some(
        (filename) =>
            typeof filename !== 'string' ||
            !filename.startsWith('notices/') ||
            filename.startsWith('/') ||
            filename.split(/[\\/]/).includes('..')
    )
) {
    throw new Error('FFmpeg manifest contains invalid license notice paths');
}
if (manifest.license.combined !== undefined) {
    throw new Error('FFmpeg manifest must describe licenses through its complete notice inventory');
}

for (const required of [
    '--disable-everything',
    '--disable-autodetect',
    '--disable-programs',
    '--disable-network',
    '--disable-pthreads',
    '--disable-gpl',
    '--disable-nonfree',
    '--disable-version3',
    '--disable-iconv',
    '--disable-avfilter',
    '--disable-swscale',
]) {
    if (!manifest.ffmpeg.configuration.includes(required)) {
        throw new Error('FFmpeg configuration is missing ' + required);
    }
}
for (const forbidden of [
    '--enable-network',
    '--enable-pthreads',
    '--enable-gpl',
    '--enable-nonfree',
    '--enable-version3',
]) {
    if (manifest.ffmpeg.configuration.includes(forbidden)) {
        throw new Error('FFmpeg configuration unexpectedly contains ' + forbidden);
    }
}
if (candidate && manifest.ffmpeg.configuration.includes('--enable-avutil')) {
    throw new Error('FFmpeg configuration must rely on --disable-everything to enable libavutil');
}
if (!/^LGPL version 2\.1 or later/.test(manifest.ffmpeg.license)) {
    throw new Error('Unexpected combined FFmpeg license: ' + manifest.ffmpeg.license);
}
if (manifest.ffmpeg.configuration.split(' ').some((argument) => argument.startsWith('--extra-version='))) {
    throw new Error('FFmpeg configuration must not override the upstream version identity');
}
if (!Number.isSafeInteger(manifest.limits?.maximumWasmBytes) || manifest.limits.maximumWasmBytes <= 0) {
    throw new Error('Manifest has an invalid WASM size limit');
}

const actualFiles = [...(await runtimeFiles(destination)), 'manifest.json'].sort();
if (!Array.isArray(manifest.runtime)) throw new Error('Manifest runtime file inventory is missing');
const declaredFiles = [...manifest.runtime.map(({ filename }) => filename), 'manifest.json'].sort();
if (JSON.stringify(actualFiles) !== JSON.stringify(declaredFiles)) {
    throw new Error('Runtime file inventory is incomplete');
}
const runtimeFilenames = new Set(manifest.runtime.map(({ filename }) => filename));
if (manifest.license.notices.some((filename) => !runtimeFilenames.has(filename))) {
    throw new Error('FFmpeg manifest license notices are missing from the runtime file inventory');
}
for (const entry of manifest.runtime) {
    if (
        typeof entry.filename !== 'string' ||
        entry.filename.startsWith('/') ||
        entry.filename.split(/[\\/]/).includes('..')
    ) {
        throw new Error('Runtime manifest contains an unsafe file path');
    }
    const path = resolve(destination, entry.filename);
    const fileStat = await stat(path);
    if (fileStat.size !== entry.bytes || (await sha256(path)) !== entry.sha256) {
        throw new Error('Runtime hash or size mismatch for ' + entry.filename);
    }
}

if (!candidate) {
    const selected = Object.fromEntries([
        ...manifest.runtime.map((entry) => [entry.filename, entry.sha256]),
        ['manifest.json', await sha256(manifestPath)],
    ]);
    if (!equalRecord(selected, lock.runtimeFiles)) {
        throw new Error('Runtime differs from artifact-lock.json');
    }
    await verifyFile(manifestPath, lock.manifestSha256);
    await verifyFile(resolve(packageRoot, 'release', lock.runtimeArchive.filename), lock.runtimeArchive.sha256);
}

if (verifySource) {
    if (!manifest.correspondingSource?.filename || !manifest.correspondingSource.sha256) {
        throw new Error('FFmpeg manifest does not identify its corresponding source');
    }
    if (
        !candidate &&
        (manifest.correspondingSource.filename !== lock.sourceArchive.filename ||
            manifest.correspondingSource.sha256 !== lock.sourceArchive.sha256)
    ) {
        throw new Error('Corresponding source differs from artifact-lock.json');
    }
    const sourcePath = resolve(packageRoot, 'release', manifest.correspondingSource.filename);
    await verifyFile(sourcePath, manifest.correspondingSource.sha256);
    if (!candidate) await verifyFile(sourcePath, lock.sourceArchive.sha256);
    const { stdout } = await execFileAsync('tar', ['-tJf', sourcePath], { maxBuffer: 64 * 1024 * 1024 });
    const paths = stdout.trim().split('\n').filter(Boolean);
    const archiveRoot = validateSingleArchiveRoot(paths, 'Corresponding-source archive');
    const { stdout: verboseListing } = await execFileAsync('tar', ['-tvJf', sourcePath], {
        maxBuffer: 64 * 1024 * 1024,
    });
    verifyArchiveEntryTypes(verboseListing, 'Corresponding-source archive');
    if (archiveHasPath(paths, archiveRoot, 'ffmpeg/artifact-lock.json')) {
        throw new Error('Corresponding-source archive contains artifact-lock.json');
    }
    if (archiveHasPath(paths, archiveRoot, '.yarn/releases/yarn-3.2.0.cjs')) {
        throw new Error('Corresponding-source archive contains the vendored Yarn release');
    }
    for (const required of [
        'LICENSE.md',
        'ffmpeg/build-config.json',
        'ffmpeg/native/runtime.cpp',
        'ffmpeg/.cache/sources/ffmpeg/',
    ]) {
        const present = archiveHasPath(paths, archiveRoot, required);
        if (!present) throw new Error('Corresponding-source archive is missing ' + required);
    }
    const { stdout: standalonePackageJson } = await execFileAsync('tar', [
        '-xOJf',
        sourcePath,
        `${archiveRoot}/package.json`,
    ]);
    if (JSON.parse(standalonePackageJson).packageManager !== 'yarn@3.2.0') {
        throw new Error('Corresponding-source archive must pin Yarn through packageManager');
    }
}

const wasmPath = resolve(destination, 'ffmpeg-core.wasm');
const wasm = new WebAssembly.Module(await readFile(wasmPath));
const exports = new Set(WebAssembly.Module.exports(wasm).map(({ name }) => name));
const glue = await readFile(resolve(destination, 'ffmpeg-core.js'), 'utf8');
for (const name of ['asb_runtime_info_json', 'asb_transcode_audio', 'asb_free', 'asb_last_error']) {
    if (!exports.has(name) && !glue.includes('_' + name)) throw new Error('WASM export ' + name + ' is missing');
}
const imports = WebAssembly.Module.imports(wasm).map(({ module: namespace, name }) => namespace + '.' + name);
if (imports.some((name) => /pthread|wasi.*thread/i.test(name))) throw new Error('WASM imports threading support');
for (const filename of ['ffmpeg-worker.js', 'ffmpeg-core.js']) {
    const source = await readFile(resolve(destination, filename), 'utf8');
    if (/https?:\/\/|unpkg\.com|new Function\s*\(|\beval\s*\(|@ffmpeg\/ffmpeg|ffprobe/.test(source)) {
        throw new Error(filename + ' contains a remote, dynamic, wrapper, or CLI path');
    }
}
const wasmBytes = (await stat(wasmPath)).size;
if (wasmBytes > manifest.limits.maximumWasmBytes) {
    throw new Error('FFmpeg WASM exceeds the configured size ceiling');
}

process.stdout.write(
    'Verified FFmpeg ' +
        version +
        (candidate ? ' candidate' : ' frozen runtime') +
        (verifySource ? ' and source' : '') +
        '\n'
);
