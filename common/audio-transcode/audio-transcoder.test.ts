/** @jest-environment node */
import { transcodeAudioTrack } from '@project/common/audio-transcode/audio-transcoder';
import type { AudioTranscodeProgress } from '@project/common/audio-transcode/audio-transcoder';
import { TestHost } from '@project/common/audio-transcode/test-host';

const file = new File(['media'], 'video.mp4');
const run = (
    host: TestHost,
    owner = new AbortController(),
    onProgress: (progress: AudioTranscodeProgress) => void = () => {}
) => transcodeAudioTrack({ file, trackIndex: 0, host, signal: owner.signal, onProgress });

it('passes the File without reading the whole input, forwards download progress, and releases the worker', async () => {
    const host = new TestHost();
    const arrayBuffer = jest.spyOn(file, 'arrayBuffer');
    const progress: AudioTranscodeProgress[] = [];
    const result = await run(host, undefined, (update) => progress.push(update));
    expect(new Uint8Array(await result.blob.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(result.mimeType).toBe('audio/mp4; codecs="mp4a.40.2"');
    expect(host.workers[0].input).toBe(file);
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(progress).toContainEqual({
        stage: 'loadingDecoder',
        download: {
            stage: 'downloading',
            downloadedBytes: 10,
            totalBytes: 20,
            bytesPerSecond: 10,
            etaSeconds: 1,
        },
    });
    expect(progress.at(-1)).toEqual({
        stage: 'transcoding',
        processedSeconds: 0,
        totalSeconds: undefined,
        elapsedSeconds: 0,
        speed: undefined,
        etaSeconds: undefined,
    });
    expect(host.workers[0].active).toBe(false);
    arrayBuffer.mockRestore();
});

it('does not create a session for an already cancelled conversion', async () => {
    const host = new TestHost();
    const owner = new AbortController();
    owner.abort();
    await expect(run(host, owner)).rejects.toMatchObject({ name: 'AbortError' });
    expect(host.workers).toHaveLength(0);
});

it.each(['initializing', 'transcoding'])(
    'terminates %s work on cancellation and permits a fresh conversion',
    async (stage) => {
        const host = new TestHost();
        host.autoInitialize = stage !== 'initializing';
        host.autoComplete = false;
        const owner = new AbortController();
        const pending = run(host, owner);
        // The preparation boundary is async; wait for the worker to receive its first request.
        while (host.workers.length === 0) await new Promise((resolve) => setTimeout(resolve, 0));
        await host.workers[0].started;
        owner.abort();
        await expect(pending).rejects.toMatchObject({ code: 'aborted' });
        expect(host.workers[0].active).toBe(false);
        host.autoInitialize = true;
        host.autoComplete = true;
        expect((await run(host)).blob.size).toBe(3);
        expect(host.workers).toHaveLength(2);
        expect(host.workers[1].active).toBe(false);
    }
);

it('releases a failed conversion and retries with a fresh session', async () => {
    const host = new TestHost();
    host.error = 'Unable to decode media';
    await expect(run(host)).rejects.toThrow('Unable to decode media');
    expect(host.workers[0].active).toBe(false);
    host.error = undefined;
    expect((await run(host)).blob.size).toBe(3);
    expect(host.workers).toHaveLength(2);
});

it('reports media progress and ETA using conversion time, excluding decoder loading', async () => {
    const host = new TestHost();
    host.autoInitialize = false;
    host.autoComplete = false;
    let time = 0;
    const updates: AudioTranscodeProgress[] = [];
    const pending = transcodeAudioTrack({
        file,
        trackIndex: 0,
        host,
        signal: new AbortController().signal,
        now: () => time,
        onProgress: (progress) => updates.push(progress),
    });
    await new Promise(setImmediate);
    time = 10000;
    host.workers[0].complete();
    await new Promise(setImmediate);
    time = 12000;
    host.workers[0].progress({ stage: 'transcoding', processedSeconds: 20, totalSeconds: 100 });
    expect(updates.at(-1)).toEqual({
        stage: 'transcoding',
        processedSeconds: 20,
        totalSeconds: 100,
        elapsedSeconds: 2,
        speed: 10,
        etaSeconds: 8,
    });
    host.workers[0].progress({ stage: 'finalizing', processedSeconds: 100, totalSeconds: 100 });
    expect(updates.at(-1)).toMatchObject({ stage: 'finalizing', etaSeconds: undefined });
    host.workers[0].complete();
    await expect(pending).resolves.toMatchObject({ mimeType: 'audio/mp4; codecs="mp4a.40.2"' });
});
