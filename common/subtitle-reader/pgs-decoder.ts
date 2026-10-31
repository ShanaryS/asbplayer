import { parseDisplaySets } from '@project/common/pgs-parser';

/** Playback timing and pixel data from the shared PGS parser. PNG encoding belongs to the worker. */
export interface PgsImage {
    start: number;
    end: number;
    width: number;
    height: number;
    screen: { width: number; height: number };
    pixels: Uint8ClampedArray;
}

export async function* decodePgs(stream: ReadableStream<Uint8Array>): AsyncGenerator<PgsImage> {
    const reader = stream.pipeThrough(parseDisplaySets()).getReader();
    let timestamp: number | undefined;
    let pending: Omit<PgsImage, 'end'> | undefined;
    try {
        while (true) {
            const { value: displaySet, done } = await reader.read();
            if (done) break;
            const pcs = displaySet.presentationCompositionSegment;
            const ticks = pcs.header.presentationTimestamp;
            if (timestamp !== undefined && ticks < timestamp)
                throw new Error('Invalid PGS: composition timestamps moved backwards');
            timestamp = ticks;
            const start = ticks / 90;
            const previous = pending && start > pending.start ? { ...pending, end: start } : undefined;
            const image = displaySet.imageBuffer();
            pending = image
                ? {
                      start,
                      width: image.width,
                      height: image.height,
                      screen: { width: pcs.width, height: pcs.height },
                      pixels: image.data,
                  }
                : undefined;
            if (previous) yield previous;
        }
        // SUP has no duration field. An image without a later composition/clear lasts five seconds at EOF.
        if (pending) yield { ...pending, end: pending.start + 5000 };
    } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
    }
}
