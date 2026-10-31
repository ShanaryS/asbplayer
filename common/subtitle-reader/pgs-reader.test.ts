import { SubtitleHtml } from '@project/common';
import SubtitleReader from '@project/common/subtitle-reader/subtitle-reader';
jest.mock('ass-compiler', () => ({ compile: () => ({ dialogues: [] }) }));

class ImageWorker {
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    terminated = false;
    postMessage() {}
    terminate() {
        this.terminated = true;
    }
    send(data: unknown) {
        this.onmessage?.(new MessageEvent('message', { data }));
    }
}
const reader = (factory: () => Promise<Worker>) =>
    new SubtitleReader({
        regexFilter: '',
        regexFilterTextReplacement: '',
        subtitleHtml: SubtitleHtml.render,
        convertNetflixRuby: false,
        pgsParserWorkerFactory: factory,
    });
const file = { name: 'image.sup', stream: () => ({}) } as unknown as File;
const image = (start: number, end: number) => ({
    command: 'subtitle',
    imageBlob: new Blob(['pixels'], { type: 'image/png' }),
    subtitle: {
        start,
        end,
        text: '',
        textImage: { image: { width: 2, height: 2 }, screen: { width: 16, height: 16 } },
    },
});
beforeAll(() => {
    HTMLCanvasElement.prototype.transferControlToOffscreen = () => ({}) as OffscreenCanvas;
});
it('waits for all asynchronous image conversions before resolving finished and keeps message order', async () => {
    const worker = new ImageWorker();
    const loading = reader(async () => worker as unknown as Worker).subtitles([file]);
    await Promise.resolve();
    worker.send(image(1000, 2000));
    worker.send(image(2000, 3000));
    worker.send({ command: 'finished' });
    const subtitles = await loading;
    expect(subtitles.map(({ start, end }) => [start, end])).toEqual([
        [1000, 2000],
        [2000, 3000],
    ]);
    expect(subtitles.map((subtitle) => subtitle.textImage?.dataUrl)).toEqual([
        'data:image/png;base64,cGl4ZWxz',
        'data:image/png;base64,cGl4ZWxz',
    ]);
    expect(worker.terminated).toBe(true);
});
it('applies the embedded adjustment once before playback offsets and clips negative preroll', async () => {
    const worker = new ImageWorker();
    const loading = reader(async () => worker as unknown as Worker).subtitles([file], false, {
        timelineOffsets: [-1000],
    });
    await Promise.resolve();
    worker.send(image(0, 500));
    worker.send(image(500, 2000));
    worker.send({ command: 'finished' });
    const subtitles = await loading;
    expect(subtitles.map(({ start, end }) => [start, end])).toEqual([[0, 1000]]);
});
it('aborts and terminates pending workers without applying their late images', async () => {
    const worker = new ImageWorker();
    const controller = new AbortController();
    const loading = reader(async () => worker as unknown as Worker).subtitles([file], false, {
        signal: controller.signal,
    });
    await Promise.resolve();
    controller.abort(new Error('cancelled'));
    worker.send(image(0, 1000));
    worker.send({ command: 'finished' });
    await expect(loading).rejects.toThrow('cancelled');
    expect(worker.terminated).toBe(true);
});
it('terminates a worker whose factory resolves after cancellation', async () => {
    let release!: (worker: Worker) => void;
    const controller = new AbortController();
    const loading = reader(
        () =>
            new Promise((resolve) => {
                release = resolve;
            })
    ).subtitles([file], false, { signal: controller.signal });
    controller.abort(new Error('cancelled'));
    const worker = new ImageWorker();
    release(worker as unknown as Worker);
    await expect(loading).rejects.toThrow('cancelled');
    expect(worker.terminated).toBe(true);
});
it('reports worker errors and terminates the failed worker', async () => {
    const worker = new ImageWorker();
    const loading = reader(async () => worker as unknown as Worker).subtitles([file]);
    await Promise.resolve();
    worker.send({ command: 'error', error: new Error('broken SUP') });
    await expect(loading).rejects.toThrow('broken SUP');
    expect(worker.terminated).toBe(true);
});
