# Embedded subtitles

Local media imports load the video immediately, initially paused, so audio conversion can run while subtitles are selected. A single external subtitle loads directly; multiple external subtitles open the existing picker with their candidate order preserved. A video imported without loaded external subtitles is probed independently, and the picker opens automatically only if supported embedded tracks are found. A failed or empty probe leaves the video loaded. Reopening the picker probes as needed and retries failed discovery.

Discovery uses the shared JavaScript Matroska/WebM and MP4/M4V metadata readers to populate track identities, languages, labels, codecs and supported formats. It does not load FFmpeg or depend on its runtime cache. Opening the picker, loading external subtitles and finding no embedded tracks do not download the runtime. Invalid or unsupported metadata reports discovery failure without an FFmpeg fallback. Completed catalogs and pending reads are reused.

Shared subtitle code uses an operation-level `SubtitleHost`; only the website-loaded FFmpeg adapter creates sessions, accumulates output chunks and disposes workers. Subtitle source descriptors, MIME types and matching helpers have no FFmpeg runtime imports, so the extension can use the same reader. The subtitle worker is owned separately from audio conversion. FFmpeg loads only when confirmed extraction needs an uncached output, or restoration needs to regenerate missing saved bytes. Extraction has no probing deadline and starts only after OK, opens the input once, routes output by global stream index, and transfers chunks into per-track Files. Initial packets establish the shared media origin without decoding audio or video. Repeated selections reuse extracted Files, including valid empty tracks. Discovery and confirmation each own an abort signal. Closing the selector, replacing an import, or unmounting aborts the relevant requests and terminates outstanding subtitle work, while completed catalogs and outputs remain reusable. The video continues loading behind the selector; selected subtitle slots are committed together after every selected file has resolved. Confirming subtitles does not reload the same video or restart audio conversion.

Picker choices show external subtitles before embedded ones, with file-text, cloud-download and film prefixes for local, online and embedded sources. Labels and output filenames number subtitle streams from one, including recognized unsupported subtitle streams; global media stream indexes remain internal identities. Metadata discovery and extraction use the picker spinner. Audio conversion uses the existing notification hook: notices appear after three seconds and hide when complete or after ten seconds.

| Container | Embedded codecs | Output |
| --- | --- | --- |
| Matroska | SubRip, plain text, ASS/SSA, WebVTT | UTF-8 SRT |
| WebM | WebVTT subtitles/captions | UTF-8 SRT |
| MP4/M4V | `mov_text` / `tx3g` | UTF-8 SRT |

Zlib-compressed and header-stripped Matroska tracks are supported. The zlib source and license are pinned and included in the normal build/source archive workflow. Image codecs, including PGS, VobSub/DVD, DVB and XSUB, remain disabled in the picker. AVI and MP4 TTML/IMSC are not supported by this runtime.

Text extraction drops source styling, fonts, positions and drawing runs, retains karaoke text, and normalizes ASS hard spaces. Cue timing uses one shared media origin, never the first cue in each subtitle track. MP4 sample timing includes the demuxer's edit-list handling. Missing cue timing or an unresolved media origin fails extraction. Embedded SRT Files have `text/x-asbplayer-plain-srt` provenance so the reader preserves extracted literal markup and entities under either subtitle HTML setting. Ordinary external text-file parsing is unchanged.

Session records retain source IDs grouped by playback slot, including multi-part tracks, duplicate selections and empty slots, separately from deduplicated cached Files. Older records with one ID per slot are migrated to the grouped layout. Embedded descriptors contain the video ID, name/size/modification fingerprint, global stream index, codec and format. Complete extracted Files and their descriptors are saved after selection resolves; pending extraction is not persisted. Matching cached Files are reused, with track indexes reconstructed from the saved slot layout. Evicted embedded outputs can be regenerated from the saved video after permission is granted. Unavailable tracks keep their positions; changed video fingerprints require selecting the tracks again. The existing browser restrictions and cache quota apply. The fingerprint is a change detector, not a content hash.

## Local verification

The released runtime selection is unchanged. Use a local candidate to try the feature:

```sh
ASB_FFMPEG_RUNTIME_VERSION=0.2.0 pnpm --filter @project/ffmpeg run build:candidate
ASB_FFMPEG_RUNTIME_VERSION=0.2.0 pnpm --filter @project/ffmpeg run test:native-wasm
VITE_FFMPEG_CANDIDATE=1 ASB_FFMPEG_RUNTIME_VERSION=0.2.0 pnpm --filter @project/client start
```

`test:native-wasm` runs subtitle regressions alongside the audio regressions. The test container generates tiny temporary inputs with its FFmpeg CLI, exercises the real WASM runtime, and removes the inputs afterward. No host FFmpeg installation, checked-in media, external artwork or fonts are needed.

Coverage concentrates on multiple text stream routing, literal text and ASS normalization, shared nonzero media origins, slow input reads, and the zlib dependency. Ordinary Jest tests check JavaScript metadata discovery, including sparse MP4 seeks beyond 4 GiB. Reader and lifecycle tests separately cover literal-text handling, cancellation and stale results; they do not depend on a generated-output directory or an optional environment variable.

## Remaining image-subtitle work

Embedded image subtitles are deferred. PGS will need packet extraction/remuxing, a shared media-origin adjustment for standalone SUP timestamps, and decoder/resource-lifecycle verification. VobSub/DVD, DVB and XSUB also need format-specific extraction and bitmap decoding before being enabled. The existing external SUP path is unchanged. OCR remains out of scope.
