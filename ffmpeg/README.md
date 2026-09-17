# asbplayer FFmpeg runtime

This workspace builds an independently versioned FFmpeg dependency for the webapp/PWA. The browser loads a versioned module worker lazily. The worker loads a single-threaded WebAssembly module and exposes runtime inspection so asbplayer can verify the selected build.

The runtime intentionally contains only the media processing needed by asbplayer. It links FFmpeg's `libavutil`, `libavcodec`, `libavformat`, and `libswresample`, with AC-3, E-AC-3, DTS, TrueHD, and MLP decoders plus an AAC encoder. It has no filters, network protocols, devices, or arbitrary command interface. The typed worker API exposes runtime inspection and audio transcoding to an MP4/AAC output.

`ffmpeg/package.json` owns the candidate version being developed. `artifact-lock.json` selects the released runtime consumed by normal asbplayer builds. Candidate builds use the package version; normal app builds use the locked release. This lets application development use a published runtime while FFmpeg development proceeds independently. Runtime assets are immutable at `/ffmpeg/${runtimeVersion}/`; the PWA caches those URLs on first use without adding the runtime to its startup download.

## Normal application development

Contributors who are not changing FFmpeg do not need Docker or an FFmpeg build. After installing dependencies, fetch the runtime selected by `artifact-lock.json`:

```sh
yarn install --immutable
yarn fetch:ffmpeg:runtime
yarn verify:ffmpeg:locked
yarn workspace @project/client start
```

The local client build does not fetch the runtime automatically. It verifies that the locked runtime is present in `ffmpeg/dist/<runtime version>` and then copies it into the client build. Pull-request CI performs the fetch automatically before building the client.

## Development and verification

Pull-request CI runs the FFmpeg TypeScript tests and compile checks, followed by the app tests, extension build, and client build. The native verification workflow always reports a stable `native-gate` check on pull requests. It detects changes to the native build inputs inside the workflow and runs `yarn verify:ffmpeg:native-wasm` only when those paths change; the gate passes when tests are unnecessary and fails when required tests fail. This command runs all native C++ test files and a real-WASM runtime smoke test through Docker using the pinned Emscripten image; it does not require a host C++ or Emscripten toolchain. `yarn verify:ffmpeg:code` is the host-only TypeScript, lint, and format layer. Root `yarn verify` includes this lightweight layer but not the Docker tests. The release check runs both native and host layers, candidate artifact verification, and reproducibility verification.

From the repository root, the Docker-only native test command is:

```sh
yarn verify:ffmpeg:native-wasm
```

The standalone corresponding-source archive retains the lower-level `test:native-wasm` workspace command.

To build the client against an unpublished local FFmpeg candidate, build and verify the candidate, then set `VITE_FFMPEG_CANDIDATE=1` on the client build:

```sh
yarn build:ffmpeg:candidate
VITE_FFMPEG_CANDIDATE=1 yarn workspace @project/client buildFast
```

Candidate mode verifies `ffmpeg/dist/<runtime version>` against the candidate manifest and does not read or modify `artifact-lock.json`. Use the default client build after a runtime has been published and selected into the lock.

From the repository root, fetch and verify the selected runtime with:

```sh
yarn fetch:ffmpeg:runtime
yarn verify:ffmpeg:locked
```

Fetching installs only the selected runtime archive. `yarn verify:ffmpeg:locked` verifies that runtime against the lock file and does not require the corresponding source archive. Source verification is available separately with `yarn workspace @project/ffmpeg verify:locked:source` when the source archive is present.

`build:ffmpeg:candidate` requires Docker buildx and downloads the hash-verified FFmpeg source archive. Candidate verification compares the output with the current package and build configuration. Locked-runtime verification instead checks the selected artifact's recorded identity, manifest and hashes; it does not compare a selected older runtime with the candidate's current build configuration.

## FFmpeg runtime changes and release

The selected runtime is cryptographically locked by `artifact-lock.json`, but the lock does not automatically prove that the current source tree is compatible with it. Before merging an FFmpeg change, manually check whether the change affects the published runtime: native code, FFmpeg/build configuration, the Docker build, the worker/native bridge, runtime-facing protocol code, build scripts, or FFmpeg build dependencies.

Changes that are purely application-side, tests, or documentation generally do not require a new runtime. When uncertain, treat a change as runtime-affecting and ask for a release review rather than merging source and the selected runtime out of sync.

### Multiple FFmpeg pull requests

Do not publish one FFmpeg runtime for every intermediate pull request when several runtime changes are being developed together. Stack the pull requests or combine them on an integration branch, and publish one runtime from the final combined source state. Update `artifact-lock.json` in the pull request that brings that matching state to `main`.

If an FFmpeg pull request must merge independently, it needs its own matching runtime release before merge. Otherwise the source/runtime relationship is intentionally broken:

```text
source on main = new runtime inputs
selected runtime = older runtime inputs
```

### Release and runtime selection

If the runtime-affecting inputs have changed, the source state entering `main` must have a matching published runtime.

1. Bump `version` in `ffmpeg/package.json`.
2. Optionally run `yarn build:ffmpeg:candidate` locally to validate the candidate. This requires Docker buildx and may be done before committing.
3. Commit and push the changes to the branch.
4. Run the manual **Release FFmpeg** workflow for that branch. It reads the version from `ffmpeg/package.json`, builds and verifies a fresh candidate, and publishes `ffmpeg-v<version>` with the runtime archive, exact corresponding source archive, manifest, and checksums. It fails if that release or tag already exists.
5. After publication, run `yarn select:ffmpeg:runtime`. This downloads and verifies the published assets, writes `artifact-lock.json`, and does not use local candidate files. Review and commit the lock-file change.

Published runtime directories and source archives are immutable. Any byte or capability change after publication requires a new runtime version.

The source archive contains the pinned FFmpeg source, native bridge, TypeScript worker/client, tests, container recipe, lockfiles, and rebuild instructions. From an extracted archive:

```sh
corepack enable
yarn install --immutable
yarn build:ffmpeg
```

## Licensing

The runtime combines asbplayer's MIT-licensed native bridge and worker with the LGPL-2.1-or-later FFmpeg runtime. The release includes the asbplayer, FFmpeg, Emscripten, musl, compiler-rt, libc++, and libc++abi notices. The corresponding-source archive includes the repository `LICENSE.md`. Verification checks the configured FFmpeg license and rejects GPL, nonfree, version-3, network, or threaded builds.
