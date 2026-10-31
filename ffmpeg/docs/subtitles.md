# Embedded subtitles

Local media imports load the video immediately, initially paused, so audio conversion can run while subtitles are selected. A single external subtitle loads directly; multiple external subtitles open the existing picker with their candidate order preserved. A video imported without loaded external subtitles is probed independently, and the picker opens automatically only if supported embedded tracks are found. A failed or empty probe leaves the video loaded. Reopening the picker probes as needed and retries failed discovery.

Discovery uses the shared JavaScript Matroska/WebM and MP4/M4V metadata readers to populate track identities, languages, labels, codecs and supported formats. It does not load FFmpeg or depend on its runtime cache. Opening the picker, loading external subtitles and finding no embedded tracks do not download the runtime. Invalid or unsupported metadata reports discovery failure without an FFmpeg fallback. Completed catalogs and pending reads are reused.

The subtitle worker is owned separately from audio conversion. FFmpeg loads only when confirmed extraction needs an uncached output, or restoration needs to regenerate missing saved bytes. Extraction has no probing deadline and starts only after OK, opens the input once, routes output by global stream index, and transfers chunks into per-track Files. Initial packets establish the shared media origin without decoding audio or video. Repeated selections reuse extracted Files, including valid empty tracks. Closing the selector, replacing an import, or unmounting terminates outstanding subtitle work. The video continues loading behind the selector; selected subtitle slots are committed together after every selected file has resolved. Confirming subtitles does not reload the same video or restart audio conversion.

Picker choices show external subtitles before embedded ones, with file-text, cloud-download and film prefixes for local, online and embedded sources. Labels and output filenames number subtitle streams from one, including recognized unsupported subtitle streams; global media stream indexes remain internal identities. Metadata discovery and extraction use the picker spinner. Audio conversion uses the existing notification hook: notices appear after three seconds and hide when complete or after ten seconds.

| Container | Embedded codecs | Output |
| --- | --- | --- |
| Matroska | SubRip, plain text, ASS/SSA, WebVTT | UTF-8 SRT |
| Matroska | PGS (`hdmv_pgs_subtitle`) | SUP images |
| WebM | WebVTT subtitles/captions | UTF-8 SRT |
| MP4/M4V | `mov_text` / `tx3g` | UTF-8 SRT |

Zlib-compressed and header-stripped Matroska tracks are supported. The zlib source and license are pinned and included in the normal build/source archive workflow. Other codecs, including VobSub/DVD, DVB and XSUB images, remain disabled in the picker. AVI and MP4 TTML/IMSC are not supported by this runtime.

Text extraction drops source styling, fonts, positions and drawing runs, retains karaoke text, and normalizes ASS hard spaces. Cue timing uses one shared media origin, never the first cue in each subtitle track. MP4 sample timing includes the demuxer's edit-list handling. Missing cue timing or an unresolved media origin fails extraction. Embedded SRT Files have `text/x-asbplayer-plain-srt` provenance so the reader preserves extracted literal markup and entities under either subtitle HTML setting. Ordinary external text-file parsing is unchanged.

PGS extraction remuxes packets through FFmpeg's SUP muxer without decoding or re-encoding them. Palette, object, composition and clear segments are retained. SUP timestamps start at the first packet; the output descriptor saves a per-track `timelineOffsetMs` relative to the shared media origin. Restoration retains that adjustment, and the reader applies it exactly once before the user's subtitle offset. Preroll is decoded before cues ending before media time zero are dropped; cues crossing zero are clipped. Missing timestamps fail extraction. Consecutive packet gaps of at least 2^31 ticks (about 6.6 hours) are rejected because a standalone SUP cannot unambiguously unwrap them. A long initial delay is supported through the saved adjustment.

The app and extension share the parser in [`common/pgs-parser`](../../common/pgs-parser/index.ts). Playback timing stays in the subtitle-reader adapter. The streaming PGS worker supports fragmented objects, sparse and partial palettes, object reuse, multiple objects, alpha composition, crops, window clipping and the 32-bit SUP clock wrap. A later composition or clear ends the current image. An image still pending at EOF lasts five seconds. Images retain their relative placement within a composite; the existing player centers and scales the composite using the source screen dimensions. The decoder accepts up to 4096 × 2160 pixels, 256 cached objects, 4096 fragments per object and 64 MiB of cached object data. It retains current decoding state rather than a history of display sets. PNG encoding and data URL conversion finish before the reader resolves. Replacing the selection or unmounting aborts pending image workers. External SUP files use this same decoder.

Session records retain ordered source IDs, duplicate and empty slots, and embedded descriptors containing the video ID, name/size/modification fingerprint, global stream index, codec and format. Complete extracted Files and their descriptors are saved after selection resolves; pending extraction is not persisted. Matching cached Files are reused. Evicted embedded outputs can be regenerated from the saved video after permission is granted. Unavailable tracks keep their positions; changed video fingerprints require selecting the tracks again. The existing browser restrictions and cache quota apply. The fingerprint is a change detector, not a content hash.

## Local verification

The released runtime selection is unchanged. Use a local candidate to try the feature:

```sh
ASB_FFMPEG_RUNTIME_VERSION=0.2.0 pnpm --filter @project/ffmpeg run build:candidate
ASB_FFMPEG_RUNTIME_VERSION=0.2.0 pnpm --filter @project/ffmpeg run test:native-wasm
VITE_FFMPEG_CANDIDATE=1 ASB_FFMPEG_RUNTIME_VERSION=0.2.0 pnpm --filter @project/client start
```

`test:native-wasm` runs subtitle regressions alongside the audio regressions. The test container generates tiny temporary inputs with its FFmpeg CLI and a small PGS byte builder, exercises the real WASM runtime, and removes the inputs afterward. No host FFmpeg installation, checked-in media, external artwork or fonts are needed.

Coverage concentrates on mixed text/image stream routing, literal text and ASS normalization, shared nonzero media origins, slow input reads, the zlib dependency, and PGS preroll, long initial delays, timestamps and resource preservation. Ordinary Jest tests check JavaScript metadata discovery, including sparse MP4 seeks beyond 4 GiB, and construct PGS bytes in memory to check fragmented input, state reuse, timestamp wrap, corrupt data and allocation limits. Reader and lifecycle tests separately cover literal-text handling, timeline adjustments, cancellation and stale results; they do not depend on a generated-output directory or an optional environment variable.

## Remaining image-subtitle work

PGS is supported in this pass. VobSub/DVD, DVB and XSUB need separate container extraction, bitmap decoders and fixtures before they can be enabled. Preserving absolute source-screen placement would also require player layout changes. OCR remains out of scope.

## Validation measurements

The local candidate WASM is 1,341,666 bytes, below the configured 2,000,000-byte limit. The earlier local candidate retained a 16 MiB WASM heap across ten repeated extractions. In isolated Chrome, mixed PGS/text loading produced the expected PNG pixels and cue times. Reopening without duplicate choices and cancelling a staged replacement passed without browser exceptions. The app's JS heap snapshot was about 59 MB, with about 26 MB of backing storage. These small synthetic-media figures are not a memory profile of a representative large MKV. The sparse 5 GiB MP4 test separately checks header discovery and 64-bit seeks without allocating or scanning the gap.
