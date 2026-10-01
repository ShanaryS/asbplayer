import { describe, expect, it, jest } from '@jest/globals';
import { SubtitleVisibility } from '@project/common/settings';
import SubtitleVisibilityController, {
    formatSubtitleVisibilityNotification,
    nextSubtitleVisibility,
} from '@project/common/playback/controllers/subtitle-visibility-controller';

const harness = (visibility: SubtitleVisibility, options?: { readonly paused: boolean }) => {
    const visibilityChanged = jest.fn();
    const controller = new SubtitleVisibilityController({ visibilityChanged });
    controller.replacePlan(visibility, { paused: options?.paused ?? false });
    visibilityChanged.mockClear();
    return { controller, visibilityChanged };
};

describe('subtitle visibility mode', () => {
    it('toggles both values and formats its notification', () => {
        const whilePaused = nextSubtitleVisibility(SubtitleVisibility.whenDue);
        const whileManuallyPaused = nextSubtitleVisibility(whilePaused);
        const whenDue = nextSubtitleVisibility(whileManuallyPaused);

        expect([whilePaused, whileManuallyPaused, whenDue]).toEqual([
            SubtitleVisibility.whilePaused,
            SubtitleVisibility.whileManuallyPaused,
            SubtitleVisibility.whenDue,
        ]);
        expect(formatSubtitleVisibilityNotification(whileManuallyPaused)).toEqual({
            key: 'subtitle-visibility',
            locKey: 'info.subtitleVisibility',
            valueLocKey: 'settings.subtitleVisibilityWhileManuallyPaused',
        });
    });
});

describe('SubtitleVisibilityController', () => {
    it('keeps due subtitles visible in when-due mode', () => {
        const { controller, visibilityChanged } = harness(SubtitleVisibility.whenDue);
        controller.autoPaused();
        controller.autoPauseResumeDelayStarted();
        controller.playbackStarted();
        expect(controller.subtitlesVisible).toBe(true);
        expect(visibilityChanged).not.toHaveBeenCalled();
    });

    it('shows an automatic pause only for its reading period', () => {
        const { controller, visibilityChanged } = harness(SubtitleVisibility.whilePaused);
        expect(controller.subtitlesVisible).toBe(false);
        controller.autoPaused();
        expect(controller.subtitlesVisible).toBe(true);
        controller.autoPauseResumeDelayStarted();
        expect(controller.subtitlesVisible).toBe(false);
        expect(visibilityChanged).toHaveBeenCalledTimes(2);
    });

    it('does not reopen the reading period when the automatic media pause is reported', () => {
        const { controller } = harness(SubtitleVisibility.whilePaused);
        controller.autoPaused();
        controller.autoPauseResumeDelayStarted();
        controller.playbackPaused();
        expect(controller.subtitlesVisible).toBe(false);
    });

    it('keeps subtitles hidden through PlaybackEngine auto-pause and reveals them for other pauses', () => {
        const { controller } = harness(SubtitleVisibility.whileManuallyPaused);
        expect(controller.subtitlesVisible).toBe(false);
        controller.autoPaused();
        controller.playbackPaused();
        expect(controller.subtitlesVisible).toBe(false);
        controller.autoPauseResumeDelayStarted();
        expect(controller.subtitlesVisible).toBe(false);
        controller.playbackStarted();
        controller.playbackPaused();
        expect(controller.subtitlesVisible).toBe(true);
        controller.playbackStarted();
        expect(controller.subtitlesVisible).toBe(false);
    });

    it('keeps an active automatic pause hidden when the visibility setting changes', () => {
        const { controller } = harness(SubtitleVisibility.whilePaused);
        controller.autoPaused();
        controller.replacePlan(SubtitleVisibility.whileManuallyPaused, { paused: true });
        controller.playbackPaused();
        expect(controller.subtitlesVisible).toBe(false);
        controller.userSeeked({ paused: true });
        expect(controller.subtitlesVisible).toBe(true);
    });

    it('preserves an automatic reading phase when an equivalent plan is replaced', () => {
        const { controller } = harness(SubtitleVisibility.whilePaused);
        controller.autoPaused();
        controller.autoPauseResumeDelayStarted();
        controller.replacePlan(SubtitleVisibility.whilePaused, { paused: true });
        controller.playbackPaused();
        expect(controller.subtitlesVisible).toBe(false);
    });

    it('shows subtitles for an ordinary pause and hides them once playback starts', () => {
        const { controller } = harness(SubtitleVisibility.whilePaused);
        controller.playbackPaused();
        expect(controller.subtitlesVisible).toBe(true);
        controller.playbackStarted();
        expect(controller.subtitlesVisible).toBe(false);
    });

    it('ends an automatic pause on user seeks while preserving paused-frame visibility', () => {
        const pausedHarness = harness(SubtitleVisibility.whilePaused);
        pausedHarness.controller.autoPaused();
        pausedHarness.controller.userSeeked({ paused: true });
        expect(pausedHarness.controller.subtitlesVisible).toBe(true);

        const playingHarness = harness(SubtitleVisibility.whilePaused);
        playingHarness.controller.autoPaused();
        playingHarness.controller.userSeeked({ paused: false });
        expect(playingHarness.controller.subtitlesVisible).toBe(false);
    });

    it('ends an automatic pause when its pending resume is cancelled', () => {
        const { controller } = harness(SubtitleVisibility.whilePaused);
        controller.autoPaused();
        controller.autoPauseResumeDelayStarted();

        controller.autoPauseCancelled({ paused: true });

        expect(controller.subtitlesVisible).toBe(true);
    });

    it('reconciles visibility from current playback state when its plan is replaced', () => {
        const playingHarness = harness(SubtitleVisibility.whenDue);
        playingHarness.controller.replacePlan(SubtitleVisibility.whilePaused, { paused: false });
        expect(playingHarness.controller.subtitlesVisible).toBe(false);

        const pausedHarness = harness(SubtitleVisibility.whenDue);
        pausedHarness.controller.replacePlan(SubtitleVisibility.whilePaused, { paused: true });
        expect(pausedHarness.controller.subtitlesVisible).toBe(true);
    });
});
