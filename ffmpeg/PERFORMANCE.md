# WASM audio conversion measurements

Measured on October 3, 2026 on an Intel Core i5-8400 (6 cores), Node 22.22.0,
using the pinned Emscripten build. The input is a synthetic 180-second, 48 kHz,
5.1 E-AC-3 track at 640 kbps. Each result is the median of three conversions
following one warmup; runtime loading and fixture generation are excluded.
These measurements compare encoder CPU cost, not browser end-to-end latency.

| Runtime              | Encoder                            | Median seconds | WASM bytes |
| -------------------- | ---------------------------------- | -------------: | ---------: |
| `9594c8867` baseline | AAC, stereo 128 kbps               |          6.903 |  1,217,062 |
| Opus implementation  | Opus, stereo 96 kbps, complexity 4 |          2.061 |  1,526,818 |

Opus is 3.35 times as fast on this fixture (70.1% less conversion time), for
309,756 additional WASM bytes. Output sizes were 2,953,218 bytes for baseline
AAC and 2,569,524 bytes for Opus. Different input audio and host load affect
both speed and variable-bitrate output size.

To reproduce, build the desired checkout with `pnpm --filter @project/ffmpeg
run build:runtime`, copy its `ffmpeg-core.js` and `ffmpeg-core.wasm` to a
separate directory, and bundle that checkout's bridge alongside them:

```sh
pnpm --filter @project/ffmpeg exec esbuild src/native.ts --bundle --format=esm \
  --platform=node --target=es2022 --outfile=/tmp/runtime/native-bridge.mjs
ffmpeg -hide_banner -loglevel error -y -f lavfi \
  -i 'aevalsrc=0.15*sin(2*PI*440*t)|0.12*sin(2*PI*660*t)|0.1*sin(2*PI*880*t)|0.08*sin(2*PI*110*t)|0.1*sin(2*PI*330*t)|0.1*sin(2*PI*550*t):s=48000:d=180:c=5.1' \
  -c:a eac3 -b:a 640k /tmp/benchmark.mkv
node ffmpeg/scripts/benchmark.mjs /tmp/runtime /tmp/benchmark.mkv /tmp/result.json
```

The AAC measurements above are historical; the current runtime only encodes Opus.
Use each checkout's own benchmark script and bridge when reproducing historical
results, because the unreleased native API changes with the feature.

## Why conversion now uses one worker

The earlier splitting implementation improved an audio-only CPU benchmark, but
full video inputs also incur browser file reads. The read-only investigation on
October 3, 2026 compared one and four workers in 82 conversions of 11 unique
files on the live `/Media` mergerfs pool, using Chromium 150 on the same six-core
host. It covered AC-3, E-AC-3, DTS, and TrueHD, short extras, episodes, feature
films, and low/high container byte rates. The sample was stratified rather than
a random estimate of the library's workload; cache state and server load varied.

Summing the primary per-file median times, always-single took 614.45 seconds,
always-four took 763.44 seconds, and the former automatic policy would have taken
approximately 608.05 seconds. Always-four was 24% slower in this selected workload;
the policy's estimated saving over single was only 6.4 seconds (1%). This last
number is constructed from the fixed-strategy medians, not a separate automatic
batch measurement.

Four workers won on five files and one won on six. Splitting saved approximately
38 seconds on a low-byte-rate E-AC-3 film, but Chromium could not determine its
duration, so automatic selection missed that gain. The 512 KiB/s cutoff also
selected splitting for an episode that slowed by 10%, while rejecting an episode
that improved by 26%. Storage/cache/load controls changed some same-file winners.
These findings do not establish a reliable static scheduling signal or a
universal performance winner.

The current implementation therefore uses one worker for simpler conversion,
retaining Opus encoding and bounded 4 MiB read-ahead.
Single-worker primary medians ranged from 19 to 90 times realtime. The reported
_Young Ladies Don't Play Fighting Games_ S01E01 input (1,548,874,280 bytes,
1,430.055 seconds, stereo E-AC-3) had a 28.29-second median, versus 50.09 seconds
with four workers. A later busy-pool single run took 190.93 seconds, including
177.32 seconds inside file reads. Single-worker conversion still experiences
storage stalls; these averages do not predict first-audio latency or guarantee
uninterrupted progressive playback.

## Browser measurements

With a candidate runtime and `google-chrome` available (`ASB_CHROME` can select
another Chromium executable):

```sh
node ffmpeg/scripts/benchmark-browser.mjs ffmpeg/dist/0.0.0 /path/to/episode.mkv /tmp/browser-stream.json stream
node ffmpeg/scripts/benchmark-browser.mjs ffmpeg/dist/0.0.0 /path/to/episode.mkv /tmp/browser-encode.json encode
node ffmpeg/scripts/benchmark-browser.mjs ffmpeg/dist/0.0.0 /path/to/episode.mkv /tmp/browser-mine.json mine
```

The harness serves the supplied runtime locally, bundles the production web host,
conversion coordinator, and playback hooks with matching asset hashes, and selects
an original file through Chromium's file-input boundary. It never copies the
source media or writes converted media. `encode` measures conversion through the
worker and records the first chunk time. `stream` also plays the original video
with streamed audio through the production hooks, verifies playback before
conversion finishes, and attempts a seek beyond the available audio. Its overall
timer includes a one-second observation period after conversion for the handoff
from MediaSource to the completed Blob. `test:media` independently decodes the
native output with host FFmpeg. `mine` creates an incomplete audio snapshot during conversion, records through the production AudioClip, independently decodes the recording to check duration and non-silent PCM, captures a screenshot, exports audio, and checks preview cancellation and source lifetime. Use a video fixture with non-silent Dolby audio for this mode.

A 180-second synthetic H.264/5.1 E-AC-3 video (14,512,004 bytes), tested in
Chromium 150 on October 3, 2026, first buffered audio at 0.338 seconds and first
played synchronized video/audio at 0.388 seconds. The browser check confirmed
playback while conversion remained incomplete, rejected a seek beyond available
audio, and reported 180 seconds for the completed audio. One worker was used with
`crossOriginIsolated: false`. The whole check, including its one-second post-conversion
observation, took 3.439 seconds. This is a startup check on a small synthetic input,
not a guarantee about live-server storage latency.

A read-only check of the reported _Young Ladies Don't Play Fighting Games_ S01E01
file on the live `/Media` pool (1,548,874,280 bytes, 1,430.055 seconds) first
buffered audio at 4.229 seconds and played video/audio at 4.297 seconds. Conversion
completed at 160.281 seconds (8.92 times realtime), with 156.315 seconds of measured
playback during the check. The attempted application seek was clamped before
changing the video time, resumed after buffering, and playback continued throughout
conversion. Final video/audio drift was 0.063 seconds. Source inode, size, mtime,
and ctime remained unchanged; no input copies or converted media files were written.
This single run includes live-pool contention and concurrent video reads, so its
conversion time is not directly comparable to the earlier encoding-only medians.

Regression checks retain bounded read-ahead, seeks above 4 GiB, EOF, every input
decoder, downmixing/resampling, progress, cancellation, streamed chunks, audio
offsets/gaps, duration finalization, seek restrictions, and audio underruns.
Split/range/join and AAC output paths have been removed.
