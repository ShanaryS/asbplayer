import { afterAll, afterEach, beforeAll, expect, it, jest } from '@jest/globals';
import type { LogLine } from '@project/common/util/log';
import { PAGE_LOG_BRIDGE_PROPERTY, PAGE_LOG_MESSAGE_SENDER } from '@project/common/util/log-bridge';

let installBridge: () => void;
const line: LogLine = { timestamp: 1, label: 'page', level: 'trace', msg: 'loaded' };

beforeAll(async () => {
    Object.defineProperty(globalThis, 'defineUnlistedScript', {
        configurable: true,
        value: (main: () => void) => ({ main }),
    });
    installBridge = (await import('@project/extension/src/entrypoints/page-log-bridge')).default.main;
});

afterEach(() => {
    jest.restoreAllMocks();
    delete (window as unknown as Record<string, unknown>)[PAGE_LOG_BRIDGE_PROPERTY];
    document.body.replaceChildren();
});

afterAll(() => {
    Reflect.deleteProperty(globalThis, 'defineUnlistedScript');
});

it.each([false, true])('routes logs locally unless the script belongs to an injected UI (UI: %s)', (isUi) => {
    const frame = document.createElement('iframe');
    document.body.append(frame);
    const parent = frame.contentWindow!;
    jest.spyOn(window, 'parent', 'get').mockReturnValue(parent);
    const localPost = jest.spyOn(window, 'postMessage').mockImplementation(() => undefined);
    const parentPost = jest.spyOn(parent, 'postMessage').mockImplementation(() => undefined);
    const script = document.createElement('script');
    if (isUi) script.setAttribute('data-asbplayer-ui', '');
    jest.spyOn(document, 'currentScript', 'get').mockReturnValue(script);

    installBridge();
    const bridge = (window as unknown as Record<string, (line: LogLine) => void>)[PAGE_LOG_BRIDGE_PROPERTY];
    bridge(line);

    expect((isUi ? parentPost : localPost).mock.calls).toEqual([
        [{ sender: PAGE_LOG_MESSAGE_SENDER, lines: [line] }, '*'],
    ]);
    expect(isUi ? localPost : parentPost).not.toHaveBeenCalled();
});
