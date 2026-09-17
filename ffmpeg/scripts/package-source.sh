#!/bin/bash
set -euo pipefail

package_root="$(cd "$(dirname "$0")/.." && pwd)"
repository_root="$(cd "$package_root/.." && pwd)"
source_integration_root="$repository_root"
if [[ ! -f "$source_integration_root/client/src/services/ffmpeg.ts" ]]; then
    source_integration_root="$repository_root/integration"
fi
runtime_version="$(node -p "require('$package_root/package.json').version")"
stage_root="$package_root/.cache/source-package/asbplayer-ffmpeg-$runtime_version-source"
stage_package="$stage_root/ffmpeg"
release="$package_root/release"

rm -rf "$stage_root"
mkdir -p "$stage_package/.cache/sources" "$stage_root/integration/client/src/services" \
    "$stage_root/integration/common/components" "$release"
cp "$package_root/source-yarn.lock" "$stage_root/yarn.lock"
cp -R "$package_root/native" "$package_root/src" "$package_root/scripts" "$package_root/tests" \
    "$stage_package/"
cp "$package_root/Dockerfile" "$package_root/.dockerignore" "$package_root/README.md" "$package_root/package.json" \
    "$package_root/build-config.json" "$package_root/source-yarn.lock" \
    "$package_root/jest.config.cjs" "$package_root/tsconfig.json" "$package_root/tsconfig.eslint.json" \
    "$package_root/.clang-format" "$stage_package/"
cp "$repository_root/LICENSE.md" "$stage_root/"
node "$package_root/scripts/prepare-standalone-workspaces.mjs" "$stage_root"
cp -R "$package_root/.cache/sources/ffmpeg" "$stage_package/.cache/sources/ffmpeg"
touch "$stage_package/.cache/sources/ffmpeg/.asb-bundled-source"

cp "$source_integration_root/client/package.json" "$source_integration_root/client/vite.config.ts" \
    "$stage_root/integration/client/"
cp "$source_integration_root/client/src/services/ffmpeg.ts" "$stage_root/integration/client/src/services/"
cp "$source_integration_root/common/package.json" "$stage_root/integration/common/"
cp "$source_integration_root/common/components/About.tsx" "$stage_root/integration/common/components/"

archive="$release/asbplayer-ffmpeg-$runtime_version-source.tar.xz"
bash "$package_root/scripts/package-archive.sh" \
    "$archive" "$(dirname "$stage_root")" "$(basename "$stage_root")" xz
echo "$archive"
