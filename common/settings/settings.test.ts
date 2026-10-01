import {
    areDictionaryPlaybackConfigsEqual,
    dictionaryPlaybackGroupSettingsEnabled,
    autoPausePreferenceForCheckboxChange,
    calculateSeekableTracksValue,
    effectiveSubtitleListCustomization,
    isTrackSeekable,
    maxSubtitlesWidth,
    subtitlesWidthCssValue,
    SubtitleListTimestampDisplay,
    updateSeekableTracksValue,
} from '.';
import type { AutoPausePreferenceEdge } from '.';
import { describe, expect, it } from '@jest/globals';
import { AutoPausePreference } from '@project/common/src/model';
import { defaultSettings } from '@project/common/settings/settings-provider';

it('compares dictionary playback fields by value regardless of object key order', () => {
    const config = defaultSettings.dictionaryTracks[0].dictionaryPlaybackConfig;
    const reordered = {
        rules: {
            wordVisibility: {
                wholeSubtitleMatchThreshold: config.rules.wordVisibility.wholeSubtitleMatchThreshold,
                hideWordsIndividuallyUntilThreshold: config.rules.wordVisibility.hideWordsIndividuallyUntilThreshold,
                maxFrequency: 0,
                maxWords: 0,
            },
            repeat: { maxFrequency: 0, maxWords: 0 },
            fastForward: {
                rateByComprehension: { ...config.rules.fastForward.rateByComprehension },
                maxFrequency: 0,
                maxWords: 0,
            },
            condensed: { maxFrequency: 0, maxWords: 0 },
            autoPause: { maxFrequency: 0, maxWords: 0 },
        },
        onStates: config.onStates.map((state) => ({
            wordVisibility: state.wordVisibility,
            repeat: state.repeat,
            fastForward: state.fastForward,
            condensed: state.condensed,
            autoPause: state.autoPause,
        })),
        onStatuses: config.onStatuses.map((status) => ({
            wordVisibility: status.wordVisibility,
            repeat: status.repeat,
            fastForward: status.fastForward,
            condensed: status.condensed,
            autoPause: status.autoPause,
        })),
    };
    expect(areDictionaryPlaybackConfigsEqual(config, reordered)).toBe(true);
    reordered.rules.fastForward.rateByComprehension.enabled = true;
    expect(areDictionaryPlaybackConfigsEqual(config, reordered)).toBe(false);
    reordered.rules.fastForward.rateByComprehension.enabled = false;
    reordered.rules.repeat.maxFrequency = 1;
    expect(areDictionaryPlaybackConfigsEqual(config, reordered)).toBe(false);
    reordered.rules.repeat.maxFrequency = 0;
    reordered.rules.wordVisibility.wholeSubtitleMatchThreshold = 0.5;
    expect(areDictionaryPlaybackConfigsEqual(config, reordered)).toBe(false);
    reordered.rules.wordVisibility.wholeSubtitleMatchThreshold = 1;
    reordered.rules.wordVisibility.hideWordsIndividuallyUntilThreshold = false;
    expect(areDictionaryPlaybackConfigsEqual(config, reordered)).toBe(false);
    reordered.rules.wordVisibility.hideWordsIndividuallyUntilThreshold = true;
    reordered.onStatuses[0].autoPause = true;
    expect(areDictionaryPlaybackConfigsEqual(config, reordered)).toBe(false);
});

it('treats the default 100 percent visibility threshold as unconfigured', () => {
    const defaultConfig = defaultSettings.dictionaryTracks[0].dictionaryPlaybackConfig;
    const config = {
        ...defaultConfig,
        rules: { ...defaultConfig.rules, wordVisibility: { ...defaultConfig.rules.wordVisibility } },
    };
    expect(config.rules.wordVisibility.wholeSubtitleMatchThreshold).toBe(1);
    expect(dictionaryPlaybackGroupSettingsEnabled(config, 'wordVisibility')).toBe(false);
    config.rules.wordVisibility.wholeSubtitleMatchThreshold = 0.8;
    expect(dictionaryPlaybackGroupSettingsEnabled(config, 'wordVisibility')).toBe(true);
});

describe('effectiveSubtitleListCustomization', () => {
    const configured = {
        showSubtitleListMiningButton: false,
        subtitleListTimestampDisplay: SubtitleListTimestampDisplay.startAndEnd,
    };

    it('uses the configured values when customization is supported', () => {
        expect(effectiveSubtitleListCustomization(configured, true)).toEqual({
            showMiningButton: false,
            timestampDisplay: SubtitleListTimestampDisplay.startAndEnd,
        });
    });

    it('uses legacy defaults when customization is not supported', () => {
        expect(effectiveSubtitleListCustomization(configured, false)).toEqual({
            showMiningButton: true,
            timestampDisplay: SubtitleListTimestampDisplay.start,
        });
    });
});

