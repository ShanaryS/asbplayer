import { AutoPausePreference, PlayMode } from '@project/common';
import type { IndexedSubtitleModel } from '@project/common';
import type {
    PlaybackTimelineBlock,
    PlaybackTimelineEndAction,
    PlaybackTimelineRepeatAction,
    PlaybackTimelineState,
} from '@project/common/playback/timeline/playback-timeline';
import {
    AutoPauseResumeMode,
    dictionaryPlaybackFeatureEnabled,
    dictionaryPlaybackFeatures,
    SubtitleVisibility,
} from '@project/common/settings';
import type { DictionaryTrack, DictionaryPlaybackFeature } from '@project/common/settings';
import { subtitleWordVisibility, matchingPlaybackTokens } from '@project/common/playback/plan/playback-dictionary';
import { sentenceComprehensionPercent } from '@project/common/dictionary-statistics/dictionary-statistics-view';
import { compilePlaybackTimelineSubtitles } from '@project/common/playback/timeline/playback-timeline-compiler';
import type { PlaybackTimelineSubtitles } from '@project/common/playback/timeline/playback-timeline-compiler';
import {
    areSubtitleModelsEqual,
    arrayEquals,
    fieldsEqual,
    normalizeFinite,
    normalizeNonNegative,
    normalizeNonPositive,
} from '@project/common/util';
import type { FieldComparators } from '@project/common/util';
import { asbTrace } from '@project/common/util/log';

export const playbackPlanCorrectionToleranceMs = 0.5;

export interface PlaybackPlanFastForward {
    readonly playbackRate: number;
    readonly minimumSkipIntervalMs: number;
}

export interface PlaybackPlanCondensed {
    readonly minimumSkipIntervalMs: number;
    readonly pauseAtStart: boolean;
}

export interface PlaybackPlanAutoPauseResumeManual {
    readonly mode: AutoPauseResumeMode.manual;
}

export interface PlaybackPlanAutoPauseResumeFixed {
    readonly mode: AutoPauseResumeMode.fixed;
    readonly fixedDurationMs: number;
    readonly delayMs: number;
}

export interface PlaybackPlanAutoPauseResumeSubtitleLength {
    readonly mode: AutoPauseResumeMode.subtitleLength;
    readonly minimumDurationMs: number;
    readonly maximumDurationMs: number;
    readonly timePerCharacterMs: number;
    readonly delayMs: number;
}

export type PlaybackPlanAutoPauseResume =
    | PlaybackPlanAutoPauseResumeManual
    | PlaybackPlanAutoPauseResumeFixed
    | PlaybackPlanAutoPauseResumeSubtitleLength;

export interface PlaybackPlanAutoPause {
    readonly resume: PlaybackPlanAutoPauseResume;
}

/** Playback policy compiled and applied beside its owning media element. */
export interface PlaybackPlan<T extends IndexedSubtitleModel> {
    readonly timelineSubtitles: PlaybackTimelineSubtitles<T>;
    readonly playbackRate: number;
    readonly condensed?: PlaybackPlanCondensed;
    readonly fastForward?: PlaybackPlanFastForward;
    readonly autoPause?: PlaybackPlanAutoPause;
    readonly subtitleVisibility: SubtitleVisibility;
    readonly hiddenSubtitleIndexes?: readonly number[];
}

