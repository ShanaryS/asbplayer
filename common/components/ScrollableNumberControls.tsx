import { makeStyles } from '@mui/styles';
import PlaybackRateInput from '@project/common/components/PlaybackRateInput';
import SubtitleOffsetInput from '@project/common/components/SubtitleOffsetInput';
import TimeDisplay from '@project/common/components/TimeDisplay';
import type { MutableRefObject } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ControlType } from '..';

const containerHeight = 40;
const scrollThreshold = containerHeight / 2 + 1;
const initialScrollFallbackMs = 800;

const clampControlType = (controlType: number): ControlType => {
    if (!Number.isFinite(controlType)) return ControlType.timeDisplay;
    return Math.max(ControlType.timeDisplay, Math.min(ControlType.playbackRate, Math.round(controlType)));
};

const useStyles = makeStyles(() => {
    return {
        container: {
            height: containerHeight,
            overflowY: 'scroll',
            overscrollBehaviorY: 'contain',
            scrollSnapType: 'y mandatory',
            scrollbarWidth: 'none',
            '&::-webkit-scrollbar': {
                display: 'none',
            },
            textAlign: 'center',
        },
        child: {
            scrollbarWidth: 'none',
            scrollSnapAlign: 'center',
            '&::-webkit-scrollbar': {
                display: 'none',
            },
            scrollSnapStop: 'always',
        },
    };
});

interface Props {
    offset: number;
    currentMilliseconds: number;
    totalMilliseconds?: number;
    playbackRate: number;
    offsetInputRef: MutableRefObject<HTMLInputElement | undefined>;
    onOffset: (offset: number) => void;
    playbackRateInputRef: MutableRefObject<HTMLInputElement | undefined>;
    onPlaybackRate: (playbackRate: number) => void;
    initialControlType?: ControlType;
    onScrollTo: (controlType: ControlType) => void;
}

enum InitialScrollState {
    notStarted = 0,
    started = 1,
    ended = 2,
}

