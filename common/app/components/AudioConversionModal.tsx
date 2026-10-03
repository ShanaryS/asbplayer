import React from 'react';
import { useTranslation } from 'react-i18next';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import LinearProgress from '@mui/material/LinearProgress';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import type { AudioTranscodeProgress } from '@project/common/audio-transcode';
import FfmpegDownloadProgress from '@project/common/app/components/FfmpegDownloadProgress';
import { humanReadableTime, localizeDateTime, timeDurationDisplay } from '@project/common/util';

interface AudioConversionModalProps {
    open: boolean;
    progress?: AudioTranscodeProgress;
    onCancel: () => void;
}

export default function AudioConversionModal({ open, progress, onCancel }: AudioConversionModalProps) {
    const { t } = useTranslation();
    const download = progress?.stage === 'loadingDecoder' ? progress.download : undefined;
    const conversion = progress !== undefined && progress.stage !== 'loadingDecoder' ? progress : undefined;
    const percent =
        conversion?.totalSeconds === undefined
            ? undefined
            : Math.min(99, Math.max(0, (100 * conversion.processedSeconds) / conversion.totalSeconds));
    const duration = (seconds: number) =>
        timeDurationDisplay(seconds * 1000, (conversion?.totalSeconds ?? 0) * 1000, false);
    const etaMilliseconds = conversion?.etaSeconds === undefined ? undefined : Math.ceil(conversion.etaSeconds * 1000);

    return (
        <Dialog
            open={open}
            onClose={(event, reason) => {
                if (reason === 'backdropClick' || reason === 'escapeKeyDown') return;
                onCancel();
            }}
            fullWidth
            maxWidth="sm"
            aria-labelledby="audio-conversion-title"
            aria-describedby="audio-conversion-description"
            disableEscapeKeyDown
            sx={{
                '& .MuiDialog-paper': {
                    bgcolor: 'background.default',
                },
            }}
        >
            <DialogTitle id="audio-conversion-title">{t('info.audioConversionTitle')}</DialogTitle>
            <DialogContent dividers>
                <Typography id="audio-conversion-description" variant="body1" align="center" gutterBottom>
                    {t(conversion === undefined ? 'info.loadingAudioConverter' : 'info.convertingAudio')}
                </Typography>
                <Box width="100%" mt={3}>
                    {download !== undefined && download.stage !== 'complete' ? (
                        <FfmpegDownloadProgress progress={download} />
                    ) : conversion !== undefined ? (
                        <Stack spacing={1}>
                            <LinearProgress
                                aria-label={t('info.audioConversionTitle')}
                                variant={percent === undefined ? 'indeterminate' : 'determinate'}
                                value={percent}
                                sx={{ height: 10, borderRadius: 5 }}
                            />
                            <Typography variant="body2" align="center">
                                {`${duration(conversion.processedSeconds)} / ${conversion.totalSeconds === undefined ? '...' : duration(conversion.totalSeconds)}`}
                                {percent !== undefined && ` (${Math.floor(percent)}%)`}
                            </Typography>
                            <Typography variant="caption" align="center">
                                {conversion.stage === 'finalizing'
                                    ? '...'
                                    : etaMilliseconds !== undefined
                                      ? `[ETA: ${localizeDateTime(Date.now() + etaMilliseconds)} (${humanReadableTime(etaMilliseconds)})]`
                                      : conversion.totalSeconds !== undefined
                                        ? '[ETA: ...]'
                                        : undefined}
                            </Typography>
                        </Stack>
                    ) : (
                        <LinearProgress variant="indeterminate" sx={{ height: 10, borderRadius: 5 }} />
                    )}
                </Box>
            </DialogContent>
            <DialogActions sx={{ justifyContent: 'center' }}>
                <Button onClick={onCancel} variant="outlined" color="primary">
                    {t('action.cancel')}
                </Button>
            </DialogActions>
        </Dialog>
    );
}