describe('autoPausePreferenceForCheckboxChange', () => {
    it.each<{
        preference: AutoPausePreference;
        edge: AutoPausePreferenceEdge;
        checked: boolean;
        expected: AutoPausePreference;
    }>([
        {
            preference: AutoPausePreference.atStart,
            edge: AutoPausePreference.atStart,
            checked: false,
            expected: AutoPausePreference.atEnd,
        },
        {
            preference: AutoPausePreference.atEnd,
            edge: AutoPausePreference.atEnd,
            checked: false,
            expected: AutoPausePreference.atStart,
        },
        {
            preference: AutoPausePreference.atStartAndEnd,
            edge: AutoPausePreference.atStart,
            checked: false,
            expected: AutoPausePreference.atEnd,
        },
        {
            preference: AutoPausePreference.atStartAndEnd,
            edge: AutoPausePreference.atEnd,
            checked: false,
            expected: AutoPausePreference.atStart,
        },
        {
            preference: AutoPausePreference.atStart,
            edge: AutoPausePreference.atEnd,
            checked: true,
            expected: AutoPausePreference.atStartAndEnd,
        },
        {
            preference: AutoPausePreference.atEnd,
            edge: AutoPausePreference.atStart,
            checked: true,
            expected: AutoPausePreference.atStartAndEnd,
        },
    ])('maps $preference when edge $edge becomes $checked to $expected', ({ preference, edge, checked, expected }) => {
        expect(autoPausePreferenceForCheckboxChange(preference, edge, { checked })).toBe(expected);
    });
});

it('can determine seekable tracks correctly', () => {
    expect(isTrackSeekable(0, 0)).toBe(false);
    expect(isTrackSeekable(0, 1)).toBe(false);
    expect(isTrackSeekable(0, 2)).toBe(false);

    expect(isTrackSeekable(1, 0)).toBe(true);
    expect(isTrackSeekable(1, 1)).toBe(false);
    expect(isTrackSeekable(1, 2)).toBe(false);

    expect(isTrackSeekable(2, 0)).toBe(false);
    expect(isTrackSeekable(2, 1)).toBe(true);
    expect(isTrackSeekable(2, 2)).toBe(false);

    expect(isTrackSeekable(3, 0)).toBe(true);
    expect(isTrackSeekable(3, 1)).toBe(true);
    expect(isTrackSeekable(3, 2)).toBe(false);

    expect(isTrackSeekable(4, 0)).toBe(false);
    expect(isTrackSeekable(4, 1)).toBe(false);
    expect(isTrackSeekable(4, 2)).toBe(true);
});

it('can calculate seekable tracks correctly', () => {
    const val = calculateSeekableTracksValue([0]);
    expect(isTrackSeekable(val, 0)).toBe(true);
    expect(isTrackSeekable(val, 1)).toBe(false);
    expect(isTrackSeekable(val, 2)).toBe(false);

    const val2 = calculateSeekableTracksValue([1, 2]);
    expect(isTrackSeekable(val2, 0)).toBe(false);
    expect(isTrackSeekable(val2, 1)).toBe(true);
    expect(isTrackSeekable(val2, 2)).toBe(true);
});

it('can update seekable tracks correctly', () => {
    expect(updateSeekableTracksValue(calculateSeekableTracksValue([1, 2]), 1, false)).toEqual(
        calculateSeekableTracksValue([2])
    );
    expect(updateSeekableTracksValue(calculateSeekableTracksValue([1, 2]), 1, true)).toEqual(
        calculateSeekableTracksValue([1, 2])
    );
    expect(updateSeekableTracksValue(calculateSeekableTracksValue([1, 2]), 0, true)).toEqual(
        calculateSeekableTracksValue([0, 1, 2])
    );
});

describe('subtitlesWidthCssValue', () => {
    it('leaves the width automatic when it is -1', () => {
        expect(subtitlesWidthCssValue({ subtitlesWidth: -1, subtitlesWidthUnit: '%' })).toBeUndefined();
        expect(subtitlesWidthCssValue({ subtitlesWidth: -1, subtitlesWidthUnit: 'px' })).toBeUndefined();
    });

    it('renders percentages and pixels', () => {
        expect(subtitlesWidthCssValue({ subtitlesWidth: 80, subtitlesWidthUnit: '%' })).toBe('80%');
        expect(subtitlesWidthCssValue({ subtitlesWidth: 800, subtitlesWidthUnit: 'px' })).toBe('800px');
    });
});

describe('subtitlesWidth bounds', () => {
    it('caps percentages at 100 and pixels at a sanity limit', () => {
        expect(maxSubtitlesWidth('%')).toBe(100);
        expect(maxSubtitlesWidth('px')).toBe(10000);
    });
});
