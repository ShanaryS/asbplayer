import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { DictionaryBuildAnkiCacheStateType, DictionaryBuildWaniKaniCacheStateType } from '@project/common';
import type { Fetcher } from '@project/common';
import { DictionaryProvider } from '@project/common/dictionary-db';
import { BuildAnnotations } from '@project/common/annotations/build-annotations';
import type { InternalSubtitleModel } from '@project/common/annotations/build-annotations';
import { TrackState } from '@project/common/annotations/subtitle-annotations';
import {
    makeDictionaryTrack,
    makeDictionaryTracks,
    makeSettings,
    makeStorage,
    makeSubtitle,
    makeToken,
} from '@project/common/annotations/annotations-test-utils';
import { MockSettingsStorage } from '@project/common/settings/mock-settings-storage';
import { ApplyStrategy, SettingsProvider, TokenState, TokenStatus, TokenStyling } from '@project/common/settings';

afterEach(() => {
    jest.useRealTimers();
});

const makeFetcher = (): Fetcher => ({
    fetch: jest.fn(async (url: string) => {
        if (url.endsWith('/yomitanVersion')) return { version: '0.0.0.0' };
        if (url.endsWith('/tokenize')) {
            return [
                {
                    id: 'id',
                    source: 'source',
                    dictionary: 'dictionary',
                    index: 0,
                    content: [[{ text: 'word', reading: '', frequency: 7 }]],
                },
            ];
        }
        if (url.endsWith('/termEntries')) return { dictionaryEntries: [] };
        throw new Error(`unexpected request: ${url}`);
    }),
});

const waitForAsyncBuild = () => new Promise((resolve) => setTimeout(resolve, 20));

const deferred = <T>() => {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>((res) => {
        resolve = res;
    });
    return { promise, resolve };
};

const makeBuild = (dictionaryTracks = makeDictionaryTracks(), fetcher = makeFetcher()) => {
    const storage = makeStorage();
    const provider = new DictionaryProvider(storage as any);
    const settings = makeSettings(dictionaryTracks);
    const settingsStorage = new MockSettingsStorage();
    settingsStorage.setData(settings);
    const settingsProvider = new SettingsProvider(settingsStorage);
    const subtitles: InternalSubtitleModel[] = [];
    const updated = jest.fn();
    const build = new BuildAnnotations({
        dictionaryProvider: provider,
        settingsProvider,
        mediaId: 'media-id',
        getSubtitles: () => subtitles,
        subtitlesAt: () => ({ showing: [] }),
        subtitleAnnotationsUpdated: updated,
        fetcher,
        createTrackState: (track, dictionaryTrack) => new TrackState(track, dictionaryTrack),
    });

    return { build, settings, storage, subtitles, updated };
};

