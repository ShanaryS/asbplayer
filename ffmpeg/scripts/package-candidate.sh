#!/bin/bash
set -euo pipefail

package_root="$(cd "$(dirname "$0")/.." && pwd)"

bash "$package_root/scripts/package-source.sh"
node "$package_root/scripts/generate-manifest.mjs"
node "$package_root/scripts/package-release.mjs"

echo "Packaged FFmpeg release candidate"
