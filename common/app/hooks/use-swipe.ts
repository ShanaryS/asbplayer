import { useEffect, useRef, useCallback } from 'react';

export type Direction = 'left' | 'right';

interface Touch {
    x: number;
    timestamp: number;
}

export const useSwipe = ({
    onSwipe,
    rect,
    distance,
    ms,
}: {
    onSwipe: (direction: Direction) => void;
    rect?: DOMRect;
    distance: number;
    ms: number;
}) => {
    const startRef = useRef<Touch | undefined>(undefined);
    const insideRect = useCallback(
        (x: number, y: number) => {
            if (rect === undefined) {
                return true;
            }

            return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
        },
        [rect]
    );

    useEffect(() => {
        const onTouchStart = (e: TouchEvent) => {
            const x = e.changedTouches[0].clientX;
            const y = e.changedTouches[0].clientY;

            if (insideRect(x, y)) {
                startRef.current = { x, timestamp: Date.now() };
            }
        };

        const onTouchEnd = (e: TouchEvent) => {
            const start = startRef.current;
            if (start === undefined) {
                return;
            }

            const x = e.changedTouches[0].clientX;
            const y = e.changedTouches[0].clientY;

            if (insideRect(x, y) && Date.now() - start.timestamp <= ms) {
                if (start.x >= x + distance) {
                    onSwipe('left');
                } else if (start.x <= x - distance) {
                    onSwipe('right');
                }
            }

            startRef.current = undefined;
        };

        document.addEventListener('touchstart', onTouchStart);
        document.addEventListener('touchend', onTouchEnd);
        return () => {
            document.removeEventListener('touchstart', onTouchStart);
            document.removeEventListener('touchend', onTouchEnd);
        };
    }, [distance, ms, onSwipe, insideRect]);
};
