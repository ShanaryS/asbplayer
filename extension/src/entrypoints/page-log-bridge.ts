import type { LogLine } from '@project/common/util/log';
import { PAGE_LOG_BRIDGE_PROPERTY, PAGE_LOG_MESSAGE_SENDER } from '@project/common/util/log-bridge';

export default defineUnlistedScript(() => {
    // Injected UI frames have no content script; ordinary pages forward to their own frame.
    const target = document.currentScript?.hasAttribute('data-asbplayer-ui') ? window.parent : window;
    const forwardLogLine = (line: LogLine) => {
        target.postMessage(
            {
                sender: PAGE_LOG_MESSAGE_SENDER,
                lines: [line],
            },
            '*'
        );
    };

    Object.defineProperty(window, PAGE_LOG_BRIDGE_PROPERTY, {
        configurable: true,
        value: forwardLogLine,
    });
});
