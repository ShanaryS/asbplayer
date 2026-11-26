/**
 * @jest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { useFullscreen } from '@project/common/app/hooks/use-fullscreen';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
const originalRequestFullscreen = document.documentElement.requestFullscreen;
const originalExitFullscreen = document.exitFullscreen;
const originalFullscreenEnabled = Object.getOwnPropertyDescriptor(document, 'fullscreenEnabled');

beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});

afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    Object.defineProperty(document.documentElement, 'requestFullscreen', {
        configurable: true,
        writable: true,
        value: originalRequestFullscreen,
    });
    Object.defineProperty(document, 'exitFullscreen', {
        configurable: true,
        writable: true,
        value: originalExitFullscreen,
    });
    if (originalFullscreenEnabled) {
        Object.defineProperty(document, 'fullscreenEnabled', originalFullscreenEnabled);
    } else {
        delete (document as { fullscreenEnabled?: boolean }).fullscreenEnabled;
    }
});

describe('useFullscreen', () => {
    it('reports unsupported and does not throw when Fullscreen API is unavailable', async () => {
        Object.defineProperty(document.documentElement, 'requestFullscreen', {
            configurable: true,
            writable: true,
            value: undefined,
        });
        Object.defineProperty(document, 'exitFullscreen', {
            configurable: true,
            writable: true,
            value: undefined,
        });

        let latest!: ReturnType<typeof useFullscreen>;
        const Harness = () => {
            latest = useFullscreen();
            return null;
        };

        await act(async () => root.render(<Harness />));
        expect(latest.supported).toBe(false);
        expect(() => latest.requestFullscreen(true)).not.toThrow();
        expect(() => latest.requestFullscreen(false)).not.toThrow();
    });

    it('reports supported and delegates requestFullscreen when available', async () => {
        const requestFullscreen = jest.fn(() => Promise.resolve());
        Object.defineProperty(document.documentElement, 'requestFullscreen', {
            configurable: true,
            writable: true,
            value: requestFullscreen,
        });
        Object.defineProperty(document, 'fullscreenEnabled', {
            configurable: true,
            value: true,
        });

        let latest!: ReturnType<typeof useFullscreen>;
        const Harness = () => {
            latest = useFullscreen();
            return null;
        };

        await act(async () => root.render(<Harness />));
        expect(latest.supported).toBe(true);
        latest.requestFullscreen(true);
        expect(requestFullscreen).toHaveBeenCalledTimes(1);
    });
});
