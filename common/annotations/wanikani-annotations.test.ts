import { describe, expect, it, jest } from '@jest/globals';
import { DictionaryBuildWaniKaniCacheStateType } from '@project/common';
import { makeDictionaryTrack, makeStorage } from '@project/common/annotations/annotations-test-utils';
import { WaniKaniAnnotations } from '@project/common/annotations/wanikani-annotations';
import { DictionaryProvider } from '@project/common/dictionary-db';
import type { DictionaryStatisticsWaniKaniSnapshots } from '@project/common/dictionary-statistics';
import type { DictionaryTrack } from '@project/common/settings';

describe('WaniKaniAnnotations', () => {
    it('uses current tracks, refreshes invalidated statistics, and rebuilds its cache after reset', async () => {
        const storage = makeStorage();
        const tracks: { track: number; dt: DictionaryTrack }[] = [];
        const snapshots: DictionaryStatisticsWaniKaniSnapshots[] = [];
        const tokensWereModified = jest.fn();
        const source = new WaniKaniAnnotations({
            dictionaryProvider: new DictionaryProvider(storage as any),
            getProfile: () => undefined,
            getTracks: () => tracks,
            generateStatistics: () => true,
            tokensWereModified,
            replaceStatisticsSnapshots: (snapshot) => snapshots.push(snapshot),
        });

        await source.refresh();
        expect(storage.buildWaniKaniCache).not.toHaveBeenCalled();

        tracks.push({
            track: 0,
            dt: makeDictionaryTrack({
                dictionaryColorizeSubtitles: true,
                dictionaryWaniKaniApiToken: 'token',
            }),
        });
        await source.refresh();
        await source.refresh();
        expect(snapshots).toHaveLength(1);

        source.cacheStateChanged({
            type: DictionaryBuildWaniKaniCacheStateType.stats,
            body: { track: 0, modifiedTokens: ['word'] },
        });
        await source.refresh();
        expect(tokensWereModified).toHaveBeenCalledWith(['word']);
        expect(snapshots).toHaveLength(2);

        source.reset();
        await source.refresh();
        expect(storage.buildWaniKaniCache).toHaveBeenCalledTimes(2);
        expect(snapshots).toHaveLength(3);
    });
});
