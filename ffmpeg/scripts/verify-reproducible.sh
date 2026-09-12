#!/bin/bash
set -euo pipefail

package_root="$(cd "$(dirname "$0")/.." && pwd)"
first="$(mktemp)"
trap 'rm -f "$first"' EXIT

bash "$package_root/scripts/build.sh"
sha256sum "$package_root"/release/asbplayer-ffmpeg-*-runtime.tar.gz \
    "$package_root"/release/asbplayer-ffmpeg-*-source.tar.xz > "$first"
bash "$package_root/scripts/build.sh"
sha256sum --check "$first"
node "$package_root/scripts/mark-reproducible.mjs"