describe('BuildAnnotations public boundary', () => {
    it('does no work for an empty subtitle collection', async () => {
        const { build, updated } = makeBuild();

        await expect(build.buildInitial()).resolves.toBe(true);

        expect(updated).not.toHaveBeenCalled();
    });

    it('turns subtitle input into tokenized output and reports the changed subtitle', async () => {
        const enabledTrack = makeDictionaryTrack({ dictionaryColorizeSubtitles: true });
        const { build, subtitles, updated } = makeBuild(makeDictionaryTracks(enabledTrack));
        subtitles.push(makeSubtitle({ text: 'word' }));

        build.setSubtitles(subtitles, true);
        await expect(build.buildInitial()).resolves.toBe(true);

        expect(subtitles[0].tokenization?.tokens[0]).toEqual(
            expect.objectContaining({ pos: [0, 4], status: expect.any(Number), frequency: null })
        );
        expect(subtitles[0].__tokenized).toBe(true);
        expect(updated).toHaveBeenCalledWith(
            [expect.objectContaining({ index: 0 })],
            [enabledTrack, ...makeDictionaryTracks().slice(1)]
        );
    });

    it('preserves supplied readings while rebuilding generated annotation fields', async () => {
        const enabledTrack = makeDictionaryTrack({ dictionaryColorizeSubtitles: true });
        const { build, subtitles } = makeBuild(makeDictionaryTracks(enabledTrack));
        subtitles.push(
            makeSubtitle({
                text: 'word',
                tokenization: { tokens: [makeToken({ readings: [{ pos: [0, 4], reading: 'よみ' }] })] },
            })
        );

        build.setSubtitles(subtitles, true);
        await expect(build.buildInitial()).resolves.toBe(true);

        expect(subtitles[0].tokenization?.tokens[0]).toEqual(
            expect.objectContaining({ readings: [{ pos: [0, 4], reading: 'よみ' }] })
        );
    });

    it('updates render-only settings without rebuilding tokenization', async () => {
        const enabledTrack = makeDictionaryTrack({ dictionaryColorizeSubtitles: true });
        const { build, settings, subtitles, updated } = makeBuild(makeDictionaryTracks(enabledTrack));
        subtitles.push(makeSubtitle({ text: 'word' }));
        build.setSubtitles(subtitles, true);
        await build.buildInitial();
        build.updateSettings(settings);
        await new Promise((resolve) => setTimeout(resolve, 10));
        updated.mockClear();

        const renderTrack = makeDictionaryTrack({
            dictionaryColorizeSubtitles: true,
            dictionaryTokenStyling: TokenStyling.BACKGROUND,
        });
        build.updateSettings({ ...settings, dictionaryTracks: makeDictionaryTracks(renderTrack) });

        expect(subtitles[0].tokenization).toBeDefined();
        expect(updated).toHaveBeenCalledWith([expect.objectContaining({ index: 0 })], expect.any(Array));
    });

    it('rebuilds annotations when the active profile changes even with unchanged settings', async () => {
        const enabledTrack = makeDictionaryTrack({ dictionaryColorizeSubtitles: true });
        const { build, settings, subtitles, updated } = makeBuild(makeDictionaryTracks(enabledTrack));
        subtitles.push(makeSubtitle({ text: 'word' }));
        build.setSubtitles(subtitles, true);
        await build.buildInitial();
        updated.mockClear();

        build.profileChanged(settings);
        await waitForAsyncBuild();

        expect(updated).toHaveBeenCalledWith([expect.objectContaining({ index: 0 })], expect.any(Array));
    });

    it('rebuilds annotation data when gloss collection is enabled', async () => {
        const initialTrack = makeDictionaryTrack({ dictionaryColorizeSubtitles: true });
        const { build, settings, subtitles, updated } = makeBuild(makeDictionaryTracks(initialTrack));
        subtitles.push(makeSubtitle({ text: 'word' }));
        build.setSubtitles(subtitles, true);
        await build.buildInitial();
        updated.mockClear();

        const glossTrack = makeDictionaryTrack({ dictionaryColorizeSubtitles: true });
        glossTrack.dictionaryTokenAnnotationConfig.onStatuses[TokenStatus.UNCOLLECTED].gloss = true;
        build.updateSettings({ ...settings, dictionaryTracks: makeDictionaryTracks(glossTrack) });
        await waitForAsyncBuild();

        expect(subtitles[0].tokenization).toBeDefined();
        expect(updated).toHaveBeenCalledWith([expect.objectContaining({ index: 0 })], expect.any(Array));
    });

    it('rebuilds annotation data when status collection becomes enabled', async () => {
        const initialTrack = makeDictionaryTrack({ dictionaryColorizeSubtitles: false });
        initialTrack.dictionaryTokenAnnotationConfig.onStates[0].reading = true;
        const { build, settings, subtitles, updated } = makeBuild(makeDictionaryTracks(initialTrack));
        subtitles.push(makeSubtitle({ text: 'word' }));
        build.setSubtitles(subtitles, true);
        await build.buildInitial();
        updated.mockClear();

        const dataTrack = makeDictionaryTrack({ dictionaryColorizeSubtitles: false });
        dataTrack.dictionaryTokenAnnotationConfig.onStates[0].reading = true;
        dataTrack.dictionaryTokenAnnotationConfig.onStatuses[TokenStatus.UNKNOWN].reading = true;
        build.updateSettings({ ...settings, dictionaryTracks: makeDictionaryTracks(dataTrack) });
        await waitForAsyncBuild();

        expect(subtitles[0].tokenization).toBeDefined();
        expect(updated).toHaveBeenCalledWith([expect.objectContaining({ index: 0 })], expect.any(Array));
    });

    it('rebuilds annotations after dictionary cache events modify tokens', async () => {
        const enabledTrack = makeDictionaryTrack({ dictionaryColorizeSubtitles: true });
        const { build, subtitles, updated } = makeBuild(makeDictionaryTracks(enabledTrack));
        subtitles.push(makeSubtitle({ text: 'word' }));
        build.setSubtitles(subtitles, true);
        await build.buildInitial();
        updated.mockClear();

        build.buildAnkiCacheStateChange({
            type: DictionaryBuildAnkiCacheStateType.stats,
            body: { modifiedTokens: ['word'] },
        });
        build.buildWaniKaniCacheStateChange({
            type: DictionaryBuildWaniKaniCacheStateType.stats,
            body: { track: 0, modifiedTokens: ['word'] },
        });
        await build.refresh();
        await waitForAsyncBuild();

        expect(updated).toHaveBeenCalledWith([expect.objectContaining({ index: 0 })], expect.any(Array));
    });

    it('prefetches and exposes glosses after the bulk term-entry capability is available', async () => {
        const glossTrack = makeDictionaryTrack({ dictionaryColorizeSubtitles: true });
        glossTrack.dictionaryTokenAnnotationConfig.onStatuses[TokenStatus.UNCOLLECTED].gloss = true;
        const entry = {
            headwords: [
                {
                    index: 0,
                    headwordIndex: 0,
                    term: 'word',
                    reading: 'word',
                    sources: [
                        {
                            originalText: 'word',
                            transformedText: 'word',
                            deinflectedText: 'word',
                            matchType: 'exact' as const,
                            matchSource: 'term' as const,
                            isPrimary: true,
                        },
                    ],
                },
            ],
            frequencies: [],
            pronunciations: [],
            definitions: [
                {
                    index: 0,
                    headwordIndices: [0],
                    dictionary: 'dictionary',
                    dictionaryIndex: 0,
                    dictionaryAlias: 'dictionary',
                    id: 0,
                    score: 0,
                    frequencyOrder: 0,
                    sequences: [],
                    isPrimary: true,
                    tags: [],
                    entries: ['meaning'],
                },
            ],
        };
        const fetcher: Fetcher = {
            fetch: jest.fn(async (url: string, request: { term?: string | string[] }) => {
                if (url.endsWith('/yomitanVersion')) return { version: '26.4.6' };
                if (url.endsWith('/tokenize'))
                    return [
                        {
                            id: 'id',
                            source: 'source',
                            dictionary: 'dictionary',
                            index: 0,
                            content: [[{ text: 'word', reading: '' }]],
                        },
                    ];
                if (url.endsWith('/termEntries')) {
                    if (Array.isArray(request.term))
                        return [{ index: 0, originalTextLength: 4, dictionaryEntries: [entry] }];
                    return { dictionaryEntries: [entry] };
                }
                throw new Error(`unexpected request: ${url}`);
            }),
        };
        const { build, subtitles } = makeBuild(makeDictionaryTracks(glossTrack), fetcher);
        subtitles.push(makeSubtitle({ text: 'word' }));
        build.setSubtitles(subtitles, true);

        await build.buildInitial();
        const initialToken = subtitles[0].tokenization?.tokens[0];
        expect(initialToken).toBeDefined();
        expect(initialToken).not.toHaveProperty('gloss');

        await build.refresh();
        await waitForAsyncBuild();
        expect(subtitles[0].tokenization?.tokens[0]).toEqual(expect.objectContaining({ gloss: 'meaning' }));
    });

    it('saves local token state through the built track state', async () => {
        const enabledTrack = makeDictionaryTrack({ dictionaryColorizeSubtitles: true });
        const { build, storage, subtitles } = makeBuild(makeDictionaryTracks(enabledTrack));
        subtitles.push(makeSubtitle({ text: 'word' }));
        build.setSubtitles(subtitles, true);
        await build.buildInitial();

        await build.saveTokenLocal(0, 'word', TokenStatus.UNKNOWN, [TokenState.IGNORED], ApplyStrategy.ADD);

        expect(storage.saveRecordLocalBulk).toHaveBeenCalledWith(
            undefined,
            [{ token: 'word', status: TokenStatus.UNKNOWN, lemmas: ['word'], states: [TokenState.IGNORED] }],
            ApplyStrategy.ADD
        );
    });

    it('cancels an overlapping build and can recover with a later build', async () => {
        const version = deferred<{ version: string }>();
        const versionStarted = deferred<void>();
        const fetcher: Fetcher = {
            fetch: jest.fn(async (url: string) => {
                if (url.endsWith('/yomitanVersion')) {
                    versionStarted.resolve();
                    return version.promise;
                }
                if (url.endsWith('/tokenize'))
                    return [
                        {
                            id: 'id',
                            source: 'source',
                            dictionary: 'dictionary',
                            index: 0,
                            content: [[{ text: 'word', reading: '' }]],
                        },
                    ];
                if (url.endsWith('/termEntries')) return { dictionaryEntries: [] };
                throw new Error(`unexpected request: ${url}`);
            }),
        };
        const { build, subtitles, updated } = makeBuild(
            makeDictionaryTracks(makeDictionaryTrack({ dictionaryColorizeSubtitles: true })),
            fetcher
        );
        subtitles.push(makeSubtitle({ text: 'word' }));
        build.setSubtitles(subtitles, true);

        const firstBuild = build.buildInitial();
        await versionStarted.promise;
        await expect(build.buildInitial()).resolves.toBe(false);

        build.setSubtitles(subtitles, true);
        version.resolve({ version: '0.0.0.0' });
        await expect(firstBuild).resolves.toBe(false);
        expect(updated).not.toHaveBeenCalled();

        await expect(build.buildInitial()).resolves.toBe(true);
        expect(subtitles[0].__tokenized).toBe(true);
    });

    it('does not publish partial annotations when reset cancels asynchronous tokenization', async () => {
        const tokenization = deferred<
            {
                id: string;
                source: string;
                dictionary: string;
                index: number;
                content: { text: string; reading: string }[][];
            }[]
        >();
        const tokenizeStarted = deferred<void>();
        const fetcher: Fetcher = {
            fetch: jest.fn(async (url: string) => {
                if (url.endsWith('/yomitanVersion')) return { version: '0.0.0.0' };
                if (url.endsWith('/tokenize')) {
                    tokenizeStarted.resolve();
                    return tokenization.promise;
                }
                if (url.endsWith('/termEntries')) return { dictionaryEntries: [] };
                throw new Error(`unexpected request: ${url}`);
            }),
        };
        const { build, subtitles, updated } = makeBuild(
            makeDictionaryTracks(makeDictionaryTrack({ dictionaryColorizeSubtitles: true })),
            fetcher
        );
        subtitles.push(makeSubtitle({ text: 'word' }));
        build.setSubtitles(subtitles, true);

        const initialBuild = build.buildInitial();
        await tokenizeStarted.promise;
        build.setSubtitles(subtitles, true);
        tokenization.resolve([
            {
                id: 'id',
                source: 'source',
                dictionary: 'dictionary',
                index: 0,
                content: [[{ text: 'word', reading: '' }]],
            },
        ]);

        await expect(initialBuild).resolves.toBe(false);
        expect(updated).not.toHaveBeenCalled();
    });

    it('retries a failed tokenization after the retry interval', async () => {
        let now = 100_000;
        jest.spyOn(Date, 'now').mockImplementation(() => now);
        let failTokenize = true;
        const fetcher: Fetcher = {
            fetch: jest.fn(async (url: string) => {
                if (url.endsWith('/yomitanVersion')) return { version: '0.0.0.0' };
                if (url.endsWith('/tokenize')) {
                    if (failTokenize) throw new Error('tokenize failed');
                    return [
                        {
                            id: 'id',
                            source: 'source',
                            dictionary: 'dictionary',
                            index: 0,
                            content: [[{ text: 'word', reading: '' }]],
                        },
                    ];
                }
                if (url.endsWith('/termEntries')) return { dictionaryEntries: [] };
                throw new Error(`unexpected request: ${url}`);
            }),
        };
        const { build, subtitles, updated } = makeBuild(
            makeDictionaryTracks(makeDictionaryTrack({ dictionaryColorizeSubtitles: true })),
            fetcher
        );
        subtitles.push(makeSubtitle({ text: 'word' }));
        build.setSubtitles(subtitles, true);

        await expect(build.buildInitial()).resolves.toBe(true);
        expect(subtitles[0].tokenization).toEqual(expect.objectContaining({ error: true }));
        expect(updated).toHaveBeenCalledWith([expect.objectContaining({ index: 0 })], expect.any(Array));

        failTokenize = false;
        now += 10_001;
        await expect(build.buildInitial()).resolves.toBe(true);
        expect(subtitles[0].__tokenized).toBe(true);
    });

    it('rebuilds subtitles invalidated by a modified token', async () => {
        const { build, subtitles, updated } = makeBuild(
            makeDictionaryTracks(makeDictionaryTrack({ dictionaryColorizeSubtitles: true }))
        );
        subtitles.push(makeSubtitle({ text: 'word' }));
        build.setSubtitles(subtitles, true);
        await build.buildInitial();
        updated.mockClear();

        build.tokensWereModified(['word']);
        await build.refresh();
        await waitForAsyncBuild();

        expect(updated).toHaveBeenCalledWith([expect.objectContaining({ index: 0 })], expect.any(Array));
    });

    it('only builds enabled dictionary tracks', async () => {
        const enabledTrack = makeDictionaryTrack({ dictionaryColorizeSubtitles: true });
        const disabledTrack = makeDictionaryTrack({ dictionaryYomitanUrl: '' });
        const dictionaryTracks = makeDictionaryTracks(enabledTrack).map((track, index) =>
            index === 1 ? disabledTrack : track
        );
        const { build, subtitles, updated } = makeBuild(dictionaryTracks);
        subtitles.push(makeSubtitle({ index: 0, track: 0, text: 'word' }));
        subtitles.push(makeSubtitle({ index: 1, track: 1, text: 'word' }));
        build.setSubtitles(subtitles, true);

        await build.buildInitial();

        expect(subtitles[0].__tokenized).toBe(true);
        expect(subtitles[1].__tokenized).toBeUndefined();
        expect(updated).toHaveBeenCalledTimes(1);
        expect(updated).toHaveBeenCalledWith([expect.objectContaining({ index: 0 })], dictionaryTracks);
    });

    it('merges generated tokens around externally supplied readings', async () => {
        const fetcher: Fetcher = {
            fetch: jest.fn(async (url: string, request: { text?: string | string[] }) => {
                if (url.endsWith('/yomitanVersion')) return { version: '0.0.0.0' };
                if (url.endsWith('/tokenize')) {
                    const text = Array.isArray(request.text) ? request.text[0] : request.text;
                    return [
                        {
                            id: 'id',
                            source: 'source',
                            dictionary: 'dictionary',
                            index: 0,
                            content: [[{ text: text ?? '', reading: '' }]],
                        },
                    ];
                }
                if (url.endsWith('/termEntries')) return { dictionaryEntries: [] };
                throw new Error(`unexpected request: ${url}`);
            }),
        };
        const { build, subtitles } = makeBuild(
            makeDictionaryTracks(makeDictionaryTrack({ dictionaryColorizeSubtitles: true })),
            fetcher
        );
        subtitles.push(
            makeSubtitle({
                text: 'first word last',
                originalText: 'first word last',
                tokenization: { tokens: [makeToken({ pos: [6, 10], readings: [{ pos: [6, 10], reading: 'よみ' }] })] },
            })
        );
        build.setSubtitles(subtitles, true);

        await build.buildInitial();

        expect(subtitles[0].text).toBe('first word last');
        expect(subtitles[0].tokenization?.tokens).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ pos: [6, 10], readings: [{ pos: [6, 10], reading: 'よみ' }] }),
            ])
        );
    });

    it('generates statistics in a batch and publishes complete progress', async () => {
        let now = Date.now();
        jest.spyOn(Date, 'now').mockImplementation(() => ++now);
        const track = makeDictionaryTrack({
            dictionaryAutoGenerateStatistics: true,
            dictionaryColorizeSubtitles: true,
        });
        const { build, storage, subtitles } = makeBuild(makeDictionaryTracks(track));
        subtitles.push(makeSubtitle({ index: 0, text: 'word' }), makeSubtitle({ index: 1, text: 'word' }));
        build.setSubtitles(subtitles, true);
        await build.buildInitial();

        build.requestStatisticsGeneration();
        await build.refresh();
        await waitForAsyncBuild();

        await build.refresh();
        await waitForAsyncBuild();
        const snapshot = storage.publishStatisticsSnapshot.mock.calls.findLast(
            (call) => call[1] !== undefined
        )?.[1] as {
            snapshots: {
                progress: { current: number; total: number };
                stats: { sentences: Record<number, unknown> };
            }[];
        };
        expect(snapshot.snapshots[0].progress).toEqual(expect.objectContaining({ current: 2, total: 2 }));
        expect(Object.keys(snapshot.snapshots[0].stats.sentences)).toEqual(['0', '1']);
    });

    it('publishes Anki statistics through the refresh boundary', async () => {
        const track = makeDictionaryTrack({
            dictionaryAutoGenerateStatistics: true,
            dictionaryColorizeSubtitles: true,
            dictionaryAnkiWordFields: ['Word'],
        });
        const fetcher: Fetcher = {
            fetch: jest.fn(async (url: string, request: { action?: string }) => {
                if (request.action === 'requestPermission') return { result: { permission: 'granted' } };
                if (request.action === 'findCards') return { result: [] };
                if (url.endsWith('/yomitanVersion')) return { version: '0.0.0.0' };
                if (url.endsWith('/tokenize'))
                    return [
                        {
                            id: 'id',
                            source: 'source',
                            dictionary: 'dictionary',
                            index: 0,
                            content: [[{ text: 'word', reading: '' }]],
                        },
                    ];
                if (url.endsWith('/termEntries')) return { dictionaryEntries: [] };
                throw new Error(`unexpected request: ${url}`);
            }),
        };
        const { build, storage, subtitles } = makeBuild(makeDictionaryTracks(track), fetcher);
        storage.getRecords.mockResolvedValue({
            tokenRecords: [],
            ankiCardRecords: {
                0: {
                    7: {
                        cardId: 7,
                        status: TokenStatus.LEARNING,
                        data: { deckName: 'Mining', modelName: 'Sentence', due: 3 },
                    },
                },
            },
            waniKaniSubjectRecords: {},
        });
        subtitles.push(makeSubtitle({ text: 'word' }));
        build.setSubtitles(subtitles, true);
        await build.buildInitial();

        build.requestStatisticsGeneration();
        await build.refresh();
        await waitForAsyncBuild();
        await build.refresh();
        await waitForAsyncBuild();

        const snapshots = storage.publishStatisticsSnapshot.mock.calls
            .map((call) => call[1])
            .filter((snapshot): snapshot is { anki?: unknown } => snapshot !== undefined);
        const snapshot = snapshots.find((published) => (published.anki as { available?: boolean })?.available);
        expect(snapshot?.anki).toEqual(
            expect.objectContaining({
                cardsInfo: { 7: { deckName: 'Mining', modelName: 'Sentence', due: 3 } },
                cardsStatus: { 7: TokenStatus.LEARNING },
                dueCards: { 0: [], 1: [], 7: [] },
            })
        );
    });

    it('defers frequency and pitch enrichment until the next refresh on older Yomitan', async () => {
        const fetcher: Fetcher = {
            fetch: jest.fn(async (url: string) => {
                if (url.endsWith('/yomitanVersion')) return { version: '26.4.5' };
                if (url.endsWith('/tokenize'))
                    return [
                        {
                            id: 'id',
                            source: 'source',
                            dictionary: 'dictionary',
                            index: 0,
                            content: [[{ text: 'word', reading: 'word' }]],
                        },
                    ];
                if (url.endsWith('/termEntries'))
                    return {
                        dictionaryEntries: [
                            {
                                headwords: [
                                    {
                                        index: 0,
                                        headwordIndex: 0,
                                        term: 'word',
                                        reading: 'word',
                                        sources: [
                                            {
                                                originalText: 'word',
                                                transformedText: 'word',
                                                deinflectedText: 'word',
                                                matchType: 'exact',
                                                matchSource: 'term',
                                                isPrimary: true,
                                            },
                                        ],
                                    },
                                ],
                                frequencies: [
                                    {
                                        index: 0,
                                        headwordIndex: 0,
                                        dictionary: 'frequency',
                                        dictionaryIndex: 0,
                                        dictionaryAlias: 'frequency',
                                        hasReading: true,
                                        frequencyMode: 'rank-based',
                                        frequency: 7,
                                        displayValue: '7',
                                        displayValueParsed: true,
                                    },
                                ],
                                definitions: [],
                                pronunciations: [
                                    {
                                        index: 0,
                                        headwordIndex: 0,
                                        dictionary: 'pitch',
                                        dictionaryIndex: 0,
                                        dictionaryAlias: 'pitch',
                                        pronunciations: [
                                            {
                                                type: 'pitch-accent',
                                                positions: 'HL',
                                                nasalPositions: [],
                                                devoicePositions: [],
                                                tags: [],
                                            },
                                        ],
                                    },
                                ],
                            },
                        ],
                    };
                throw new Error(`unexpected request: ${url}`);
            }),
        };
        const { build, subtitles } = makeBuild(
            makeDictionaryTracks(makeDictionaryTrack({ dictionaryColorizeSubtitles: true })),
            fetcher
        );
        subtitles.push(makeSubtitle({ text: 'word' }));
        build.setSubtitles(subtitles, true);

        await build.buildInitial();
        expect(subtitles[0].tokenization?.tokens[0]).toEqual(
            expect.not.objectContaining({ frequency: 7, pitchAccent: 'HL' })
        );

        await build.refresh();
        await waitForAsyncBuild();
        expect(subtitles[0].tokenization?.tokens[0]).toEqual(
            expect.objectContaining({ frequency: 7, pitchAccent: 'HL' })
        );
    });

    it('refreshes Anki once per observed card change through the public refresh boundary', async () => {
        const recentCards = [[1], [2]];
        const fetcher: Fetcher = {
            fetch: jest.fn(async (url: string, request: { action?: string }) => {
                if (url.endsWith('/yomitanVersion')) return { version: '0.0.0.0' };
                if (url.endsWith('/tokenize'))
                    return [
                        {
                            id: 'id',
                            source: 'source',
                            dictionary: 'dictionary',
                            index: 0,
                            content: [[{ text: 'word', reading: '' }]],
                        },
                    ];
                if (url.endsWith('/termEntries')) return { dictionaryEntries: [] };
                if (request.action === 'requestPermission') return { result: { permission: 'granted' } };
                if (request.action === 'findCards') return { result: recentCards.shift() ?? [] };
                throw new Error(`unexpected request: ${url}`);
            }),
        };
        const track = makeDictionaryTrack({
            dictionaryColorizeSubtitles: true,
            dictionaryAnkiWordFields: ['Word'],
        });
        const { build, storage, subtitles } = makeBuild(makeDictionaryTracks(track), fetcher);
        subtitles.push(makeSubtitle({ text: 'word' }));
        build.setSubtitles(subtitles, true);
        await build.buildInitial();

        build.ankiCardWasModified();
        await build.refresh();
        await waitForAsyncBuild();
        build.ankiCardWasModified();
        await build.refresh();
        await waitForAsyncBuild();

        expect(storage.buildAnkiCache).toHaveBeenCalledTimes(2);
        expect(fetcher.fetch).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({ action: 'requestPermission' })
        );
        expect(fetcher.fetch).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({ action: 'findCards' })
        );
    });

    it('builds the WaniKani cache when statistics generation requests an external refresh', async () => {
        const track = makeDictionaryTrack({
            dictionaryAutoGenerateStatistics: true,
            dictionaryColorizeSubtitles: true,
            dictionaryWaniKaniApiToken: 'wani-token',
        });
        const { build, storage, subtitles } = makeBuild(makeDictionaryTracks(track));
        subtitles.push(makeSubtitle({ text: 'word' }));
        build.setSubtitles(subtitles, true);
        await build.buildInitial();

        build.requestStatisticsGeneration();
        await build.refresh();
        await waitForAsyncBuild();
        await build.refresh();
        await waitForAsyncBuild();

        expect(storage.buildWaniKaniCache).toHaveBeenCalledWith(undefined);
    });

    it('publishes available and unavailable WaniKani track results through the refresh boundary', async () => {
        const firstTrack = makeDictionaryTrack({
            dictionaryAutoGenerateStatistics: true,
            dictionaryColorizeSubtitles: true,
            dictionaryWaniKaniApiToken: 'first-token',
        });
        const secondTrack = makeDictionaryTrack({
            dictionaryColorizeSubtitles: true,
            dictionaryWaniKaniApiToken: 'second-token',
        });
        const dictionaryTracks = makeDictionaryTracks(firstTrack).map((track, index) =>
            index === 1 ? secondTrack : track
        );
        const { build, storage, subtitles } = makeBuild(dictionaryTracks);
        const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
        storage.getRecords.mockImplementation(async (_profile?: string, track?: number) => {
            if (track === 1) throw new Error('track offline');
            if (track === 0)
                return {
                    tokenRecords: [],
                    ankiCardRecords: {},
                    waniKaniAssignmentRecords: {
                        0: {
                            21: {
                                profile: 'Profile',
                                track: 0,
                                assignmentId: 21,
                                subjectId: 11,
                                status: TokenStatus.UNKNOWN,
                                data: { srs_stage: 1, hidden: false },
                            },
                        },
                    },
                    waniKaniSubjectRecords: {
                        0: {
                            11: {
                                profile: 'Profile',
                                track: 0,
                                subjectId: 11,
                                data: {
                                    characters: 'word',
                                    hidden_at: null,
                                    level: 2,
                                    spaced_repetition_system_id: 1,
                                },
                            },
                        },
                    },
                };
            return { tokenRecords: [], ankiCardRecords: {}, waniKaniSubjectRecords: {} };
        });
        subtitles.push(makeSubtitle({ text: 'word', track: 0 }));
        build.setSubtitles(subtitles, true);
        await build.buildInitial();

        build.requestStatisticsGeneration();
        await build.refresh();
        await waitForAsyncBuild();
        await build.refresh();
        await waitForAsyncBuild();

        const snapshots = storage.publishStatisticsSnapshot.mock.calls
            .map((call) => call[1])
            .filter((snapshot): snapshot is { waniKani?: Record<number, unknown> } => snapshot !== undefined);
        const snapshot = snapshots.find((published) => published.waniKani !== undefined);
        expect(snapshot?.waniKani).toEqual(
            expect.objectContaining({
                0: expect.objectContaining({ available: true, assignments: expect.any(Array) }),
                1: { available: false, assignments: [], subjects: {} },
            })
        );
        expect(consoleError).toHaveBeenCalledWith(
            expect.stringContaining('[asbplayer][annotations/wanikani]'),
            'Error refreshing WaniKani for Track2 statistics:',
            expect.any(Error)
        );
        consoleError.mockRestore();
    });
});
