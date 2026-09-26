import { localizedDate } from '@project/common/util/util';

export const MAX_TRACE_LOG_COUNT = 9000;
export const MAX_NON_TRACE_LOG_COUNT = 1000;

export type LogLevel = 'error' | 'warning' | 'info' | 'log' | 'trace';

export interface LogLine {
    readonly timestamp: number;
    readonly label: string;
    readonly level: LogLevel;
    readonly msg: string;
}

export interface LogSnapshot {
    readonly lines: readonly LogLine[];
}

/** Persistence for logs, backed by IndexedDB directly or through the extension. */
export interface LogStorage {
    append(lines: readonly LogLine[]): Promise<void>;
    getLogs(): Promise<LogSnapshot>;
}

export function isLogLevel(level: unknown): level is LogLevel {
    return level === 'trace' || level === 'error' || level === 'warning' || level === 'info' || level === 'log';
}

export function isValidLogTimestamp(timestamp: unknown): timestamp is number {
    return typeof timestamp === 'number' && !Number.isNaN(new Date(timestamp).getTime());
}

export function isLogLine(value: unknown): value is LogLine {
    if (typeof value !== 'object' || value === null) return false;

    const logLine = value as { timestamp?: unknown; label?: unknown; level?: unknown; msg?: unknown };
    return (
        typeof logLine.msg === 'string' &&
        typeof logLine.label === 'string' &&
        isValidLogTimestamp(logLine.timestamp) &&
        isLogLevel(logLine.level)
    );
}

export function formatLogLine(logLine: LogLine): string {
    const timestamp = localizedDate(logLine.timestamp, { hour12: false, includeMilliseconds: true });
    const prefix = logLine.label.length ? '[asbplayer][' + logLine.label + ']' : '[asbplayer]';
    const msg = logLine.msg.length ? ' ' + logLine.msg : '';
    return '[' + timestamp + '][' + logLine.level + '] ' + prefix + msg;
}