export interface PlaybackPlanInput<T extends IndexedSubtitleModel> {
    /** Subtitles eligible to influence playback modes. */
    readonly subtitles: readonly T[];
    /** All subtitles eligible for display. Defaults to subtitles. */
    readonly displaySubtitles?: readonly T[];
    readonly durationMs: number;
    readonly playModes: ReadonlySet<PlayMode>;
    readonly autoPausePreference: AutoPausePreference;
    readonly subtitleTriggerStartOffset: number;
    readonly subtitleTriggerEndOffset: number;
    readonly subtitleTriggerGapStartOffset: number;
    readonly subtitleTriggerGapEndOffset: number;
    readonly repeatCountPreference: number;
    readonly repeatsBeforeShowingSubtitles: number;
    readonly condensedPlaybackMinimumSkipIntervalMs: number;
    readonly playbackRate: number;
    readonly fastForwardModePlaybackRate: number;
    readonly fastForwardPlaybackMinimumSkipIntervalMs: number;
    readonly autoPauseResumeMode: AutoPauseResumeMode;
    readonly autoPauseResumeDelayMs: number;
    readonly autoPauseFixedDurationMs: number;
    readonly autoPauseMinimumDurationMs: number;
    readonly autoPauseMaximumDurationMs: number;
    readonly autoPauseTimePerCharacterMs: number;
    readonly subtitleVisibility: SubtitleVisibility;
    readonly dictionaryTracks?: readonly DictionaryTrack[];
}

const autoPausePreferenceIncludes = (
    preference: AutoPausePreference,
    edge: AutoPausePreference.atStart | AutoPausePreference.atEnd
) => preference === edge || preference === AutoPausePreference.atStartAndEnd;

export const timestampComparisonToleranceMs = 1e-6;

export const normalizeAutoPauseDurationBounds = (minimumDurationMs: number, maximumDurationMs: number) => {
    const minimum = normalizeNonNegative(minimumDurationMs);
    const maximum = normalizeNonNegative(maximumDurationMs);

    return {
        minimumDurationMs: minimum,
        maximumDurationMs: maximum === 0 ? 0 : Math.max(minimum, maximum),
    };
};

