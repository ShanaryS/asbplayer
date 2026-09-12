import { readFile, writeFile } from 'node:fs/promises';

const path = process.argv[2];
const source = await readFile(path, 'utf8');
const sanitized = source.replace(
    /`https:\/\/unpkg\.com\/@ffmpeg\/core@\$\{CORE_VERSION\}\/dist\/umd\/ffmpeg-core\.js`/g,
    '`./ffmpeg-core.js`'
);
if (/https?:\/\/|unpkg\.com/.test(sanitized)) {
    throw new Error('Could not remove the upstream remote-core fallback from the packaged wrapper asset');
}
await writeFile(path, sanitized);
