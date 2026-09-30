import { describe, expect, it, jest } from '@jest/globals';
import { DictionaryBuildAnkiCacheStateType } from '@project/common';
import type { Fetcher } from '@project/common';
import { AnkiAnnotations } from '@project/common/annotations/anki-annotations';
import { makeDictionaryTrack, makeSettings, makeStorage } from '@project/common/annotations/annotations-test-utils';
import { DictionaryProvider } from '@project/common/dictionary-db';
import type { DictionaryStatisticsAnkiSnapshot } from '@project/common/dictionary-statistics';
import { SettingsProvider } from '@project/common/settings';
import { MockSettingsStorage } from '@project/common/settings/mock-settings-storage';

describe('AnkiAnnotations', () => {
    it('refreshes statistics after a cache stats event and reports modified tokens', async () => {
        const storage = makeStorage();
        const settingsStorage = new MockSettingsStorage();
        settingsStorage.setData(makeSettings());
        const snapshots: DictionaryStatisticsAnkiSnapshot[] = [];
        const tracks = [{ track: 0, dt: makeDictionaryTrack({ dictionaryColorizeSubtitles: true }) }];
        const tokensWereModified = jest.fn();
        const fetcher: Fetcher = {
            fetch: jest.fn(async (_url: string, request: { action?: string }) => {
                if (request.action === 'requestPermission') return { result: { permission: 'granted' } };
                if (request.action === 'findCards') return { result: [] };
                throw new Error(`unexpected Anki action: ${request.action}`);
            }),
        };
        const source = new AnkiAnnotations({
            dictionaryProvider: new DictionaryProvider(storage as any),
            settingsProvider: new SettingsProvider(settingsStorage),
            fetcher,
            getProfile: () => undefined,
            getTracks: () => tracks,
            generateStatistics: () => true,
            tokensWereModified,
            replaceStatisticsSnapshot: (snapshot) => snapshots.push(snapshot),
        });

        await source.refresh();
        await source.refresh();
        expect(snapshots).toHaveLength(1);

        source.cacheStateChanged({
            type: DictionaryBuildAnkiCacheStateType.stats,
            body: { modifiedTokens: ['word'] },
        });
        await source.refresh();

        expect(tokensWereModified).toHaveBeenCalledWith(['word']);
        expect(snapshots).toHaveLength(2);
        expect(snapshots[1]).toEqual(expect.objectContaining({ available: true, dueCards: { 0: [], 1: [], 7: [] } }));
        expect(storage.buildAnkiCache).toHaveBeenCalledTimes(1);
    });
});