export const buildPlaybackPlan = <T extends IndexedSubtitleModel>({
    subtitles,
    displaySubtitles,
    durationMs,
    playModes,
    autoPausePreference,
    subtitleTriggerStartOffset,
    subtitleTriggerEndOffset,
    subtitleTriggerGapStartOffset,
    subtitleTriggerGapEndOffset,
    repeatCountPreference,
    repeatsBeforeShowingSubtitles,
    condensedPlaybackMinimumSkipIntervalMs,
    playbackRate,
    fastForwardModePlaybackRate,
    fastForwardPlaybackMinimumSkipIntervalMs,
    autoPauseResumeMode,
    autoPauseResumeDelayMs,
    autoPauseFixedDurationMs,
    autoPauseMinimumDurationMs,
    autoPauseMaximumDurationMs,
    autoPauseTimePerCharacterMs,
    subtitleVisibility,
    dictionaryTracks = [],
}: PlaybackPlanInput<T>): PlaybackPlan<T> => {
    const autoPauseEnabled = playModes.has(PlayMode.autoPause);
    const autoPauseAtStart =
        autoPauseEnabled && autoPausePreferenceIncludes(autoPausePreference, AutoPausePreference.atStart);
    const autoPauseAtEnd =
        autoPauseEnabled && autoPausePreferenceIncludes(autoPausePreference, AutoPausePreference.atEnd);
    const repeat = playModes.has(PlayMode.repeat);
    const repeatCount = normalizeNonNegative(Math.floor(repeatCountPreference));
    const revealAfterRepeats = Math.min(
        normalizeNonNegative(Math.floor(repeatsBeforeShowingSubtitles)),
        repeatCount || Infinity
    );
    const startOffset = normalizeFinite(subtitleTriggerStartOffset);
    const gapEndOffset = normalizeNonPositive(subtitleTriggerGapEndOffset);
    const condensedMinimumSkipIntervalMs = normalizeNonNegative(condensedPlaybackMinimumSkipIntervalMs);
    const fastForwardMinimumSkipIntervalMs = normalizeNonNegative(fastForwardPlaybackMinimumSkipIntervalMs);
    const timeline = compilePlaybackTimelineSubtitles({
        subtitles,
        displaySubtitles,
        durationMs,
        subtitleTriggerStartOffset,
        subtitleTriggerEndOffset,
        subtitleTriggerGapStartOffset,
        subtitleTriggerGapEndOffset,
    });

    const configuredFeatures = new Set(
        dictionaryPlaybackFeatures.filter((feature) =>
            dictionaryTracks.some((track) => dictionaryPlaybackFeatureEnabled(track.dictionaryPlaybackConfig, feature))
        )
    );
    const configured = (feature: DictionaryPlaybackFeature) => configuredFeatures.has(feature);
    const matchesByFeature = new Map<
        DictionaryPlaybackFeature,
        Map<number, ReturnType<typeof matchingPlaybackTokens>>
    >();
    for (const feature of dictionaryPlaybackFeatures) {
        if (feature === 'wordVisibility' || !configured(feature)) continue;
        if (feature === 'autoPause' && !autoPauseEnabled) continue;
        if (feature === 'repeat' && !repeat) continue;
        if (feature === 'condensed' && !playModes.has(PlayMode.condensed)) continue;
        if (feature === 'fastForward' && !playModes.has(PlayMode.fastForward)) continue;
        const matches = new Map<number, ReturnType<typeof matchingPlaybackTokens>>();
        for (const subtitle of subtitles) {
            const config = dictionaryTracks[subtitle.track]?.dictionaryPlaybackConfig;
            if (config) matches.set(subtitle.index, matchingPlaybackTokens(subtitle, config, feature));
        }
        matchesByFeature.set(feature, matches);
    }
    const matching = (block: PlaybackTimelineBlock, feature: DictionaryPlaybackFeature) =>
        block.subtitleIndexes.some((index) => (matchesByFeature.get(feature)?.get(index)?.length ?? 0) > 0);
    const comprehensionRateByIndex = new Map<number, number>();
    if (playModes.has(PlayMode.fastForward)) {
        for (const subtitle of subtitles) {
            const config = dictionaryTracks[subtitle.track]?.dictionaryPlaybackConfig;
            if (!config?.rules.fastForward.rateByComprehension.enabled) continue;
            const comprehensionPercent = sentenceComprehensionPercent(subtitle);
            comprehensionRateByIndex.set(
                subtitle.index,
                playbackRate +
                    Math.max(0, (comprehensionPercent - 60) / 40) * (fastForwardModePlaybackRate - playbackRate)
            );
        }
    }
    const blockRate = (block: PlaybackTimelineBlock): number | undefined => {
        if (!playModes.has(PlayMode.fastForward)) return undefined;
        if (matching(block, 'fastForward')) return playbackRate;
        const comprehensionRates = block.subtitleIndexes
            .map((index) => comprehensionRateByIndex.get(index))
            .filter((rate): rate is number => rate !== undefined);
        if (comprehensionRates.length) return Math.min(...comprehensionRates);
        return configured('fastForward') ? fastForwardModePlaybackRate : undefined;
    };
    const autoPauseToken = (block: PlaybackTimelineBlock) => {
        for (const index of block.subtitleIndexes) {
            const token = matchesByFeature.get('autoPause')?.get(index)?.[0];
            if (token) return { subtitleIndex: index, tokenStart: token.pos[0] };
        }
        return undefined;
    };
    const compileMatchingBlocks = (feature: DictionaryPlaybackFeature) =>
        compilePlaybackTimelineSubtitles({
            subtitles: subtitles.filter(
                (subtitle) => (matchesByFeature.get(feature)?.get(subtitle.index)?.length ?? 0) > 0
            ),
            displaySubtitles: timeline.displaySubtitles,
            durationMs: timeline.durationMs,
            subtitleTriggerStartOffset,
            subtitleTriggerEndOffset,
            subtitleTriggerGapStartOffset,
            subtitleTriggerGapEndOffset,
        }).blocks;
    const actionBlocks: PlaybackTimelineBlock[] = [];
    if (autoPauseEnabled && configured('autoPause')) {
        for (const block of compileMatchingBlocks('autoPause')) {
            const pauseToken = autoPauseToken(block);
            actionBlocks.push({
                ...block,
                id: `autoPause:${block.id}`,
                ...(autoPauseAtStart ? { startAction: true as const } : {}),
                ...(autoPauseAtEnd ? { endAction: { pause: true } } : {}),
                ...(pauseToken === undefined ? {} : { autoPauseToken: pauseToken }),
            });
        }
    }
    if (repeat && configured('repeat')) {
        for (const block of compileMatchingBlocks('repeat')) {
            actionBlocks.push({
                ...block,
                id: `repeat:${block.id}`,
                endAction: {
                    pause: false,
                    repeat: { count: repeatCount, repeatsBeforeShowingSubtitles: revealAfterRepeats },
                },
            });
        }
    }
    const hiddenSubtitleIndexes =
        subtitleVisibility === SubtitleVisibility.whenDue && configured('wordVisibility')
            ? (displaySubtitles ?? subtitles)
                  .filter((subtitle) => {
                      const config = dictionaryTracks[subtitle.track]?.dictionaryPlaybackConfig;
                      return config !== undefined && subtitleWordVisibility(subtitle, config).hideWholeSubtitle;
                  })
                  .map((subtitle) => subtitle.index)
            : [];
    const condensedBlocks =
        playModes.has(PlayMode.condensed) && configured('condensed') ? compileMatchingBlocks('condensed') : undefined;

    const pauseThisBlock = !configured('autoPause');
    const repeatThisBlock = !configured('repeat');
    const blocks = timeline.blocks.map<PlaybackTimelineBlock>((block) => {
        const fastForwardPlaybackRate = blockRate(block);
        return {
            ...block,
            ...(autoPauseAtStart && pauseThisBlock ? { startAction: true as const } : {}),
            ...(fastForwardPlaybackRate === undefined ? {} : { fastForwardPlaybackRate }),
            ...((autoPauseAtEnd && pauseThisBlock) || (repeat && repeatThisBlock)
                ? {
                      endAction: {
                          pause: autoPauseAtEnd && pauseThisBlock,
                          ...(repeat && repeatThisBlock
                              ? {
                                    repeat: {
                                        count: repeatCount,
                                        repeatsBeforeShowingSubtitles: revealAfterRepeats,
                                    },
                                }
                              : {}),
                      },
                  }
                : {}),
        };
    });

    const plan: PlaybackPlan<T> = {
        timelineSubtitles: {
            ...timeline,
            blocks,
            ...(actionBlocks.length ? { actionBlocks } : {}),
            ...(condensedBlocks === undefined ? {} : { condensedBlocks }),
        },
        playbackRate,
        subtitleVisibility,
        hiddenSubtitleIndexes,
        ...(autoPauseEnabled
            ? {
                  autoPause: {
                      resume: (() => {
                          switch (autoPauseResumeMode) {
                              case AutoPauseResumeMode.fixed:
                                  return {
                                      mode: AutoPauseResumeMode.fixed,
                                      fixedDurationMs: normalizeNonNegative(autoPauseFixedDurationMs),
                                      delayMs: normalizeNonNegative(autoPauseResumeDelayMs),
                                  } as const;
                              case AutoPauseResumeMode.subtitleLength: {
                                  const { minimumDurationMs, maximumDurationMs } = normalizeAutoPauseDurationBounds(
                                      autoPauseMinimumDurationMs,
                                      autoPauseMaximumDurationMs
                                  );
                                  return {
                                      mode: AutoPauseResumeMode.subtitleLength,
                                      minimumDurationMs,
                                      maximumDurationMs,
                                      timePerCharacterMs: normalizeNonNegative(autoPauseTimePerCharacterMs),
                                      delayMs: normalizeNonNegative(autoPauseResumeDelayMs),
                                  } as const;
                              }
                              default:
                                  return { mode: AutoPauseResumeMode.manual } as const;
                          }
                      })(),
                  },
              }
            : {}),
        ...(playModes.has(PlayMode.condensed)
            ? {
                  condensed: {
                      minimumSkipIntervalMs: condensedMinimumSkipIntervalMs,
                      pauseAtStart:
                          autoPauseAtStart && startOffset <= 0 && Math.abs(gapEndOffset) <= Math.abs(startOffset),
                  },
              }
            : {}),
        ...(playModes.has(PlayMode.fastForward)
            ? {
                  fastForward: {
                      playbackRate: fastForwardModePlaybackRate,
                      minimumSkipIntervalMs: fastForwardMinimumSkipIntervalMs,
                  },
              }
            : {}),
    };
    asbTrace('playback/plan', 'Built playback plan', {
        autoPause: plan.autoPause?.resume.mode,
        condensed: plan.condensed !== undefined,
        displaySubtitleCount: timeline.displaySubtitles.length,
        durationMs: timeline.durationMs,
        fastForward: plan.fastForward?.playbackRate,
        modes: [...playModes],
        playbackRate,
        timelineBlockCount: plan.timelineSubtitles.blocks.length,
    });
    return plan;
};

