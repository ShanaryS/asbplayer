#!/bin/bash
set -euo pipefail

package_root="$(cd "$(dirname "$0")/.." && pwd)"
rebuilt="$(mktemp -d)"
trap 'rm -rf "$rebuilt"' EXIT

runtime_version="$(node -p "require('$package_root/package.json').version")"
source_archive="$package_root/release/asbplayer-ffmpeg-$runtime_version-source.tar.xz"
runtime_archive="$package_root/release/asbplayer-ffmpeg-$runtime_version-runtime.tar.gz"
test -f "$source_archive"
test -f "$runtime_archive"

build_into() {
    local destination="$1"
    tar -xJf "$source_archive" --strip-components=1 -C "$destination"
    (cd "$destination" && yarn install --immutable \
        && bash ffmpeg/scripts/build.sh \
        && bash ffmpeg/scripts/package-candidate.sh \
        && yarn workspace @project/ffmpeg verify:candidate \
        && yarn workspace @project/ffmpeg test:native)
}

ASB_FFMPEG_NO_CACHE=1 build_into "$rebuilt"
for path in \
    "ffmpeg/dist/$runtime_version/ffmpeg-core.js" \
    "ffmpeg/dist/$runtime_version/ffmpeg-core.wasm" \
    "ffmpeg/dist/$runtime_version/ffmpeg-worker.js" \
    "ffmpeg/dist/$runtime_version/manifest.json" \
    "ffmpeg/release/asbplayer-ffmpeg-$runtime_version-runtime.tar.gz" \
    "ffmpeg/release/asbplayer-ffmpeg-$runtime_version-source.tar.xz" \
    "ffmpeg/release/manifest.json" \
    "ffmpeg/release/SHA256SUMS"; do
    cmp "$rebuilt/$path" "$package_root/../$path"
done
echo "The corresponding source reproduces the FFmpeg release"
