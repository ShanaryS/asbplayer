import { asbError, asbTrace } from '@project/common/util/log';
import {
    arrayEquals,
    HAS_LETTER_REGEX,
    inBatches,
    iterateOverStringInBlocks,
    areTokenizationsEqual,
    normalizeToken,
} from '@project/common/util';
import type {
    DictionaryBuildAnkiCacheState,
    DictionaryBuildWaniKaniCacheState,
    Fetcher,
    IndexedSubtitleModel,
    Token,
    Tokenization,
    TokenReading,
} from '@project/common';
import type {
    ApplyStrategy,
    AsbplayerSettings,
    DictionaryTrack,
    SettingsProvider,
    TokenStatus,
} from '@project/common/settings';
import {
    areDictionaryTracksEqual,
    areDictionaryTracksRenderOnly,
    dictionaryStatusCollectionEnabled,
    dictionaryTrackEnabled,
    getEnabledAnnotations,
    getFullyKnownTokenStatus,
    shouldUseAnnotation,
    TokenState,
} from '@project/common/settings';
import type { DictionaryProvider, TokenResults } from '@project/common/dictionary-db';
import { DictionaryStatistics } from '@project/common/dictionary-statistics';
import type { SubtitleSlice } from '@project/common/subtitle-collection';
import { Yomitan } from '@project/common/yomitan';
import type { InternalToken } from '@project/common/annotations';
import type { TrackState } from '@project/common/annotations/subtitle-annotations';
import { resolveTokenStatus } from '@project/common/annotations/token-collection';
import { AnkiAnnotations } from '@project/common/annotations/anki-annotations';
import { WaniKaniAnnotations } from '@project/common/annotations/wanikani-annotations';

const TOKEN_CACHE_BUILD_AHEAD_INIT = 10;
const TOKEN_CACHE_BUILD_AHEAD = 100;
const TOKEN_CACHE_BUILD_AHEAD_THRESHOLD = 10;
const TOKEN_CACHE_BATCH_SIZE = 1;
const TOKEN_CACHE_DEFAULT_REFRESH_INTERVAL = 10000;
const TOKEN_CACHE_STATISTICS_REFRESH_INTERVAL = 1000;
const YOMITAN_RETRY_DELAY = 10000;

export interface InternalSubtitleModel extends IndexedSubtitleModel {
    __tokenized?: boolean;
}

export interface BuildAnnotationsOptions {
    dictionaryProvider: DictionaryProvider;
    settingsProvider: SettingsProvider;
    mediaId: string;
    getSubtitles: () => InternalSubtitleModel[];
    subtitlesAt: (timestamp: number) => SubtitleSlice<IndexedSubtitleModel>;
    subtitleAnnotationsUpdated: (
        updatedSubtitles: readonly IndexedSubtitleModel[],
        dictionaryTracks: readonly DictionaryTrack[]
    ) => void;
    getMediaTimeMs?: () => number;
    fetcher?: Fetcher;
    createTrackState: (track: number, dictionaryTrack: DictionaryTrack) => TrackState;
}

function untokenize(s: InternalSubtitleModel) {
    s.__tokenized = undefined;
    if (s.tokenization) {
        s.tokenization.tokens = s.tokenization.tokens.filter((t) => !(t as InternalToken).__internal);
        if (s.tokenization.tokens.length) {
            s.tokenization.error = undefined;
            for (const [index, { pos, readings }] of s.tokenization.tokens.entries()) {
                s.tokenization.tokens[index] = { pos, readings, states: [] };
            }
        } else {
            (s as any).tokenization = undefined;
        }
    }
    if (s.originalText !== undefined) (s as any).text = s.originalText;
}

export class BuildAnnotations {
    // Preserve the original process-wide refresh cadence shared by annotation instances.
    private static tokenCacheRefreshInterval = TOKEN_CACHE_DEFAULT_REFRESH_INTERVAL;
    private readonly options: BuildAnnotationsOptions;
    private readonly dictionaryStatistics: DictionaryStatistics;
    private totalSubtitlesPerTrack = new Map<number, number>();
    private statisticsBatchProcessedIndex = 0;
    private statisticsProcessedSubtitleIndexesByTrack = new Map<number, Set<number>>();
    private generateStatistics?: boolean;
    private generateStatisticsRequested = false;
    private profile: string | undefined | null = null;
    private readonly ankiAnnotations: AnkiAnnotations;
    private readonly waniKaniAnnotations: WaniKaniAnnotations;
    private trackStates: TrackState[] = [];
    private refreshCache = new Set<number>();
    private deferredRefreshCache = new Set<number>();
    private erroredCache = new Set<number>();
    private tokenToIndexesCache = new Map<string, Set<number>>();
    private tokensForRefresh = new Set<string>();
    private externalTokenReadings = new Map<string, Map<number, TokenReading[]>>();
    private annotationsLastRefresh = Date.now();
    private annotationsBuilding = false;
    private annotationsBuildingCurrentIndexes = new Set<number>();
    private shouldCancelBuild = false;
    private pendingBuild?: { annotationsStartIndex: number; annotationsEndIndex: number; init?: boolean };
    private tokenRequestFailedForTracks = new Set<number>();
    private buildLowerThreshold = 0;
    private buildUpperThreshold = 0;
    private initialized = false;
    private showingSubtitles?: IndexedSubtitleModel[];
    private showingNeedsRefreshCount = 0;

    constructor(options: BuildAnnotationsOptions) {
        this.options = options;
        this.dictionaryStatistics = new DictionaryStatistics(
            options.settingsProvider,
            options.dictionaryProvider,
            options.mediaId
        );
        this.ankiAnnotations = new AnkiAnnotations({
            dictionaryProvider: options.dictionaryProvider,
            settingsProvider: options.settingsProvider,
            fetcher: options.fetcher,
            getProfile: () => this.profile,
            getTracks: () => this.trackStates,
            generateStatistics: () => this.generateStatistics,
            tokensWereModified: (tokens) => this.tokensWereModified(tokens),
            replaceStatisticsSnapshot: (snapshot) => this.dictionaryStatistics.replaceAnkiSnapshot(snapshot),
        });
        this.waniKaniAnnotations = new WaniKaniAnnotations({
            dictionaryProvider: options.dictionaryProvider,
            getProfile: () => this.profile,
            getTracks: () => this.trackStates,
            generateStatistics: () => this.generateStatistics,
            tokensWereModified: (tokens) => this.tokensWereModified(tokens),
            replaceStatisticsSnapshots: (snapshots) => this.dictionaryStatistics.replaceWaniKaniSnapshots(snapshots),
        });
    }

