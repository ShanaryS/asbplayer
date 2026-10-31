import { diagnosticMessageLimit, diagnosticTextLimit } from '@project/ffmpeg/protocol';
import type {
    ExtractedSubtitle,
    FfmpegDiagnostic,
    FfmpegDiagnostics,
    FfmpegRuntimeInfo,
} from '@project/ffmpeg/protocol';
import type { InputReader } from '@project/ffmpeg/input-reader';

export type NativeModule = {
    _asb_runtime_info_json(): number;
    _asb_transcode_audio(inputSize: number, trackIndex: number): number;
    _asb_last_error(): number;
    _asb_extract_subtitles(inputSize: number, streamIndexes: number): number;
    _malloc(size: number): number;
    _free(pointer: number): void;
    stringToUTF8(value: string, pointer: number, size: number): void;
    lengthBytesUTF8(value: string): number;
    asbWriteSubtitleOutput?: (streamIndex: number, pointer: number, length: number) => number;
    HEAPU8: Uint8Array;
    UTF8ToString(pointer: number): string;
    asbWriteOutput: ((pointer: number, length: number) => number) | undefined;
    asbReadInput: ((offset: number, pointer: number, length: number) => number) | undefined;
    asbDiagnostic:
        | ((source: FfmpegDiagnostic['source'], level: FfmpegDiagnostic['level'], message: string) => void)
        | undefined;
};

export class NativeBridge {
    private constructor(private readonly module: NativeModule) {}

    static create(module: NativeModule) {
        for (const name of [
            '_asb_runtime_info_json',
            '_asb_transcode_audio',
            '_asb_last_error',
            '_asb_extract_subtitles',
            '_malloc',
            '_free',
            'stringToUTF8',
            'lengthBytesUTF8',
            'UTF8ToString',
        ] as const) {
            if (typeof module[name] !== 'function') throw new Error(`Native export ${name} is missing`);
        }
        if (!(module.HEAPU8 instanceof Uint8Array)) throw new Error('Native heap view is missing');
        return new NativeBridge(module);
    }

    inspect(): FfmpegRuntimeInfo {
        return JSON.parse(this.module.UTF8ToString(this.module._asb_runtime_info_json())) as FfmpegRuntimeInfo;
    }

    private collectDiagnostics(onDiagnostics: (diagnostics: FfmpegDiagnostics) => void) {
        const diagnostics: FfmpegDiagnostics = { messages: [], omittedMessages: 0 };
        this.module.asbDiagnostic = (source, level, text) => {
            const message = text.trim().slice(0, diagnosticTextLimit);
            if (message.length === 0) return;
            const previous = diagnostics.messages.at(-1);
            if (previous?.source === source && previous.level === level && previous.message === message) {
                previous.occurrences++;
                return;
            }
            if (diagnostics.messages.length === diagnosticMessageLimit) {
                diagnostics.omittedMessages += diagnostics.messages.shift()!.occurrences;
            }
            diagnostics.messages.push({ source, level, message, occurrences: 1 });
        };
        return () => {
            this.module.asbDiagnostic = undefined;
            try {
                onDiagnostics(diagnostics);
            } catch {
                // Diagnostics must not replace an operation result or its original failure.
            }
        };
    }

    private subtitles<T>(
        input: InputReader,
        operation: () => number,
        onDiagnostics: (diagnostics: FfmpegDiagnostics) => void,
        onChunk?: (streamIndex: number, chunk: ArrayBuffer) => void
    ): T {
        let callbackError: unknown;
        const finishDiagnostics = this.collectDiagnostics(onDiagnostics);
        this.module.asbReadInput = (offset, pointer, length) => {
            try {
                const bytes = input.readAt(offset, length);
                this.module.HEAPU8.set(bytes, pointer);
                return bytes.length;
            } catch (error) {
                callbackError = error;
                return -1;
            }
        };
        this.module.asbWriteSubtitleOutput = (index, pointer, length) => {
            try {
                if (!onChunk) throw new Error('Unexpected subtitle output');
                onChunk(index, this.module.HEAPU8.slice(pointer, pointer + length).buffer);
                return length;
            } catch (error) {
                callbackError = error;
                return -1;
            }
        };
        try {
            const pointer = operation();
            if (callbackError !== undefined) throw callbackError;
            if (!pointer) throw new Error(this.module.UTF8ToString(this.module._asb_last_error()));
            return JSON.parse(this.module.UTF8ToString(pointer)) as T;
        } finally {
            this.module.asbReadInput = undefined;
            this.module.asbWriteSubtitleOutput = undefined;
            finishDiagnostics();
        }
    }

    extractSubtitles(
        input: InputReader,
        streamIndexes: number[],
        onChunk: (streamIndex: number, chunk: ArrayBuffer) => void,
        onDiagnostics: (diagnostics: FfmpegDiagnostics) => void
    ): ExtractedSubtitle[] {
        const module = this.module;
        const indexes = streamIndexes.join(',');
        const size = module.lengthBytesUTF8(indexes) + 1;
        const pointer = module._malloc(size);
        if (!pointer) throw new Error('Could not allocate subtitle arguments');
        try {
            module.stringToUTF8(indexes, pointer, size);
            return this.subtitles(
                input,
                () => module._asb_extract_subtitles(input.size, pointer),
                onDiagnostics,
                onChunk
            );
        } finally {
            module._free(pointer);
        }
    }

    transcodeAudio(
        input: InputReader,
        trackIndex: number,
        onChunk: (chunk: ArrayBuffer) => void,
        onDiagnostics: (diagnostics: FfmpegDiagnostics) => void
    ): number {
        let readError: unknown;
        let outputError: unknown;
        let outputBytes = 0;
        const finishDiagnostics = this.collectDiagnostics(onDiagnostics);
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
            if (outputError !== undefined) throw outputError;
            if (!Number.isFinite(result) || result <= 0) {
                throw new Error(this.module.UTF8ToString(this.module._asb_last_error()));
            }
            if (outputBytes === 0) throw new Error('FFmpeg produced an empty audio output');
            return result;
        } finally {
            this.module.asbReadInput = undefined;
            this.module.asbWriteOutput = undefined;
            finishDiagnostics();
        }
    }
}
