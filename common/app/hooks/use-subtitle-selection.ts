import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConfirmedVideoDataSubtitleTrack, LoadableSubtitleTrack } from '@project/common';
import type { FileWithId } from '@project/common/file-selector';
import type { MediaSources } from '@project/common/app/services/media-sources';
import { resolveSubtitleSelection } from '@project/common/embedded-subtitles/embedded-subtitles';
import type { EmbeddedSubtitles } from '@project/common/embedded-subtitles/embedded-subtitles';
import { asbError } from '@project/common/util/log';

/** Owns one confirmation, including extraction, downloads and the caller's commit. */
export const useSubtitleSelection = ({
    source,
    service,
    selectedTrackIds,
    sources,
}: {
    source: FileWithId | undefined;
    service: EmbeddedSubtitles;
    selectedTrackIds: string[];
    sources: MediaSources;
}) => {
    const request = useRef<AbortController>(undefined);
    const [state, setState] = useState<'idle' | 'loading' | 'failed'>('idle');
    const cancel = useCallback(() => {
        request.current?.abort();
        request.current = undefined;
        setState('idle');
    }, []);
    useEffect(() => {
        cancel();
        return () => request.current?.abort();
    }, [source?.file, source?.id, service, cancel]);

    const confirm = useCallback(
        (
            tracks: ConfirmedVideoDataSubtitleTrack[],
            commit: (tracks: LoadableSubtitleTrack<FileWithId>[], signal: AbortSignal) => Promise<void>
        ) => {
            if (request.current) return;
            const controller = new AbortController();
            request.current = controller;
            const { signal } = controller;
            setState('loading');
            void (async () => {
                try {
                    if (
                        tracks.length !== selectedTrackIds.length ||
                        tracks.some((track, index) => track.id !== selectedTrackIds[index])
                    ) {
                        throw new Error('Subtitle selection has changed');
                    }
                    const files = await resolveSubtitleSelection(tracks, source, service, signal);
                    signal.throwIfAborted();
                    const selectedTracks = files.map(
                        (file) => sources.findSubtitleTrack(file) ?? { fileParts: [file] }
                    );
                    await commit(selectedTracks, signal);
                    if (!signal.aborted) setState('idle');
                } catch (error) {
                    if (!signal.aborted) {
                        asbError('app/selector', 'Failed to confirm subtitle selection:', error);
                        setState('failed');
                    }
                } finally {
                    if (request.current === controller) request.current = undefined;
                }
            })();
        },
        [source, service, selectedTrackIds, sources]
    );

    return {
        confirm,
        cancel,
        busy: state === 'loading',
        error: state === 'failed',
    };
};
