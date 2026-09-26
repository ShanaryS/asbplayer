import { describe, expect, it } from '@jest/globals';
import { localizedDate } from '@project/common/util/util';
import { formatLogLine, isLogLevel, isLogLine, isValidLogTimestamp } from '@project/common/util/log-utils';
import type { LogLine, LogLevel } from '@project/common/util/log-utils';

const validLine: LogLine = {
    timestamp: Date.UTC(2026, 0, 1, 13, 2, 3, 123),
    label: 'playback',
    level: 'info',
    msg: 'ready',
};

describe('log validation helpers', () => {
    it('accepts each supported level and rejects unknown values', () => {
        const levels: LogLevel[] = ['error', 'warning', 'info', 'log', 'trace'];
        for (const level of levels) expect(isLogLevel(level)).toBe(true);
        for (const level of [undefined, null, '', 'debug', 1]) expect(isLogLevel(level)).toBe(false);
    });

    it('accepts finite valid timestamps and rejects invalid ones', () => {
        expect(isValidLogTimestamp(0)).toBe(true);
        expect(isValidLogTimestamp(validLine.timestamp)).toBe(true);
        for (const timestamp of [undefined, null, '1', NaN, Infinity, -Infinity, 8.65e15]) {
            expect(isValidLogTimestamp(timestamp)).toBe(false);
        }
    });

    it('validates all required log-line fields', () => {
        expect(isLogLine(validLine)).toBe(true);
        expect(isLogLine({ ...validLine, level: 'debug' })).toBe(false);
        expect(isLogLine({ ...validLine, timestamp: NaN })).toBe(false);
        expect(isLogLine({ ...validLine, label: undefined })).toBe(false);
        expect(isLogLine({ ...validLine, msg: 1 })).toBe(false);
        expect(isLogLine(null)).toBe(false);
        expect(isLogLine([])).toBe(false);
    });
});

describe('log formatters', () => {
    it('formats the timestamp, severity, prefix, and message', () => {
        expect(formatLogLine(validLine)).toBe(
            `[${localizedDate(validLine.timestamp, { hour12: false, includeMilliseconds: true })}][info] [asbplayer][playback] ready`
        );
        expect(formatLogLine({ ...validLine, label: '', msg: '' })).toBe(
            `[${localizedDate(validLine.timestamp, { hour12: false, includeMilliseconds: true })}][info] [asbplayer]`
        );
    });
});
