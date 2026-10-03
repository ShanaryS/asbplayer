import LinearProgress from '@mui/material/LinearProgress';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useTranslation } from 'react-i18next';
import type { FfmpegDownloadProgress as DownloadProgress } from '@project/ffmpeg';

/** Shared by optional media features and the background PWA runtime replacement. */
const FfmpegDownloadProgress = ({ progress }: { progress: DownloadProgress }) => {
    const { t, i18n } = useTranslation();
    const locale = (i18n.resolvedLanguage ?? i18n.language ?? 'en').replaceAll('_', '-');
    const mib = (bytes: number) => (bytes / (1024 * 1024)).toLocaleString(locale, { maximumFractionDigits: 2 });
    return (
        <Stack spacing={1} sx={{ minWidth: 250 }}>
            <Typography variant="body2">
                FFmpeg: {t(progress.stage === 'verifying' ? 'info.verifying' : 'info.downloading')}
            </Typography>
            <LinearProgress
                variant="determinate"
                value={progress.totalBytes > 0 ? (100 * progress.downloadedBytes) / progress.totalBytes : 0}
            />
            <Typography variant="caption">
                {`${mib(progress.downloadedBytes)} / ${mib(progress.totalBytes)} MiB · ${mib(progress.bytesPerSecond)} MiB/s`}
                {progress.etaSeconds !== undefined && ` · ETA: ${Math.ceil(progress.etaSeconds)}s`}
            </Typography>
        </Stack>
    );
};

export default FfmpegDownloadProgress;
