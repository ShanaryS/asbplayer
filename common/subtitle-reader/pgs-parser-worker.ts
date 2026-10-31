import { decodePgs } from '@project/common/subtitle-reader/pgs-decoder';

async function parse(fileStream: ReadableStream<Uint8Array>, canvas: OffscreenCanvas) {
    try {
        for await (const image of decodePgs(fileStream)) {
            canvas.width = image.width;
            canvas.height = image.height;
            const context = canvas.getContext('2d');
            if (!context) throw new Error('Could not create subtitle image canvas');
            context.putImageData(new ImageData(image.pixels, image.width, image.height), 0, 0);
            postMessage({
                command: 'subtitle',
                imageBlob: await canvas.convertToBlob({ type: 'image/png' }),
                subtitle: {
                    start: image.start,
                    end: image.end,
                    text: '',
                    textImage: { image: { width: image.width, height: image.height }, screen: image.screen },
                },
            });
        }
        postMessage({ command: 'finished' });
    } catch (error) {
        postMessage({ command: 'error', error });
    }
}
export function onMessage() {
    onmessage = (event: MessageEvent) => {
        void parse(event.data.fileStream, event.data.canvas);
    };
}
onMessage();