const ScrollableNumberControls = ({
    currentMilliseconds,
    totalMilliseconds,
    offset,
    offsetInputRef,
    onOffset,
    playbackRate,
    playbackRateInputRef,
    onPlaybackRate,
    initialControlType,
    onScrollTo,
}: Props) => {
    const classes = useStyles();
    const [controlType, setControlType] = useState<ControlType>(ControlType.timeDisplay);
    const [initialScroll, setInitialScroll] = useState<InitialScrollState>(InitialScrollState.notStarted);
    const initialScrollRef = useRef<InitialScrollState>(initialScroll);
    initialScrollRef.current = initialScroll;
    const containerRef = useRef<HTMLDivElement | null>(null);
    const programmaticallyScrollingTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);
    const controlTypeRef = useRef<ControlType>(controlType);
    const onScrollToRef = useRef<(controlType: ControlType) => void>(undefined);
    onScrollToRef.current = onScrollTo;
    controlTypeRef.current = controlType;

    const handleScroll = useCallback(
        (e: React.UIEvent<HTMLDivElement>) => {
            const currentScrollTop = e.currentTarget.scrollTop;
            // Clamp to valid enum bounds so elastic overscroll (e.g. iOS bounce past 0 or max) cannot emit invalid values.
            const newControlType = clampControlType(currentScrollTop / containerHeight);

            if (initialScroll === InitialScrollState.ended && newControlType !== controlType) {
                onScrollTo(newControlType);
                setControlType(newControlType);
            }
        },
        [onScrollTo, initialScroll, controlType]
    );

    const handleWheel = useCallback((e: WheelEvent) => {
        if (programmaticallyScrollingTimeoutRef.current !== undefined) {
            // Programmatic scroll already started
            e.preventDefault();
            return;
        }

        if (Number.isInteger(e.deltaY) || e.deltaX !== 0 || Math.abs(e.deltaY) < 1) {
            // Probably from a touchpad, let this through
            return;
        }

        // Only allow programmatic scroll to the next control
        e.preventDefault();

        const goingDown = e.deltaY > 0;
        let didProgrammaticallyScroll = false;

        if (goingDown && controlTypeRef.current < ControlType.playbackRate) {
            containerRef.current?.scrollBy({ top: scrollThreshold, behavior: 'smooth' });
            didProgrammaticallyScroll = true;
        } else if (!goingDown && controlTypeRef.current > ControlType.timeDisplay) {
            containerRef.current?.scrollBy({ top: -scrollThreshold, behavior: 'smooth' });
            didProgrammaticallyScroll = true;
        }

        if (didProgrammaticallyScroll) {
            if (programmaticallyScrollingTimeoutRef.current !== undefined) {
                clearTimeout(programmaticallyScrollingTimeoutRef.current);
            }

            // Ensure the scrolling flag is reset so that we don't block all wheel operations
            programmaticallyScrollingTimeoutRef.current = setTimeout(() => {
                programmaticallyScrollingTimeoutRef.current = undefined;
            }, 500);
        }
    }, []);

    useEffect(() => {
        const div = containerRef.current;
        if (!div) return;

        const clearProgrammaticScroll = () => {
            programmaticallyScrollingTimeoutRef.current = undefined;
        };
        div.addEventListener('wheel', handleWheel, { passive: false });
        div.addEventListener('scrollend', clearProgrammaticScroll);

        return () => {
            div.removeEventListener('wheel', handleWheel);
            div.removeEventListener('scrollend', clearProgrammaticScroll);
            if (programmaticallyScrollingTimeoutRef.current !== undefined) {
                clearTimeout(programmaticallyScrollingTimeoutRef.current);
                programmaticallyScrollingTimeoutRef.current = undefined;
            }
        };
    }, [handleWheel]);

    useEffect(() => {
        if (initialScrollRef.current > InitialScrollState.notStarted) return;

        const div = containerRef.current;
        if (!div) return;

        if (initialControlType === undefined) {
            setInitialScroll(InitialScrollState.ended);
            return;
        }

        const destinationControlType = clampControlType(initialControlType);
        const finishInitialScroll = (settledControlType: ControlType) => {
            if (initialScrollRef.current === InitialScrollState.ended) return;
            initialScrollRef.current = InitialScrollState.ended;
            onScrollToRef.current?.(settledControlType);
            setControlType(settledControlType);
            setInitialScroll(InitialScrollState.ended);
        };

        if (destinationControlType === ControlType.playbackRate) {
            div.scrollTop = containerHeight * 2;
            finishInitialScroll(ControlType.playbackRate);
            return;
        }

        const targetTop = destinationControlType * containerHeight;
        if (!('onscrollend' in window) || typeof div.scroll !== 'function') {
            div.scrollTop = targetTop;
            finishInitialScroll(destinationControlType);
            return;
        }

        initialScrollRef.current = InitialScrollState.started;
        setInitialScroll(InitialScrollState.started);
        div.scrollTop = containerHeight * 2;

        const handleInitialScrollEnd = () => {
            if (div.scrollTop >= containerHeight * 2) return;
            div.removeEventListener('scrollend', handleInitialScrollEnd);
            clearTimeout(fallbackTimer);
            finishInitialScroll(clampControlType(div.scrollTop / containerHeight));
        };

        div.addEventListener('scrollend', handleInitialScrollEnd);
        const frameId = requestAnimationFrame(() => {
            div.scroll({ top: targetTop, behavior: 'smooth' });
        });
        const fallbackTimer = setTimeout(() => {
            div.removeEventListener('scrollend', handleInitialScrollEnd);
            if (initialScrollRef.current === InitialScrollState.started) {
                div.scrollTop = targetTop;
                finishInitialScroll(destinationControlType);
            }
        }, initialScrollFallbackMs);

        return () => {
            cancelAnimationFrame(frameId);
            clearTimeout(fallbackTimer);
            div.removeEventListener('scrollend', handleInitialScrollEnd);
            if (initialScrollRef.current === InitialScrollState.started) {
                initialScrollRef.current = InitialScrollState.notStarted;
            }
        };
    }, [initialControlType]);

    return (
        <div ref={containerRef} onScroll={handleScroll} className={classes.container}>
            <TimeDisplay
                currentMilliseconds={currentMilliseconds}
                totalMilliseconds={totalMilliseconds}
                className={classes.child}
            />
            <SubtitleOffsetInput
                inputRef={offsetInputRef}
                offset={offset}
                onOffset={onOffset}
                className={classes.child}
            />
            <PlaybackRateInput
                inputRef={playbackRateInputRef}
                playbackRate={playbackRate}
                onPlaybackRate={onPlaybackRate}
                className={classes.child}
            />
        </div>
    );
};

export default ScrollableNumberControls;
