import { afterEach, describe, expect, it } from '@jest/globals';
import { LogProvider } from '@project/common/util/log';
import type { LogLine, LogStorage } from '@project/common/util/log';
import { PAGE_LOG_MESSAGE_SENDER } from '@project/common/util/log-bridge';
import { bindPageLogForwarder } from '@project/extension/src/services/page-log-forwarder';

const logLine: LogLine = {
    timestamp: 1,
    label: 'page',
    level: 'trace',
    msg: 'loaded',
};

const dispatch = (source: Window, data: unknown) => {
    window.dispatchEvent(new MessageEvent('message', { source, data }));
};

describe('page log forwarder', () => {
    afterEach(() => {
        document.body.replaceChildren();
    });

    it('accepts valid logs from this frame and its child frames only', async () => {
        const storedLines: LogLine[] = [];
        const storage: LogStorage = {
            append: async (lines) => {
                storedLines.push(...lines);
            },
            getLogs: async () => ({ lines: storedLines }),
        };
        const provider = new LogProvider(storage);
        const unbind = bindPageLogForwarder(provider);
        const iframe = document.createElement('iframe');
        document.body.append(iframe);
        const childWindow = iframe.contentWindow!;
        const nestedFrame = childWindow.document.createElement('iframe');
        childWindow.document.body.append(nestedFrame);
        const unrelatedWindow = nestedFrame.contentWindow!;

        dispatch(window, { sender: PAGE_LOG_MESSAGE_SENDER, lines: [logLine] });
        dispatch(childWindow, {
            sender: PAGE_LOG_MESSAGE_SENDER,
            lines: [{ ...logLine, msg: 'child frame' }],
        });
        dispatch(unrelatedWindow, {
            sender: PAGE_LOG_MESSAGE_SENDER,
            lines: [{ ...logLine, msg: 'unrelated frame' }],
        });
        dispatch(window, {
            sender: PAGE_LOG_MESSAGE_SENDER,
            lines: [{ ...logLine, msg: 4 }],
        });
        dispatch(window, { sender: 'other', lines: [logLine] });

        expect(await provider.getLogLines()).toEqual([logLine, { ...logLine, msg: 'child frame' }]);

        unbind();
    });
});
