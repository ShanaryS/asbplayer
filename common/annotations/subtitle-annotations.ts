import { areTokenizationsEqual, isKanaOnly, normalizeToken } from '@project/common/util';
import { asbTrace } from '@project/common/util/log';
import type {
    DictionaryBuildAnkiCacheState,
    DictionaryBuildWaniKaniCacheState,
    Fetcher,
    IndexedSubtitleModel,
    Tokenization,
} from '@project/common';
import type {
    ApplyStrategy,
    AsbplayerSettings,
    DictionaryTrack,
    SettingsProvider,
    TokenState,
    TokenStatus,
} from '@project/common/settings';
import { DictionaryTokenSource, TokenMatchStrategy } from '@project/common/settings';
import type { DictionaryProvider } from '@project/common/dictionary-db';
import type { SubtitleCollectionOptions } from '@project/common/subtitle-collection';
import { SubtitleCollection } from '@project/common/subtitle-collection';
import { TokenCollection, TokenCollectionArray } from '@project/common/annotations/token-collection';
import { BuildAnnotations } from '@project/common/annotations/build-annotations';
import type { InternalSubtitleModel } from '@project/common/annotations/build-annotations';
import type { Yomitan } from '@project/common/yomitan';

export class TrackState {
    readonly track: number;
    readonly dt: DictionaryTrack;
    readonly yt: Yomitan | undefined;
    readonly ytLastResetAt: number;
    readonly tokenCollectionExact: TokenCollection;
    readonly tokenCollectionLemma: TokenCollection;
    readonly tokenCollectionAny: TokenCollectionArray;
    readonly tokenStates: Map<string, TokenState[]>;
    readonly indexTokenOccurrences: Map<number, Map<string, number>>;

    constructor(track: number, dt: DictionaryTrack) {
        this.track = track;
        this.dt = dt;
        this.yt = undefined;
        this.ytLastResetAt = 0;
        this.tokenStates = new Map();
        this.indexTokenOccurrences = new Map();
        const updateTokenStates = (normalizedToken: string, states: TokenState[]) => {
            if (!states.length) return;
            const existingStates = this.tokenStates.get(normalizedToken);
            if (!existingStates) {
                this.tokenStates.set(normalizedToken, states);
                return;
            }
            for (const state of states) if (!existingStates.includes(state)) existingStates.push(state);
        };
        this.tokenCollectionExact = new TokenCollection(TokenMatchStrategy.EXACT_FORM_COLLECTED, dt, updateTokenStates);
        this.tokenCollectionLemma = new TokenCollection(TokenMatchStrategy.LEMMA_FORM_COLLECTED, dt, updateTokenStates);
        this.tokenCollectionAny = new TokenCollectionArray(
            TokenMatchStrategy.ANY_FORM_COLLECTED,
            dt,
            updateTokenStates
        );
    }

    updateDictionaryTrack(dt: DictionaryTrack) {
        (this.dt as any) = dt;
        this.tokenCollectionExact.updateDictionaryTrack(dt);
        this.tokenCollectionLemma.updateDictionaryTrack(dt);
        this.tokenCollectionAny.updateDictionaryTrack(dt);
    }

    updateYomitan(yt: Yomitan | undefined) {
        (this.yt as any) = yt;
    }

    resetYomitan() {
        (this.ytLastResetAt as any) = Date.now();
        if (!this.yt) return;
        this.yt.resetCache();
        this.updateYomitan(undefined);
    }

    private lemmasForScript(trimmedToken: string, lemmas: readonly string[]): readonly string[] {
        const tokenIsKanaOnly = isKanaOnly(trimmedToken);
        if (tokenIsKanaOnly && this.dt.dictionaryMatchAcrossScripts) return lemmas;
        return lemmas.filter((lemma) => isKanaOnly(lemma) === tokenIsKanaOnly);
    }

    async lemmatizeForScript(trimmedToken: string, normalize = true) {
        const rawLemmas = await this.yt!.lemmatize(trimmedToken);
        if (!rawLemmas) return;
        const lemmas = this.lemmasForScript(trimmedToken, rawLemmas);
        return normalize ? lemmas.map(normalizeToken) : lemmas;
    }