export const fastForwardingForPlanState = <T extends IndexedSubtitleModel>(
    plan: PlaybackPlan<T>,
    state: PlaybackTimelineState
): boolean => {
    if (plan.fastForward === undefined) return false;
    if (state.current !== undefined)
        return (state.current.fastForwardPlaybackRate ?? plan.playbackRate) > plan.playbackRate;

    const previousGapEdge = state.previous?.subtitleTriggerGapStartOffsetMs;
    const nextGapEdge = state.next?.subtitleTriggerGapEndOffsetMs;
    if (previousGapEdge === undefined && nextGapEdge === undefined) return true;

    let gapDurationMs: number;
    if (previousGapEdge === undefined) {
        gapDurationMs = nextGapEdge! + 1;
    } else if (nextGapEdge === undefined) {
        gapDurationMs = plan.timelineSubtitles.durationMs - previousGapEdge;
    } else {
        gapDurationMs = nextGapEdge - previousGapEdge + 1;
    }
    return gapDurationMs + timestampComparisonToleranceMs >= plan.fastForward.minimumSkipIntervalMs;
};

const playbackTimelineRepeatActionComparators: FieldComparators<PlaybackTimelineRepeatAction> = {
    count: (left, right) => left === right,
    repeatsBeforeShowingSubtitles: (left, right) => left === right,
};

