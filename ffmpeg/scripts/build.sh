#!/bin/bash
set -euo pipefail

package_root="$(cd "$(dirname "$0")/.." && pwd)"
runtime_version="$(node -p "require('$package_root/package.json').version")"
output="$package_root/dist/$runtime_version"
docker_output="$package_root/.cache/docker-output"

node "$package_root/scripts/prepare-sources.mjs"
node "$package_root/scripts/generate-configure-args.mjs"
node "$package_root/scripts/generate-build-inputs.mjs"
rm -rf "$docker_output" "$output"
mkdir -p "$docker_output" "$output/notices"

docker_arguments=()
while IFS= read -r argument; do
    docker_arguments+=(--build-arg "$argument")
done < "$package_root/.cache/build/docker-build-args"
build_platform="$(<"$package_root/.cache/build/platform")"
if [[ "${ASB_FFMPEG_NO_CACHE:-0}" == "1" ]]; then
    docker_arguments+=(--no-cache)
fi
docker buildx build \
    --platform "$build_platform" \
    "${docker_arguments[@]}" \
    --output "type=local,dest=$docker_output" \
    "$package_root"

cp "$docker_output/ffmpeg-core.js" "$docker_output/ffmpeg-core.wasm" "$output/"
yarn workspace @project/ffmpeg exec esbuild "$package_root/src/worker.ts" \
    --bundle --format=esm --platform=browser --target=es2022 \
    --outfile="$output/ffmpeg-worker.js"

cp "$package_root/.cache/sources/ffmpeg/COPYING.LGPLv2.1" "$output/notices/FFmpeg-LGPL-2.1.txt"
cp "$docker_output/notices/Emscripten-MIT.txt" "$output/notices/"
cp "$docker_output/notices/libcxx-Apache-2.0.txt" "$output/notices/"

echo "Built FFmpeg runtime $runtime_version in $output"
