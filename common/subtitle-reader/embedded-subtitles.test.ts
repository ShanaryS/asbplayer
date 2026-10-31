import { SubtitleHtml } from '@project/common';
import { plainSrtMimeType } from '@project/common/embedded-subtitles/embedded-subtitles';
import SubtitleReader from '@project/common/subtitle-reader/subtitle-reader';

// ASS is unrelated to this SRT/reader integration; its ESM parser is not loaded by Jest.
jest.mock('ass-compiler', () => ({ compile: () => ({ dialogues: [] }) }));

const reader = (subtitleHtml: SubtitleHtml) =>
    new SubtitleReader({
        regexFilter: '',
        regexFilterTextReplacement: '',
        subtitleHtml,
        convertNetflixRuby: false,
        pgsParserWorkerFactory: async () => {
            throw new Error('No image subtitles');
        },
    });
const file = (text: string, plain = true) =>
    ({
        name: 'episode.srt',
        type: plain ? plainSrtMimeType : 'text/plain',
        text: async () => text,
    }) as File;

it.each([SubtitleHtml.render, SubtitleHtml.remove])(
    'retains literal plain text and overlapping cues with HTML setting %s',
    async (setting) => {
        const nodes = await reader(setting).subtitles([
            file(
                '1\n00:00:02,000 --> 00:00:04,500\n日本語 <b>literal</b> &amp; {\\an8}\nline two\n\n' +
                    '2\n00:00:03,000 --> 00:00:05,000\nOverlap\n\n' +
                    '3\n00:00:06,000 --> 00:00:07,000\nFinal cue\n\n'
            ),
        ]);
        expect(nodes.map(({ start, end, text }) => ({ start, end, text }))).toEqual([
            { start: 2000, end: 4500, text: '日本語 &lt;b&gt;literal&lt;/b&gt; &amp;amp; {\\an8}\nline two' },
            { start: 3000, end: 5000, text: 'Overlap' },
            { start: 6000, end: 7000, text: 'Final cue' },
        ]);
    }
);
it('preserves ordinary external SRT markup handling and accepts empty embedded tracks', async () => {
    const srt = '1\n00:00:01,000 --> 00:00:02,000\n{\\an8}<b>normal</b> &amp;\n\n';
    expect((await reader(SubtitleHtml.remove).subtitles([file(srt, false)]))[0].text).toBe('normal &');
    expect(await reader(SubtitleHtml.render).subtitles([file('')])).toEqual([]);
});
