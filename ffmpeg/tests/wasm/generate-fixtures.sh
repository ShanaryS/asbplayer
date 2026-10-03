#!/bin/bash
set -euo pipefail

# The media check owns this temporary directory and cleans it up, including on failure.
fixture_root="${1:?A temporary fixture directory is required}"
mkdir -p "$fixture_root"
ffmpeg -hide_banner -loglevel error -y -f lavfi -i 'sine=frequency=440:duration=30:sample_rate=48000' \
    -c:a eac3 "$fixture_root/progress.mkv"
ffmpeg -hide_banner -loglevel error -y -f lavfi -i 'sine=frequency=440:duration=0.2:sample_rate=44100' \
    -c:a ac3 "$fixture_root/ac3.mp4"
ffmpeg -hide_banner -loglevel error -y -f lavfi -i 'sine=frequency=440:duration=0.2:sample_rate=48000' \
    -c:a eac3 -ac 6 "$fixture_root/eac3-surround.mkv"
ffmpeg -hide_banner -loglevel error -y -f lavfi -i 'sine=frequency=440:duration=0.2:sample_rate=32000' \
    -c:a ac3 "$fixture_root/ac3-resample.mkv"
ffmpeg -hide_banner -loglevel error -y -f lavfi -i 'sine=frequency=440:duration=0.2:sample_rate=48000' \
    -c:a dca -strict -2 "$fixture_root/dts.mkv"
ffmpeg -hide_banner -loglevel error -y -f lavfi -i 'sine=frequency=440:duration=0.2:sample_rate=48000' \
    -c:a truehd -strict -2 "$fixture_root/truehd.mkv"
ffmpeg -hide_banner -loglevel error -y -f lavfi -i 'sine=frequency=440:duration=0.2:sample_rate=48000' \
    -c:a mlp -strict -2 "$fixture_root/mlp.mkv"
ffmpeg -hide_banner -loglevel error -y -f lavfi -i 'color=c=black:s=16x16:r=10:d=0.8' \
    -itsoffset 0.3 -f lavfi -i 'sine=frequency=440:duration=0.2:sample_rate=48000' \
    -map 0:v -map 1:a -c:v mpeg4 -c:a ac3 "$fixture_root/audio-offset.mp4"
ffmpeg -hide_banner -loglevel error -y -f lavfi -i 'sine=frequency=440:duration=0.8:sample_rate=48000' \
    -af "aselect='lt(t,0.25)+gte(t,0.55)'" -c:a ac3 "$fixture_root/audio-gap.mkv"

# Unused attachments must not be copied repeatedly while probing the audio track.
truncate -s 80M "$fixture_root/unused-attachment.bin"
ffmpeg -hide_banner -loglevel error -y -i "$fixture_root/eac3-surround.mkv" \
    -map 0:a -c copy -attach "$fixture_root/unused-attachment.bin" \
    -metadata:s:t mimetype=application/octet-stream "$fixture_root/eac3-attachment.mkv"
