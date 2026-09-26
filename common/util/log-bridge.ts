/**
 * The page-world logger can see this callback; the extension isolated world cannot.
 * That keeps page logs flowing through the content script without forwarding extension logs twice.
 */
export const PAGE_LOG_BRIDGE_PROPERTY = '__asbplayerLogLine';

/** Sender tag for messages carrying logs from the page world to the content script. */
export const PAGE_LOG_MESSAGE_SENDER = 'asbplayer-page-log';
