import { execFile } from 'node:child_process';
import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { publish } from 'gh-pages';

const execFileAsync = promisify(execFile);
const temporary = await mkdtemp(join(tmpdir(), 'asbplayer-gh-pages-'));
try {
    const { stdout: repository } = await execFileAsync('git', ['remote', 'get-url', 'origin']);
    await execFileAsync('git', ['clone', '--depth=1', '--branch=gh-pages', repository.trim(), temporary]);
    const previousFfmpeg = resolve(temporary, 'ffmpeg');
    const destination = resolve('dist', 'ffmpeg');
    for (const version of await readdir(previousFfmpeg).catch(() => [])) {
        await cp(resolve(previousFfmpeg, version), resolve(destination, version), {
            recursive: true,
            force: false,
            errorOnExist: false,
        });
    }
    await publish('dist');
} finally {
    await rm(temporary, { recursive: true, force: true });
}