    get dictionaryTracks(): readonly DictionaryTrack[] {
        return this.trackStates.map((ts) => ts.dt);
    }

    setSubtitles(subtitles: InternalSubtitleModel[], shouldReset: boolean): void {
        this.totalSubtitlesPerTrack.clear();
        for (const subtitle of subtitles) {
            this.totalSubtitlesPerTrack.set(subtitle.track, (this.totalSubtitlesPerTrack.get(subtitle.track) ?? 0) + 1);
        }
        if (!shouldReset) return;

        this.reset();
        this.refreshCache.clear();
        this.deferredRefreshCache.clear();
        this.erroredCache.clear();
        this.tokenToIndexesCache.clear();
        this.tokensForRefresh.clear();
        this.externalTokenReadings.clear();
        for (const subtitle of subtitles) {
            if (!subtitle.tokenization) continue;
            for (const token of subtitle.tokenization.tokens) {
                if ((token as InternalToken).__internal || !token.readings.length) continue;
                const tokenText = subtitle.text.substring(token.pos[0], token.pos[1]);
                let externalReadings = this.externalTokenReadings.get(tokenText);
                if (!externalReadings) {
                    externalReadings = new Map();
                    this.externalTokenReadings.set(tokenText, externalReadings);
                }
                externalReadings.set(subtitle.track, token.readings);
            }
        }
    }

    private reset(): void {
        asbTrace('annotations/cache', 'Resetting annotation cache', {
            annotationsBuilding: this.annotationsBuilding,
            subtitleCount: this.options.getSubtitles().length,
            trackCount: this.trackStates.length,
        });
        if (this.annotationsBuilding) this.shouldCancelBuild = true;
        this.pendingBuild = undefined;
        this.profile = null;
        this.ankiAnnotations.reset();
        this.waniKaniAnnotations.reset();
        this.trackStates.forEach((ts) => ts.resetYomitan());
        this.trackStates = [];
        this.showingSubtitles = undefined;
        this.showingNeedsRefreshCount = 0;
        this.dictionaryStatistics.reset();
        this.statisticsBatchProcessedIndex = 0;
        this.statisticsProcessedSubtitleIndexesByTrack.clear();
        this.generateStatisticsRequested = false;
        this.annotationsLastRefresh = Date.now();
        this.options.getSubtitles().forEach(untokenize);
        this.buildLowerThreshold = 0;
        this.buildUpperThreshold = 0;
        this.initialized = false;
    }

    profileChanged(settings?: AsbplayerSettings): void {
        if (settings) {
            this.updateSettings(settings, { force: true });
        } else {
            void this.options.settingsProvider
                .getAll()
                .then((currentSettings) => this.updateSettings(currentSettings, { force: true }))
                .catch((error) => asbError('annotations/settings', 'Failed to refresh profile settings:', error));
        }
    }

    updateSettings(settings: AsbplayerSettings, options: { readonly force: boolean } = { force: false }): void {
        const ankiSettingsChanged = this.ankiAnnotations.updateSettings(settings);
        asbTrace('annotations/settings', 'Annotation settings update received', {
            ankiSettingsChanged,
            configuredTrackCount: settings.dictionaryTracks.length,
            initializedTrackCount: this.trackStates.length,
        });
        let settingsAreEqual =
            !options.force && !ankiSettingsChanged && this.trackStates.length === settings.dictionaryTracks.length;
        let renderSettingsChanged = false;
        for (const [index, dt] of settings.dictionaryTracks.entries()) {
            const ts = this.trackStates[index];
            if (ts && areDictionaryTracksEqual(ts.dt, dt)) continue;
            if (ts && areDictionaryTracksRenderOnly(ts.dt, dt)) {
                renderSettingsChanged = true;
                continue;
            }
            settingsAreEqual = false;
            break;
        }
        if (settingsAreEqual) {
            if (renderSettingsChanged) {
                asbTrace('annotations/settings', 'Applying render-only annotation settings', {
                    trackCount: settings.dictionaryTracks.length,
                });
                for (const [index, dt] of settings.dictionaryTracks.entries()) {
                    const ts = this.trackStates[index];
                    if (ts && !areDictionaryTracksEqual(ts.dt, dt)) ts.updateDictionaryTrack(dt);
                }
                const tokenizedSubtitles = this.options.getSubtitles().filter((s) => s.tokenization);
                if (tokenizedSubtitles.length) {
                    this.options.subtitleAnnotationsUpdated(tokenizedSubtitles, settings.dictionaryTracks);
                }
            } else {
                asbTrace('annotations/settings', 'Ignoring unchanged annotation settings');
            }
            return;
        }

        this.updateGenerateStatistics(this.dictionaryTracks, settings.dictionaryTracks);
        const subtitlesToReset: InternalSubtitleModel[] = [];
        for (const ts of this.trackStates) {
            if (!dictionaryTrackEnabled(ts.dt)) continue;
            const newDt = settings.dictionaryTracks[ts.track];
            if (newDt && dictionaryTrackEnabled(newDt)) continue;
            subtitlesToReset.push(...this.options.getSubtitles().filter((s) => s.track === ts.track));
            ts.updateDictionaryTrack(newDt);
        }
        if (subtitlesToReset.length) {
            asbTrace('annotations/settings', 'Clearing annotations for disabled tracks', {
                subtitleCount: subtitlesToReset.length,
            });
            subtitlesToReset.forEach(untokenize);
            this.options.subtitleAnnotationsUpdated(subtitlesToReset, settings.dictionaryTracks);
        }
        this.reset();
        const { annotationsStartIndex, annotationsEndIndex } = this.getAnnotationsIndexes(true);
        asbTrace('annotations/settings', 'Scheduling annotation rebuild after settings update', {
            annotationsStartIndex,
            annotationsEndIndex,
            building: this.annotationsBuilding,
        });
        if (this.annotationsBuilding) {
            this.pendingBuild = { annotationsStartIndex, annotationsEndIndex, init: true };
        } else {
            void this.build(annotationsStartIndex, annotationsEndIndex, true);
        }
    }

