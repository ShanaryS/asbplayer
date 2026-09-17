import type { FfmpegRuntimeInfo } from '@project/ffmpeg/protocol';

export type NativeModule = {
    _asb_runtime_info_json(): number;
    _asb_transcode_audio(
        input: number,
        inputSize: number,
        trackIndex: number,
        outputPointer: number,
        outputSize: number
    ): number;
    _asb_free(pointer: number): void;
    _asb_last_error(): number;
    _malloc(size: number): number;
    _free(pointer: number): void;
    HEAPU8: Uint8Array;
    HEAPU32: Uint32Array;
    UTF8ToString(pointer: number): string;
};

export class NativeBridge {
    private constructor(private readonly module: NativeModule) {}

    static create(module: NativeModule) {
        if (typeof module._asb_runtime_info_json !== 'function') {
            throw new Error('Native export _asb_runtime_info_json is missing');
        }
        return new NativeBridge(module);
    }

    inspect(): FfmpegRuntimeInfo {
        return JSON.parse(this.module.UTF8ToString(this.module._asb_runtime_info_json())) as FfmpegRuntimeInfo;
    }

    transcodeAudio(input: ArrayBuffer, trackIndex: number): ArrayBuffer {
        if (
            typeof this.module._asb_transcode_audio !== 'function' ||
            typeof this.module._asb_last_error !== 'function'
        ) {
            throw new Error('FFmpeg transcode exports are missing');
        }
        const inputBytes = new Uint8Array(input);
        const inputPointer = this.module._malloc(inputBytes.byteLength);
        const resultPointer = this.module._malloc(4);
        const resultSize = this.module._malloc(4);
        if (inputPointer === 0 || resultPointer === 0 || resultSize === 0) {
            throw new Error('Unable to allocate FFmpeg input memory');
        }
        try {
            this.module.HEAPU8.set(inputBytes, inputPointer);
            this.module.HEAPU32[resultPointer >>> 2] = 0;
            this.module.HEAPU32[resultSize >>> 2] = 0;
            const result = this.module._asb_transcode_audio(
                inputPointer,
                inputBytes.byteLength,
                trackIndex,
                resultPointer,
                resultSize
            );
            if (result !== 0) {
                throw new Error(this.module.UTF8ToString(this.module._asb_last_error()));
            }
            const outputPointer = this.module.HEAPU32[resultPointer >>> 2];
            const outputLength = this.module.HEAPU32[resultSize >>> 2];
            return this.module.HEAPU8.slice(outputPointer, outputPointer + outputLength).buffer;
        } finally {
            const outputPointer = this.module.HEAPU32[resultPointer >>> 2];
            if (outputPointer !== 0) this.module._asb_free(outputPointer);
            this.module._free(resultSize);
            this.module._free(resultPointer);
            this.module._free(inputPointer);
        }
    }
}
