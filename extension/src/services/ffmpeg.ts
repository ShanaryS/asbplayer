import { createFfmpegSession } from '@project/ffmpeg';

export const createExtensionFfmpegSession = () => {
    const wrapperUrl = browser.runtime.getURL('/ffmpeg/0.1.0/ffmpeg-wrapper.js');
    return createFfmpegSession({ assetBaseUrl: new URL('../../', wrapperUrl).href });
};
