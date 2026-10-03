#!/bin/bash
set -euo pipefail

package_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$package_root/.."

test_media=0
if [[ "$#" == 1 && "$1" == --media ]]; then
    test_media=1
elif [[ "$#" != 0 ]]; then
    echo "Usage: $0 [--media]" >&2
    exit 2
fi

test_root="$package_root/.cache/build/native-wasm-test"
rm -rf -- "$test_root"
mkdir -p "$test_root/fixtures"
trap 'rm -rf -- "$test_root"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ "$test_media" == 1 ]]; then
    bash "$package_root/tests/wasm/generate-fixtures.sh" "$test_root/fixtures"
fi

node "$package_root/scripts/prepare-sources.mjs"
node "$package_root/scripts/generate-build-inputs.mjs"
pnpm --filter @project/ffmpeg exec esbuild "$package_root/src/native.ts" \
    --bundle --format=esm --platform=node --target=es2022 \
    --outfile="$test_root/native-bridge.mjs"

docker_arguments=()
while IFS= read -r argument; do
    docker_arguments+=(--build-arg "$argument")
done < "$package_root/.cache/build/docker-build-args"
build_platform="$(<"$package_root/.cache/build/platform")"
runtime_version="$(node -p "require('$package_root/package.json').version")"
ffmpeg_version="$(node -p "require('$package_root/build-config.json').ffmpeg.version")"

docker buildx build \
    --platform "$build_platform" \
    --target wasm-test \
    --build-arg "ASB_TEST_MEDIA=$test_media" \
    --build-arg "ASB_RUNTIME_VERSION=$runtime_version" \
    --build-arg "ASB_FFMPEG_VERSION=$ffmpeg_version" \
    "${docker_arguments[@]}" \
    --output type=cacheonly \
    "$package_root"

echo "Docker C++ and WASM tests passed for asbplayer $runtime_version with FFmpeg $ffmpeg_version"
