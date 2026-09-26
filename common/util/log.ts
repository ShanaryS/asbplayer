import { PAGE_LOG_BRIDGE_PROPERTY } from '@project/common/util/log-bridge';
import { MAX_NON_TRACE_LOG_COUNT, MAX_TRACE_LOG_COUNT, formatLogLine } from '@project/common/util/log-utils';
import type { LogLevel, LogLine, LogStorage } from '@project/common/util/log-utils';
export * from '@project/common/util/log-utils';

export class LogProvider {
    private writeQueue: Promise<void> = Promise.resolve();

    constructor(private readonly storage: LogStorage) {}

    append(lines: readonly LogLine[]): Promise<void> {
        if (lines.length === 0) return Promise.resolve();

        // Logging must not fail its caller, and a failed write must not block later writes.
        this.writeQueue = this.writeQueue.then(() => this.storage.append(lines)).catch(() => undefined);
        return this.writeQueue;
    }

    flush(): Promise<void> {
        return this.writeQueue;
    }

    async getLogLines(): Promise<readonly LogLine[]> {
        await this.writeQueue;
        const { lines } = await this.storage.getLogs();
        return [...lines].sort((a, b) => a.timestamp - b.timestamp);
    }

    async getLogText(): Promise<string> {
        return (await this.getLogLines()).map(formatLogLine).join('\n');
    }
}

let activeLogProvider: LogProvider | undefined;
let startupLogLines: LogLine[] = [];

export function configureLogProvider(provider: LogProvider): Promise<void> {
    const previousLogProvider = activeLogProvider;
    activeLogProvider = provider;
    const linesToWrite = startupLogLines;
    startupLogLines = [];
    return Promise.all([previousLogProvider?.flush(), provider.append(linesToWrite)]).then(() => undefined);
}

// ---------- Logging functions ----------

type LogArgs = [firstArg: unknown, ...args: unknown[]];

function formatLogArg(arg: unknown): string {
    try {
        if (typeof arg === 'string') return arg;
        if (arg instanceof Error) return arg.name + ': ' + arg.message + (arg.stack ? '\n' + arg.stack : '');
        if (arg === undefined) return 'undefined';
        if (typeof arg === 'bigint') return String(arg) + 'n';
        const serialized = JSON.stringify(arg, (_key, value: unknown) => {
            if (!(value instanceof Error)) return value;
            return {
                name: value.name,
                message: value.message,
                ...(value.stack ? { stack: value.stack } : {}),
            };
        });
        return serialized === undefined ? String(arg) : serialized;
    } catch {
        try {
            return String(arg);
        } catch {
            return '[Unserializable]';
        }
    }
}

function logLineText(args: LogArgs): string {
    return args
        .map(formatLogArg)
        .join(' ')
        .replace(/[\r\n]+/g, '\\n');
}

function forwardLogLineToPageBridge(logLine: LogLine): boolean {
    if (typeof window === 'undefined') return false;

    try {
        const pageBridge = (window as unknown as Record<string, unknown>)[PAGE_LOG_BRIDGE_PROPERTY];
        if (typeof pageBridge !== 'function') return false;

        (pageBridge as (line: LogLine) => void)(logLine);
        return true;
    } catch {
        // A page must not be able to interfere with logging in the extension context.
        return false;
    }
}

function createLogLine(label: string, level: LogLevel, msg: string): LogLine {
    return {
        timestamp: Date.now(),
        label,
        level,
        msg,
    };
}

function trimLogLines(lines: LogLine[]): LogLine[] {
    let traceCount = 0;
    let nonTraceCount = 0;
    return lines
        .slice()
        .reverse()
        .filter((line) =>
            line.level === 'trace' ? ++traceCount <= MAX_TRACE_LOG_COUNT : ++nonTraceCount <= MAX_NON_TRACE_LOG_COUNT
        )
        .reverse();
}

function addLogLine(logLine: LogLine): void {
    if (forwardLogLineToPageBridge(logLine)) return;
    if (activeLogProvider) {
        void activeLogProvider.append([logLine]);
    } else {
        startupLogLines.push(logLine);
        startupLogLines = trimLogLines(startupLogLines);
    }
}

function writeLog(method: (...args: unknown[]) => void, level: LogLevel, label: string, ...args: LogArgs): void {
    const logLine = createLogLine(label, level, logLineText(args));
    method.apply(console, [formatLogLine({ ...logLine, msg: '' }), ...args]);
    addLogLine(logLine);
}

/**
 * Logs a message using console.log with an [asbplayer] prefix and label.
 */
export function asbLog(label: string, ...args: LogArgs): void {
    writeLog(console.log, 'log', label, ...args); // eslint-disable-line no-restricted-properties
}

/**
 * Logs an info message using console.info with an [asbplayer] prefix and label.
 */
export function asbInfo(label: string, ...args: LogArgs): void {
    writeLog(console.info, 'info', label, ...args); // eslint-disable-line no-restricted-properties
}

/**
 * Logs a warning using console.warn with an [asbplayer] prefix and label.
 */
export function asbWarn(label: string, ...args: LogArgs): void {
    writeLog(console.warn, 'warning', label, ...args); // eslint-disable-line no-restricted-properties
}

/**
 * Logs an error using console.error with an [asbplayer] prefix and label.
 */
export function asbError(label: string, ...args: LogArgs): void {
    writeLog(console.error, 'error', label, ...args); // eslint-disable-line no-restricted-properties
}

/**
 * Logs a trace message to the log viewer and export.
 *
 * Ensure this is not used in hot paths to avoid performance degradation. Generally it should only cover
 * meaningful events and state with compact metadata over full contents.
 */
export function asbTrace(label: string, ...args: LogArgs): void {
    addLogLine(createLogLine(label, 'trace', logLineText(args)));
}
