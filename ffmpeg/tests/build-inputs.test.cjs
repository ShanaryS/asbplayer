/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
const { execFile } = require('node:child_process');
const { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { promisify } = require('node:util');
const config = require('../build-config.json');

const exec = promisify(execFile);
let temporary;
let configuration;
beforeEach(async () => {
    temporary = await mkdtemp(join(tmpdir(), 'asbplayer-build-inputs-'));
    await mkdir(join(temporary, 'scripts'));
    for (const script of ['lib.mjs', 'generate-build-inputs.mjs']) {
        await copyFile(join(__dirname, '../scripts', script), join(temporary, 'scripts', script));
    }
    configuration = structuredClone(config);
    await writeFile(join(temporary, 'package.json'), JSON.stringify({ version: '1.2.3-rc.1' }));
});
afterEach(async () => {
    await rm(temporary, { recursive: true, force: true });
});
const generate = async () => {
    await writeFile(join(temporary, 'build-config.json'), JSON.stringify(configuration));
    return exec(process.execPath, [join(temporary, 'scripts/generate-build-inputs.mjs')]);
};

it('generates the configure flags, version header, platform, and memory arguments together', async () => {
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
            '--disable-everything',
            '--disable-network',
            '--disable-avcodec',
            '--disable-avformat',
            '--disable-pthreads',
            '--disable-gpl',
        ])
    );
    expect(
        flags.some(
            (flag) =>
                flag.startsWith('--enable-') &&
                !['--enable-cross-compile', '--enable-static', '--enable-small'].includes(flag)
        )
    ).toBe(false);
});

it.each([
    ['initialMemoryBytes', 0],
    ['maximumMemoryBytes', -1],
    ['stackBytes', Number.MAX_SAFE_INTEGER + 1],
])('rejects invalid %s before producing compiler inputs', async (field, value) => {
    configuration.limits[field] = value;
    await expect(generate()).rejects.toThrow('positive safe integer');
});
