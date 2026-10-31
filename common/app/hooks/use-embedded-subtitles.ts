import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FileWithId } from '@project/common/file-selector';
import type { EmbeddedSubtitleTrack } from '@project/common/media-probe/subtitle-probe';
import type { SubtitleHost } from '@project/common/embedded-subtitles/embedded-subtitles';
import { EmbeddedSubtitles } from '@project/common/embedded-subtitles/embedded-subtitles';
import { asbError } from '@project/common/util/log';

export const useEmbeddedSubtitles = (
    source: FileWithId | undefined,
    host: SubtitleHost,
    open: boolean,
    // A replacement import can cancel discovery without changing the video or closing the selector.
    discoveryKey?: object,
    discoverOnLoad = false
) => {
    const service = useMemo(() => new EmbeddedSubtitles(host), [host]);
    const [catalog, setCatalog] = useState<{ file: File; tracks: EmbeddedSubtitleTrack[] }>();
    const [error, setError] = useState(false);
    const [loading, setLoading] = useState(false);
    const generation = useRef({});
    const cancel = useCallback(() => {
        generation.current = {};
        service.cancel();
        setLoading(false);
    }, [service]);
    useEffect(() => {
        cancel();
        setCatalog(undefined);
        setError(false);
        return () => {
            generation.current = {};
            service.cancel();
        };
    }, [source?.file, service, cancel]);
    const discover = useCallback(async () => {
        if (!source) return;
        const attempt = generation.current;
        setLoading(true);
        setError(false);
        try {
            const tracks = await service.discover(source);
            if (generation.current === attempt && tracks) setCatalog({ file: source.file, tracks });
        } catch (error) {
            if (generation.current === attempt) {
                asbError('app/subtitles', 'Failed to discover embedded subtitles:', error);
                setError(true);
            }
        } finally {
            if (generation.current === attempt) setLoading(false);
        }
    }, [source, service]);
    useEffect(() => {
        if (open || discoverOnLoad) void discover();
        else cancel();
    }, [open, discoverOnLoad, discover, cancel, discoveryKey]);
    return {
        service,
        cancel,
        loading,
        error,
        tracks: catalog?.file === source?.file ? catalog?.tracks : undefined,
    };
};
