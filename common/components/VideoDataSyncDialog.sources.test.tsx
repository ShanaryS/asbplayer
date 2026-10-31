import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import VideoDataSyncDialog from '@project/common/components/VideoDataSyncDialog';
import { VideoDataUiOpenReason } from '@project/common';
import type { VideoDataSubtitleTrack } from '@project/common';
import { DefaultFileSelector } from '@project/common/file-selector';
import { initialGlobalState } from '@project/common/global-state';

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it('prefixes embedded, local and cached online choices and keeps external tracks first', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const tracks: VideoDataSubtitleTrack[] = [
        { id: '-', label: 'Empty', extension: 'srt' },
        {
            id: 'embedded:video:4',
            label: 'Embedded',
            extension: 'srt',
            embedded: {
                videoId: 'video',
                fingerprint: { name: 'video.mkv', size: 1, lastModified: 0 },
                streamIndex: 4,
                codec: 'subrip',
                format: 'srt',
            },
        },
        { id: 'local', label: 'Local', extension: 'srt', file: new File([''], 'local.srt') },
        // Downloaded outputs retain their URL IDs even when restored from the file cache.
        {
            id: 'https://example.com/subtitle.srt',
            label: 'Online',
            extension: 'srt',
            file: new File([''], 'online.srt'),
        },
    ];
    try {
        act(() =>
            root.render(
                <VideoDataSyncDialog
                    open={true}
                    disabled={false}
                    isLoading={false}
                    suggestedName="Video"
                    subtitleTracks={tracks}
                    selectedSubtitleTrackIds={['local', '-', '-']}
                    defaultCheckboxState={false}
                    error=""
                    openReason={VideoDataUiOpenReason.userRequested}
                    profiles={[]}
                    onlineSubtitleSourceConfig={initialGlobalState.onlineSubtitleSourceConfig}
                    clientId="test"
                    hasSeenFtue={true}
                    hideRememberTrackPreferenceToggle={true}
                    hideVideoNameTextField={true}
                    fileSelector={new DefaultFileSelector(() => {})}
                    onCancel={() => {}}
                    onOpenSettings={() => {}}
                    onConfirm={() => {}}
                    onSetActiveProfile={() => {}}
                    onOnlineSourceConfigChanged={() => {}}
                    onDismissFtue={() => {}}
                    onOpenFiles={() => {}}
                    onSubtitleTracks={() => {}}
                    onSelectedSubtitleTrackIds={() => {}}
                />
            )
        );
        act(() => {
            document
                .querySelector('[role=combobox]')!
                .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
        });
        const options = [...document.querySelectorAll('[role=option]')].slice(0, 4);
        expect(options.map((option) => option.textContent)).toEqual(['Empty', 'Local', 'Online', 'Embedded']);
        expect(options.map((option) => option.querySelector('svg')?.getAttribute('data-testid'))).toEqual([
            undefined,
            'DescriptionOutlinedIcon',
            'CloudDownloadOutlinedIcon',
            'MovieOutlinedIcon',
        ]);
    } finally {
        act(() => root.unmount());
        container.remove();
    }
});
