import Dexie from 'dexie';
import { MAX_TRACE_LOG_COUNT, MAX_NON_TRACE_LOG_COUNT } from '@project/common/util/log-utils';
import type { LogLine, LogSnapshot, LogStorage } from '@project/common/util/log-utils';

class LogDatabase extends Dexie {
    lines!: Dexie.Table<LogLine, number>;

    constructor(name: string) {
        super(name);
        this.version(1).stores({
            lines: '++id,timestamp,level,label',
        });
    }
}

const LOG_CLEANUP_INTERVAL_MS = 60_000;

/** IndexedDB-backed log history for contexts that own their storage. */
export class IndexedDBLogStore implements LogStorage {
    private readonly database: LogDatabase;
    private writeQueue: Promise<void> = Promise.resolve();
    private lastCleanupTime = 0;

    constructor(databaseName = 'LogDatabase') {
        this.database = new LogDatabase(databaseName);
    }

    append(lines: readonly LogLine[]): Promise<void> {
        if (lines.length === 0) return Promise.resolve();

        const copiedLines = lines.map(({ timestamp, label, level, msg }) => ({ timestamp, label, level, msg }));
        const write = this.writeQueue.then(async () => {
            await this.database.transaction('rw', this.database.lines, () => this.database.lines.bulkAdd(copiedLines));

            const now = Date.now();
            if (now - this.lastCleanupTime >= LOG_CLEANUP_INTERVAL_MS) {
                await this.cleanup();
                this.lastCleanupTime = now;
            }
        });
        this.writeQueue = write.catch(() => undefined);
        return write;
    }

    private async cleanup(): Promise<void> {
        await this.database.transaction('rw', this.database.lines, async () => {
            await this.database.lines.where('level').equals('trace').reverse().offset(MAX_TRACE_LOG_COUNT).delete();
            await this.database.lines
                .orderBy('id')
                .reverse()
                .filter((line) => line.level !== 'trace')
                .offset(MAX_NON_TRACE_LOG_COUNT)
                .delete();
        });
    }

    async getLogs(): Promise<LogSnapshot> {
        await this.writeQueue;
        const lines = await this.database.lines.orderBy('id').toArray();
        return {
            lines: lines.map(({ timestamp, label, level, msg }) => ({ timestamp, label, level, msg })),
        };
    }

    async delete(): Promise<void> {
        await this.writeQueue;
        await this.database.delete();
    }
}