function arePlaybackTimelineRepeatActionsEqual(
    left: PlaybackTimelineRepeatAction | undefined,
    right: PlaybackTimelineRepeatAction | undefined
): boolean {
    return fieldsEqual(left, right, playbackTimelineRepeatActionComparators);
}

const playbackTimelineEndActionComparators: FieldComparators<PlaybackTimelineEndAction> = {
    pause: (left, right) => left === right,
    repeat: (left, right) => arePlaybackTimelineRepeatActionsEqual(left, right),
};

function arePlaybackTimelineEndActionsEqual(
    left: PlaybackTimelineEndAction | undefined,
    right: PlaybackTimelineEndAction | undefined
): boolean {
    return fieldsEqual(left, right, playbackTimelineEndActionComparators);
}

const playbackTimelineBlockComparators: FieldComparators<PlaybackTimelineBlock> = {
    id: (left, right) => left === right,
    subtitleIndexes: (left, right) => arrayEquals(left, right),
    playbackModeStartMs: (left, right) => left === right,
    playbackModeEndMs: (left, right) => left === right,
    playbackModeEndExclusiveMs: (left, right) => left === right,
    subtitleTriggerGapEndOffsetMs: (left, right) => left === right,
    subtitleTriggerGapStartOffsetMs: (left, right) => left === right,
    startAction: (left, right) => left === right,
    fastForwardPlaybackRate: (left, right) => left === right,
    autoPauseToken: (left, right) =>
        left?.subtitleIndex === right?.subtitleIndex && left?.tokenStart === right?.tokenStart,
    endAction: (left, right) => arePlaybackTimelineEndActionsEqual(left, right),
};

function arePlaybackTimelineBlocksEqual(left: PlaybackTimelineBlock, right: PlaybackTimelineBlock): boolean {
    return fieldsEqual(left, right, playbackTimelineBlockComparators);
}

