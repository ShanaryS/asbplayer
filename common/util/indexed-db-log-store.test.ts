import 'core-js/stable/structured-clone';
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from '@jest/globals';
import { IndexedDBLogStore } from '@project/common/util/indexed-db-log-store';
import { MAX_NON_TRACE_LOG_COUNT } from '@project/common/util/log-utils';

let testDatabaseId = 0;
const stores: IndexedDBLogStore[] = [];

const createStore = (databaseName = `LogDatabaseTest${++testDatabaseId}`) => {
    const store = new IndexedDBLogStore(databaseName);
    stores.push(store);
    return store;
};

afterEach(async () => {
    await Promise.all(stores.splice(0).map((store) => store.delete()));
});

describe('IndexedDBLogStore', () => {
    it('treats an empty append as a no-op', async () => {
        const storage = createStore();

        await expect(storage.append([])).resolves.toBeUndefined();
        await expect(storage.getLogs()).resolves.toEqual({ lines: [] });
    });

    it('returns appended lines in insertion order without database fields', async () => {
        const storage = createStore();
        const firstLine = { timestamp: 2, label: 'app', level: 'info' as const, msg: 'first' };
        const secondLine = { timestamp: 1, label: 'app', level: 'warning' as const, msg: 'second' };

        const firstWrite = storage.append([firstLine]);
        const secondWrite = storage.append([secondLine]);
        await Promise.all([firstWrite, secondWrite]);

        await expect(storage.getLogs()).resolves.toEqual({ lines: [firstLine, secondLine] });
    });

    it('ignores database keys and extra fields supplied by message senders', async () => {
        const storage = createStore();
        const firstLine = { timestamp: 1, label: 'page', level: 'info' as const, msg: 'first' };
        const secondLine = { ...firstLine, msg: 'second' };

        const lines = [
            { ...firstLine, id: 1, extra: 'ignored' },
            { ...secondLine, id: 1 },
        ];
        await storage.append(lines);

        await expect(storage.getLogs()).resolves.toEqual({ lines: [firstLine, secondLine] });
    });

    it('retains the newest non-trace lines up to their limit without dropping traces', async () => {
        const storage = createStore();
        const nonTraces = Array.from({ length: MAX_NON_TRACE_LOG_COUNT + 1 }, (_, i) => ({
            timestamp: MAX_NON_TRACE_LOG_COUNT - i,
            label: 'app',
            level: i % 2 === 0 ? ('info' as const) : ('warning' as const),
            msg: `info-${i}`,
        }));
        const trace = { timestamp: 0, label: 'app', level: 'trace' as const, msg: 'trace' };

        await storage.append([...nonTraces, trace]);

        const { lines } = await storage.getLogs();
        expect(lines).toHaveLength(MAX_NON_TRACE_LOG_COUNT + 1);
        expect(lines[0].msg).toBe('info-1');
        expect(lines[MAX_NON_TRACE_LOG_COUNT - 1].msg).toBe(`info-${MAX_NON_TRACE_LOG_COUNT}`);
        expect(lines[MAX_NON_TRACE_LOG_COUNT]).toEqual(trace);
    }, 20_000);

    it('waits for queued writes and deletes the database', async () => {
        const databaseName = `LogDatabaseDeleteTest${++testDatabaseId}`;
        const storage = createStore(databaseName);
        const line = { timestamp: 1, label: 'app', level: 'info' as const, msg: 'startup' };

        void storage.append([line]);
        await storage.delete();

        const reopenedStorage = createStore(databaseName);
        await expect(reopenedStorage.getLogs()).resolves.toEqual({ lines: [] });
    });
});
