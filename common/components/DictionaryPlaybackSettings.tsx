import React from 'react';
import { useTranslation } from 'react-i18next';
import Checkbox from '@mui/material/Checkbox';
import Box from '@mui/material/Box';
import PowerSettingsNewIcon from '@mui/icons-material/PowerSettingsNew';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import InputAdornment from '@mui/material/InputAdornment';
import type { DictionaryPlaybackConfig, DictionaryPlaybackFeature } from '@project/common/settings';
import {
    dictionaryPlaybackFeatures,
    dictionaryPlaybackGroupSettingsEnabled,
    NUM_TOKEN_STATUSES,
    NUM_TOKEN_STATES,
    TokenState,
} from '@project/common/settings';
import SettingsTextField from '@project/common/components/SettingsTextField';
import NumericSettingInput from '@project/common/components/NumericSettingInput';
import SwitchLabelWithHoverEffect from '@project/common/components/SwitchLabelWithHoverEffect';
import ResponsiveSettingsStack from '@project/common/components/ResponsiveSettingsStack';

interface Props {
    config: DictionaryPlaybackConfig;
    onChange: (config: DictionaryPlaybackConfig) => void;
}

const featureLabel: Record<DictionaryPlaybackFeature, string> = {
    autoPause: 'dictionaryPlaybackAutoPause',
    condensed: 'dictionaryPlaybackCondensed',
    fastForward: 'dictionaryPlaybackFastForward',
    repeat: 'dictionaryPlaybackRepeat',
    wordVisibility: 'dictionaryPlaybackWordVisibility',
};

const optionValues = (value: unknown): number[] => {
    if (Array.isArray(value)) return value.map(Number).filter(Number.isFinite);
    if (typeof value === 'string') return value ? value.split(',').map(Number).filter(Number.isFinite) : [];
    return [];
};