    tokensWereModified(modifiedTokens: string[]): void {
        for (const token of modifiedTokens) this.tokensForRefresh.add(normalizeToken(token));
    }

    buildAnkiCacheStateChange(state: DictionaryBuildAnkiCacheState): void {
        this.ankiAnnotations.cacheStateChanged(state);
    }

    buildWaniKaniCacheStateChange(state: DictionaryBuildWaniKaniCacheState): void {
        this.waniKaniAnnotations.cacheStateChanged(state);
    }

    ankiCardWasModified(): void {
        this.ankiAnnotations.cardWasModified();
    }

    async saveTokenLocal(
        track: number,
        token: string,
        status: TokenStatus | null,
        states: TokenState[],
        applyStates: ApplyStrategy
    ): Promise<void> {
        asbTrace('annotations/local-status', 'Saving local token status', {
            applyStates,
            stateCount: states.length,
            status,
            token,
            track,
        });
        if (this.profile === null) return;
        const profile = this.profile;
        const ts = this.trackStates[track];
        if (!ts || !dictionaryTrackEnabled(ts.dt) || !ts.yt) return;
        const lemmas = await ts.yt.lemmatize(token);
        if (!lemmas) return;
        await this.options.dictionaryProvider.saveRecordLocalBulk(
            profile,
            [{ token, status, lemmas, states }],
            applyStates
        );
        this.tokensForRefresh.add(normalizeToken(token));
        for (const lemma of lemmas) this.tokensForRefresh.add(normalizeToken(lemma));
        asbTrace('annotations/local-status', 'Local token status saved', {
            token,
            lemmas,
            refreshTokenCount: this.tokensForRefresh.size,
            track,
        });
    }

    requestStatisticsGeneration(): void {
        asbTrace('annotations/statistics', 'Statistics generation requested');
        this.generateStatistics = true;
    }

    publishStatisticsSnapshot(): void {
        this.dictionaryStatistics.publishSnapshot();
    }

    buildInitial(): Promise<boolean> {
        const { annotationsStartIndex, annotationsEndIndex } = this.getAnnotationsIndexes(true);
        return this.build(annotationsStartIndex, annotationsEndIndex, true);
    }

    async refresh(): Promise<void> {
        if (!this.options.getSubtitles().length) return;
        if (this.pendingBuild && !this.annotationsBuilding) {
            const { annotationsStartIndex, annotationsEndIndex, init } = this.pendingBuild;
            this.pendingBuild = undefined;
            await this.build(annotationsStartIndex, annotationsEndIndex, init);
            return;
        }
        const subtitles = this.options.getSubtitles();
        if (
            this.generateStatistics === true &&
            this.statisticsBatchProcessedIndex < subtitles.length &&
            this.initialized
        ) {
            if (this.annotationsBuilding && !this.generateStatisticsRequested) this.shouldCancelBuild = true;
            this.generateStatisticsRequested = true;
            const { annotationsStartIndex, annotationsEndIndex } = this.getAnnotationsIndexes();
            void this.build(annotationsStartIndex, annotationsEndIndex);
            this.annotationsLastRefresh = Date.now();
        }
        if (this.options.getMediaTimeMs) {
            const slice = this.options.subtitlesAt(this.options.getMediaTimeMs());
            const subtitlesAreNew =
                this.showingSubtitles === undefined ||
                !arrayEquals(slice.showing, this.showingSubtitles, (a, b) => a.index === b.index);
            if (subtitlesAreNew) {
                this.showingSubtitles = slice.showing;
                this.showingNeedsRefreshCount++;
                if (
                    this.annotationsBuilding &&
                    !this.generateStatisticsRequested &&
                    this.initialized &&
                    slice.showing.some(
                        (s) => !subtitles[s.index].__tokenized && !this.annotationsBuildingCurrentIndexes.has(s.index)
                    )
                ) {
                    this.shouldCancelBuild = true;
                }
            }
            if (this.showingNeedsRefreshCount) {
                const { annotationsStartIndex, annotationsEndIndex } = this.getAnnotationsIndexes(false, slice.showing);
                void this.build(annotationsStartIndex, annotationsEndIndex).then((res) => {
                    if (res) this.showingNeedsRefreshCount = Math.max(0, this.showingNeedsRefreshCount - 1);
                });
                this.annotationsLastRefresh = Date.now();
            }
        }
        if (
            (this.tokensForRefresh.size ||
                (this.deferredRefreshCache.size &&
                    this.initialized &&
                    !(this.generateStatistics && this.statisticsBatchProcessedIndex < subtitles.length)) ||
                Date.now() - this.annotationsLastRefresh >= BuildAnnotations.tokenCacheRefreshInterval) &&
            !this.showingNeedsRefreshCount
        ) {
            const { annotationsStartIndex, annotationsEndIndex } = this.getAnnotationsIndexes();
            void this.build(annotationsStartIndex, annotationsEndIndex);
            this.annotationsLastRefresh = Date.now();
        }
        this.ankiAnnotations.refreshIfDue();
        this.waniKaniAnnotations.refreshIfDue();
    }

    private shouldAutoGenerateStatistics(dictionaryTracks: readonly DictionaryTrack[]) {
        return dictionaryTracks.some((dt) => dictionaryTrackEnabled(dt) && dt.dictionaryAutoGenerateStatistics);
    }

    private updateGenerateStatistics(oldTracks: readonly DictionaryTrack[], newTracks: readonly DictionaryTrack[]) {
        const wasEnabled = this.shouldAutoGenerateStatistics(oldTracks);
        const nowEnabled = this.shouldAutoGenerateStatistics(newTracks);
        if (wasEnabled && !nowEnabled) this.generateStatistics = false;
        else this.generateStatistics = this.generateStatistics || nowEnabled;
    }

    private getAnnotationsIndexes(init?: boolean, subtitles?: IndexedSubtitleModel[]) {
        const allSubtitles = this.options.getSubtitles();
        if (!subtitles?.length) {
            if (this.options.getMediaTimeMs) {
                const slice = this.options.subtitlesAt(this.options.getMediaTimeMs());
                subtitles = slice.showing;
                if (!subtitles.length) subtitles = slice.nextToShow ?? [];
            } else return { annotationsStartIndex: 0, annotationsEndIndex: allSubtitles.length };
        }
        const tokenCacheBuildAhead = init ? TOKEN_CACHE_BUILD_AHEAD_INIT : TOKEN_CACHE_BUILD_AHEAD;
        if (!subtitles.length) return { annotationsStartIndex: 0, annotationsEndIndex: tokenCacheBuildAhead };
        return {
            annotationsStartIndex: Math.min(...subtitles.map((s) => s.index)),
            annotationsEndIndex: Math.max(...subtitles.map((s) => s.index)) + 1 + tokenCacheBuildAhead,
        };
    }

