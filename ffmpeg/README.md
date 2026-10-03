# asbplayer FFmpeg runtime

This workspace builds an optional, independently versioned FFmpeg dependency for the webapp/PWA. It currently exposes runtime inspection and links only `libavutil`. Media features should add the FFmpeg components, typed worker operations, native IO, and real-WASM tests they need.

## Ordinary app development

Use the repository's Node and pnpm versions. From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @project/client run start
```

Client startup and builds automatically fetch and verify the runtime selected by `ffmpeg/artifact-lock.json`. Valid local artifacts are reused, including offline. Docker and an FFmpeg build are only needed when developing FFmpeg itself. Extension development does not need runtime preparation.

## FFmpeg feature development

Install the repository dependencies and have Docker with buildx available, then run:

```sh
pnpm --filter @project/ffmpeg run build:candidate
VITE_FFMPEG_CANDIDATE=1 pnpm --filter @project/client run start
```

The build command builds the native runtime and worker, packages the corresponding source, and verifies the candidate. It downloads hash-verified upstream source and uses the pinned Emscripten container; no host C++ or Emscripten toolchain is required. The second command starts the client against the local candidate.

Candidate builds use the version in `ffmpeg/package.json` and the current `build-config.json`. They leave `artifact-lock.json` untouched. After changing native code, the worker, or build inputs, rebuild and restart the client so it receives the rebuilt assets and matching hashes. Ordinary client changes use Vite's hot reload.

To create a client build for testing the candidate, including its PWA behavior:

```sh
VITE_FFMPEG_CANDIDATE=1 pnpm --filter @project/client run buildFast
VITE_FFMPEG_CANDIDATE=1 pnpm --filter @project/client run preview
```

Candidate client startup/builds verify the local candidate instead of fetching a release. Use normal client commands to return to the selected release.

## Verification

Run commands from the repository root:

| Command                                            | Checks                                                                                                                                                 |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm run verify`                                  | App checks and FFmpeg tests, TypeScript, lint, and formatting; no Docker                                                                               |
| `pnpm --filter @project/ffmpeg run verify:code`    | FFmpeg tests, TypeScript, lint, and formatting                                                                                                         |
| `pnpm --filter @project/ffmpeg run verify:release` | Code checks, candidate/source verification, native/WASM tests, and a clean rebuild from the corresponding source with byte-for-byte release comparison |

The FFmpeg package's `build:candidate` command validates the generated candidate. For native C++ tests and a real-WASM smoke test, run `pnpm run test:native-wasm` from `ffmpeg/`. The full release check requires a candidate to exist and is separate so normal development does not repeat the clean reproduction build.

Pull-request CI checks the host code and runs native tests when native build inputs change. The manual **Release FFmpeg** workflow runs the full release check before publishing.

## Publishing and selecting a runtime

Native code, emitted worker code, build configuration/toolchain, and runtime API changes need a matching release before they merge. App-only integration, tests, and documentation generally do not. For a series of FFmpeg changes, publish once from the final combined source and select that release in the PR that brings it to `main`.

1. Choose an unreleased version in `ffmpeg/package.json`.
2. Build/test locally as needed, then commit and push the final source.
3. Run **Release FFmpeg** for that branch. It builds and checks the candidate, then publishes `ffmpeg-v<version>` with the runtime archive, corresponding source, manifest, and checksums.
4. Run `pnpm run select:runtime` from `ffmpeg/`. This downloads and verifies the published release for the package version and writes `artifact-lock.json`.
5. Review and commit the lock change. Normal client commands now consume the selected release.

Published versions are immutable. Any change to published runtime bytes or capabilities needs a new version. Selection verifies published assets rather than relying on local candidate files.

Each app deployment includes only its selected runtime. Deploying a newer runtime retires the previous hosted version. An old app with its complete runtime cached can continue using it offline; an uncached old app is asked to update when its runtime is no longer hosted.

## Browser integration

Use `createWebFfmpegSession` from `client/src/services/ffmpeg.ts`. Create a session for the lifetime of the feature that owns it:

```ts
const owner = new AbortController();
const session = createWebFfmpegSession({
    signal: owner.signal,
    onDownloadProgress: setDownloadProgress,
});
// Wire the feature's Cancel action to owner.abort().
try {
    const runtime = await session.load();
    const info = await runtime.inspect();
    // Use the runtime within this feature's lifetime.
} finally {
    session.dispose();
}
```

The first load downloads and SHA-256 verifies the worker, core module, and WASM. Later sessions trust cached responses with matching verification markers. Sessions execute Blob URLs created from the verified bytes, including before service-worker control or when persistent storage is unavailable. A Content Security Policy must allow Blob workers, module imports, and WASM fetches.

The owner's signal or `dispose()` stops shared downloads and terminates the worker, including synchronous native work. Disposal/failure releases executable URLs. Create a fresh session to retry. A signal passed to `load({ signal })` or `inspect({ signal })` cancels only that caller's wait. Initialization has no timeout.

`onDownloadProgress` reports uncompressed downloaded/total bytes, average speed, ETA, and downloading/verifying/complete stages. Reused cache bytes count toward completion but not speed. `common/app/components/FfmpegDownloadProgress.tsx` renders these metrics. Media-processing progress belongs to the feature introducing that operation.

`createInputReader(fileOrBlob)` provides synchronous worker-side random access through bounded slices, with a 64 KiB default maximum per read. It preserves safe integer offsets above 4 GiB, clips reads at EOF, and rejects invalid ranges without copying the entire file into WASM. Native IO adapters, codecs, and job queues belong to future features that need them.

## Offline use and app updates

The app works offline without FFmpeg. FFmpeg works offline after its complete runtime is cached, subject to browser storage limits. First installation needs a connection. Storage failures allow online execution of verified bytes without an offline cache.

If FFmpeg was installed, an app update selecting a different runtime downloads and verifies its replacement before retiring the old cache. The old app/runtime stays usable while the update waits or if preparation fails. Acceptance checks again because FFmpeg can be installed while an update waits. An unchanged runtime is reused without downloading or hashing it again; unused FFmpeg stays lazy. Accepted updates reload all open app tabs.

Missing runtime assets reject initialization with `FfmpegUpdateRequiredError`, a localized request to update the app. Offline and temporary server errors are reported separately. The service worker manages replacement/retirement; sessions read the executable cache directly.

## Corresponding source and licensing

The source archive contains the pinned FFmpeg source, native bridge, worker/client source, tests, container recipe, lockfiles, and rebuild scripts. From an extracted archive, with Docker/buildx available:

```sh
corepack enable
pnpm install --frozen-lockfile
cd ffmpeg
pnpm run build:candidate
```

This command builds the runtime/worker, packages the corresponding source, and verifies the candidate, just as it does in the repository.

The runtime combines asbplayer's AGPL-3.0-or-later native bridge and worker with LGPL-2.1-or-later FFmpeg. Releases include the asbplayer, FFmpeg, and related notices. Verification rejects GPL, nonfree, version-3, network, or threaded builds but may be allowed if a specific need arises.
