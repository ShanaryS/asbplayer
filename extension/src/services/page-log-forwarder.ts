import { isLogLine } from '@project/common/util/log';
import type { LogProvider } from '@project/common/util/log';
import { PAGE_LOG_MESSAGE_SENDER } from '@project/common/util/log-bridge';

export function bindPageLogForwarder(logProvider: LogProvider): () => void {
    const listener = (event: MessageEvent) => {
        if (event.data?.sender !== PAGE_LOG_MESSAGE_SENDER) return;

        const isChildFrame = Array.from(window.frames).includes(event.source as Window);
        if (event.source !== window && !isChildFrame) return;

        const lines = Array.isArray(event.data.lines) ? event.data.lines.filter(isLogLine) : [];
        void logProvider.append(lines);
    };

    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
}