    private async build(annotationsStartIndex: number, annotationsEndIndex: number, init?: boolean): Promise<boolean> {
        const subtitles = this.options.getSubtitles();
        if (!subtitles.length) {
            asbTrace('annotations/build', 'Skipping annotation build because there are no subtitles');
            this.pendingBuild = undefined;
            return true;
        }
        if (this.annotationsBuilding) return false;
        this.pendingBuild = undefined;
        const requestedAnnotationsStartIndex = annotationsStartIndex;
        const requestedAnnotationsEndIndex = annotationsEndIndex;
        const startedAt = Date.now();
        let tokensRefreshed: string[] = [];
        const skipTracks: number[] = [];
        let buildWasCancelled = false;
        let buildOutcome: 'completed' | 'cancelled' | 'retry' | 'skipped' = 'completed';
        let updateThresholds = false;
        let statisticsBatching = false;
        let builtNewTokenization = false;
        let selectedSubtitleCount = 0;
        let tokenizationAttemptCount = 0;
        let tokenizationUpdateCount = 0;
        let tokenizationErrorCount = 0;
        try {
            this.annotationsBuilding = true;
            asbTrace('annotations/build', 'Starting annotation build', {
                annotationsEndIndex,
                annotationsStartIndex,
                erroredCacheSize: this.erroredCache.size,
                init: init === true,
                refreshCacheSize: this.refreshCache.size,
                subtitleCount: subtitles.length,
                tokensForRefreshCount: this.tokensForRefresh.size,
            });
            if (this.profile === null) {
                const profile = (await this.options.settingsProvider.activeProfile())?.name;
                if (this.profile === null) this.profile = profile;
                asbTrace('annotations/build', 'Resolved active dictionary profile', {
                    hasProfile: this.profile !== undefined && this.profile !== null,
                });
            }
            const profile = this.profile;
            if (!this.trackStates.length) {
                this.trackStates = (await this.options.settingsProvider.getSingle('dictionaryTracks')).map(
                    (dt, track) => this.options.createTrackState(track, dt)
                );
                if (this.generateStatistics === undefined)
                    this.generateStatistics = this.shouldAutoGenerateStatistics(this.dictionaryTracks);
                asbTrace('annotations/build', 'Initialized annotation track state', {
                    generateStatistics: this.generateStatistics === true,
                    trackCount: this.trackStates.length,
                    tracks: this.trackStates.map((ts) => ({
                        enabled: dictionaryTrackEnabled(ts.dt),
                        track: ts.track,
                    })),
                });
            }
            if (this.trackStates.every((t) => !dictionaryTrackEnabled(t.dt))) {
                buildOutcome = 'skipped';
                return true;
            }
            if (this.shouldCancelBuild) {
                buildOutcome = 'cancelled';
                return false;
            }
            for (const ts of this.trackStates) {
                if (!dictionaryTrackEnabled(ts.dt) || ts.yt) continue;
                if (Date.now() - ts.ytLastResetAt < YOMITAN_RETRY_DELAY) {
                    skipTracks.push(ts.track);
                    continue;
                }
                try {
                    const yt = new Yomitan(ts.dt, this.options.fetcher, {
                        lemmaTokenFallback: true,
                        tokensWereModified: (token) => {
                            const indexes = this.tokenToIndexesCache.get(normalizeToken(token)) ?? [];
                            for (const index of indexes) this.refreshCache.add(index);
                        },
                    });
                    const version = await yt.version();
                    ts.updateYomitan(yt);
                    asbTrace('annotations/yomitan', 'Initialized Yomitan for annotation track', {
                        parser: ts.dt.dictionaryYomitanParser,
                        track: ts.track,
                        version,
                    });
                } catch (e) {
                    asbError('annotations/yomitan', `YomitanTrack${ts.track + 1} version request failed:`, e);
                    ts.resetYomitan();
                }
            }
            const generatingStatistics = this.generateStatistics === true && this.initialized;
            if (generatingStatistics) {
                statisticsBatching = this.statisticsBatchProcessedIndex < subtitles.length;
                if (statisticsBatching) {
                    annotationsStartIndex = this.statisticsBatchProcessedIndex;
                    annotationsEndIndex = Math.min(subtitles.length, annotationsStartIndex + TOKEN_CACHE_BUILD_AHEAD);
                    for (let i = annotationsStartIndex; i < annotationsEndIndex; i++) this.refreshCache.add(i);
                }
                if (!this.dictionaryStatistics.hasStatistics()) {
                    this.generateStatisticsRequested = true;
                    for (const ts of this.trackStates) {
                        if (!dictionaryTrackEnabled(ts.dt)) continue;
                        this.dictionaryStatistics.init(ts.track, this.totalSubtitlesPerTrack.get(ts.track) ?? 0);
                        this.statisticsProcessedSubtitleIndexesByTrack.set(ts.track, new Set());
                    }
                    void this.dictionaryStatistics.refreshDictionaryTokens(profile).catch((error) => {
                        asbError('annotations/statistics', 'Failed to refresh dictionary statistics:', error);
                    });
                    this.ankiAnnotations.requestRefresh();
                    this.waniKaniAnnotations.requestRefresh();
                    BuildAnnotations.tokenCacheRefreshInterval = TOKEN_CACHE_STATISTICS_REFRESH_INTERVAL;
                }
                asbTrace('annotations/statistics', 'Preparing annotation statistics batch', {
                    batching: statisticsBatching,
                    endIndex: annotationsEndIndex,
                    startIndex: annotationsStartIndex,
                });
            }
            const subtitlesToBuild = !skipTracks.length
                ? subtitles.slice(annotationsStartIndex, annotationsEndIndex)
                : subtitles
                      .slice(annotationsStartIndex, annotationsEndIndex)
                      .filter((s) => !skipTracks.includes(s.track));
            selectedSubtitleCount = subtitlesToBuild.length;
            if (!subtitlesToBuild.length) {
                buildOutcome = skipTracks.length ? 'retry' : 'skipped';
                return !skipTracks.length;
            }
            if (
                this.deferredRefreshCache.size &&
                this.initialized &&
                !this.generateStatisticsRequested &&
                subtitlesToBuild.every(
                    (subtitle) => subtitle.__tokenized || !dictionaryTrackEnabled(this.trackStates[subtitle.track].dt)
                )
            ) {
                for (const index of this.deferredRefreshCache) this.refreshCache.add(index);
                this.deferredRefreshCache.clear();
            }
            if (this.refreshCache.size || this.tokensForRefresh.size) {
                const existingIndexes = new Set(subtitlesToBuild.map((s) => s.index));
                for (const token of this.tokensForRefresh) {
                    tokensRefreshed.push(token);
                    for (const index of this.tokenToIndexesCache.get(token) ?? []) this.refreshCache.add(index);
                }
                for (const index of this.refreshCache) {
                    if (existingIndexes.has(index)) continue;
                    existingIndexes.add(index);
                    subtitlesToBuild.push(subtitles[index]);
                }
            } else if (!subtitlesToBuild.some((s) => this.erroredCache.has(s.index))) {
                if (
                    annotationsStartIndex >= this.buildLowerThreshold &&
                    annotationsStartIndex < this.buildUpperThreshold
                ) {
                    buildOutcome = 'skipped';
                    return true;
                }
                updateThresholds = true;
            }
            try {
                for (const subtitle of subtitlesToBuild) this.annotationsBuildingCurrentIndexes.add(subtitle.index);
                await this.buildTokenAndLemmaMap(profile, subtitlesToBuild);
            } finally {
                this.annotationsBuildingCurrentIndexes.clear();
            }
            const statisticsTracksToUpdate = new Set<number>();
            await inBatches(
                subtitlesToBuild,
                async (batch) => {
                    await Promise.all(
                        batch.map(async ({ index, text, track, __tokenized: alreadyTokenized }) => {
                            if (this.shouldCancelBuild) return;
                            if (alreadyTokenized && !this.refreshCache.has(index) && !this.erroredCache.has(index))
                                return;
                            tokenizationAttemptCount++;
                            const ts = this.trackStates[track];
                            if (!dictionaryTrackEnabled(ts.dt)) return;
                            const deletedFromRefreshCache = this.refreshCache.delete(index);
                            const deletedFromErroredCache = this.erroredCache.delete(index);
                            try {
                                this.annotationsBuildingCurrentIndexes.add(index);
                                const existingTokenization = subtitles[index].tokenization;
                                const tokenizationModel = !existingTokenization
                                    ? await this.tokenizationModel(text, index, ts)
                                    : await this.tokenizationModelMergedWithExistingOne(
                                          text,
                                          existingTokenization,
                                          index,
                                          ts
                                      );
                                if (this.shouldCancelBuild) return;
                                if (
                                    areTokenizationsEqual(tokenizationModel?.tokenization, existingTokenization) &&
                                    !this.generateStatisticsRequested
                                )
                                    return;
                                builtNewTokenization = true;
                                const updatedSubtitles: IndexedSubtitleModel[] = [];
                                if (tokenizationModel) {
                                    const { tokenization, reconstructedText } = tokenizationModel;
                                    const subtitle = subtitles[index];
                                    (subtitle as any).tokenization = tokenization;
                                    if (subtitle.originalText === undefined)
                                        (subtitle as any).originalText = subtitle.text;
                                    (subtitle as any).text = reconstructedText;
                                    subtitle.__tokenized = true;
                                    updatedSubtitles.push(subtitle);
                                    this.recordTokenOccurrences(index, reconstructedText, tokenization, ts);
                                    tokenizationUpdateCount++;
                                    if (generatingStatistics) {
                                        const sentence = { ...subtitle };
                                        this.dictionaryStatistics.ingest(sentence);
                                        if (
                                            sentence.tokenization!.tokens.every(
                                                (t) =>
                                                    t.frequency !== undefined ||
                                                    !HAS_LETTER_REGEX.test(
                                                        reconstructedText.substring(t.pos[0], t.pos[1])
                                                    )
                                            )
                                        ) {
                                            this.statisticsProcessedSubtitleIndexesByTrack.get(track)!.add(index);
                                            statisticsTracksToUpdate.add(track);
                                        }
                                    }
                                }
                                this.options.subtitleAnnotationsUpdated(updatedSubtitles, this.dictionaryTracks);
                            } catch (e) {
                                tokenizationErrorCount++;
                                asbError(
                                    'annotations/tokenization',
                                    `Error building annotations for subtitle index ${index}:`,
                                    e
                                );
                                if (deletedFromRefreshCache) this.refreshCache.add(index);
                                else this.erroredCache.add(index);
                            } finally {
                                if (this.shouldCancelBuild) {
                                    if (deletedFromRefreshCache) this.refreshCache.add(index);
                                    else if (deletedFromErroredCache) this.erroredCache.add(index);
                                }
                                this.annotationsBuildingCurrentIndexes.delete(index);
                            }
                        })
                    );
                },
                { batchSize: TOKEN_CACHE_BATCH_SIZE }
            );
            if (statisticsTracksToUpdate.size) {
                for (const track of statisticsTracksToUpdate)
                    this.dictionaryStatistics.updateProgress(
                        track,
                        this.statisticsProcessedSubtitleIndexesByTrack.get(track)!.size
                    );
                if (
                    Array.from(this.statisticsProcessedSubtitleIndexesByTrack).every(
                        ([track, indexes]) => indexes.size >= (this.totalSubtitlesPerTrack.get(track) ?? 0)
                    )
                )
                    BuildAnnotations.tokenCacheRefreshInterval = TOKEN_CACHE_DEFAULT_REFRESH_INTERVAL;
            }
            if (tokensRefreshed.length && generatingStatistics) {
                void this.dictionaryStatistics.refreshDictionaryTokens(profile).catch((error) => {
                    asbError('annotations/statistics', 'Failed to refresh dictionary statistics:', error);
                });
            }
            if (this.shouldCancelBuild || skipTracks.length) {
                buildWasCancelled = true;
                buildOutcome = 'cancelled';
                tokensRefreshed = [];
                updateThresholds = false;
            }
        } finally {
            if (this.tokenRequestFailedForTracks.size) {
                buildOutcome = 'retry';
                tokensRefreshed = [];
                updateThresholds = false;
                for (const track of this.tokenRequestFailedForTracks) this.trackStates[track]?.resetYomitan();
                this.tokenRequestFailedForTracks.clear();
            } else if (!this.shouldCancelBuild && !skipTracks.length) {
                if (builtNewTokenization) this.inferFrequencyModesFromTokenOccurrences();
                this.initialized = true;
                if (statisticsBatching) {
                    this.statisticsBatchProcessedIndex = annotationsEndIndex;
                    if (annotationsEndIndex >= subtitles.length) this.generateStatisticsRequested = false;
                }
            }
            if (updateThresholds && !init) {
                this.buildUpperThreshold = annotationsEndIndex - TOKEN_CACHE_BUILD_AHEAD_THRESHOLD;
                this.buildLowerThreshold = annotationsStartIndex;
            }
            if (
                tokensRefreshed.length &&
                tokensRefreshed.length === this.tokensForRefresh.size &&
                tokensRefreshed.every((token) => this.tokensForRefresh.has(token))
            )
                this.tokensForRefresh.clear();
            this.shouldCancelBuild = false;
            this.annotationsBuilding = false;
            asbTrace('annotations/build', 'Finished annotation build', {
                buildOutcome,
                durationMs: Date.now() - startedAt,
                effectiveAnnotationsEndIndex: annotationsEndIndex,
                effectiveAnnotationsStartIndex: annotationsStartIndex,
                erroredCacheSize: this.erroredCache.size,
                init: init === true,
                requestedAnnotationsEndIndex,
                requestedAnnotationsStartIndex,
                selectedSubtitleCount,
                skipTracks,
                subtitleCount: subtitles.length,
                tokenizationAttemptCount,
                tokenizationErrorCount,
                tokenizationUpdateCount,
                tokensRefreshedCount: tokensRefreshed.length,
            });
        }
        return !buildWasCancelled;
    }

