import { expect, it, jest } from '@jest/globals';

const unexpectedExtraction = async () => {
    throw new Error('Unexpected embedded subtitle extraction');
};

jest.mock('ass-compiler', () => ({ compile: () => ({ dialogues: [] }) }));

it('loads shared subtitle readers and session restoration without FFmpeg build definitions', async () => {
    const globals = globalThis as unknown as Record<string, unknown>;
    const definitions = Object.fromEntries(
        Object.keys(globals)
            .filter((key) => key.startsWith('__ASB_FFMPEG_'))
            .map((key) => [key, globals[key]])
    );
    for (const key of Object.keys(definitions)) delete globals[key];
    try {
        await jest.isolateModulesAsync(async () => {
            const { SubtitleReader } = await import('@project/common/subtitle-reader');
            const { SubtitleHtml } = await import('@project/common');
            const { restoreSessionFiles } = await import('@project/common/file-system-access');
            const { embeddedSubtitleId, plainSrtMimeType } = await import(
                '@project/common/embedded-subtitles/subtitle-source'
            );
            const reader = new SubtitleReader({
                regexFilter: '',
                regexFilterTextReplacement: '',
                subtitleHtml: SubtitleHtml.render,
                convertNetflixRuby: false,
                pgsParserWorkerFactory: async () => {
                    throw new Error('Text subtitles do not need an image worker');
                },
            });
            const file = new File([], 'embedded.srt', { type: plainSrtMimeType });
            file.text = async () => '1\n00:00:01,000 --> 00:00:02,000\n<b>literal</b>\n\n';
            const subtitle = { id: embeddedSubtitleId('video', 1), file };
            expect(await reader.subtitles([{ fileParts: [file] }])).toMatchObject([
                { start: 1000, end: 2000, text: '&lt;b&gt;literal&lt;/b&gt;' },
            ]);
            expect(
                await restoreSessionFiles(
                    { id: 1, timestamp: 0, subtitleHandles: [], cachedSubtitleFiles: [subtitle] },
                    [],
                    unexpectedExtraction
                )
            ).toEqual([{ ...subtitle, track: 0 }]);
        });
    } finally {
        Object.assign(globals, definitions);
    }
});
