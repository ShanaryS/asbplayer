import { describe, expect, it } from '@jest/globals';
import { AutoPausePreference, PlayMode } from '@project/common';
import type { IndexedSubtitleModel, Token } from '@project/common';
import type { DictionaryPlaybackConfig } from '@project/common/settings';
import {
    defaultSettings,
    dictionaryStatusCollectionEnabled,
    dictionaryTrackEnabled,
    SubtitleVisibility,
    TokenState,
    TokenStatus,
} from '@project/common/settings';
import { subtitleWordVisibility, matchingPlaybackTokens } from '@project/common/playback/plan/playback-dictionary';
import { sentenceComprehensionPercent } from '@project/common/dictionary-statistics/dictionary-statistics-view';
import { buildPlaybackPlan } from '@project/common/playback/plan/playback-plan';
import { makePlaybackPlanInput, makeSubtitle } from '@project/common/playback/playback-test-utils';
import PlaybackTimeline from '@project/common/playback/timeline/playback-timeline';
import PlaybackPlanExecutor from '@project/common/playback/plan/playback-plan-executor';

const config = (): DictionaryPlaybackConfig =>
    JSON.parse(JSON.stringify(defaultSettings.dictionaryTracks[0].dictionaryPlaybackConfig));
const token = (start: number, end: number, status: TokenStatus, overrides?: Partial<Token>): Token => ({
    pos: [start, end],
    states: [],
    status,
    readings: [],
    ...overrides,
});
const subtitle = (
    text: string,
    tokens: Token[],
    options?: { readonly index?: number; readonly start?: number }
): IndexedSubtitleModel => {
    const start = options?.start ?? 1000;
    return makeSubtitle({
        text,
        tokenization: { tokens },
        index: options?.index ?? 0,
        start,
        end: start + 1000,
        originalStart: start,
        originalEnd: start + 1000,
    });
};
const tracksWith = (playback: DictionaryPlaybackConfig) => [
    { ...defaultSettings.dictionaryTracks[0], dictionaryPlaybackConfig: playback },
    ...defaultSettings.dictionaryTracks.slice(1),
];

