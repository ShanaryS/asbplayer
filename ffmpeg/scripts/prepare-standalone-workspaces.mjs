import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const stageRoot = process.argv[2];
if (stageRoot === undefined) throw new Error('A standalone source staging root is required');

await writeFile(
    resolve(stageRoot, 'package.json'),
    `${JSON.stringify(
        {
            name: 'asbplayer-ffmpeg-source',
            private: true,
            workspaces: ['ffmpeg'],
            scripts: { 'build:ffmpeg': 'yarn workspace @project/ffmpeg build:runtime' },
            packageManager: 'yarn@3.2.0',
        },
        null,
        4
    )}\n`
);

const ffmpegPath = resolve(stageRoot, 'ffmpeg/package.json');
const ffmpeg = JSON.parse(await readFile(ffmpegPath, 'utf8'));
ffmpeg.scripts = {
    'build:runtime': ffmpeg.scripts['build:runtime'],
    'package:candidate': ffmpeg.scripts['package:candidate'],
    'verify:candidate': ffmpeg.scripts['verify:candidate'],
    'test:native': ffmpeg.scripts['test:native'],
};
ffmpeg.devDependencies = { esbuild: ffmpeg.devDependencies.esbuild };
await writeFile(ffmpegPath, `${JSON.stringify(ffmpeg, null, 4)}\n`);
