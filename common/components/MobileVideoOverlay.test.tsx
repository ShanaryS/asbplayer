import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { ThemeProvider } from '@mui/material/styles';
import { createTheme } from '@project/common/theme';
import MobileVideoOverlay from '@project/common/components/MobileVideoOverlay';
import { ControlType, PlayMode, PostMineAction } from '@project/common';
import type { MobileOverlayModel } from '@project/common';
import { minimumPlaybackRate } from '@project/common/util';

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const makeModel = (overrides: Partial<MobileOverlayModel> = {}): MobileOverlayModel => ({
    offset: 0,
    playbackRate: 1,
    emptySubtitleTrack: true,
    recordingEnabled: true,
    recording: false,
    currentTimestamp: 10_000,
    postMineAction: PostMineAction.showAnkiDialog,
    subtitleDisplaying: false,
    subtitlesAreVisible: true,
    playModes: [PlayMode.normal],
    themeType: 'dark',
    ...overrides,
});

describe('MobileVideoOverlay arrow controls', () => {
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

    const tapArrow = (testId: 'NavigateBeforeIcon' | 'NavigateNextIcon') => {
        const button = container.querySelector(`[data-testid="${testId}"]`)?.closest('button');
        expect(button).not.toBeNull();
        act(() => {
            button!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        });
        act(() => {
            button!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        });
    };

    it('falls back to seekDuration when seeking without subtitles', () => {
        const onSeek = jest.fn<(timestamp: number) => void>();
        act(() => {
            root.render(
                <ThemeProvider theme={createTheme('dark')}>
                    <MobileVideoOverlay
                        model={makeModel({ currentTimestamp: 10_000, emptySubtitleTrack: true })}
                        anchor="top"
                        tooltipsEnabled={false}
                        initialControlType={ControlType.timeDisplay}
                        flexDirection="column"
                        seekDuration={5}
                        speedChangeStep={0.25}
                        onScrollToControlType={() => {}}
                        onMineSubtitle={() => {}}
                        onOffset={() => {}}
                        onPlaybackRate={() => {}}
                        onPlayModeSelected={() => {}}
                        onSeek={onSeek}
                        onToggleSubtitles={() => {}}
                    />
                </ThemeProvider>
            );
        });

        tapArrow('NavigateBeforeIcon');
        tapArrow('NavigateNextIcon');

        expect(onSeek).toHaveBeenNthCalledWith(1, 5_000);
        expect(onSeek).toHaveBeenNthCalledWith(2, 15_000);
    });

    it('adjusts playback rate by speedChangeStep and clamps to minimumPlaybackRate', () => {
        const onPlaybackRate = jest.fn<(playbackRate: number) => void>();
        act(() => {
            root.render(
                <ThemeProvider theme={createTheme('dark')}>
                    <MobileVideoOverlay
                        model={makeModel({ playbackRate: 1 })}
                        anchor="top"
                        tooltipsEnabled={false}
                        initialControlType={ControlType.playbackRate}
                        flexDirection="column"
                        seekDuration={5}
                        speedChangeStep={0.25}
                        onScrollToControlType={() => {}}
                        onMineSubtitle={() => {}}
                        onOffset={() => {}}
                        onPlaybackRate={onPlaybackRate}
                        onPlayModeSelected={() => {}}
                        onSeek={() => {}}
                        onToggleSubtitles={() => {}}
                    />
                </ThemeProvider>
            );
        });

        tapArrow('NavigateBeforeIcon');
        tapArrow('NavigateNextIcon');

        expect(onPlaybackRate).toHaveBeenNthCalledWith(1, 0.75);
        expect(onPlaybackRate).toHaveBeenNthCalledWith(2, 1.25);

        act(() => {
            root.render(
                <ThemeProvider theme={createTheme('dark')}>
                    <MobileVideoOverlay
                        model={makeModel({ playbackRate: 0.2 })}
                        anchor="top"
                        tooltipsEnabled={false}
                        initialControlType={ControlType.playbackRate}
                        flexDirection="column"
                        seekDuration={5}
                        speedChangeStep={0.25}
                        onScrollToControlType={() => {}}
                        onMineSubtitle={() => {}}
                        onOffset={() => {}}
                        onPlaybackRate={onPlaybackRate}
                        onPlayModeSelected={() => {}}
                        onSeek={() => {}}
                        onToggleSubtitles={() => {}}
                    />
                </ThemeProvider>
            );
        });

        tapArrow('NavigateBeforeIcon');
        expect(onPlaybackRate).toHaveBeenNthCalledWith(3, minimumPlaybackRate);
    });
});