describe('dictionary playback rules', () => {
    it.each([0, 1, 2])('matches %i words without a word-count limit for status and state triggers', (count) => {
        const playback = config();
        const tokens = [token(0, 3, TokenStatus.UNKNOWN), token(4, 8, TokenStatus.UNKNOWN)].slice(0, count);
        const sentence = subtitle('red blue', tokens);
        playback.onStatuses[TokenStatus.UNKNOWN].autoPause = true;
        expect(matchingPlaybackTokens(sentence, playback, 'autoPause')).toEqual(tokens);

        playback.onStatuses[TokenStatus.UNKNOWN].autoPause = false;
        playback.onStates[TokenState.IGNORED].autoPause = true;
        for (const word of tokens) {
            word.status = undefined;
            word.states = [TokenState.IGNORED];
        }
        expect(matchingPlaybackTokens(sentence, playback, 'autoPause')).toEqual(tokens);
    });

    it('does not match tokens when only another feature has selected triggers', () => {
        const playback = config();
        playback.onStatuses[TokenStatus.UNKNOWN].repeat = true;
        playback.onStates[TokenState.IGNORED].repeat = true;
        const sentence = subtitle('red', [token(0, 3, TokenStatus.UNKNOWN, { states: [TokenState.IGNORED] })]);
        expect(matchingPlaybackTokens(sentence, playback, 'autoPause')).toEqual([]);
    });

    it('applies status counts separately and treats missing frequency as one', () => {
        const playback = config();
        playback.onStatuses[TokenStatus.UNKNOWN].autoPause = true;
        playback.rules.autoPause.maxWords = 1;
        playback.rules.autoPause.maxFrequency = 1;
        const twoUnknown = subtitle('red blue', [token(0, 3, TokenStatus.UNKNOWN), token(4, 8, TokenStatus.UNKNOWN)]);
        expect(matchingPlaybackTokens(twoUnknown, playback, 'autoPause')).toEqual([]);

        const oneUnknown = subtitle('red blue', [
            token(0, 3, TokenStatus.UNKNOWN, { frequency: null }),
            token(4, 8, TokenStatus.MATURE),
        ]);
        expect(matchingPlaybackTokens(oneUnknown, playback, 'autoPause')).toEqual([oneUnknown.tokenization!.tokens[0]]);
        oneUnknown.tokenization!.tokens[0].frequency = 2;
        expect(matchingPlaybackTokens(oneUnknown, playback, 'autoPause')).toEqual([]);
        playback.rules.autoPause.maxFrequency = 0;
        expect(matchingPlaybackTokens(oneUnknown, playback, 'autoPause')).toEqual([oneUnknown.tokenization!.tokens[0]]);
    });

    it('checks selected states independently of statuses', () => {
        const playback = config();
        playback.onStates[TokenState.IGNORED].repeat = true;
        playback.rules.repeat.maxWords = 1;
        const selected = token(0, 3, TokenStatus.MATURE, { states: [TokenState.IGNORED] });
        const other = token(4, 8, TokenStatus.UNKNOWN);
        expect(matchingPlaybackTokens(subtitle('red blue', [selected, other]), playback, 'repeat')).toEqual([selected]);
        other.states = [TokenState.IGNORED];
        expect(matchingPlaybackTokens(subtitle('red blue', [selected, other]), playback, 'repeat')).toEqual([]);
        other.states = [];
        selected.status = undefined;
        expect(matchingPlaybackTokens(subtitle('red blue', [selected, other]), playback, 'repeat')).toEqual([selected]);
    });

    it('counts nonmatching words toward the whole-subtitle threshold and keeps untokenized text visible', () => {
        const playback = config();
        const allHidden = subtitle('red, blue!', [token(0, 3, TokenStatus.UNKNOWN), token(5, 9, TokenStatus.UNKNOWN)]);
        expect(subtitleWordVisibility(allHidden, playback)).toEqual({
            hiddenTokens: new Set(),
            hideWholeSubtitle: false,
        });

        playback.onStatuses[TokenStatus.MATURE].wordVisibility = true;
        const partial = subtitle('red, blue!', [token(0, 3, TokenStatus.MATURE), token(5, 9, TokenStatus.UNKNOWN)]);
        const untokenizedWord = subtitle('red blue', [token(0, 3, TokenStatus.UNKNOWN)]);
        expect(subtitleWordVisibility(allHidden, playback)).toEqual({
            hiddenTokens: new Set(allHidden.tokenization!.tokens),
            hideWholeSubtitle: true,
        });
        expect(subtitleWordVisibility(partial, playback)).toEqual({
            hiddenTokens: new Set([partial.tokenization!.tokens[1]]),
            hideWholeSubtitle: false,
        });
        expect(playback.rules.wordVisibility.wholeSubtitleMatchThreshold).toBe(1);
        expect(subtitleWordVisibility(untokenizedWord, playback).hideWholeSubtitle).toBe(false);
        playback.rules.wordVisibility.wholeSubtitleMatchThreshold = 0.5;
        expect(subtitleWordVisibility(partial, playback).hideWholeSubtitle).toBe(true);
        expect(subtitleWordVisibility(untokenizedWord, playback).hideWholeSubtitle).toBe(true);
        playback.rules.wordVisibility.wholeSubtitleMatchThreshold = 0.51;
        expect(subtitleWordVisibility(partial, playback).hideWholeSubtitle).toBe(false);
    });

    it('uses the statistics status weights and excludes ignored or nonletter tokens', () => {
        const scored = subtitle('red red blue !', [
            token(0, 3, TokenStatus.UNKNOWN, { groupingKey: 'red', lemmasGroupingKey: 'red' }),
            token(4, 7, TokenStatus.MATURE, { groupingKey: 'red', lemmasGroupingKey: 'red' }),
            token(8, 12, TokenStatus.GRADUATED, { groupingKey: 'blue' }),
            token(13, 14, TokenStatus.UNKNOWN, { groupingKey: 'punctuation' }),
        ]);
        expect(sentenceComprehensionPercent(scored)).toBeCloseTo((2.5 / 3) * 100);
        const zeroScore = subtitle('red blue', [
            token(0, 3, TokenStatus.UNCOLLECTED, { groupingKey: 'red' }),
            token(4, 8, TokenStatus.UNKNOWN, { groupingKey: 'blue' }),
        ]);
        expect(sentenceComprehensionPercent(zeroScore)).toBe(0);
        const ignored = subtitle('red', [
            token(0, 3, TokenStatus.UNKNOWN, { groupingKey: 'red', states: [TokenState.IGNORED] }),
        ]);
        expect(sentenceComprehensionPercent(ignored)).toBe(100);
        expect(
            sentenceComprehensionPercent(
                subtitle('!', [token(0, 1, TokenStatus.UNKNOWN, { groupingKey: 'punctuation' })])
            )
        ).toBe(100);
    });

    it('enables annotation collection for playback rules, including comprehension', () => {
        const playback = config();
        const track = tracksWith(playback)[0];
        expect(dictionaryTrackEnabled(track)).toBe(false);
        playback.onStatuses[TokenStatus.UNKNOWN].autoPause = true;
        expect(dictionaryTrackEnabled(track)).toBe(true);
        expect(dictionaryStatusCollectionEnabled(track, { includeStates: false })).toBe(true);
        playback.onStatuses[TokenStatus.UNKNOWN].autoPause = false;
        playback.rules.fastForward.rateByComprehension.enabled = true;
        expect(dictionaryStatusCollectionEnabled(track, { includeStates: false })).toBe(true);
    });
});

