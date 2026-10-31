import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { DisplaySubtitleModel } from '@project/common';
import { subtitleOffsetUpdate } from '@project/common/util/subtitle-offset';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const subtitle = (text: string, start: number, end: number, track = 0): DisplaySubtitleModel => ({
    text,
    start,
    end,
    originalStart: start,
    originalEnd: end,
    track,
    index: 0,
    displayTime: '',
    displayEndTime: '',
});

it.each([0, 250, -250])(
    'keeps newly loaded subtitles when an offset of %s arrives before React renders them',
    (offset) => {
        const loaded = [subtitle('First', 1000, 2000), subtitle('Second', 3000, 4000, 2)];
        // This callback is created while the player still has no subtitles.
        const offsetUpdate = subtitleOffsetUpdate(offset);
        function Harness() {
            const [subtitles, setSubtitles] = useState<DisplaySubtitleModel[] | undefined>([]);
            return (
                <>
                    <button
                        onClick={() => {
                            setSubtitles(loaded);
                            setSubtitles(offsetUpdate);
                        }}
                    >
                        Finish extraction and receive initial offset
                    </button>
                    <output>
                        {JSON.stringify(subtitles?.map(({ text, start, end, track }) => ({ text, start, end, track })))}
                    </output>
                </>
            );
        }
        const container = document.createElement('div');
        const root = createRoot(container);
        try {
            act(() => root.render(<Harness />));
            act(() => container.querySelector('button')!.click());
            expect(JSON.parse(container.querySelector('output')!.textContent!)).toEqual([
                { text: 'First', start: 1000 + offset, end: 2000 + offset, track: 0 },
                { text: 'Second', start: 3000 + offset, end: 4000 + offset, track: 2 },
            ]);
        } finally {
            act(() => root.unmount());
        }
    }
);

it('preserves missing and empty subtitle sources', () => {
    expect(subtitleOffsetUpdate(100)(undefined)).toBeUndefined();
    expect(subtitleOffsetUpdate(100)([])).toEqual([]);
});

it('applies each new offset to original timings without changing the loaded source', () => {
    const original = [subtitle('First', 1000, 2000)];
    const shifted = subtitleOffsetUpdate(500)(original)!;
    const shiftedAgain = subtitleOffsetUpdate(-100)(shifted)!;
    expect(shiftedAgain[0]).toMatchObject({ start: 900, end: 1900, originalStart: 1000, originalEnd: 2000 });
    expect(original[0]).toMatchObject({ start: 1000, end: 2000 });
});
