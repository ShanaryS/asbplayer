import { afterEach, describe, expect, it, jest } from '@jest/globals';
import {
    ApplyStrategy,
    TokenMatchStrategy,
    TokenReadingAnnotation,
    TokenState,
    TokenStatus,
} from '@project/common/settings';
import { Yomitan } from '@project/common/yomitan';
import { renderRichTextOntoSubtitles } from '@project/common/annotations/render-annotations';
import { needsReset, TrackState } from '@project/common/annotations/subtitle-annotations';
import {
    makeDictionaryTrack,
    makeDictionaryTracks,
    makeSettings,
    makeSubtitle,
    makeSubtitleAnnotations,
    makeToken,
} from '@project/common/annotations/annotations-test-utils';

afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
});

describe('TrackState', () => {
    it('filters lemmas by script and honors cross-script matching', async () => {
        const crossScript = new TrackState(0, makeDictionaryTrack({ dictionaryMatchAcrossScripts: true }));
        crossScript.updateYomitan({ lemmatize: jest.fn(async () => ['見る', 'みる']) } as any);
        await expect(crossScript.lemmatizeForScript('みる')).resolves.toEqual(['見る', 'みる']);

        const sameScript = new TrackState(0, makeDictionaryTrack({ dictionaryMatchAcrossScripts: false }));
        sameScript.updateYomitan({ lemmatize: jest.fn(async () => ['見る', 'みる']) } as any);
        await expect(sameScript.lemmatizeForScript('見る', false)).resolves.toEqual(['見る']);
    });

    it('creates stable grouping keys only when the selected strategy uses lemmas', () => {
        const track = makeDictionaryTrack({
            dictionaryMatchAcrossScripts: true,
            dictionaryTokenMatchStrategy: TokenMatchStrategy.ANY_FORM_COLLECTED,
        });
        const state = new TrackState(0, track);
        expect(state.groupingKeysForToken('みる', ['見る', 'みる', '見る'], undefined)).toEqual({
            groupingKey: 'みる',
            lemmasGroupingKey: JSON.stringify(['みる', '見る']),
        });
    });
});

describe('needsReset', () => {
    it('ignores changes to generated text but detects source and external-token changes', () => {
        const previous = [makeSubtitle({ text: 'annotated', originalText: 'word' })];
        expect(needsReset([makeSubtitle({ text: 'updated', originalText: 'word' })], previous)).toBe(false);
        expect(needsReset([makeSubtitle({ text: 'other', originalText: 'other' })], previous)).toBe(true);
        expect(
            needsReset(
                [makeSubtitle({ text: 'word', tokenization: { tokens: [makeToken({ pos: [0, 2] })] } })],
                previous
            )
        ).toBe(true);
        expect(needsReset([], previous)).toBe(true);
    });
});

const waitForTokenization = async (annotations: ReturnType<typeof makeSubtitleAnnotations>['subtitleAnnotations']) => {
    const deadline = Date.now() + 2000;
    while (!annotations.subtitles[0]?.tokenization) {
        if (Date.now() > deadline) throw new Error('Timed out waiting for subtitle tokenization');
        await new Promise((resolve) => setTimeout(resolve, 1));
    }
};

