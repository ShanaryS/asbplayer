import { mountInput, withMountedInput } from '@project/ffmpeg';
import type { FfmpegClient } from '@project/ffmpeg';

const client = () =>
    ({
        createDir: jest.fn(async () => true),
        deleteDir: jest.fn(async () => true),
        mount: jest.fn(async () => true),
        unmount: jest.fn(async () => true),
    }) as unknown as FfmpegClient;

describe('FFmpeg WORKERFS inputs', () => {
    it('mounts a browser blob without reading it into an ArrayBuffer', async () => {
        const ffmpeg = client();
        const input = new Blob(['small fixture'], { type: 'video/test' });
        const arrayBuffer = jest.fn();
        Object.defineProperty(input, 'arrayBuffer', { value: arrayBuffer });
        const mounted = await mountInput(ffmpeg, input);

        expect(arrayBuffer).not.toHaveBeenCalled();
        expect(ffmpeg.mount).toHaveBeenCalledWith(
            'WORKERFS',
            { files: [expect.objectContaining({ name: 'input' })] },
            expect.stringMatching(/^\/asbplayer-input-/)
        );
        expect(mounted.path).toMatch(/\/input$/);
        await mounted.dispose();
        await mounted.dispose();
        expect(ffmpeg.unmount).toHaveBeenCalledTimes(1);
        expect(ffmpeg.deleteDir).toHaveBeenCalledTimes(1);
    });

    it('always unmounts after a failed operation', async () => {
        const ffmpeg = client();
        await expect(
            withMountedInput(ffmpeg, new Blob(['fixture']), async () => {
                throw new Error('operation failed');
            })
        ).rejects.toThrow('operation failed');
        expect(ffmpeg.unmount).toHaveBeenCalledTimes(1);
        expect(ffmpeg.deleteDir).toHaveBeenCalledTimes(1);
    });
});
