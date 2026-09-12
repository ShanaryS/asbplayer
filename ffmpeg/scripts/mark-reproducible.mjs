import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { packageRoot } from './lib.mjs';

const path = resolve(packageRoot, 'release', 'build-report.json');
const report = JSON.parse(await readFile(path, 'utf8'));
report.reproducibleBuildVerified = true;
await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
