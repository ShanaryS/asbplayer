import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { useDoubleTapSeek } from '@project/common/app/hooks/use-double-tap-seek';
import type { DoubleTapSeekIndicator, TapSide } from '@project/common/app/hooks/use-double-tap-seek';

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const screenRect = { left: 0, width: 400 };

describe('useDoubleTapSeek', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        jest.useFakeTimers();
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
        jest.useRealTimers();
    });

    const mount = (enabled = true) => {
        const singleTaps: number[] = [];
        const seeks: { side: TapSide; isNewBurst: boolean }[] = [];
        let latestTap: ((clientX: number, rect: { left: number; width: number }) => void) | undefined;
        let latestConfirm: ((actualDeltaMs: number) => void) | undefined;
        let latestIndicator: DoubleTapSeekIndicator | undefined;

        function Harness() {
            const { handleTap, confirmSeek, indicator } = useDoubleTapSeek({
                enabled,
                onSingleTap: () => singleTaps.push(Date.now()),
                onSeek: (side, isNewBurst) => seeks.push({ side, isNewBurst }),
            });
            latestTap = handleTap;
            latestConfirm = confirmSeek;
            latestIndicator = indicator;
            return null;
        }

        act(() => {
            root.render(<Harness />);
        });

        return {
            tap: (clientX: number) => act(() => latestTap?.(clientX, screenRect)),
            confirm: (actualDeltaMs: number) => act(() => latestConfirm?.(actualDeltaMs)),
            singleTaps,
            seeks,
            indicator: () => latestIndicator,
        };
    };

    it('handles center taps immediately and delays single edge taps before toggling', () => {
        const harness = mount(true);

        harness.tap(200);
        expect(harness.singleTaps).toHaveLength(1);
        expect(harness.seeks).toEqual([]);

        harness.tap(50);
        expect(harness.singleTaps).toHaveLength(1);
        act(() => jest.advanceTimersByTime(250));
        expect(harness.singleTaps).toHaveLength(2);
        expect(harness.seeks).toEqual([]);
    });

    it('only displays and accumulates confirmed seek deltas during a burst', () => {
        const harness = mount(true);

        // Double tap left (50 / 400 = 12.5%) — indicator stays hidden until seek confirms
        harness.tap(50);
        act(() => jest.advanceTimersByTime(100));
        harness.tap(60);

        expect(harness.singleTaps).toEqual([]);
        expect(harness.seeks).toEqual([{ side: 'left', isNewBurst: true }]);
        expect(harness.indicator()).toBeUndefined();

        // First seek confirms (e.g. clamped to -1.5s)
        harness.confirm(-1500);
        expect(harness.indicator()).toEqual({ side: 'left', deltaMs: -1500 });

        // Rapid 3rd tap continues burst; unconfirmed tap does not change displayed delta
        act(() => jest.advanceTimersByTime(200));
        harness.tap(55);
        expect(harness.seeks).toEqual([
            { side: 'left', isNewBurst: true },
            { side: 'left', isNewBurst: false },
        ]);
        expect(harness.indicator()).toEqual({ side: 'left', deltaMs: -1500 });

        // Zero or wrong-direction confirmations are ignored
        harness.confirm(0);
        harness.confirm(3000);
        expect(harness.indicator()).toEqual({ side: 'left', deltaMs: -1500 });

        // Confirming another -3s accumulates to -4.5s
        harness.confirm(-3000);
        expect(harness.indicator()).toEqual({ side: 'left', deltaMs: -4500 });

        // Burst clears after inactivity
        act(() => jest.advanceTimersByTime(650));
        expect(harness.indicator()).toBeUndefined();
        expect(harness.singleTaps).toEqual([]);

        // Late confirmation after burst ends is ignored
        harness.confirm(-3000);
        expect(harness.indicator()).toBeUndefined();
    });

    it('does not trigger a seek when tapping opposite sides and cleans up timers on unmount', () => {
        const harness = mount(true);

        harness.tap(40);
        act(() => jest.advanceTimersByTime(100));
        harness.tap(360);
        expect(harness.seeks).toEqual([]);
        expect(harness.singleTaps).toEqual([]);

        act(() => root.unmount());
        act(() => jest.advanceTimersByTime(1000));
        expect(harness.singleTaps).toEqual([]);
    });

    it('passes all taps straight through to onSingleTap when disabled', () => {
        const harness = mount(false);

        harness.tap(40);
        harness.tap(40);
        expect(harness.singleTaps).toHaveLength(2);
        expect(harness.seeks).toEqual([]);
    });
});
