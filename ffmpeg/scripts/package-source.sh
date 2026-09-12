#!/bin/bash
set -euo pipefail

package_root="$(cd "$(dirname "$0")/.." && pwd)"
repository_root="$(cd "$package_root/.." && pwd)"
core_version="$(node -p "require('$package_root/versions.json').coreVersion")"
ffmpeg_version="$(node -p "require('$package_root/versions.json').ffmpegVersion")"
wrapper_version="$(node -p "require('$package_root/versions.json').wrapperVersion")"
stage="$package_root/.cache/source-package/asbplayer-ffmpeg-$core_version-source"
release="$package_root/release"

rm -rf "$stage"
mkdir -p "$stage/upstream" "$stage/asbplayer" "$stage/build-environment"
cp -R "$package_root/.cache/sources/ffmpeg" "$stage/upstream/FFmpeg-$ffmpeg_version"
cp -R "$package_root/.cache/sources/ffmpeg-wasm" "$stage/upstream/ffmpeg.wasm-$wrapper_version"
cp -R "$package_root/scripts" "$package_root/src" "$package_root/tests" "$package_root/patches" "$stage/asbplayer/"
cp "$package_root/Dockerfile" "$package_root/README.md" "$package_root/package.json" \
    "$package_root/versions.json" "$package_root/capabilities.json" "$package_root/jest.config.cjs" \
    "$package_root/tsconfig.json" "$package_root/tsconfig.eslint.json" "$stage/asbplayer/"
cp "$repository_root/package.json" "$repository_root/yarn.lock" "$stage/build-environment/"
mkdir -p "$stage/asbplayer/integration/client/src/services" \
    "$stage/asbplayer/integration/common/components" \
    "$stage/asbplayer/integration/extension/src/services" \
    "$stage/asbplayer/integration/.github/workflows"
cp "$repository_root/client/src/services/ffmpeg.ts" "$stage/asbplayer/integration/client/src/services/"
cp "$repository_root/client/vite.config.ts" "$stage/asbplayer/integration/client/"
cp "$repository_root/common/components/About.tsx" "$stage/asbplayer/integration/common/components/"
cp "$repository_root/extension/src/services/ffmpeg.ts" "$stage/asbplayer/integration/extension/src/services/"
cp "$repository_root/extension/wxt.config.ts" "$stage/asbplayer/integration/extension/"
cp "$repository_root/.github/workflows/ffmpeg-build.yml" \
    "$repository_root/.github/workflows/ffmpeg-release.yml" \
    "$stage/asbplayer/integration/.github/workflows/"

mkdir -p "$release"
archive="$release/asbplayer-ffmpeg-$core_version-source.tar.xz"
tar --sort=name --mtime='UTC 2020-01-01' --owner=0 --group=0 --numeric-owner \
    -cJf "$archive" -C "$(dirname "$stage")" "$(basename "$stage")"
echo "$archive"