    groupingKeysForToken(
        trimmedToken: string,
        lemmas: readonly string[],
        source: DictionaryTokenSource | undefined
    ): { groupingKey: string; lemmasGroupingKey?: string } {
        const groupingKey = trimmedToken;
        let lemmasGroupingKey: string | undefined;
        const strategy =
            source === DictionaryTokenSource.ANKI_SENTENCE
                ? this.dt.dictionaryAnkiSentenceTokenMatchStrategy
                : this.dt.dictionaryTokenMatchStrategy;
        if (
            strategy === TokenMatchStrategy.ANY_FORM_COLLECTED ||
            strategy === TokenMatchStrategy.LEMMA_OR_EXACT_FORM_COLLECTED ||
            strategy === TokenMatchStrategy.LEMMA_FORM_COLLECTED
        ) {
            const groupingLemmas = this.lemmasForScript(trimmedToken, lemmas);
            if (groupingLemmas.length) lemmasGroupingKey = JSON.stringify(Array.from(new Set(groupingLemmas)).sort());
        }
        return { groupingKey, lemmasGroupingKey };
    }
}

function originalTokenization(tokenization: Tokenization | undefined): Tokenization {
    return {
        tokens:
            tokenization?.tokens
                ?.filter((t) => !(t as any).__internal)
                .map((t) => ({
                    pos: [t.pos[0], t.pos[1]],
                    readings: t.readings.map((r) => ({ pos: [r.pos[0], r.pos[1]], reading: r.reading })),
                    states: [],
                })) ?? [],
    };
}

export function needsReset(subtitles: IndexedSubtitleModel[], previousSubtitles: IndexedSubtitleModel[]) {
    return (
        subtitles.length !== previousSubtitles.length ||
        subtitles.some((s) => {
            const prev = previousSubtitles[s.index];
            if ((s.originalText ?? s.text) !== (prev.originalText ?? prev.text)) return true;
            return !areTokenizationsEqual(
                originalTokenization(s.tokenization),
                originalTokenization(prev.tokenization)
            );
        })
    );
}

export class SubtitleAnnotations extends SubtitleCollection<IndexedSubtitleModel> {
    private _subtitles: InternalSubtitleModel[] = [];
    private readonly dictionaryProvider: DictionaryProvider;
    private readonly buildAnnotations: BuildAnnotations;
    private subtitlesInterval?: ReturnType<typeof setInterval>;
    private removeBuildAnkiCacheStateChangeCB?: () => void;
    private removeBuildWaniKaniCacheStateChangeCB?: () => void;
    private removeAnkiCardModifiedCB?: () => void;
    private removeRequestStatisticsSnapshotCB?: () => void;
    private removeRequestStatisticsGenerationCB?: () => void;

    constructor(
        dictionaryProvider: DictionaryProvider,
        settingsProvider: SettingsProvider,
        options: SubtitleCollectionOptions,
        mediaId: string,
        subtitleAnnotationsUpdated: (
            updatedSubtitles: readonly IndexedSubtitleModel[],
            dt: readonly DictionaryTrack[]
        ) => void,
        getMediaTimeMs?: () => number,
        fetcher?: Fetcher
    ) {
        super({ ...options, returnNextToShow: true });
        this.dictionaryProvider = dictionaryProvider;
        this.buildAnnotations = new BuildAnnotations({
            dictionaryProvider,
            settingsProvider,
            mediaId,
            getSubtitles: () => this._subtitles,
            subtitlesAt: (timestamp) => this.subtitlesAt(timestamp),
            subtitleAnnotationsUpdated,
            getMediaTimeMs,
            fetcher,
            createTrackState: (track, dt) => new TrackState(track, dt),
        });
    }

    get subtitles() {
        return this._subtitles;
    }

    override setSubtitles(subtitles: IndexedSubtitleModel[]) {
        const previousSubtitleCount = this._subtitles.length;
        for (const subtitle of subtitles)
            if (subtitle.originalText === undefined) (subtitle as any).originalText = subtitle.text;
        const shouldReset = needsReset(subtitles, this._subtitles);
        if (!shouldReset)
            for (const subtitle of subtitles) {
                (subtitle as any).text = this._subtitles[subtitle.index].text;
                (subtitle as any).tokenization = this._subtitles[subtitle.index].tokenization;
                (subtitle as any).__tokenized = this._subtitles[subtitle.index].__tokenized;
            }
        this._subtitles = subtitles.map((subtitle) => ({ ...subtitle }));
        super.setSubtitles(this._subtitles);
        asbTrace('annotations/subtitles', 'Subtitle collection updated', {
            previousSubtitleCount,
            subtitleCount: subtitles.length,
            trackCount: new Set(subtitles.map((subtitle) => subtitle.track)).size,
            shouldReset,
        });
        if (shouldReset) {
            asbTrace('annotations/subtitles', 'Resetting annotation cache for new subtitle source', {
                subtitleCount: this._subtitles.length,
            });
        }
        this.buildAnnotations.setSubtitles(this._subtitles, shouldReset);
        if (shouldReset) void this.buildAnnotations.buildInitial();
    }

