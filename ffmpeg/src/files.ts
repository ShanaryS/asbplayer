import type { FfmpegClient } from '@project/ffmpeg/types';

export type MountedInput = {
    readonly path: string;
    dispose(): Promise<void>;
};

let mountSequence = 0;

export const mountInput = async (ffmpeg: FfmpegClient, input: Blob): Promise<MountedInput> => {
    const directory = `/asbplayer-input-${mountSequence++}`;
    const filename = 'input';
    const file =
        input instanceof File && input.name === filename ? input : new File([input], filename, { type: input.type });
    let mounted = false;
    let disposed = false;

    await ffmpeg.createDir(directory);
    try {
        await ffmpeg.mount('WORKERFS', { files: [file] }, directory);
        mounted = true;
    } catch (error) {
        await ffmpeg.deleteDir(directory).catch(() => false);
        throw error;
    }

    return {
        path: `${directory}/${filename}`,
        async dispose() {
            if (disposed) {
                return;
            }
            disposed = true;
            if (mounted) {
                try {
                    await ffmpeg.unmount(directory);
                } finally {
                    await ffmpeg.deleteDir(directory);
                }
                return;
            }
            await ffmpeg.deleteDir(directory);
        },
    };
};

export const withMountedInput = async <T>(
    ffmpeg: FfmpegClient,
    input: Blob,
    operation: (path: string) => Promise<T>
): Promise<T> => {
    const mounted = await mountInput(ffmpeg, input);
    try {
        return await operation(mounted.path);
    } finally {
        await mounted.dispose();
    }
};

export const deleteOutput = async (ffmpeg: FfmpegClient, path: string) => {
    await ffmpeg.deleteFile(path);
};
