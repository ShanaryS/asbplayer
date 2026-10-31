import { NativeBridge } from '@project/ffmpeg/native';
import type { NativeModule } from '@project/ffmpeg/native';
import type { FfmpegDiagnostics } from '@project/ffmpeg/protocol';

// The WASM module is the boundary here; real decoding is covered by runtime-audio.mjs.
const nativeModule = (run: (module: NativeModule) => number): NativeModule => {
    const module: NativeModule = {
        HEAPU8: new Uint8Array([1, 2, 3]),
        UTF8ToString: () => 'Native decoder failed',
        _asb_runtime_info_json: () => 0,
        _asb_last_error: () => 0,
        _asb_transcode_audio: () => run(module),
        _asb_extract_subtitles: () => 0,
        _malloc: () => 0,
        _free: () => {},
        stringToUTF8: () => {},
        lengthBytesUTF8: (value) => new TextEncoder().encode(value).length,
        asbReadInput: undefined,
        asbWriteOutput: undefined,
        asbDiagnostic: undefined,
    };
    return module;
};

const input = { size: 1, readAt: () => new Uint8Array([1]) };

it.each(['_asb_extract_subtitles', '_malloc', '_free', 'stringToUTF8', 'lengthBytesUTF8'] as const)(
    'rejects a runtime missing %s during bridge initialization',
    (name) => {
        const module = nativeModule(() => 1);
        Reflect.deleteProperty(module, name);
        expect(() => NativeBridge.create(module)).toThrow(`Native export ${name} is missing`);
    }
);

it('preserves subtitle results and diagnostics when the sink throws', () => {
    const reports: FfmpegDiagnostics[] = [];
    const module = nativeModule(() => 1);
    module.HEAPU8 = new Uint8Array(64);
    module.UTF8ToString = () => '[]';
    const run = () => {
        module.asbDiagnostic!('ffmpeg', 'warning', 'Subtitle warning');
        return 1;
    };
    module._asb_extract_subtitles = run;
    module._malloc = () => 8;
    module._free = () => {};
    module.lengthBytesUTF8 = (value) => value.length;
    module.stringToUTF8 = (value, pointer) => module.HEAPU8.set(new TextEncoder().encode(value), pointer);
    const bridge = NativeBridge.create(module);
    const onDiagnostics = (report: FfmpegDiagnostics) => {
        reports.push(report);
        throw new Error('Logging failed');
    };
    const result = bridge.extractSubtitles(input, [2], () => {}, onDiagnostics);
    expect(result).toEqual([]);
    expect(reports).toEqual([
        {
            messages: [{ source: 'ffmpeg', level: 'warning', message: 'Subtitle warning', occurrences: 1 }],
            omittedMessages: 0,
        },
    ]);
    expect(module.asbDiagnostic).toBeUndefined();
    expect(module.asbReadInput).toBeUndefined();
    expect(module.asbWriteSubtitleOutput).toBeUndefined();
});

it('retains native subtitle failures and their diagnostics when reporting fails', () => {
    const reports: FfmpegDiagnostics[] = [];
    const module = nativeModule(() => 1);
    module._malloc = () => 8;
    module._asb_extract_subtitles = () => {
        module.asbDiagnostic!('ffmpeg', 'error', 'Invalid subtitle container');
        return 0;
    };
    const bridge = NativeBridge.create(module);
    expect(() =>
        bridge.extractSubtitles(
            input,
            [2],
            () => {},
            (report) => {
                reports.push(report);
                throw new Error('Logging failed');
            }
        )
    ).toThrow('Native decoder failed');
    expect(reports[0].messages[0].message).toBe('Invalid subtitle container');
    expect(module.asbDiagnostic).toBeUndefined();
});

it('buffers recent diagnostics, folds repeats, and bounds both message count and text', () => {
    const reports: FfmpegDiagnostics[] = [];
    const module = nativeModule((module) => {
        for (let index = 0; index < 40; ++index) {
            module.asbDiagnostic!('ffmpeg', 'warning', `warning ${index}`);
        }
        module.asbDiagnostic!('ffmpeg', 'warning', 'warning 39\n');
        module.asbDiagnostic!('ffmpeg', 'warning', 'warning 39');
        module.asbDiagnostic!('runtime', 'trace', 'x'.repeat(2048));
        expect(reports).toEqual([]);
        module.asbWriteOutput!(0, 1);
        return 1;
    });
    expect(
        NativeBridge.create(module).transcodeAudio(
            input,
            0,
            () => {},
            (report) => reports.push(report)
        )
    ).toBe(1);
    expect(reports).toHaveLength(1);
    expect(reports[0].messages).toHaveLength(32);
    expect(reports[0].messages[0].message).toBe('warning 9');
    expect(reports[0].messages.at(-2)).toMatchObject({ message: 'warning 39', occurrences: 3 });
    expect(reports[0].messages.at(-1)?.message).toHaveLength(1024);
    expect(reports[0].omittedMessages).toBe(9);
    expect(module.asbDiagnostic).toBeUndefined();
});

it('keeps diagnostics separate between conversions and ignores a throwing sink on success', () => {
    const reports: FfmpegDiagnostics[] = [];
    let runs = 0;
    const module = nativeModule((module) => {
        if (runs++ === 0) module.asbDiagnostic!('runtime', 'warning', 'Tolerated 2 audio decoder errors');
        module.asbWriteOutput!(0, 1);
        return 1;
    });
    const bridge = NativeBridge.create(module);
    const onDiagnostics = (report: FfmpegDiagnostics) => {
        reports.push(report);
        throw new Error('Logging failed');
    };
    expect(bridge.transcodeAudio(input, 0, () => {}, onDiagnostics)).toBe(1);
    expect(bridge.transcodeAudio(input, 0, () => {}, onDiagnostics)).toBe(1);
    expect(reports[0].messages).toHaveLength(1);
    expect(reports[1]).toEqual({ messages: [], omittedMessages: 0 });
});

it.each(['return error', 'trap'])('preserves diagnostics and the original %s when logging fails', (failure) => {
    const trap = new Error('WASM trapped');
    const module = nativeModule((module) => {
        module.asbDiagnostic!('ffmpeg', 'error', 'Invalid audio bitstream');
        if (failure === 'trap') throw trap;
        return -1;
    });
    const reports: FfmpegDiagnostics[] = [];
    const convert = () =>
        NativeBridge.create(module).transcodeAudio(
            input,
            0,
            () => {},
            (report) => {
                reports.push(report);
                throw new Error('Logging failed');
            }
        );
    expect(convert).toThrow(failure === 'trap' ? trap : 'Native decoder failed');
    expect(reports).toEqual([
        {
            messages: [{ source: 'ffmpeg', level: 'error', message: 'Invalid audio bitstream', occurrences: 1 }],
            omittedMessages: 0,
        },
    ]);
    expect(module.asbDiagnostic).toBeUndefined();
    expect(module.asbReadInput).toBeUndefined();
    expect(module.asbWriteOutput).toBeUndefined();
});
