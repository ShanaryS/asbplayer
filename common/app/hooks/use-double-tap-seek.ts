import { useCallback, useEffect, useRef, useState } from 'react';

export type TapSide = 'left' | 'right';

export interface DoubleTapSeekIndicator {
    readonly side: TapSide;
    readonly deltaMs: number;
}

export interface UseDoubleTapSeekOptions {
    readonly enabled: boolean;
    readonly onSingleTap: () => void;
    readonly onSeek: (side: TapSide, isNewBurst: boolean) => void;
}

const doubleTapDelayMs = 250;
const seekBurstWindowMs = 650;
const seekEdgeZoneRatio = 0.35;
const minConfirmedSeekMs = 100;

interface PendingTap {
    readonly side: TapSide;
    readonly timer: ReturnType<typeof setTimeout>;
}

interface ActiveBurst {
    readonly side: TapSide;
    confirmedDeltaMs: number;
    timer: ReturnType<typeof setTimeout>;
}

const resolveTapZone = (clientX: number, rect: Pick<DOMRect, 'left' | 'width'>): TapSide | 'center' => {
    if (rect.width <= 0) return 'center';
    const relativeX = (clientX - rect.left) / rect.width;
    if (relativeX < seekEdgeZoneRatio) return 'left';
    if (relativeX > 1 - seekEdgeZoneRatio) return 'right';
    return 'center';
};

export const useDoubleTapSeek = ({ enabled, onSingleTap, onSeek }: UseDoubleTapSeekOptions) => {
    const [indicator, setIndicator] = useState<DoubleTapSeekIndicator>();
    const pendingTapRef = useRef<PendingTap | undefined>(undefined);
    const activeBurstRef = useRef<ActiveBurst | undefined>(undefined);
    const onSingleTapRef = useRef(onSingleTap);
    const onSeekRef = useRef(onSeek);
    onSingleTapRef.current = onSingleTap;
    onSeekRef.current = onSeek;

    const clearPendingTap = useCallback(() => {
        if (!pendingTapRef.current) return;
        clearTimeout(pendingTapRef.current.timer);
        pendingTapRef.current = undefined;
    }, []);

    const clearActiveBurst = useCallback(() => {
        if (!activeBurstRef.current) return;
        clearTimeout(activeBurstRef.current.timer);
        activeBurstRef.current = undefined;
        setIndicator(undefined);
    }, []);

    const scheduleBurstClear = useCallback(() => {
        return setTimeout(() => {
            activeBurstRef.current = undefined;
            setIndicator(undefined);
        }, seekBurstWindowMs);
    }, []);

    useEffect(() => {
        return () => {
            clearPendingTap();
            if (activeBurstRef.current) {
                clearTimeout(activeBurstRef.current.timer);
                activeBurstRef.current = undefined;
            }
        };
    }, [clearPendingTap]);

    const handleTap = useCallback(
        (clientX: number, rect: Pick<DOMRect, 'left' | 'width'>) => {
            if (!enabled) {
                onSingleTapRef.current();
                return;
            }

            const zone = resolveTapZone(clientX, rect);
            if (zone === 'center') {
                clearPendingTap();
                clearActiveBurst();
                onSingleTapRef.current();
                return;
            }

            if (activeBurstRef.current?.side === zone) {
                clearTimeout(activeBurstRef.current.timer);
                activeBurstRef.current.timer = scheduleBurstClear();
                onSeekRef.current(zone, false);
                return;
            }

            if (pendingTapRef.current?.side === zone) {
                clearPendingTap();
                clearActiveBurst();
                activeBurstRef.current = {
                    side: zone,
                    confirmedDeltaMs: 0,
                    timer: scheduleBurstClear(),
                };
                onSeekRef.current(zone, true);
                return;
            }

            clearPendingTap();
            clearActiveBurst();
            pendingTapRef.current = {
                side: zone,
                timer: setTimeout(() => {
                    pendingTapRef.current = undefined;
                    onSingleTapRef.current();
                }, doubleTapDelayMs),
            };
        },
        [clearActiveBurst, clearPendingTap, enabled, scheduleBurstClear]
    );

    const confirmSeek = useCallback(
        (actualDeltaMs: number) => {
            const burst = activeBurstRef.current;
            if (!burst) return;
            if (burst.side === 'right' && actualDeltaMs < minConfirmedSeekMs) return;
            if (burst.side === 'left' && actualDeltaMs > -minConfirmedSeekMs) return;

            burst.confirmedDeltaMs += actualDeltaMs;
            clearTimeout(burst.timer);
            burst.timer = scheduleBurstClear();
            setIndicator({ side: burst.side, deltaMs: burst.confirmedDeltaMs });
        },
        [scheduleBurstClear]
    );

    return { handleTap, confirmSeek, indicator };
};
