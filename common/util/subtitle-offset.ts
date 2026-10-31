import type { DisplaySubtitleModel } from '@project/common';
import { timeDurationDisplay } from '@project/common/util/util';

// Resolve the subtitles when React applies the update, including any source that
// finished loading before an offset message from the media channel arrived.
export const subtitleOffsetUpdate = (offset: number) => (subtitles: DisplaySubtitleModel[] | undefined) => {
    if (subtitles === undefined) return subtitles;
    const length = subtitles.length > 0 ? subtitles[subtitles.length - 1].end + offset : 0;
    return subtitles.map((subtitle, index) => ({
        text: subtitle.text,
        textImage: subtitle.textImage,
        start: subtitle.originalStart + offset,
        originalStart: subtitle.originalStart,
        end: subtitle.originalEnd + offset,
        originalEnd: subtitle.originalEnd,
        displayTime: timeDurationDisplay(subtitle.originalStart + offset, length),
        displayEndTime: timeDurationDisplay(subtitle.originalEnd + offset, length),
        track: subtitle.track,
        index,
        tokenization: subtitle.tokenization,
    }));
};
