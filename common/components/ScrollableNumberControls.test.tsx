import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import React, { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import ScrollableNumberControls from '@project/common/components/ScrollableNumberControls';
import { ControlType } from '@project/common';

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

function Harness({
    initialControlType,
    onScrollTo,
}: {
    initialControlType?: ControlType;
    onScrollTo: (controlType: ControlType) => void;
}) {
    const offsetInputRef = useRef<HTMLInputElement | undefined>(undefined);
    const playbackRateInputRef = useRef<HTMLInputElement | undefined>(undefined);
    return (
        <ScrollableNumberControls
            offset={0}
            currentMilliseconds={12_000}
            playbackRate={1}
            offsetInputRef={offsetInputRef}
            onOffset={() => {}}
            playbackRateInputRef={playbackRateInputRef}
            onPlaybackRate={() => {}}
            initialControlType={initialControlType}
            onScrollTo={onScrollTo}
        />
    );
}

describe('ScrollableNumberControls', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(() => {
        act(() => {
            root.unmount();
        });
        container.remove();
        reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
    });

    it('clamps elastic overscroll past both bounds to valid ControlType values', () => {
        const onScrollTo = jest.fn<(controlType: ControlType) => void>();
        act(() => {
            root.render(<Harness initialControlType={ControlType.timeDisplay} onScrollTo={onScrollTo} />);
        });
        onScrollTo.mockClear();

        const scrollContainer = container.firstElementChild as HTMLDivElement;
        const dispatchScroll = (scrollTop: number) => {
            act(() => {
                Object.defineProperty(scrollContainer, 'scrollTop', { value: scrollTop, configurable: true });
                scrollContainer.dispatchEvent(new Event('scroll', { bubbles: true }));
            });
        };

        // Middle item
        dispatchScroll(40);
        expect(onScrollTo).toHaveBeenLastCalledWith(ControlType.subtitleOffset);

        // Last item and iOS rubber-band overscroll past max (80 -> 95)
        dispatchScroll(80);
        dispatchScroll(95);
        dispatchScroll(140);
        expect(onScrollTo).toHaveBeenLastCalledWith(ControlType.playbackRate);
        expect(onScrollTo.mock.calls.map(([c]) => c)).toEqual([ControlType.subtitleOffset, ControlType.playbackRate]);

        // Back to first item and iOS rubber-band overscroll past 0 (-25)
        dispatchScroll(0);
        dispatchScroll(-25);
        expect(onScrollTo).toHaveBeenLastCalledWith(ControlType.timeDisplay);
        expect(onScrollTo.mock.calls.map(([c]) => c)).toEqual([
            ControlType.subtitleOffset,
            ControlType.playbackRate,
            ControlType.timeDisplay,
        ]);
    });

    it('syncs initialControlType when starting on playbackRate', () => {
        const onScrollTo = jest.fn<(controlType: ControlType) => void>();
        act(() => {
            root.render(<Harness initialControlType={ControlType.playbackRate} onScrollTo={onScrollTo} />);
        });

        expect(onScrollTo).toHaveBeenCalledWith(ControlType.playbackRate);
    });
});
