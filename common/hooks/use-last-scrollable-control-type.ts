import { asbError } from '@project/common/util/log';
import { useCallback, useEffect, useState, useMemo } from 'react';
import { ControlType } from '..';

interface Params {
    isMobile: boolean;
    fetchLastControlType: () => Promise<ControlType | undefined>;
    saveLastControlType: (controlType: ControlType) => Promise<void>;
}

const isValidControlType = (controlType: unknown): controlType is ControlType =>
    controlType === ControlType.timeDisplay ||
    controlType === ControlType.subtitleOffset ||
    controlType === ControlType.playbackRate;

export const useLastScrollableControlType = ({ isMobile, fetchLastControlType, saveLastControlType }: Params) => {
    const defaultControlType = useMemo(
        () => (isMobile ? ControlType.timeDisplay : ControlType.subtitleOffset),
        [isMobile]
    );
    const [lastControlType, setLastControlType] = useState<ControlType>(defaultControlType);

    useEffect(() => {
        void fetchLastControlType()
            .then((controlType) => {
                setLastControlType(isValidControlType(controlType) ? controlType : defaultControlType);
            })
            .catch((error) => asbError('settings/ui', 'Failed to load last scrollable control type:', error));
    }, [defaultControlType, fetchLastControlType]);

    const wrapSaveLastControlType = useCallback(
        (controlType: ControlType) => {
            if (!isValidControlType(controlType)) return;
            setLastControlType(controlType);
            void saveLastControlType(controlType).catch((error) =>
                asbError('settings/ui', 'Failed to save last scrollable control type:', error)
            );
        },
        [saveLastControlType]
    );

    return { lastControlType, setLastControlType: wrapSaveLastControlType };
};

export default useLastScrollableControlType;
