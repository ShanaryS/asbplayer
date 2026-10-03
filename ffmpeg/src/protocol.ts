export type FfmpegLibraryInfo = {
    name: string;
    version: number;
    configuration: string;
    license: string;
};

export type FfmpegRuntimeInfo = {
    runtimeVersion: string;
    ffmpegVersion: string;
    ffmpegConfiguration: string;
    ffmpegLicense: string;
    linkedLibraries: string[];
    libraries: FfmpegLibraryInfo[];
    operations: string[];
};

type RequestBase = { sessionId: string; requestId: number };

export type FfmpegTranscodeProgress = {
    readonly stage: 'transcoding' | 'finalizing';
    /** Encoded media timeline, including any leading silence and timestamp gaps. */
    readonly processedSeconds: number;
    /** Estimated output timeline duration; undefined when the input has no duration metadata. */
    readonly totalSeconds: number | undefined;
};

export type WorkerRequest = RequestBase &
    (
        | { operation: 'initialize'; coreURL: string; wasmURL: string }
        | { operation: 'inspect' }
        | { operation: 'transcodeAudio'; input: Blob; trackIndex: number }
    );

export type WorkerRequestBody = WorkerRequest extends infer Request
    ? Request extends RequestBase
        ? Omit<Request, keyof RequestBase>
        : never
    : never;

export type FfmpegErrorCode = 'aborted' | 'disposed' | 'initialization' | 'native' | 'protocol' | 'unsupported';

const errorCodes = new Set<FfmpegErrorCode>([
    'aborted',
    'disposed',
    'initialization',
    'native',
    'protocol',
    'unsupported',
]);

export type WorkerReply = {
    sessionId: string;
    requestId: number;
} & (
    | { ok: true; result: unknown }
    | { ok: false; error: { code: FfmpegErrorCode; message: string } }
    | { type: 'progress'; progress: FfmpegTranscodeProgress }
);

export type WorkerReplyBody = WorkerReply extends infer Reply
    ? Reply extends { sessionId: string; requestId: number }
        ? Omit<Reply, 'sessionId' | 'requestId'>
        : never
    : never;

export const isWorkerReply = (value: unknown): value is WorkerReply => {
    if (typeof value !== 'object' || value === null) return false;
    const reply = value as Record<string, unknown>;
    if (typeof reply.sessionId !== 'string' || !Number.isSafeInteger(reply.requestId)) return false;
    if ('type' in reply) {
        if (reply.type !== 'progress') return false;
        if (typeof reply.progress !== 'object' || reply.progress === null || 'ok' in reply) return false;
        const progress = reply.progress as Record<string, unknown>;
        return (
            (progress.stage === 'transcoding' || progress.stage === 'finalizing') &&
            typeof progress.processedSeconds === 'number' &&
            Number.isFinite(progress.processedSeconds) &&
            progress.processedSeconds >= 0 &&
            'totalSeconds' in progress &&
            (progress.totalSeconds === undefined ||
                (typeof progress.totalSeconds === 'number' &&
                    Number.isFinite(progress.totalSeconds) &&
                    progress.totalSeconds > 0))
        );
    }
    if (reply.ok === true) return 'result' in reply;
    if (reply.ok !== false || typeof reply.error !== 'object' || reply.error === null) return false;
    const error = reply.error as Record<string, unknown>;
    return errorCodes.has(error.code as FfmpegErrorCode) && typeof error.message === 'string';
};
