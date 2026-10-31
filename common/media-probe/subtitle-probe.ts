import ByteReader from '@project/common/media-probe/byte-reader';
import { ebmlHeaderId, ebmlHeaderIdBytes } from '@project/common/media-probe/ebml';
import { matroskaTracks } from '@project/common/media-probe/matroska';
import { isoBmffTracks } from '@project/common/media-probe/iso-bmff';

export interface EmbeddedSubtitleTrack {
    streamIndex: number;
    codec: string;
    language?: string;
    title?: string;
    outputFormat?: 'srt' | 'sup';
    unsupportedReason?: string;
}

const matroskaCodecs: Record<string, string> = {
    'S_TEXT/UTF8': 'subrip',
    'S_TEXT/ASCII': 'text',
    'S_TEXT/ASS': 'ass',
    S_ASS: 'ass',
    'S_TEXT/SSA': 'ass',
    S_SSA: 'ass',
    'S_HDMV/PGS': 'hdmv_pgs_subtitle',
    S_VOBSUB: 'dvd_subtitle',
    S_DVBSUB: 'dvb_subtitle',
};
const mp4Codecs: Record<string, string> = { tx3g: 'mov_text', text: 'mov_text', wvtt: 'webvtt', stpp: 'ttml' };
const textCodecs = new Set(['subrip', 'text', 'ass', 'ssa', 'webvtt', 'mov_text']);

const subtitle = (
    streamIndex: number,
    codec: string,
    language: string | undefined,
    title: string | undefined,
    supported = true
): EmbeddedSubtitleTrack => ({
    streamIndex,
    codec,
    language,
    title,
    ...(supported && (textCodecs.has(codec) || codec === 'hdmv_pgs_subtitle')
        ? { outputFormat: codec === 'hdmv_pgs_subtitle' ? 'sup' : 'srt' }
        : { unsupportedReason: 'unsupported-codec' }),
});

/** Discover dedicated subtitle tracks from container metadata, without loading FFmpeg. */
export const probeSubtitleTracks = async (blob: Blob, signal?: AbortSignal): Promise<EmbeddedSubtitleTrack[]> => {
    const reader = new ByteReader(blob, undefined, signal);
    if ((await reader.unsignedInt(0, ebmlHeaderIdBytes)) === ebmlHeaderId) {
        const tracks = await matroskaTracks(reader);
        if (!tracks) throw new Error('Could not read Matroska tracks');
        return tracks.flatMap((track, index) => {
            if (track.type !== 17) return [];
            const codec = track.codecId.startsWith('D_WEBVTT/')
                ? 'webvtt'
                : (matroskaCodecs[track.codecId] ?? track.codecId);
            return [subtitle(index, codec, track.language, track.title)];
        });
    }
    const boxType = await reader.ascii(4, 4);
    if (boxType && ['ftyp', 'styp', 'moov', 'free', 'skip', 'wide', 'mdat'].includes(boxType)) {
        const tracks = await isoBmffTracks(reader);
        if (!tracks) throw new Error('Could not read MP4 tracks');
        return tracks.flatMap((track, index) => {
            if (track.chapter) return [];
            if (!['text', 'sbtl', 'subt', 'subp', 'clcp'].includes(track.handler)) return [];
            if (!track.format) throw new Error('Missing MP4 subtitle sample entry');
            // Only timed text is enabled for MP4 in this runtime.
            return [
                subtitle(
                    index,
                    mp4Codecs[track.format] ?? track.format,
                    track.language,
                    track.title,
                    track.format === 'tx3g' || track.format === 'text'
                ),
            ];
        });
    }
    throw new Error('Unsupported subtitle container');
};