    private recordTokenOccurrences(
        index: number,
        reconstructedText: string,
        tokenization: Tokenization,
        ts: TrackState
    ): void {
        const tokenOccurrences = new Map<string, number>();
        for (const token of tokenization.tokens) {
            const tokenText = reconstructedText.substring(token.pos[0], token.pos[1]).trim();
            if (!HAS_LETTER_REGEX.test(tokenText)) continue;
            tokenOccurrences.set(tokenText, (tokenOccurrences.get(tokenText) ?? 0) + 1);
        }
        ts.indexTokenOccurrences.set(index, tokenOccurrences);
    }

    private inferFrequencyModesFromTokenOccurrences(): void {
        for (const ts of this.trackStates)
            if (dictionaryTrackEnabled(ts.dt) && ts.yt)
                ts.yt.inferFrequencyModesFromTokenOccurrences(ts.indexTokenOccurrences);
    }

    private async buildTokenAndLemmaMap(
        profile: string | undefined | null,
        subtitles: IndexedSubtitleModel[]
    ): Promise<void> {
        const eventsPerTrack = new Map<number, string[]>();
        for (const subtitle of subtitles) {
            const eventsForTrack = eventsPerTrack.get(subtitle.track);
            if (eventsForTrack) eventsForTrack.push(subtitle.text);
            else eventsPerTrack.set(subtitle.track, [subtitle.text]);
        }
        for (const [track, texts] of eventsPerTrack.entries()) {
            const ts = this.trackStates[track];
            if (!ts) continue;
            try {
                asbTrace('annotations/token-map', 'Building token and lemma map', {
                    refreshTokenCount: this.tokensForRefresh.size,
                    subtitleCount: texts.length,
                    track,
                });
                if (!ts.yt) {
                    asbTrace('annotations/token-map', 'Skipping token and lemma map because Yomitan is unavailable', {
                        track,
                    });
                    continue;
                }
                const tokenizationStartedAt = Date.now();
                const tokenizeBulkRes = await ts.yt.tokenizeBulk(texts);
                asbTrace('annotations/token-map', 'Tokenized subtitle batch', {
                    durationMs: Date.now() - tokenizationStartedAt,
                    track,
                });
                if (this.shouldCancelBuild) return;
                if (
                    getEnabledAnnotations(ts.dt).gloss &&
                    !ts.yt.getSupportsBulkGloss() &&
                    ts.yt.getSupportsTermEntriesBulk() &&
                    this.initialized &&
                    !this.generateStatisticsRequested
                ) {
                    const tokenTexts = tokenizeBulkRes.map((tokenParts) =>
                        tokenParts
                            .map((p) => p.text)
                            .join('')
                            .trim()
                    );
                    await ts.yt.termEntriesBulk(tokenTexts, { triggerTokensWereModified: true });
                    if (this.shouldCancelBuild) return;
                }
                if (!dictionaryStatusCollectionEnabled(ts.dt, { includeStates: true })) {
                    asbTrace(
                        'annotations/token-map',
                        'Skipping dictionary status queries because collection is disabled',
                        {
                            track,
                        }
                    );
                    continue;
                }
                if (this.shouldCancelBuild) return;
                for (const token of this.tokensForRefresh) {
                    ts.tokenCollectionExact.delete(token);
                    ts.tokenCollectionLemma.delete(token);
                    ts.tokenCollectionAny.delete(token);
                    ts.tokenStates.delete(token);
                }
                const forExactFormQuery = new Map<string, string[]>();
                const forLemmaFormQuery = new Map<string, string[]>();
                const forAnyFormQuery = new Map<string, string[]>();
                for (const tokenParts of tokenizeBulkRes) {
                    const token = tokenParts
                        .map((p) => p.text)
                        .join('')
                        .trim();
                    if (ts.tokenCollectionExact.enabled) ts.tokenCollectionExact.addQuery(forExactFormQuery, token);
                    if (ts.tokenCollectionLemma.enabled || ts.tokenCollectionAny.enabled) {
                        const lemmas = (await ts.lemmatizeForScript(token, false)) ?? [];
                        if (ts.tokenCollectionLemma.enabled)
                            for (const lemma of lemmas) ts.tokenCollectionLemma.addQuery(forLemmaFormQuery, lemma);
                        if (ts.tokenCollectionAny.enabled)
                            for (const lemma of lemmas) ts.tokenCollectionAny.addQuery(forAnyFormQuery, lemma);
                    }
                }
                if (this.shouldCancelBuild) return;
                asbTrace('annotations/token-map', 'Querying dictionary token statuses', {
                    exactQueryCount: forExactFormQuery.size,
                    lemmaQueryCount: forLemmaFormQuery.size,
                    anyFormQueryCount: forAnyFormQuery.size,
                    track,
                });
                const emptyTokenResults: TokenResults = {};
                const [exactFormResultMap, lemmaFormResultMap, anyFormResultsMap] = await Promise.all([
                    forExactFormQuery.size
                        ? this.options.dictionaryProvider.getBulk(
                              profile ?? undefined,
                              track,
                              ts.tokenCollectionExact.getAllQueries(forExactFormQuery)
                          )
                        : emptyTokenResults,
                    forLemmaFormQuery.size
                        ? this.options.dictionaryProvider.getBulk(
                              profile ?? undefined,
                              track,
                              ts.tokenCollectionLemma.getAllQueries(forLemmaFormQuery)
                          )
                        : emptyTokenResults,
                    forAnyFormQuery.size
                        ? this.options.dictionaryProvider.getByLemmaBulk(
                              profile ?? undefined,
                              track,
                              ts.tokenCollectionAny.getAllQueries(forAnyFormQuery)
                          )
                        : emptyTokenResults,
                ]);
                if (this.shouldCancelBuild) return;
                asbTrace('annotations/token-map', 'Loaded dictionary token statuses', {
                    anyFormResultCount: Object.keys(anyFormResultsMap).length,
                    durationMs: Date.now() - tokenizationStartedAt,
                    exactResultCount: Object.keys(exactFormResultMap).length,
                    lemmaResultCount: Object.keys(lemmaFormResultMap).length,
                    track,
                });
                for (const [token, { states, statuses, externalCandidateStatuses, source }] of Object.entries(
                    exactFormResultMap
                ))
                    ts.tokenCollectionExact.add(statuses, source, externalCandidateStatuses, token, states);
                for (const [lemma, { states, statuses, externalCandidateStatuses, source }] of Object.entries(
                    lemmaFormResultMap
                ))
                    ts.tokenCollectionLemma.add(statuses, source, externalCandidateStatuses, lemma, states);
                for (const [lemma, lemmaResults] of Object.entries(anyFormResultsMap))
                    for (const { states, statuses, externalCandidateStatuses, source, token } of lemmaResults)
                        ts.tokenCollectionAny.add(statuses, source, externalCandidateStatuses, lemma, states, token);
                asbTrace('annotations/token-map', 'Finished token and lemma map', { track });
            } catch (e) {
                asbTrace('annotations/token-map', 'Token and lemma map failed', { error: e, track });
                asbError('annotations/yomitan', `Error building token and lemma map for track ${track}:`, e);
                ts.resetYomitan();
            }
        }
    }

