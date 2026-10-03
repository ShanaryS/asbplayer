import { useCallback, useEffect, useRef, useState } from 'react';
import { transcodeAudioTrack } from '@project/common/audio-transcode';
import type { AudioTranscodeHost, AudioTranscodeProgress } from '@project/common/audio-transcode';
import { createBlobUrl, revokeBlobUrl } from '@project/common/blob-url';
import type { FileWithId } from '@project/common/file-selector';
import { audioCodecDisplayName, audioTrackRequiringTranscode } from '@project/common/media-probe';
import { asbError, asbTrace, asbWarn } from '@project/common/util/log';

export type TranscodedAudioState = 'idle' | 'prompting' | 'transcoding' | 'ready' | 'failed';

export interface TranscodedAudio {
    readonly state: TranscodedAudioState;
    /** Display name of the codec the browser cannot decode, e.g. "E-AC-3". */
    readonly codecName?: string;
    readonly progress?: AudioTranscodeProgress;
    readonly error?: unknown;
    /** Blob URL of the transcoded audio, for playback alongside the muted video. */
    readonly url?: string;
    /** The transcoded audio itself, so mined cards can be given their own blob URL. */
    readonly blob?: Blob;
    readonly start: () => void;
    readonly dismiss: () => void;
}

/**
 * Detects audio tracks the browser cannot decode - Dolby formats like E-AC-3, most commonly - and
 * transcodes one into a playable format when the user asks for it.
 */
export const useTranscodedAudio = (
    videoFile: FileWithId | undefined,
    host: AudioTranscodeHost | undefined
): TranscodedAudio => {
    const [state, setState] = useState<TranscodedAudioState>('idle');
    const [codecName, setCodecName] = useState<string>();
    const [progress, setProgress] = useState<AudioTranscodeProgress>();
    const [url, setUrl] = useState<string>();
    const [blob, setBlob] = useState<Blob>();
    const [error, setError] = useState<unknown>();
    const trackIndexRef = useRef<number>(undefined);
    const abortControllerRef = useRef<AbortController>(undefined);
    const urlRef = useRef<string>(undefined);

    const revokeUrl = useCallback(() => {
        if (urlRef.current !== undefined) {
            revokeBlobUrl(urlRef.current);
            urlRef.current = undefined;
        }
    }, []);

    useEffect(() => {
        abortControllerRef.current?.abort();
        abortControllerRef.current = undefined;
        setState('idle');
        setCodecName(undefined);
        setProgress(undefined);
        setError(undefined);
        setBlob(undefined);
        revokeUrl();
        setUrl(undefined);
        trackIndexRef.current = undefined;

        if (videoFile === undefined || host === undefined) {
            return;
        }

        let cancelled = false;

        audioTrackRequiringTranscode(videoFile.file)
            .then(async (track) => {
                // Nothing to do when the file already plays, or when the decoder can't be fetched -
                // an offline browser should just behave as it always has.
                if (cancelled || track === undefined) {
                    return;
                }

                const available = await host.isAvailable();
                if (cancelled) return;
                if (!available) {
                    asbTrace('audio/transcode', 'Suppressing conversion prompt: decoder is unavailable', {
                        fileId: videoFile.id,
                        codec: track.codec,
                    });
                    return;
                }

                asbTrace('audio/transcode', 'Offering audio conversion', {
                    fileId: videoFile.id,
                    trackIndex: track.index,
                    codec: track.codec,
                });
                trackIndexRef.current = track.index;
                setCodecName(audioCodecDisplayName(track.codec));
                setState('prompting');
            })
            .catch((error: unknown) => {
                if (!cancelled) {
                    asbWarn('audio/transcode', 'Could not determine whether to offer audio conversion', {
                        fileId: videoFile.id,
                        error,
                    });
                }
            });

        return () => {
            cancelled = true;
            abortControllerRef.current?.abort();
        };
    }, [videoFile, host, revokeUrl]);

    useEffect(() => {
        return () => {
            abortControllerRef.current?.abort();
            revokeUrl();
        };
    }, [revokeUrl]);

    const start = useCallback(() => {
        const trackIndex = trackIndexRef.current;

        if (videoFile === undefined || trackIndex === undefined || host === undefined) {
            return;
        }

        const abortController = new AbortController();
        abortControllerRef.current?.abort();
        abortControllerRef.current = abortController;
        setProgress(undefined);
        setState('transcoding');
        setError(undefined);

        transcodeAudioTrack({
            file: videoFile.file,
            trackIndex,
            host,
            onProgress: (progress) => {
                if (!abortController.signal.aborted) {
                    setProgress(progress);
                }
            },
            signal: abortController.signal,
        })
            .then(({ blob }) => {
                if (abortController.signal.aborted) {
                    return;
                }

                revokeUrl();
                urlRef.current = createBlobUrl(blob);
                setBlob(blob);
                setUrl(urlRef.current);
                setState('ready');
                asbTrace('audio/transcode', 'Converted audio is ready for playback', {
                    fileId: videoFile.id,
                    outputBytes: blob.size,
                });
            })
            .catch((e) => {
                if (abortController.signal.aborted) {
                    return;
                }

                asbError('audio/transcode', 'Failed to transcode audio', {
                    fileId: videoFile.id,
                    trackIndex,
                    error: e,
                });
                setError(e);
                setState('failed');
            });
    }, [videoFile, host, revokeUrl]);

    const dismiss = useCallback(() => {
        asbTrace('audio/transcode', 'Audio conversion dismissed');
        abortControllerRef.current?.abort();
        abortControllerRef.current = undefined;
        setProgress(undefined);
        setState('idle');
        setError(undefined);
    }, []);

    return { state, codecName, progress, error, url, blob, start, dismiss };
};
