import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import useLastScrollableControlType from '@project/common/hooks/use-last-scrollable-control-type';
import { ControlType } from '@project/common';

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

describe('useLastScrollableControlType', () => {
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

    it('falls back to the default control type when storage contains an out-of-range value and ignores invalid saves', async () => {
        let currentControlType: ControlType | undefined;
        let saveFn: ((controlType: ControlType) => void) | undefined;
        const saveLastControlType = jest.fn<(controlType: ControlType) => Promise<void>>().mockResolvedValue(undefined);
        const fetchLastControlType = jest
            .fn<() => Promise<ControlType | undefined>>()
            .mockResolvedValue(3 as ControlType);

        function Harness() {
            const { lastControlType, setLastControlType } = useLastScrollableControlType({
                isMobile: true,
                fetchLastControlType,
                saveLastControlType,
            });
            currentControlType = lastControlType;
            saveFn = setLastControlType;
            return null;
        }

        await act(async () => {
            root.render(<Harness />);
            await Promise.resolve();
        });

        expect(currentControlType).toBe(ControlType.timeDisplay);

        await act(async () => {
            saveFn?.(3 as ControlType);
            saveFn?.(-1 as ControlType);
            saveFn?.(Number.NaN);
            await Promise.resolve();
        });

        expect(saveLastControlType).not.toHaveBeenCalled();
        expect(currentControlType).toBe(ControlType.timeDisplay);

        await act(async () => {
            saveFn?.(ControlType.playbackRate);
            await Promise.resolve();
        });

        expect(saveLastControlType).toHaveBeenCalledWith(ControlType.playbackRate);
        expect(currentControlType).toBe(ControlType.playbackRate);
    });
});
