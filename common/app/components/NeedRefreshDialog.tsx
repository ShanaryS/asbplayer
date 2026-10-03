import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import DialogActions from '@mui/material/DialogActions';
import { useTranslation } from 'react-i18next';
import type { FfmpegDownloadProgress as DownloadProgress } from '@project/ffmpeg';
import FfmpegDownloadProgress from '@project/common/app/components/FfmpegDownloadProgress';

interface Props {
    open: boolean;
    onRefresh: () => void;
    onClose: () => void;
    ffmpegDownloadProgress?: DownloadProgress;
}

const NeedRefreshDialog = ({ open, onRefresh, onClose, ffmpegDownloadProgress }: Props) => {
    const { t } = useTranslation();
    const preparingFfmpeg = ffmpegDownloadProgress !== undefined && ffmpegDownloadProgress.stage !== 'complete';
    return (
        <Dialog open={open} onClose={onClose}>
            <DialogTitle>{t('app.pwaUpdatePromptTitle')}</DialogTitle>
            <DialogContent>
                {t('app.pwaUpdatePromptBody')}
                {preparingFfmpeg && <FfmpegDownloadProgress progress={ffmpegDownloadProgress} />}
            </DialogContent>
            <DialogActions>
                <Button onClick={onClose}>{t('action.cancel')}</Button>
                <Button onClick={onRefresh} disabled={preparingFfmpeg}>
                    {t('action.ok')}
                </Button>
            </DialogActions>
        </Dialog>
    );
};

export default NeedRefreshDialog;