describe('compiled dictionary playback', () => {
    it('limits auto-pause and repeat to matching subtitles and selects the first matching token', () => {
        const playback = config();
        playback.onStatuses[TokenStatus.UNKNOWN].autoPause = true;
        playback.onStatuses[TokenStatus.UNKNOWN].repeat = true;
        const matching = subtitle('one two', [token(0, 3, TokenStatus.MATURE), token(4, 7, TokenStatus.UNKNOWN)], {
            index: 0,
        });
        const other = subtitle('three', [token(0, 5, TokenStatus.MATURE)], { index: 1, start: 3000 });
        const plan = buildPlaybackPlan(
            makePlaybackPlanInput([matching, other], {
                playModes: new Set([PlayMode.autoPause, PlayMode.repeat]),
                autoPausePreference: AutoPausePreference.atStartAndEnd,
                dictionaryTracks: tracksWith(playback),
            })
        );
        expect(plan.timelineSubtitles.blocks.every((block) => block.startAction === undefined)).toBe(true);
        expect(plan.timelineSubtitles.blocks.every((block) => block.endAction === undefined)).toBe(true);
        expect(plan.timelineSubtitles.actionBlocks).toEqual([
            expect.objectContaining({
                id: 'autoPause:[0]',
                startAction: true,
                autoPauseToken: { subtitleIndex: 0, tokenStart: 4 },
                endAction: { pause: true },
            }),
            expect.objectContaining({
                id: 'repeat:[0]',
                endAction: { pause: false, repeat: { count: 0, repeatsBeforeShowingSubtitles: 0 } },
            }),
        ]);
    });

    it('runs adaptive auto-pause and repeat at the matching subtitle edges inside an overlap', async () => {
        const playback = config();
        playback.onStatuses[TokenStatus.UNKNOWN].autoPause = true;
        playback.onStatuses[TokenStatus.UNKNOWN].repeat = true;
        const outer = {
            ...subtitle('known', [token(0, 5, TokenStatus.MATURE)], { index: 0 }),
            end: 5000,
            originalEnd: 5000,
        };
        const inner = subtitle('unknown', [token(0, 7, TokenStatus.UNKNOWN)], { index: 1, start: 2000 });
        const plan = buildPlaybackPlan(
            makePlaybackPlanInput([outer, inner], {
                playModes: new Set([PlayMode.autoPause, PlayMode.repeat]),
                autoPausePreference: AutoPausePreference.atStartAndEnd,
                repeatCountPreference: 1,
                repeatsBeforeShowingSubtitles: 1,
                dictionaryTracks: tracksWith(playback),
            })
        );
        expect(plan.timelineSubtitles.blocks).toHaveLength(1);
        expect(plan.timelineSubtitles.blocks[0].subtitleIndexes).toEqual([0, 1]);
        expect(plan.timelineSubtitles.blocks[0].startAction).toBeUndefined();
        expect(plan.timelineSubtitles.blocks[0].endAction).toBeUndefined();
        expect(
            plan.timelineSubtitles.actionBlocks?.map((block) => [
                block.id,
                block.playbackModeStartMs,
                block.playbackModeEndMs,
            ])
        ).toEqual([
            ['autoPause:[1]', 2000, 2999],
            ['repeat:[1]', 2000, 2999],
        ]);

        const pauses: { timestampMs: number; subtitleIndex?: number }[] = [];
        const seeks: number[] = [];
        const executor = new PlaybackPlanExecutor(plan, 1500, {
            play: async () => {},
            paused: () => false,
            pause: ({ timestampMs, autoPauseToken, playbackModeSubtitlesAtPause }) => {
                expect(playbackModeSubtitlesAtPause).toEqual([inner]);
                pauses.push({ timestampMs, subtitleIndex: autoPauseToken?.subtitleIndex });
            },
            seek: async (timestampMs) => {
                seeks.push(timestampMs);
            },
            setPlaybackRate: () => {},
            correctAutoPause: async () => ({ seekIssued: false }),
        });
        expect(executor.hideSubtitlesForRepeatAt(1500)).toBe(false);
        expect(executor.hideSubtitlesForRepeatAt(2500)).toBe(true);
        expect(executor.hideSubtitlesForRepeatAt(3500)).toBe(false);
        await executor.update(1999, {});
        expect(pauses).toEqual([]);
        await executor.update(2000, {});
        expect(pauses).toEqual([{ timestampMs: 2000, subtitleIndex: 1 }]);
        await executor.update(2999, {});
        expect(pauses).toEqual([
            { timestampMs: 2000, subtitleIndex: 1 },
            { timestampMs: 2999, subtitleIndex: 1 },
        ]);
        await executor.playbackStarted();
        expect(seeks).toEqual([2000]);
        expect(executor.handleDiscontinuity(2000).cause).toBe('internal-seek');
        await executor.update(2000, {});
        expect(pauses).toHaveLength(2);
    });

    it('skips subtitles without selected words in condensed mode', () => {
        const playback = config();
        playback.onStatuses[TokenStatus.UNKNOWN].condensed = true;
        const skipped = subtitle('known', [token(0, 5, TokenStatus.MATURE)], { index: 0 });
        const retained = subtitle('unknown', [token(0, 7, TokenStatus.UNKNOWN)], { index: 1, start: 4000 });
        const plan = buildPlaybackPlan(
            makePlaybackPlanInput([skipped, retained], {
                durationMs: 6000,
                playModes: new Set([PlayMode.condensed]),
                dictionaryTracks: tracksWith(playback),
            })
        );
        const timeline = PlaybackTimeline.fromSubtitles(plan.timelineSubtitles);
        expect(timeline.lookupAt(100).segment.condensedTarget).toBe(3999);
        expect(timeline.lookupAt(4500).segment.condensedTarget).toBeUndefined();
    });

    it.each([6000, NaN])(
        'respects adaptive condensed gap offsets with explicit or inferred duration %s',
        (durationMs) => {
            const playback = config();
            playback.onStatuses[TokenStatus.UNKNOWN].condensed = true;
            const retained = subtitle('unknown', [token(0, 7, TokenStatus.UNKNOWN)], { index: 0 });
            const skipped = subtitle('known', [token(0, 5, TokenStatus.MATURE)], { index: 1, start: 5000 });
            const plan = buildPlaybackPlan(
                makePlaybackPlanInput([retained, skipped], {
                    durationMs,
                    playModes: new Set([PlayMode.condensed]),
                    dictionaryTracks: tracksWith(playback),
                    subtitleTriggerGapStartOffset: 1500,
                })
            );
            const timeline = PlaybackTimeline.fromSubtitles(plan.timelineSubtitles);
            expect(timeline.lookupAt(2500).segment.condensedTarget).toBeUndefined();
            expect(timeline.lookupAt(3500).segment.condensedTarget).toBe(6000);
        }
    );

    it.each([
        { startOffset: 1500, endOffset: 0, gapStart: 3500, gapEnd: 4999 },
        { startOffset: 0, endOffset: -1500, gapStart: 2000, gapEnd: 3499 },
        { startOffset: 1500, endOffset: -1000, gapStart: 3500, gapEnd: 3999 },
    ])(
        'respects adaptive condensed gap boundaries with offsets $startOffset and $endOffset',
        async ({ startOffset, endOffset, gapStart, gapEnd }) => {
            const playback = config();
            playback.onStatuses[TokenStatus.UNKNOWN].condensed = true;
            const plan = buildPlaybackPlan(
                makePlaybackPlanInput(
                    [
                        subtitle('unknown', [token(0, 7, TokenStatus.UNKNOWN)], { index: 0 }),
                        subtitle('known', [token(0, 5, TokenStatus.MATURE)], { index: 1, start: 3000 }),
                        subtitle('unknown', [token(0, 7, TokenStatus.UNKNOWN)], { index: 2, start: 5000 }),
                    ],
                    {
                        durationMs: 8000,
                        playModes: new Set([PlayMode.condensed]),
                        dictionaryTracks: tracksWith(playback),
                        subtitleTriggerGapStartOffset: startOffset,
                        subtitleTriggerGapEndOffset: endOffset,
                    }
                )
            );
            const timeline = PlaybackTimeline.fromSubtitles(plan.timelineSubtitles);
            expect(timeline.lookupAt(gapStart - 1).segment.condensedTarget).toBeUndefined();
            expect(timeline.lookupAt(gapStart).segment.condensedTarget).toBe(gapEnd);
            expect(timeline.lookupAt(gapEnd - 1).segment.condensedTarget).toBe(gapEnd);
            expect(timeline.lookupAt(gapEnd).segment.condensedTarget).toBeUndefined();

            const seeks: number[] = [];
            const pauses: number[] = [];
            const executor = new PlaybackPlanExecutor(plan, gapStart - 1, {
                play: async () => {},
                paused: () => false,
                pause: ({ timestampMs }) => pauses.push(timestampMs),
                seek: async (timestampMs) => {
                    seeks.push(timestampMs);
                },
                setPlaybackRate: () => {},
                correctAutoPause: async () => ({ seekIssued: false }),
            });
            await executor.update(gapStart - 1, {});
            expect(seeks).toEqual([]);
            await executor.update(gapStart, {});
            expect(seeks).toEqual([gapEnd]);
            expect(pauses).toEqual([]);
        }
    );

    it('hides a whole subtitle when 80 percent of words do not match', () => {
        const playback = config();
        playback.onStatuses[TokenStatus.UNKNOWN].wordVisibility = true;
        playback.rules.wordVisibility.wholeSubtitleMatchThreshold = 0.8;
        const belowThreshold = subtitle('a b c d e', [
            token(0, 1, TokenStatus.MATURE),
            token(2, 3, TokenStatus.MATURE),
            token(4, 5, TokenStatus.MATURE),
            token(6, 7, TokenStatus.UNKNOWN),
            token(8, 9, TokenStatus.UNKNOWN),
        ]);
        const atThreshold = subtitle(
            'a b c d e',
            [
                token(0, 1, TokenStatus.MATURE),
                token(2, 3, TokenStatus.MATURE),
                token(4, 5, TokenStatus.MATURE),
                token(6, 7, TokenStatus.MATURE),
                token(8, 9, TokenStatus.UNKNOWN),
            ],
            { index: 1 }
        );
        const input = makePlaybackPlanInput([belowThreshold, atThreshold], {
            dictionaryTracks: tracksWith(playback),
        });
        expect(buildPlaybackPlan(input).hiddenSubtitleIndexes).toEqual([1]);
    });

    it('skips adaptive whole-subtitle hiding when subtitles are shown only while paused', () => {
        const playback = config();
        playback.onStatuses[TokenStatus.UNKNOWN].wordVisibility = true;
        const hidden = subtitle('known', [token(0, 5, TokenStatus.MATURE)], { index: 0 });
        const input = makePlaybackPlanInput([hidden], { dictionaryTracks: tracksWith(playback) });
        expect(buildPlaybackPlan(input).hiddenSubtitleIndexes).toEqual([0]);
        expect(
            buildPlaybackPlan({ ...input, subtitleVisibility: SubtitleVisibility.whilePaused }).hiddenSubtitleIndexes
        ).toEqual([]);
    });

    it('does not skip a repeat action while jumping over an ineligible condensed subtitle', async () => {
        const playback = config();
        playback.onStatuses[TokenStatus.UNKNOWN].condensed = true;
        playback.onStatuses[TokenStatus.MATURE].repeat = true;
        const repeated = subtitle('known', [token(0, 5, TokenStatus.MATURE)], { index: 0 });
        const retained = subtitle('unknown', [token(0, 7, TokenStatus.UNKNOWN)], { index: 1, start: 4000 });
        const plan = buildPlaybackPlan(
            makePlaybackPlanInput([repeated, retained], {
                durationMs: 6000,
                playModes: new Set([PlayMode.condensed, PlayMode.repeat]),
                dictionaryTracks: tracksWith(playback),
            })
        );
        const seeks: number[] = [];
        const executor = new PlaybackPlanExecutor(plan, 0, {
            play: async () => {},
            paused: () => false,
            pause: () => {},
            seek: async (timestampMs) => {
                seeks.push(timestampMs);
            },
            setPlaybackRate: () => {},
            correctAutoPause: async () => ({ seekIssued: false }),
        });
        await executor.update(0, {});
        expect(seeks).toEqual([1999]);
    });

    it('fast-forwards through subtitles without selected words', () => {
        const playback = config();
        playback.onStatuses[TokenStatus.UNKNOWN].fastForward = true;
        const normal = subtitle('unknown', [token(0, 7, TokenStatus.UNKNOWN)], { index: 0 });
        const accelerated = subtitle('known', [token(0, 5, TokenStatus.MATURE)], { index: 1, start: 3000 });
        const plan = buildPlaybackPlan(
            makePlaybackPlanInput([normal, accelerated], {
                playModes: new Set([PlayMode.fastForward]),
                dictionaryTracks: tracksWith(playback),
            })
        );
        expect(plan.timelineSubtitles.blocks.map((block) => block.fastForwardPlaybackRate)).toEqual([1.25, 2.5]);
    });

    it('interpolates the compiled rate between 60 and 100 percent comprehension', () => {
        const playback = config();
        playback.rules.fastForward.rateByComprehension.enabled = true;
        const make = (known: number, { index, start }: { readonly index: number; readonly start: number }) =>
            subtitle(
                'a b c d e',
                Array.from({ length: 5 }, (_, i) =>
                    token(i * 2, i * 2 + 1, i < known ? TokenStatus.MATURE : TokenStatus.UNKNOWN, {
                        groupingKey: `word-${i}`,
                    })
                ),
                { index, start }
            );
        const plan = buildPlaybackPlan(
            makePlaybackPlanInput(
                [
                    make(3, { index: 0, start: 1000 }),
                    make(4, { index: 1, start: 3000 }),
                    make(5, { index: 2, start: 5000 }),
                ],
                {
                    durationMs: 7000,
                    playModes: new Set([PlayMode.fastForward]),
                    dictionaryTracks: tracksWith(playback),
                }
            )
        );
        expect(plan.timelineSubtitles.blocks.map((block) => block.fastForwardPlaybackRate)).toEqual([1.25, 1.875, 2.5]);
        const rates: number[] = [];
        const executor = new PlaybackPlanExecutor(plan, 1500, {
            play: async () => {},
            paused: () => false,
            pause: () => {},
            seek: async () => {},
            setPlaybackRate: (rate) => {
                rates.push(rate);
            },
            correctAutoPause: async () => ({ seekIssued: false }),
        });
        executor.reconcileAt(3500, { forcePlaybackRate: false });
        executor.reconcileAt(5500, { forcePlaybackRate: false });
        expect(rates).toEqual([1.875, 2.5]);
    });
});