const playbackPlanCondensedComparators: FieldComparators<PlaybackPlanCondensed> = {
    minimumSkipIntervalMs: (left, right) => left === right,
    pauseAtStart: (left, right) => left === right,
};

function arePlaybackPlanCondensedEqual(
    left: PlaybackPlanCondensed | undefined,
    right: PlaybackPlanCondensed | undefined
): boolean {
    return fieldsEqual(left, right, playbackPlanCondensedComparators);
}

export function playbackPlanAutoPauseResumesEqual(
    left: PlaybackPlanAutoPauseResume | undefined,
    right: PlaybackPlanAutoPauseResume | undefined
): boolean {
    if (left === right) return true;
    if (left === undefined || right === undefined) return false;
    if (left.mode !== right.mode) return false;
    switch (left.mode) {
        case AutoPauseResumeMode.fixed:
            return (
                right.mode === AutoPauseResumeMode.fixed &&
                left.fixedDurationMs === right.fixedDurationMs &&
                left.delayMs === right.delayMs
            );
        case AutoPauseResumeMode.subtitleLength:
            return (
                right.mode === AutoPauseResumeMode.subtitleLength &&
                left.minimumDurationMs === right.minimumDurationMs &&
                left.maximumDurationMs === right.maximumDurationMs &&
                left.timePerCharacterMs === right.timePerCharacterMs &&
                left.delayMs === right.delayMs
            );
        default:
            return true;
    }
}

function arePlaybackPlanAutoPausesEqual(
    left: PlaybackPlanAutoPause | undefined,
    right: PlaybackPlanAutoPause | undefined
): boolean {
    if (left === right) return true;
    if (left === undefined || right === undefined) return false;
    return playbackPlanAutoPauseResumesEqual(left.resume, right.resume);
}

const playbackPlanFastForwardComparators: FieldComparators<PlaybackPlanFastForward> = {
    playbackRate: (left, right) => left === right,
    minimumSkipIntervalMs: (left, right) => left === right,
};

function arePlaybackPlanFastForwardsEqual(
    left: PlaybackPlanFastForward | undefined,
    right: PlaybackPlanFastForward | undefined
): boolean {
    return fieldsEqual(left, right, playbackPlanFastForwardComparators);
}

const playbackTimelineSubtitlesComparators: FieldComparators<PlaybackTimelineSubtitles<IndexedSubtitleModel>> = {
    durationMs: (left, right) => left === right,
    blocks: (left, right) => arrayEquals(left, right, arePlaybackTimelineBlocksEqual),
    actionBlocks: (left, right) => arrayEquals(left, right, arePlaybackTimelineBlocksEqual),
    condensedBlocks: (left, right) => arrayEquals(left, right, arePlaybackTimelineBlocksEqual),
    displaySubtitles: (left, right) => arrayEquals(left, right, areSubtitleModelsEqual),
};

function arePlaybackTimelineSubtitlesEqual(
    left: PlaybackTimelineSubtitles<IndexedSubtitleModel>,
    right: PlaybackTimelineSubtitles<IndexedSubtitleModel>
): boolean {
    return fieldsEqual(left, right, playbackTimelineSubtitlesComparators);
}

const playbackPlanComparators: FieldComparators<PlaybackPlan<IndexedSubtitleModel>> = {
    timelineSubtitles: (left, right) => arePlaybackTimelineSubtitlesEqual(left, right),
    playbackRate: (left, right) => left === right,
    condensed: (left, right) => arePlaybackPlanCondensedEqual(left, right),
    fastForward: (left, right) => arePlaybackPlanFastForwardsEqual(left, right),
    autoPause: (left, right) => arePlaybackPlanAutoPausesEqual(left, right),
    subtitleVisibility: (left, right) => left === right,
    hiddenSubtitleIndexes: (left, right) => arrayEquals(left, right),
};

export const playbackPlansEqual = <T extends IndexedSubtitleModel>(
    left: PlaybackPlan<T>,
    right: PlaybackPlan<T>
): boolean => fieldsEqual(left, right, playbackPlanComparators);
