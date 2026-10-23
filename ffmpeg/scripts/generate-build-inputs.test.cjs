/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
const { execFile } = require('node:child_process');
const { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { promisify } = require('node:util');
const config = require('../build-config.json');

const exec = promisify(execFile);
let repositoryRoot;
let temporary;
let configuration;
beforeEach(async () => {
    repositoryRoot = await mkdtemp(join(tmpdir(), 'asbplayer-build-inputs-'));
    temporary = join(repositoryRoot, 'ffmpeg');
    await mkdir(join(temporary, 'scripts'), { recursive: true });
    for (const script of ['lib.mjs', 'release-names.mjs', 'generate-build-inputs.mjs']) {
        await copyFile(join(__dirname, script), join(temporary, 'scripts', script));
    }
    configuration = structuredClone(config);
    await writeFile(join(temporary, 'package.json'), JSON.stringify({ version: '9.9.9' }));
    await writeFile(
        join(repositoryRoot, 'project.json'),
        JSON.stringify({
            version: '7.0.0',
            artifacts: { ffmpeg: { version: '1.2.3-rc.1', prefix: 'example-ffmpeg', tagPrefix: 'runtime-v' } },
        })
    );
});
afterEach(async () => {
    await rm(repositoryRoot, { recursive: true, force: true });
});
const generate = async () => {
    await writeFile(join(temporary, 'build-config.json'), JSON.stringify(configuration));
    return exec(process.execPath, [join(temporary, 'scripts/generate-build-inputs.mjs')]);
};

it('generates compiler inputs using the project runtime version independently of package and extension versions', async () => {
    await generate();
    const output = join(temporary, '.cache/build');
    expect(await readFile(join(output, 'asb-build-config.hpp'), 'utf8')).toContain(
        '#define ASB_RUNTIME_VERSION "1.2.3-rc.1"'
    );
    expect(await readFile(join(output, 'platform'), 'utf8')).toBe(`${config.toolchain.platform}\n`);
    const dockerArguments = await readFile(join(output, 'docker-build-args'), 'utf8');
    expect(dockerArguments.trim().split('\n')).toEqual([
        `ASB_EMSDK_IMAGE=${config.toolchain.container}`,
        `ASB_INITIAL_MEMORY_BYTES=${config.limits.initialMemoryBytes}`,
        `ASB_MAXIMUM_MEMORY_BYTES=${config.limits.maximumMemoryBytes}`,
        `ASB_STACK_BYTES=${config.limits.stackBytes}`,
    ]);
    const flags = (await readFile(join(output, 'ffmpeg-configure-args'), 'utf8')).trim().split('\n');
    expect(flags).toEqual(
        expect.arrayContaining([
            '--disable-all',
            '--disable-autodetect',
            '--disable-network',
            '--disable-pthreads',
            '--disable-iconv',
        ])
    );
    expect(flags.filter((flag) => flag.startsWith('--enable-')).sort()).toEqual(
        [
            '--enable-cross-compile',
            '--enable-small',
            '--enable-avcodec',
            '--enable-avformat',
            '--enable-swresample',
            '--enable-decoder=ac3',
            '--enable-decoder=eac3',
            '--enable-decoder=dca',
            '--enable-decoder=truehd',
            '--enable-decoder=mlp',
            '--enable-libopus',
            '--enable-encoder=libopus',
            '--enable-demuxer=matroska',
            '--enable-demuxer=mov',
            '--enable-muxer=webm',
            '--enable-parser=ac3',
            '--enable-parser=dca',
            '--enable-parser=mlp',
        ].sort()
    );
});

it.each([
    ['initialMemoryBytes', 0],
    ['maximumMemoryBytes', -1],
    ['stackBytes', Number.MAX_SAFE_INTEGER + 1],
])('rejects invalid %s before producing compiler inputs', async (field, value) => {
    configuration.limits[field] = value;
    await expect(generate()).rejects.toThrow('positive safe integer');
});
