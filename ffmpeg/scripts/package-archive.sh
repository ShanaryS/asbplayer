#!/bin/bash
set -euo pipefail

if [[ "$#" -ne 4 || ("$4" != "gz" && "$4" != "xz") ]]; then
    echo "Usage: $0 ARCHIVE DIRECTORY ENTRY (gz|xz)" >&2
    exit 2
fi

package_root="$(cd "$(dirname "$0")/.." && pwd)"
repository_root="$(cd "$package_root/.." && pwd)"
archive="$1"
directory="$2"
entry="$3"
compression="$4"

container_path() {
    local path="$1"
    case "$path" in
        "$repository_root"/*) echo "/workspace/${path#"$repository_root"/}" ;;
        *)
            echo "Path must be inside the repository: $path" >&2
            exit 2
            ;;
    esac
}

case "$compression" in
    gz) tar_compression='-czf' ;;
    xz) tar_compression='-cJf' ;;
esac

packaging_image="$(node -p "require('$package_root/build-config.json').toolchain.container")"
packaging_platform="$(node -p "require('$package_root/build-config.json').toolchain.platform")"
archive_in_container="$(container_path "$archive")"
directory_in_container="$(container_path "$directory")"

# The image is digest-pinned in build-config.json, so tar and its compressors
# are fixed together with the Emscripten toolchain used to build the runtime.
docker run --rm --platform "$packaging_platform" \
    --volume "$repository_root:/workspace" \
    "$packaging_image" \
    tar --sort=name --mtime='UTC 2020-01-01' --owner=0 --group=0 --numeric-owner \
        --mode='a+rX,u+w,go-w' \
        "$tar_compression" "$archive_in_container" \
        -C "$directory_in_container" "$entry"