    reset() {
        this.setSubtitles([]);
    }

    profileChanged(settings?: AsbplayerSettings): void {
        this.buildAnnotations.profileChanged(settings);
    }

    settingsUpdated(settings: AsbplayerSettings, options: { readonly force: boolean } = { force: false }): void {
        this.buildAnnotations.updateSettings(settings, options);
    }

    tokensWereModified(modifiedTokens: string[]) {
        this.buildAnnotations.tokensWereModified(modifiedTokens);
    }

    buildAnkiCacheStateChange(state: DictionaryBuildAnkiCacheState) {
        this.buildAnnotations.buildAnkiCacheStateChange(state);
    }

    buildWaniKaniCacheStateChange(state: DictionaryBuildWaniKaniCacheState) {
        this.buildAnnotations.buildWaniKaniCacheStateChange(state);
    }

    ankiCardWasModified() {
        this.buildAnnotations.ankiCardWasModified();
    }

    saveTokenLocal(
        track: number,
        token: string,
        status: TokenStatus | null,
        states: TokenState[],
        applyStates: ApplyStrategy
    ): Promise<void> {
        return this.buildAnnotations.saveTokenLocal(track, token, status, states, applyStates);
    }

    requestStatisticsGeneration() {
        this.buildAnnotations.requestStatisticsGeneration();
    }

    bind() {
        asbTrace('annotations/lifecycle', 'Binding annotation pipeline');
        if (this.removeBuildAnkiCacheStateChangeCB) this.removeBuildAnkiCacheStateChangeCB();
        this.removeBuildAnkiCacheStateChangeCB = this.dictionaryProvider.onBuildAnkiCacheStateChange((state) =>
            this.buildAnkiCacheStateChange(state)
        );
        if (this.removeBuildWaniKaniCacheStateChangeCB) this.removeBuildWaniKaniCacheStateChangeCB();
        this.removeBuildWaniKaniCacheStateChangeCB = this.dictionaryProvider.onBuildWaniKaniCacheStateChange((state) =>
            this.buildWaniKaniCacheStateChange(state)
        );
        if (this.removeAnkiCardModifiedCB) this.removeAnkiCardModifiedCB();
        this.removeAnkiCardModifiedCB = this.dictionaryProvider.onAnkiCardModified(() => this.ankiCardWasModified());
        if (this.removeRequestStatisticsSnapshotCB) this.removeRequestStatisticsSnapshotCB();
        this.removeRequestStatisticsSnapshotCB = this.dictionaryProvider.onRequestStatisticsSnapshot(() =>
            this.buildAnnotations.publishStatisticsSnapshot()
        );
        if (this.removeRequestStatisticsGenerationCB) this.removeRequestStatisticsGenerationCB();
        this.removeRequestStatisticsGenerationCB = this.dictionaryProvider.onRequestStatisticsGeneration(() =>
            this.requestStatisticsGeneration()
        );
        this.subtitlesInterval = setInterval(() => void this.buildAnnotations.refresh(), 100);
    }

    unbind() {
        asbTrace('annotations/lifecycle', 'Unbinding annotation pipeline');
        this.reset();
        for (const remove of [
            this.removeBuildAnkiCacheStateChangeCB,
            this.removeBuildWaniKaniCacheStateChangeCB,
            this.removeAnkiCardModifiedCB,
            this.removeRequestStatisticsSnapshotCB,
            this.removeRequestStatisticsGenerationCB,
        ])
            remove?.();
        this.removeBuildAnkiCacheStateChangeCB = undefined;
        this.removeBuildWaniKaniCacheStateChangeCB = undefined;
        this.removeAnkiCardModifiedCB = undefined;
        this.removeRequestStatisticsSnapshotCB = undefined;
        this.removeRequestStatisticsGenerationCB = undefined;
        if (this.subtitlesInterval) clearInterval(this.subtitlesInterval);
        this.subtitlesInterval = undefined;
    }
}