    private async tokenizationModelMergedWithExistingOne(
        fullText: string,
        existingTokenization: Tokenization,
        index: number,
        ts: TrackState
    ): Promise<{ reconstructedText: string; tokenization: Tokenization } | undefined> {
        if (!ts.yt) {
            this.tokenRequestFailedForTracks.add(ts.track);
            asbError('annotations/yomitan', `Yomitan not initialized`);
            existingTokenization.error = true;
            return { reconstructedText: fullText, tokenization: existingTokenization };
        }
        if (!existingTokenization.tokens.length) return this.tokenizationModel(fullText, index, ts);
        const externalTokens = existingTokenization.tokens.filter((t) => !(t as InternalToken).__internal);
        let promise: Promise<void> = Promise.resolve();
        const reconstructedTextParts: string[] = [];
        const allTokens: Token[] = [];
        let error = false;
        iterateOverStringInBlocks(
            fullText,
            (_, blockIndex) => externalTokens[blockIndex],
            (left, right, existingToken?: Token) => {
                if (existingToken === undefined) {
                    promise = promise.then(async () => {
                        const model = await this.tokenizationModel(fullText.substring(left, right), index, ts, left);
                        if (this.shouldCancelBuild) return;
                        if (!model) {
                            error = true;
                            this.erroredCache.add(index);
                            return;
                        }
                        reconstructedTextParts.push(model.reconstructedText);
                        if (model.tokenization.tokens.length) allTokens.push(...model.tokenization.tokens);
                        else if (model.tokenization.error) {
                            error = true;
                            this.erroredCache.add(index);
                        }
                    });
                } else {
                    promise = promise.then(async () => {
                        const tokenText = fullText.substring(existingToken.pos[0], existingToken.pos[1]);
                        const trimmedToken = tokenText.trim();
                        const normalizedToken = normalizeToken(trimmedToken);
                        const indexes = this.tokenToIndexesCache.get(normalizedToken);
                        if (indexes) indexes.add(index);
                        else this.tokenToIndexesCache.set(normalizedToken, new Set([index]));
                        const lemmas = await ts.yt!.lemmatize(trimmedToken);
                        if (this.shouldCancelBuild) return;
                        if (!lemmas) {
                            error = true;
                            this.erroredCache.add(index);
                            return;
                        }
                        for (const lemma of lemmas) {
                            const normalizedLemma = normalizeToken(lemma);
                            const lemmaIndexes = this.tokenToIndexesCache.get(normalizedLemma);
                            if (lemmaIndexes) lemmaIndexes.add(index);
                            else this.tokenToIndexesCache.set(normalizedLemma, new Set([index]));
                        }
                        const states = ts.tokenStates.get(normalizedToken) ?? [];
                        const tokenStatusResult =
                            states.includes(TokenState.IGNORED) || !HAS_LETTER_REGEX.test(trimmedToken)
                                ? { status: getFullyKnownTokenStatus() }
                                : ((await resolveTokenStatus(trimmedToken, normalizedToken, ts)) ?? { status: null });
                        const token: Token = {
                            pos: [existingToken.pos[0], existingToken.pos[1]],
                            readings: existingToken.readings.map((r) => ({
                                pos: [r.pos[0], r.pos[1]],
                                reading: r.reading,
                            })),
                            status: tokenStatusResult.status,
                            states,
                            ...ts.groupingKeysForToken(
                                trimmedToken,
                                lemmas,
                                'source' in tokenStatusResult ? tokenStatusResult.source : undefined
                            ),
                        };
                        if ('externalCandidateStatuses' in tokenStatusResult)
                            token.externalCandidateStatuses = tokenStatusResult.externalCandidateStatuses;
                        if (token.status === null) this.erroredCache.add(index);
                        await this.updateFrequency(token, trimmedToken, index, ts);
                        await this.updateGloss(token, trimmedToken, index, ts);
                        await this.updatePitchAccent(token, trimmedToken, index, ts);
                        if (this.shouldCancelBuild) return;
                        reconstructedTextParts.push(tokenText);
                        allTokens.push(token);
                    });
                }
            }
        );
        try {
            await promise;
        } catch (e) {
            this.tokenRequestFailedForTracks.add(ts.track);
            asbError('annotations/tokenization', `Tokenization request failed for index ${index}:`, e);
            this.erroredCache.add(index);
            existingTokenization.error = true;
            return { reconstructedText: fullText, tokenization: existingTokenization };
        }
        if (this.shouldCancelBuild) return;
        return { reconstructedText: reconstructedTextParts.join(''), tokenization: { tokens: allTokens, error } };
    }

