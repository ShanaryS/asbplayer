# asbplayer FFmpeg runtime

This workspace builds an independently versioned FFmpeg dependency for the webapp/PWA. The browser loads a versioned module worker lazily. The worker loads a single-threaded WebAssembly module and exposes runtime inspection so asbplayer can verify the selected build.

The foundation intentionally contains no media processing. It links only FFmpeg's `libavutil`; it has no codecs, containers, filters, network protocols, devices, or arbitrary command interface. FFmpeg's `--disable-everything` configuration enables `libavutil` as its base library, so the build does not explicitly enable it. Future feature work should add only the FFmpeg components, typed worker operation, app integration, and production-WASM checks that capability requires.

`ffmpeg/package.json` owns the candidate version currently being developed. `artifact-lock.json` selects the released runtime consumed by normal asbplayer builds. Candidate builds use the package version; app builds and runtime metadata use the artifact lock. This lets normal app development keep using a released runtime while an FFmpeg candidate changes independently. Runtime assets are immutable at `/ffmpeg/${runtimeVersion}/`; the PWA caches those URLs on first use without adding the runtime to its startup download.

## Development and verification

Pull-request CI runs the FFmpeg TypeScript tests and compile checks, followed by the app tests, extension build, and client build. The native verification workflow always reports a stable `native-gate` check on pull requests; configure branch protection to require this check. It detects changes to the native build inputs inside the workflow and runs `yarn verify:ffmpeg:native` only when those paths change; the gate passes when tests are unnecessary and fails when required tests fail. This command runs all native C++ test files and a real-WASM runtime smoke test through Docker using the pinned Emscripten image; it does not require a host C++ or Emscripten toolchain. `yarn verify:ffmpeg:code` is the host-only TypeScript, lint, and format layer. Root `yarn verify` includes this lightweight layer but not the Docker tests. The release check runs both native and host layers, candidate artifact verification, and reproducibility verification. It has no browser-test harness.

From the repository root, the Docker-only native test command is:

```sh
yarn workspace @project/ffmpeg test:native
```

The root workspace also exposes it as `yarn verify:ffmpeg:native`. The standalone corresponding-source archive retains the workspace command.

From the repository root, fetch and verify the selected runtime with:

```sh
yarn fetch:ffmpeg
yarn verify:ffmpeg:frozen
```

Fetching installs only the selected runtime archive. `yarn verify:ffmpeg:frozen` verifies that runtime against the lock file and does not require the corresponding source archive. Source verification is available separately with `yarn workspace @project/ffmpeg verify:frozen:source` when the source archive is present.

To build and validate the current candidate locally:

```sh
yarn build:ffmpeg
```

`build:ffmpeg` requires Docker buildx and downloads the hash-verified FFmpeg source archive. Candidate verification compares the output with the current package and build configuration. Frozen-runtime verification instead checks the selected artifact's recorded identity, manifest and hashes; it does not compare a selected older runtime with the candidate's current build configuration.

## Release and runtime selection

Run the manual FFmpeg workflow to build, package, verify, and upload a candidate. The FFmpeg release workflow repeats full verification and publishes the runtime and exact corresponding source under the candidate's versioned release. After publication, select that released runtime for asbplayer by running:

```sh
yarn release:ffmpeg
```

The selector downloads the runtime archive, corresponding source archive, manifest, and `SHA256SUMS` from the release, then verifies their hashes and contents before writing `artifact-lock.json`. It does not use local candidate files or a local download cache. Seed the initial lock from the published assets manually; after selection, different bytes require a new version. Keep published runtime directories and source archives indefinitely; any byte or capability change after publication requires a new version.

The source archive contains the pinned FFmpeg source, native bridge, TypeScript worker/client, tests, container recipe, lockfiles, and rebuild instructions. From an extracted archive:

```sh
corepack enable
yarn install --immutable
yarn build:ffmpeg
```

## Licensing

The runtime is distributed under LGPL-2.1-or-later terms. The release includes FFmpeg, Emscripten, and libc++ notices. Verification checks the configured FFmpeg license and rejects GPL, nonfree, version-3, network, or threaded builds.
