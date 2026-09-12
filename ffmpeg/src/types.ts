export type FfmpegEventType = 'log' | 'progress';

export type FfmpegEventCallback = (event: unknown) => void;

export type FfmpegLoadConfig = {
    classWorkerURL: string;
    coreURL: string;
    wasmURL: string;
};

export type FfmpegFileSystemType = 'WORKERFS';

export interface FfmpegClient {
    readonly loaded: boolean;
    load(config: FfmpegLoadConfig, options?: { signal?: AbortSignal }): Promise<boolean>;
    exec(args: string[], timeout?: number, options?: { signal?: AbortSignal }): Promise<number>;
    on(event: FfmpegEventType, callback: FfmpegEventCallback): void;
    off(event: FfmpegEventType, callback: FfmpegEventCallback): void;
    createDir(path: string): Promise<boolean>;
    deleteDir(path: string): Promise<boolean>;
    deleteFile(path: string): Promise<boolean>;
    mount(type: FfmpegFileSystemType, options: { files: File[] }, mountPoint: string): Promise<boolean>;
    unmount(mountPoint: string): Promise<boolean>;
    terminate(): void;
}

export type FfmpegConstructor = new () => FfmpegClient;
