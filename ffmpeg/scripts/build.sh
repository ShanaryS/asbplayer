#!/bin/bash
set -euo pipefail

package_root="$(cd "$(dirname "$0")/.." && pwd)"
core_version="$(node -p "require('$package_root/versions.json').coreVersion")"
output="$package_root/dist/$core_version"
docker_output="$package_root/.cache/docker-output"

node "$package_root/scripts/prepare-sources.mjs"
rm -rf "$docker_output" "$output"
mkdir -p "$docker_output" "$output/notices"

docker buildx build \
    --platform linux/amd64 \
    --output "type=local,dest=$docker_output" \
    "$package_root"

cp "$docker_output/ffmpeg-core.js" "$docker_output/ffmpeg-core.wasm" "$output/"
yarn esbuild "$package_root/../node_modules/@ffmpeg/ffmpeg/dist/esm/index.js" \
    --bundle --format=esm --platform=browser --target=es2020 \
    --outfile="$output/ffmpeg-wrapper.js"
node "$package_root/scripts/sanitize-worker.mjs" "$output/ffmpeg-wrapper.js"
yarn esbuild "$package_root/../node_modules/@ffmpeg/ffmpeg/dist/esm/worker.js" \
    --bundle --format=esm --platform=browser --target=es2020 \
    --outfile="$output/ffmpeg-worker.js"
node "$package_root/scripts/sanitize-worker.mjs" "$output/ffmpeg-worker.js"

cp "$package_root/.cache/sources/ffmpeg/COPYING.LGPLv2.1" "$output/notices/FFmpeg-LGPL-2.1.txt"
cp "$package_root/.cache/sources/ffmpeg-wasm/LICENSE" "$output/notices/ffmpeg-wasm-MIT.txt"
cp "$package_root/.cache/sources/ffmpeg-wasm/LICENSE" "$output/notices/ffmpeg-wrapper-MIT.txt"
cp "$docker_output/emscripten-LICENSE.txt" "$output/notices/Emscripten-MIT.txt"
bash "$package_root/scripts/package-source.sh"
node "$package_root/scripts/generate-manifest.mjs"
node "$package_root/scripts/verify-artifacts.mjs"
node "$package_root/scripts/package-release.mjs"

echo "Built FFmpeg runtime $core_version in $output"
