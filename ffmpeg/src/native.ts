import type { FfmpegRuntimeInfo, FfmpegTranscodeProgress } from '@project/ffmpeg/protocol';
import type { InputReader } from '@project/ffmpeg/input-reader';

export type NativeModule = {
    _asb_runtime_info_json(): number;
    _asb_transcode_audio(inputSize: number, trackIndex: number): number;
    _asb_last_error(): number;
    _malloc(size: number): number;
    _free(pointer: number): void;
    HEAPU8: Uint8Array;
    HEAPU32: Uint32Array;
    UTF8ToString(pointer: number): string;
    asbWriteOutput: ((pointer: number, length: number) => number) | undefined;
    asbReadInput?: (offset: number, pointer: number, length: number) => number;
    /** Installed for each conversion and cleared after native resources have been released. */
    asbReportProgress: ((processedSeconds: number, totalSeconds: number, finalizing: number) => void) | undefined;
};

export class NativeBridge {
    private constructor(private readonly module: NativeModule) {}

    static create(module: NativeModule) {
        for (const name of [
            '_asb_runtime_info_json',
            '_asb_transcode_audio',
            '_asb_last_error',
            '_malloc',
            '_free',
            'UTF8ToString',
        ] as const) {
            if (typeof module[name] !== 'function') throw new Error(`Native export ${name} is missing`);
        }
        if (!(module.HEAPU8 instanceof Uint8Array) || !(module.HEAPU32 instanceof Uint32Array)) {
            throw new Error('Native heap views are missing');
        }
        return new NativeBridge(module);
    }

    inspect(): FfmpegRuntimeInfo {
        return JSON.parse(this.module.UTF8ToString(this.module._asb_runtime_info_json())) as FfmpegRuntimeInfo;
    }

    transcodeAudio(
        input: InputReader,
        trackIndex: number,
        onProgress: (progress: FfmpegTranscodeProgress) => void,
        onChunk: (chunk: ArrayBuffer) => void
    ): number {
        let readError: unknown;
        let progressError: unknown;
        let outputError: unknown;
        let outputBytes = 0;
        this.module.asbWriteOutput = (pointer, length) => {
            if (outputError !== undefined) return -1;
            try {
                const chunk = this.module.HEAPU8.slice(pointer, pointer + length).buffer;
                onChunk(chunk);
                outputBytes += length;
                return length;
            } catch (error) {
                outputError = error;
                return -1;
            }
        };
        this.module.asbReportProgress = (processedSeconds, totalSeconds, finalizing) => {
            // Keep callbacks from unwinding through WASM and bypassing native resource cleanup.
            if (progressError !== undefined) return;
            try {
                onProgress({
                    stage: finalizing ? 'finalizing' : 'transcoding',
                    processedSeconds,
                    totalSeconds: totalSeconds > 0 ? totalSeconds : undefined,
                });
            } catch (error) {
                progressError = error;
            }
        };
        this.module.asbReadInput = (offset, pointer, length) => {
            try {
                const bytes = input.readAt(offset, length);
                this.module.HEAPU8.set(bytes, pointer);
                return bytes.byteLength;
            } catch (error) {
                readError = error;
                return -1;
            }
        };
        try {
            const result = this.module._asb_transcode_audio(input.size, trackIndex);
            if (readError !== undefined) throw readError;
            if (progressError !== undefined) throw progressError;
            if (outputError !== undefined) throw outputError;
            if (!Number.isFinite(result) || result <= 0)
                throw new Error(this.module.UTF8ToString(this.module._asb_last_error()));
            if (outputBytes === 0) throw new Error('FFmpeg produced an empty audio output');
            return result;
        } finally {
            this.module.asbReadInput = undefined;
            this.module.asbReportProgress = undefined;
            this.module.asbWriteOutput = undefined;
        }
    }
}
