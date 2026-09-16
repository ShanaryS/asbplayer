#!/bin/bash
set -euo pipefail

package_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$package_root/.."

yarn verify:ffmpeg:code
yarn workspace @project/ffmpeg verify:candidate
yarn verify:ffmpeg:native
yarn workspace @project/ffmpeg verify:reproducible

echo "FFmpeg release candidate passed all automated release checks"