const DictionaryPlaybackSettings: React.FC<Props> = ({ config, onChange }) => {
    const { t } = useTranslation();
    const label = (value: number) =>
        value < NUM_TOKEN_STATUSES
            ? t(`settings.dictionaryTokenStatus${value}`)
            : value - NUM_TOKEN_STATUSES === TokenState.IGNORED
              ? t('settings.dictionaryTokenStateIgnored')
              : String(value - NUM_TOKEN_STATUSES);
    const options = Array.from({ length: NUM_TOKEN_STATUSES + NUM_TOKEN_STATES }, (_, value) => value);
    const updateRule = <K extends DictionaryPlaybackFeature>(
        feature: K,
        update: Partial<DictionaryPlaybackConfig['rules'][K]>
    ) => onChange({ ...config, rules: { ...config.rules, [feature]: { ...config.rules[feature], ...update } } });
    return (
        <Stack spacing={2} sx={{ mt: 1 }}>
            {dictionaryPlaybackFeatures.map((feature) => {
                const selected = options.filter((value) =>
                    value < NUM_TOKEN_STATUSES
                        ? config.onStatuses[value]?.[feature]
                        : config.onStates[value - NUM_TOKEN_STATUSES]?.[feature]
                );
                return (
                    <Box
                        key={feature}
                        component="fieldset"
                        sx={{
                            m: 0,
                            p: 1.5,
                            border: (theme) => `1px solid ${theme.palette.action.focus}`,
                            borderRadius: 1,
                        }}
                    >
                        {dictionaryPlaybackGroupSettingsEnabled(config, feature) && (
                            <Box component="legend" sx={{ px: 0.5, color: 'primary.main' }}>
                                <PowerSettingsNewIcon sx={{ width: 16, height: 16, display: 'block' }} />
                            </Box>
                        )}
                        <Stack spacing={1}>
                            <SettingsTextField
                                select
                                fullWidth
                                color="primary"
                                variant="outlined"
                                size="small"
                                label={t(`settings.${featureLabel[feature]}`)}
                                value={selected}
                                SelectProps={{
                                    multiple: true,
                                    renderValue: (values) =>
                                        optionValues(values).map(label).join(', ') ||
                                        t('settings.dictionaryTokenReadingAnnotationNever'),
                                }}
                                onChange={(event) => {
                                    const values = optionValues(event.target.value);
                                    onChange({
                                        ...config,
                                        onStatuses: config.onStatuses.map((status, index) => ({
                                            ...status,
                                            [feature]: values.includes(index),
                                        })),
                                        onStates: config.onStates.map((state, index) => ({
                                            ...state,
                                            [feature]: values.includes(NUM_TOKEN_STATUSES + index),
                                        })),
                                    });
                                }}
                            >
                                {options.map((value) => (
                                    <MenuItem key={value} value={value}>
                                        <ListItemIcon>
                                            <Checkbox checked={selected.includes(value)} />
                                        </ListItemIcon>
                                        <ListItemText primary={label(value)} />
                                    </MenuItem>
                                ))}
                            </SettingsTextField>
                            <Box sx={{ '& .MuiFormLabel-root': { minHeight: '3em' } }}>
                                <ResponsiveSettingsStack>
                                    <NumericSettingInput
                                        fullWidth
                                        color="primary"
                                        label={t('settings.dictionaryPlaybackMaxWords')}
                                        helperText={t('settings.dictionaryPlaybackMaxWordsHelper')}
                                        value={config.rules[feature].maxWords}
                                        normalizeValue={(value) => Math.max(0, Math.floor(value))}
                                        onValueChange={(value) => updateRule(feature, { maxWords: value })}
                                        slotProps={{ htmlInput: { min: 0, step: 1 } }}
                                    />
                                    <NumericSettingInput
                                        fullWidth
                                        color="primary"
                                        label={t('settings.dictionaryPlaybackMaxFrequency')}
                                        helperText={t('settings.dictionaryPlaybackMaxFrequencyHelper')}
                                        value={config.rules[feature].maxFrequency}
                                        normalizeValue={(value) => Math.min(100000, Math.max(0, Math.floor(value)))}
                                        onValueChange={(value) => updateRule(feature, { maxFrequency: value })}
                                        slotProps={{ htmlInput: { min: 0, max: 100000, step: 1 } }}
                                    />
                                </ResponsiveSettingsStack>
                            </Box>
                            {feature === 'wordVisibility' && (
                                <>
                                    <NumericSettingInput
                                        fullWidth
                                        color="primary"
                                        label={t('settings.dictionaryPlaybackWholeSubtitleMatchThreshold')}
                                        value={config.rules.wordVisibility.wholeSubtitleMatchThreshold * 100}
                                        normalizeValue={(value) => Math.min(100, Math.max(1, Math.floor(value)))}
                                        onValueChange={(value) =>
                                            updateRule('wordVisibility', {
                                                wholeSubtitleMatchThreshold: value / 100,
                                            })
                                        }
                                        slotProps={{
                                            input: { endAdornment: <InputAdornment position="end">%</InputAdornment> },
                                            htmlInput: { min: 1, max: 100, step: 1 },
                                        }}
                                    />
                                    <SwitchLabelWithHoverEffect
                                        control={
                                            <Switch
                                                checked={
                                                    config.rules.wordVisibility.hideWordsIndividuallyUntilThreshold
                                                }
                                                onChange={(event) =>
                                                    updateRule('wordVisibility', {
                                                        hideWordsIndividuallyUntilThreshold: event.target.checked,
                                                    })
                                                }
                                            />
                                        }
                                        label={t('settings.dictionaryPlaybackHideWordsIndividuallyUntilThreshold')}
                                        labelPlacement="start"
                                    />
                                </>
                            )}
                            {feature === 'fastForward' && (
                                <SwitchLabelWithHoverEffect
                                    control={
                                        <Switch
                                            checked={config.rules.fastForward.rateByComprehension.enabled}
                                            onChange={(event) =>
                                                updateRule('fastForward', {
                                                    rateByComprehension: {
                                                        ...config.rules.fastForward.rateByComprehension,
                                                        enabled: event.target.checked,
                                                    },
                                                })
                                            }
                                        />
                                    }
                                    label={t('settings.dictionaryPlaybackFastForwardComprehension')}
                                    labelPlacement="start"
                                />
                            )}
                        </Stack>
                    </Box>
                );
            })}
        </Stack>
    );
};

export default DictionaryPlaybackSettings;