    private async tokenizationModel(
        fullText: string,
        index: number,
        ts: TrackState,
        baseIndex = 0
    ): Promise<{ reconstructedText: string; tokenization: Tokenization } | undefined> {
        try {
            if (!ts.yt) throw new Error(`Yomitan not initialized for Track${ts.track + 1}`);
            const tokenizeRes = await ts.yt.tokenize(fullText);
            if (this.shouldCancelBuild) return;
            ts.yt.verifyTokenizeResult(fullText, tokenizeRes);
            const tokens: (Token & Partial<InternalToken>)[] = [];
            let currentOffset = 0;
            const reconstructedTextParts: string[] = [];
            for (const tokenParts of tokenizeRes) {
                const tokenText = tokenParts.map((p) => p.text).join('');
                reconstructedTextParts.push(tokenText);
                const trimmedToken = tokenText.trim();
                const normalizedToken = normalizeToken(trimmedToken);
                const indexes = this.tokenToIndexesCache.get(normalizedToken);
                if (indexes) indexes.add(index);
                else this.tokenToIndexesCache.set(normalizedToken, new Set([index]));
                const token: InternalToken = {
                    pos: [baseIndex + currentOffset, baseIndex + currentOffset + tokenText.length],
                    states: ts.tokenStates.get(normalizedToken) ?? [],
                    __internal: true,
                    readings: [],
                };
                tokens.push(token);
                currentOffset += tokenText.length;
                const externalReadings = this.externalTokenReadings.get(tokenText);
                if (externalReadings) {
                    token.readings = externalReadings.get(ts.track) ?? externalReadings.values().next().value!;
                    token.__usingExternalReadings = true;
                } else {
                    let currentPartOffset = 0;
                    for (const part of tokenParts) {
                        if (part.reading)
                            token.readings.push({
                                pos: [currentPartOffset, currentPartOffset + part.text.length],
                                reading: part.reading,
                            });
                        currentPartOffset += part.text.length;
                    }
                }
                const lemmas = await ts.yt.lemmatize(trimmedToken);
                if (this.shouldCancelBuild) return;
                if (!lemmas) {
                    this.erroredCache.add(index);
                    token.status = null;
                    continue;
                }
                for (const lemma of lemmas) {
                    const normalizedLemma = normalizeToken(lemma);
                    const lemmaIndexes = this.tokenToIndexesCache.get(normalizedLemma);
                    if (lemmaIndexes) lemmaIndexes.add(index);
                    else this.tokenToIndexesCache.set(normalizedLemma, new Set([index]));
                }
                const tokenStatusResult =
                    token.states.includes(TokenState.IGNORED) || !HAS_LETTER_REGEX.test(trimmedToken)
                        ? { status: getFullyKnownTokenStatus() }
                        : ((await resolveTokenStatus(trimmedToken, normalizedToken, ts)) ?? { status: null });
                token.status = tokenStatusResult.status;
                const { groupingKey, lemmasGroupingKey } = ts.groupingKeysForToken(
                    trimmedToken,
                    lemmas,
                    'source' in tokenStatusResult ? tokenStatusResult.source : undefined
                );
                token.groupingKey = groupingKey;
                token.lemmasGroupingKey = lemmasGroupingKey;
                if ('externalCandidateStatuses' in tokenStatusResult)
                    token.externalCandidateStatuses = tokenStatusResult.externalCandidateStatuses;
                if (token.status === null) this.erroredCache.add(index);
                await this.updateFrequency(token, trimmedToken, index, ts);
                await this.updateGloss(token, trimmedToken, index, ts);
                await this.updatePitchAccent(token, trimmedToken, index, ts);
                if (this.shouldCancelBuild) return;
            }
            return { reconstructedText: reconstructedTextParts.join(''), tokenization: { tokens } };
        } catch (error) {
            this.tokenRequestFailedForTracks.add(ts.track);
            asbError('annotations/tokenization', `Error annotating subtitle text for Track${ts.track + 1}:`, error);
            this.erroredCache.add(index);
            return { reconstructedText: fullText, tokenization: { tokens: [], error: true } };
        }
    }

