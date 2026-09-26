import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Box from '@mui/material/Box';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import { useTranslation } from 'react-i18next';
import { useCallback, useEffect, useState } from 'react';
import { download, formatLogLine, getCurrentTimeString } from '@project/common/util';
import type { LogLevel, LogLine, LogProvider } from '@project/common/util';

interface Props {
    open: boolean;
    onClose: () => void;
    logProvider: LogProvider;
}

const LOG_LEVEL_COLORS: Record<LogLevel, string> = {
    error: 'error.main',
    warning: 'warning.main',
    info: 'info.main',
    log: 'inherit',
    trace: 'grey.500',
};

const DEFAULT_LOG_LINE_COUNT = 100;

const LogViewerDialog: React.FC<Props> = ({ open, onClose, logProvider }) => {
    const { t } = useTranslation();
    const [showTrace, setShowTrace] = useState(false);
    const [numberOfLines, setNumberOfLines] = useState(DEFAULT_LOG_LINE_COUNT);
    const [logLines, setLogLines] = useState<readonly LogLine[]>([]);
    const [loadError, setLoadError] = useState<string>();

    const reloadLogLines = useCallback(async () => {
        try {
            const lines = await logProvider.getLogLines();
            setLogLines(lines);
            setLoadError(undefined);
        } catch (error) {
            setLoadError(error instanceof Error ? error.message : String(error));
        }
    }, [logProvider]);

    const handleExportLogs = useCallback(async () => {
        try {
            const logText = await logProvider.getLogText();
            download(new Blob([logText], { type: 'text/plain' }), `asbplayer-log-${getCurrentTimeString()}.txt`);
            setLoadError(undefined);
        } catch (error) {
            setLoadError(error instanceof Error ? error.message : String(error));
        }
    }, [logProvider]);

    useEffect(() => {
        if (!open) return;
        void reloadLogLines();
    }, [open, reloadLogLines]);

    const displayedLogLines = logLines
        .filter((logLine) => showTrace || logLine.level !== 'trace')
        .slice(-numberOfLines);

    return (
        <Dialog fullWidth maxWidth="md" open={open} onClose={onClose}>
            <DialogTitle
                component="div"
                sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}
            >
                <span>{t('settings.logs')}</span>
                <FormControlLabel
                    sx={{ m: 0 }}
                    control={<Switch checked={showTrace} onChange={(event) => setShowTrace(event.target.checked)} />}
                    label={t('settings.traceLogging')}
                />
            </DialogTitle>
            <DialogContent dividers>
                {loadError && <Alert severity="error">{loadError}</Alert>}
                <Box
                    component="div"
                    sx={{
                        minHeight: '20rem',
                        maxHeight: '60vh',
                        overflow: 'auto',
                        m: 0,
                        fontFamily: 'monospace',
                    }}
                >
                    {displayedLogLines.map((logLine, index) => (
                        <Box
                            component="div"
                            key={`${logLine.timestamp}-${index}`}
                            sx={{
                                px: 1,
                                py: 0.5,
                                whiteSpace: 'pre-wrap',
                                overflowWrap: 'anywhere',
                                color: LOG_LEVEL_COLORS[logLine.level],
                                backgroundColor: index % 2 === 0 ? 'background.default' : 'action.hover',
                            }}
                        >
                            {formatLogLine(logLine)}
                        </Box>
                    ))}
                </Box>
            </DialogContent>
            <DialogActions sx={{ justifyContent: 'space-between', gap: 1 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <TextField
                        size="small"
                        type="number"
                        label={t('settings.lines')}
                        value={numberOfLines}
                        onChange={(event) => {
                            const value = Math.max(1, Math.floor(Number(event.target.value)));
                            if (Number.isFinite(value)) {
                                setNumberOfLines(value);
                            }
                        }}
                        slotProps={{
                            htmlInput: {
                                min: 1,
                                step: 1,
                            },
                        }}
                        sx={{ width: 100 }}
                    />
                    <Button onClick={() => void reloadLogLines()}>{t('action.reload')}</Button>
                </Box>
                <Box sx={{ display: 'flex', gap: 1 }}>
                    <Button onClick={() => void handleExportLogs()}>{t('ankiDialog.export')}</Button>
                    <Button onClick={onClose}>{t('action.close')}</Button>
                </Box>
            </DialogActions>
        </Dialog>
    );
};

export default LogViewerDialog;
