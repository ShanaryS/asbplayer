import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { ThemeProvider } from '@mui/material/styles';
import { createTheme } from '@project/common/theme';
import Bar from '@project/common/app/components/Bar';

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

describe('Bar close confirmation', () => {
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

    const renderBar = ({
        onClose,
        confirmClose = true,
        canDownloadSubtitles = true,
        hidden = false,
    }: {
        onClose?: () => void;
        confirmClose?: boolean;
        canDownloadSubtitles?: boolean;
        hidden?: boolean;
    } = {}) => {
        act(() => {
            root.render(
                <ThemeProvider theme={createTheme('dark')}>
                    <Bar
                        drawerWidth={300}
                        drawerOpen={false}
                        hidden={hidden}
                        title="episode.mkv"
                        canDownloadSubtitles={canDownloadSubtitles}
                        lang="en"
                        onClose={onClose}
                        confirmClose={confirmClose}
                        onDownloadSubtitleFilesAsSrt={() => {}}
                        onDownloadSubtitleTimeline={() => {}}
                        onOpenSettings={() => {}}
                        onOpenCopyHistory={() => {}}
                        onCopyLastError={() => {}}
                    />
                </ThemeProvider>
            );
        });
    };

    const closeButton = () =>
        container.querySelector<HTMLButtonElement>('[data-testid="CloseIcon"]')?.closest('button');
    const confirmButton = () =>
        container.querySelector<HTMLButtonElement>('[data-testid="CheckIcon"]')?.closest('button');

    it('places the close button to the left of the download button and hides it when onClose is omitted', () => {
        renderBar();
        expect(closeButton()).toBeUndefined();

        renderBar({ onClose: () => {} });
        const closeBtn = closeButton();
        const downloadBtn = container.querySelector('[data-testid="SaveAltIcon"]')?.closest('button');
        expect(closeBtn).not.toBeNull();
        expect(downloadBtn).not.toBeNull();
        expect(closeBtn!.compareDocumentPosition(downloadBtn!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('switches to a confirm check icon for 2s on first click and closes on second click', () => {
        const onClose = jest.fn();
        renderBar({ onClose });

        // First click enters confirmation state without closing
        act(() => {
            closeButton()!.click();
        });
        expect(onClose).not.toHaveBeenCalled();
        expect(closeButton()).toBeUndefined();
        expect(confirmButton()?.getAttribute('aria-label')).toBe('action.confirm');

        // Reverts after 2 seconds without closing
        act(() => {
            jest.advanceTimersByTime(2_000);
        });
        expect(onClose).not.toHaveBeenCalled();
        expect(confirmButton()).toBeUndefined();
        expect(closeButton()?.getAttribute('aria-label')).toBe('action.close');

        // Second click within 2 seconds confirms and closes
        act(() => {
            closeButton()!.click();
        });
        act(() => {
            confirmButton()!.click();
        });
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(confirmButton()).toBeUndefined();
        expect(closeButton()).toBeDefined();
    });

    it('closes immediately on first click when confirmClose is false', () => {
        const onClose = jest.fn();
        renderBar({ onClose, confirmClose: false });

        act(() => {
            closeButton()!.click();
        });
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(confirmButton()).toBeUndefined();
        expect(closeButton()).toBeDefined();
    });

    it('resets confirmation when the bar is hidden', () => {
        const onClose = jest.fn();
        renderBar({ onClose });

        act(() => {
            closeButton()!.click();
        });
        expect(confirmButton()).toBeDefined();

        renderBar({ onClose, hidden: true });
        expect(confirmButton()).toBeUndefined();
        expect(closeButton()).toBeDefined();
    });
});