    private async updateFrequency(token: Token, trimmedToken: string, index: number, ts: TrackState): Promise<void> {
        if (!ts.yt) throw new Error('Yomitan uninitialized - cannot update token frequency');
        if (this.initialized || ts.yt.getSupportsBulkFrequency()) token.frequency = await ts.yt.frequency(trimmedToken);
        else this.deferredRefreshCache.add(index);
    }

    private async updateGloss(token: Token, trimmedToken: string, index: number, ts: TrackState): Promise<void> {
        if (!ts.yt) throw new Error('Yomitan uninitialized - cannot update token gloss');
        if (token.status == null || !shouldUseAnnotation('gloss', token.status, token.states, ts.dt)) return;
        if ((this.initialized && !this.generateStatisticsRequested) || ts.yt.getSupportsBulkGloss())
            token.gloss = await ts.yt.gloss(trimmedToken);
        else this.deferredRefreshCache.add(index);
    }

    private async updatePitchAccent(token: Token, trimmedToken: string, index: number, ts: TrackState): Promise<void> {
        if (!ts.yt) throw new Error('Yomitan uninitialized - cannot update token pitch accent');
        if ((this.initialized && !this.generateStatisticsRequested) || ts.yt.getSupportsBulkPitchAccent())
            token.pitchAccent = await ts.yt.pitchAccent(trimmedToken);
        else this.deferredRefreshCache.add(index);
    }
}
