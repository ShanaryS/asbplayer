/**
 * @jest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { useSwipe } from '@project/common/app/hooks/use-swipe';
import type { Direction } from '@project/common/app/hooks/use-swipe';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

const dispatchTouch = (type: 'touchstart' | 'touchend', clientX: number, clientY: number) => {
    const event = new Event(type, { bubbles: true }) as TouchEvent;
    Object.defineProperty(event, 'changedTouches', {
        value: [{ clientX, clientY }],
    });
    document.dispatchEvent(event);
};

beforeEach(() => {
    jest.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});

afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    jest.useRealTimers();
});

describe('useSwipe', () => {
    it('detects left and right swipes without re-rendering the component on touch', async () => {
        const swipes: Direction[] = [];
        let renderCount = 0;

        const Harness = () => {
            renderCount++;
            useSwipe({ onSwipe: (direction) => swipes.push(direction), distance: 50, ms: 500 });
            return null;
        };

        await act(async () => root.render(<Harness />));
        expect(renderCount).toBe(1);

        await act(async () => {
            dispatchTouch('touchstart', 200, 100);
            jest.advanceTimersByTime(100);
            dispatchTouch('touchend', 120, 100);
        });
        expect(swipes).toEqual(['left']);
        expect(renderCount).toBe(1);

        await act(async () => {
            dispatchTouch('touchstart', 100, 100);
            jest.advanceTimersByTime(100);
            dispatchTouch('touchend', 180, 100);
        });
        expect(swipes).toEqual(['left', 'right']);
        expect(renderCount).toBe(1);
    });

    it('ignores touches that do not meet the distance or time threshold', async () => {
        const swipes: Direction[] = [];

        const Harness = () => {
            useSwipe({ onSwipe: (direction) => swipes.push(direction), distance: 50, ms: 500 });
            return null;
        };

        await act(async () => root.render(<Harness />));

        await act(async () => {
            dispatchTouch('touchstart', 100, 100);
            jest.advanceTimersByTime(100);
            dispatchTouch('touchend', 130, 100);

            dispatchTouch('touchstart', 100, 100);
            jest.advanceTimersByTime(600);
            dispatchTouch('touchend', 200, 100);
        });
        expect(swipes).toEqual([]);
    });
});
