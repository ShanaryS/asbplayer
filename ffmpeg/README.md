# asbplayer FFmpeg runtime

This workspace owns the separately versioned, single-threaded LGPL FFmpeg CLI runtime used by asbplayer. Version `0.1.0` is an infrastructure skeleton: it supports CLI diagnostics and WORKERFS, but deliberately enables no codecs, formats, parsers, filters, bitstream filters, or protocols.

## Preparing the runtime

Normal application builds do not compile or download native code. Prepare the exact published binary and corresponding source with:

```sh
yarn fetch:ffmpeg
yarn verify:ffmpeg
```

To rebuild after changing a pin, configuration, patch, binding, or wrapper, install Docker with buildx and run:

```sh
yarn build:ffmpeg
```

The build verifies the source archive hashes in `versions.json`, uses the pinned Emscripten container, emits `dist/0.1.0`, and creates deterministic release archives under `release/`. Generated files are ignored. Never edit or publish a generated runtime under an existing core version.

### Rebuilding from the corresponding-source archive

Extract the archive beside a clean checkout of the asbplayer revision that selected this core. Replace that checkout's `ffmpeg/` directory with the archive's `asbplayer/` directory, then restore the bundled upstream trees before building:

```sh
mkdir -p ffmpeg/.cache/sources
cp -R ../asbplayer-ffmpeg-0.1.0-source/upstream/FFmpeg-5.1.4 ffmpeg/.cache/sources/ffmpeg
cp -R ../asbplayer-ffmpeg-0.1.0-source/upstream/ffmpeg.wasm-0.12.15 ffmpeg/.cache/sources/ffmpeg-wasm
yarn install --immutable
yarn build:ffmpeg
```

`build-environment/` preserves the repository package manifest and Yarn lockfile used for the published build. Compare the generated archives with `artifact-lock.json`, or run `yarn workspace @project/ffmpeg verify:reproducible` to perform two builds and compare them automatically. A modified LGPL core follows the same route after incrementing `coreVersion` and updating its hashes.

## Replacing the core

To test a modified LGPL core, change the source or build recipe, increment `coreVersion`, rebuild, and update the checked-in artifact lock with the generated hashes. The website serves that version from its configured `/ffmpeg/` asset base; an unpacked extension packages the same bytes and resolves them with `browser.runtime.getURL`. This is the supported relinking/replacement route; no remotely hosted executable fallback is used.

`capabilities.json` is the reviewed allowlist. Every future media component must name its consumer and regression fixture and must ship as a new core version with updated source, notices, size measurements, and browser coverage.

## Licenses and source

asbplayer integration code and `@ffmpeg/ffmpeg` are MIT licensed. The compiled FFmpeg core is LGPL-2.1-or-later. Runtime notices are copied into both products, and the exact corresponding-source archive is published beside every runtime archive.