const makeFetcher = () => ({
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

describe('SubtitleAnnotations public boundary', () => {
    it('builds annotations from subtitle input and publishes the observable tokenization', async () => {
        const fetcher = makeFetcher();
        const track = makeDictionaryTrack({ dictionaryColorizeSubtitles: true });
        const { subtitleAnnotations, subtitleAnnotationsUpdated, storage } = makeSubtitleAnnotations(
            makeSettings(makeDictionaryTracks(track)),
            fetcher
        );

        subtitleAnnotations.setSubtitles([makeSubtitle({ text: 'word' })]);
        await waitForTokenization(subtitleAnnotations);

        expect(subtitleAnnotations.subtitles[0].tokenization?.tokens[0]).toEqual(
            expect.objectContaining({ pos: [0, 4], status: expect.any(Number), frequency: null })
        );
        expect(subtitleAnnotationsUpdated).toHaveBeenCalledWith(
            [expect.objectContaining({ index: 0 })],
            expect.any(Array)
        );
        await subtitleAnnotations.saveTokenLocal(
            0,
            'word',
            TokenStatus.UNKNOWN,
            [TokenState.IGNORED],
            ApplyStrategy.ADD
        );
        expect(storage.saveRecordLocalBulk).toHaveBeenCalledWith(
            undefined,
            [{ token: 'word', status: TokenStatus.UNKNOWN, lemmas: ['word'], states: [TokenState.IGNORED] }],
            ApplyStrategy.ADD
        );
    });

    it('defaults source text, clones caller data, and preserves generated tokenization on replacement', async () => {
        const track = makeDictionaryTrack({ dictionaryColorizeSubtitles: true });
        const { subtitleAnnotations, subtitleAnnotationsUpdated } = makeSubtitleAnnotations(
            makeSettings(makeDictionaryTracks(track)),
            makeFetcher()
        );
        const input = makeSubtitle({ text: 'word', originalText: undefined });
        subtitleAnnotations.setSubtitles([input]);
        await waitForTokenization(subtitleAnnotations);
        const tokenization = subtitleAnnotations.subtitles[0].tokenization;
        expect(tokenization?.tokens).toHaveLength(1);
        subtitleAnnotationsUpdated.mockClear();

        subtitleAnnotations.setSubtitles([makeSubtitle({ text: 'word', originalText: 'word' })]);

        expect(input.originalText).toBe('word');
        expect(subtitleAnnotations.subtitles[0]).not.toBe(input);
        expect(subtitleAnnotations.subtitles[0].tokenization).toBe(tokenization);
        expect(subtitleAnnotationsUpdated).not.toHaveBeenCalled();
    });

    it('restores raw subtitle data when an enabled track is switched off', () => {
        const enabled = makeDictionaryTrack({ dictionaryColorizeSubtitles: true });
        const { subtitleAnnotations, subtitleAnnotationsUpdated } = makeSubtitleAnnotations(
            makeSettings(makeDictionaryTracks(enabled))
        );
        subtitleAnnotations.setSubtitles([
            makeSubtitle({
                text: 'annotated',
                originalText: 'raw',
                tokenization: { tokens: [makeToken({ states: [TokenState.IGNORED] })] },
            }),
        ]);
        subtitleAnnotationsUpdated.mockClear();

        subtitleAnnotations.settingsUpdated(makeSettings(makeDictionaryTracks(makeDictionaryTrack())));

        expect(subtitleAnnotations.subtitles[0].text).toBe('raw');
        expect(subtitleAnnotations.subtitles[0].tokenization?.tokens[0]).toEqual({
            pos: [0, 4],
            readings: [],
            states: [],
        });
    });

    it('ignores local token saves before a track is initialized', async () => {
        const { subtitleAnnotations, storage } = makeSubtitleAnnotations();
        await subtitleAnnotations.saveTokenLocal(
            0,
            'word',
            TokenStatus.UNKNOWN,
            [TokenState.IGNORED],
            ApplyStrategy.ADD
        );
        expect(storage.saveRecordLocalBulk).not.toHaveBeenCalled();
    });

    it('binds provider callbacks and removes them on unbind', () => {
        const { subtitleAnnotations, storage } = makeSubtitleAnnotations();
        const removeAnkiBuild = jest.fn();
        const removeWaniKaniBuild = jest.fn();
        const removeAnkiCard = jest.fn();
        const removeSnapshot = jest.fn();
        const removeGeneration = jest.fn();
        storage.onBuildAnkiCacheStateChange.mockReturnValue(removeAnkiBuild);
        storage.onBuildWaniKaniCacheStateChange.mockReturnValue(removeWaniKaniBuild);
        storage.onAnkiCardModified.mockReturnValue(removeAnkiCard);
        storage.onRequestStatisticsSnapshot.mockReturnValue(removeSnapshot);
        storage.onRequestStatisticsGeneration.mockReturnValue(removeGeneration);

        subtitleAnnotations.bind();
        subtitleAnnotations.unbind();

        expect(storage.onBuildAnkiCacheStateChange).toHaveBeenCalledTimes(1);
        expect(storage.onBuildWaniKaniCacheStateChange).toHaveBeenCalledTimes(1);
        expect(removeAnkiBuild).toHaveBeenCalledTimes(1);
        expect(removeWaniKaniBuild).toHaveBeenCalledTimes(1);
        expect(removeAnkiCard).toHaveBeenCalledTimes(1);
        expect(removeSnapshot).toHaveBeenCalledTimes(1);
        expect(removeGeneration).toHaveBeenCalledTimes(1);
    });

    it('keeps imported ASCII and numeric readings visible when reused on a later subtitle', async () => {
        // Yomitan is an external service; keep annotation building and rendering real.
        jest.spyOn(Yomitan.prototype, 'version').mockResolvedValue('26.4.6');
        jest.spyOn(Yomitan.prototype, 'tokenizeBulk').mockImplementation(async (texts) =>
            texts.map(() => [
                { text: 'MIU', reading: '' },
                { text: '007', reading: '' },
            ])
        );
        jest.spyOn(Yomitan.prototype, 'tokenize').mockResolvedValue([
            [{ text: 'MIU', reading: 'dictionary reading' }],
            [{ text: '007', reading: 'dictionary reading' }],
        ]);
        jest.spyOn(Yomitan.prototype, 'lemmatize').mockImplementation(async (text) => [text]);
        const track = makeDictionaryTrack({ dictionaryTokenReadingAnnotation: TokenReadingAnnotation.ALWAYS });
        const settings = makeSettings(makeDictionaryTracks(track));
        const { subtitleAnnotations, subtitleAnnotationsUpdated } = makeSubtitleAnnotations(settings);
        const completed = new Promise<void>((resolve) => {
            subtitleAnnotationsUpdated.mockImplementation((subtitles) => {
                if (subtitles.some((subtitle) => subtitle.index === 1)) resolve();
            });
        });

        subtitleAnnotations.setSubtitles([
            makeSubtitle({
                text: 'MIU007',
                originalText: 'MIU007',
                tokenization: {
                    tokens: [
                        makeToken({ pos: [0, 3], readings: [{ pos: [0, 3], reading: 'ミウ' }] }),
                        makeToken({ pos: [3, 6], readings: [{ pos: [0, 3], reading: 'ゼロゼロセブン' }] }),
                    ],
                },
            }),
            makeSubtitle({ index: 1, text: 'MIU007', originalText: 'MIU007' }),
        ]);
        await completed;

        const rendered = renderRichTextOntoSubtitles(subtitleAnnotations.subtitles, 'video', settings.dictionaryTracks);
        for (const index of [0, 1]) {
            const sink = document.createElement('div');
            sink.innerHTML = rendered.get(index)?.richText ?? '';
            expect(Array.from(sink.querySelectorAll('ruby'), (ruby) => ruby.firstChild?.textContent)).toEqual([
                'MIU',
                '007',
            ]);
            expect(Array.from(sink.querySelectorAll('rt'), (reading) => reading.textContent)).toEqual([
                'ミウ',
                'ゼロゼロセブン',
            ]);
        }
    });
});
