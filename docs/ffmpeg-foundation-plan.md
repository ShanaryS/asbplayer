**FFmpeg foundation PR: implementation plan**

Prepared 2026-09-12 against local commit `21b911a01` and [PR #1111](https://github.com/asbplayer/asbplayer/pull/1111), head `d9c31f7f76e17c6904252be95dcf813a86d202d9`. Updated with the subsequent architecture/toolchain discussion: start with the existing ffmpeg.wasm CLI wrapper and an asbplayer-built minimal core. Direct C/C++ integration is a future option requiring an explicit, measured motivation. This document specifies implementation work; no WASM build, size comparison, or browser compatibility test has been performed for this plan.

**1. Result and scope**

Merge one foundation PR that supplies a reproducible, separately versioned LGPL FFmpeg CLI runtime to the website and all extension builds. Its first release, `0.1.0`, contains the existing CLI and the infrastructure needed to load it, run diagnostic commands, mount browser files in a worker, and release its resources. It contains **zero media codecs, demuxers, muxers, parsers, media filters, bitstream filters, or FFmpeg protocols**. The CLI's required library/framework code remains; an empty component allowlist does not mean a `libavutil`-only binary.

The skeleton is the deliberate infrastructure exception to the “only compile what we use” rule. Its behavior is exercised by integration tests, without inventing a user feature to justify an encoder. Every later media capability must arrive with its actual consumer, behavioral coverage, corresponding source, and measured size change in the same feature PR. Necessary internal dependencies count as used; speculative formats and fallback encoders do not.

This PR adds no audio conversion prompt, media probing, playback changes, mining changes, output encoder, worker pool, alternate core profile, native helper, or generic `MediaProcessor` hierarchy. The visible product change is FFmpeg attribution and source access in About. Opening About must not initialize FFmpeg.

The foundation does not close the media issues listed in the research. It gives #1111 and subsequent feature PRs a shared dependency on which to build those solutions.

**2. Architecture decision**

Use the existing MIT `@ffmpeg/ffmpeg` JavaScript wrapper and its worker, backed by an asbplayer-built minimal LGPL core containing the existing FFmpeg CLI. Place the build and thin TypeScript integration in a new top-level `ffmpeg/` Yarn workspace named `@project/ffmpeg`. We maintain the build recipe and integration; we do not write a CLI or an application-specific C/C++ media pipeline in this PR.

| Question            | Decision                                                                                                         |
| ------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Package location    | `ffmpeg/`, imported as `@project/ffmpeg`; no duplicate facade in `common/ffmpeg`                                 |
| Ownership           | Package owns source pins, compilation, wrapper/core packaging, lifecycle helpers, artifact metadata, and notices |
| Shared consumers    | `common`, `client`, and `extension` declare workspace dependencies wherever they directly import it              |
| FFmpeg interface    | Existing `FFmpeg.load`, `exec`, filesystem, log/progress, and termination APIs                                   |
| Initial native code | Upstream FFmpeg CLI, ffmpeg.wasm bindings, and their required library infrastructure; no media components        |
| Runtime model       | One independent dedicated Web Worker per session; one session used by a consumer initially                       |
| Distribution        | Same runtime files copied unchanged into website and extension outputs                                           |
| Media policy        | One production core, built from the union of capabilities used by the application                                |

`plugins/` currently contains the external Anki plugin; FFmpeg is an internal dependency. A top-level workspace follows the existing `@project/*` import convention and avoids tying it to `common/audio-transcode`.

The integration is:

```text
asbplayer TypeScript feature
    → @project/ffmpeg lifecycle/asset helpers
    → @ffmpeg/ffmpeg wrapper and worker
    → our ffmpeg-core.wasm: upstream CLI + enabled FFmpeg components
```

The wrapper and compiled core are separate components. Reuse the wrapper; replace the stock broad/GPL core with our verified LGPL build. Custom cores are an intended upstream integration path. [ffmpeg.wasm architecture](https://ffmpegwasm.netlify.app/docs/overview/#architecture), [wrapper/core licensing](https://ffmpegwasm.netlify.app/docs/faq/#what-is-the-license-of-ffmpegwasm)

This accepts ffmpeg.wasm's source/toolchain compatibility constraints. The inspected upstream build pins FFmpeg `n5.1.4` and documents a CLI threading obstacle to upgrading. Pin a tested wrapper/bindings/FFmpeg/toolchain combination, examine the selected FFmpeg revision's maintenance/security status, and record any required backports. Do not assume a current upstream FFmpeg release can replace that fork without porting work. An inability to maintain the chosen revision is one explicit reason to revisit the backend. [ffmpeg.wasm build](https://github.com/ffmpegwasm/ffmpeg.wasm/blob/main/Dockerfile)

**#1111 can retain its command-based transcoding implementation after rebase.** Move dependency ownership, loading, asset URLs, caching, and worker lifecycle into the shared package, and adapt its commands to the components deliberately enabled by that feature PR. Keep its `transcodeAudioTrack` contract, probing, UI, synchronization, and mining integration. Future features normally add TypeScript commands and required build components. The C/C++ reference design is retained in section 12, with no second backend or abstraction hierarchy implemented now.

Neither the first summary's broad audio/container allowlist nor the second summary's AAC transcoder belongs in the foundation. The reported 4–6 MB sizes describe other configurations and are not a size prediction for this skeleton.

**3. Files and package boundary**

Proposed layout, with generated directories ignored by Git:

```text
ffmpeg/
  package.json
  README.md                    build, development, replacement, and release instructions
  versions.json                exact source and toolchain pins
  capabilities.json            explicit enabled components and their consumers
  artifact-lock.json           selected published runtime, source URLs, and hashes
  Dockerfile
  scripts/
    build.sh                   compile and stage a complete artifact set
    fetch.mjs                  obtain an already published, hash-pinned artifact
    verify-artifacts.mjs       provenance, license, capabilities, and sizes
    package-source.sh
  patches/
  src/
    index.ts                   public client/types, with no eager runtime import
    session.ts                 load/exec lifecycle around the upstream wrapper
    files.ts                   WORKERFS mount/unmount and cleanup helpers
    metadata.ts                small generated/validated consumer metadata
  tests/                       browser and artifact integration tests
  dist/0.1.0/                  ignored runtime output
  release/                     ignored binary/source archives and reports
  .cache/                      ignored source/toolchain build cache

client/src/services/ffmpeg.ts   web URLs and on-demand asset caching
extension/src/services/ffmpeg.ts
                               extension-local URLs and session factory
```

Extend the root workspace list, verification/lint/format paths, ESLint TypeScript projects, and package test/typecheck configuration to cover `ffmpeg/`. Exclude generated glue, archives, and build caches from ordinary source linting. Use the existing localization workflow for the few About/source strings.

The runtime artifact contains `ffmpeg-wrapper.js`, `ffmpeg-worker.js`, `ffmpeg-core.js`, `ffmpeg-core.wasm`, `manifest.json`, and a notices/license directory. During `build:ffmpeg`, bundle the pinned upstream wrapper entry and worker entry as two standalone browser ESM files, using a pinned JS bundler. This packages existing upstream implementation; there is no asbplayer worker protocol to maintain. Include the wrapper dependency in the FFmpeg workspace and its exact version in the lockfile/source archive.

Use the wrapper's explicit `classWorkerURL`, `coreURL`, and `wasmURL` load options. `classWorkerURL` selects the wrapper's module worker; it is distinct from `workerURL`, which the multithread core uses for a pthread worker. Emit matching ESM core glue. Always supply our URLs, so the default CDN location/default worker path is unused. Consumer bundlers copy the complete versioned artifact without rewriting it or emitting another unused default worker. Verify module-worker execution on the supported browser targets. [Upstream loader](https://github.com/ffmpegwasm/ffmpeg.wasm/blob/main/packages/ffmpeg/src/classes.ts), [upstream worker](https://github.com/ffmpegwasm/ffmpeg.wasm/blob/main/packages/ffmpeg/src/worker.ts)

Only our small TypeScript helpers and metadata participate in normal application bundling. Dynamically import the versioned wrapper URL on demand, leaving it as an external asset import for Vite/WXT. The wrapper then loads its packaged worker/core. Do not statically import the wrapper or generated glue from About, shared barrels, or application startup. This keeps all executable FFmpeg assets under the directory excluded from PWA precaching.

**4. Build and provenance**

Expose these explicit commands:

```sh
yarn build:ffmpeg               # compile locally using the pinned container/toolchain
yarn fetch:ffmpeg               # download and verify the pinned published artifact
yarn verify:ffmpeg              # inspect artifacts and run foundation checks
```

Normal Vite/WXT builds validate and copy an existing artifact; they never invoke a C compiler or silently download a replacement. If it is absent or stale, fail with the two preparation commands. `fetch:ffmpeg` obtains the runtime and corresponding-source archives, verifying both, so a normal website release can stage the source alongside the binary. `yarn install` and WXT's `postinstall` preparation must still work before an artifact exists: declare known public paths from metadata instead of reading a missing `dist` directory.

Use Emscripten for the custom CLI build. It supplies Clang/LLVM, C/C++ runtime support, JavaScript glue, and WORKERFS. The pinned Docker environment contains the compiler; contributors doing normal frontend work download the prepared artifacts, while contributors changing FFmpeg configuration or native patches run `build:ffmpeg`. End users receive WASM and install no native FFmpeg or compiler. The build downloads upstream native source into the ignored cache and includes it in release sources; build/compatibility patches may contain C/C++, but we own no new media pipeline. [Emscripten toolchain](https://emscripten.org/docs/introducing_emscripten/about_emscripten.html)

WASI SDK and bare Clang/`wasm-ld` are alternatives, but require different browser host/runtime and file integration. WORKERFS is an Emscripten facility. Keep toolchain replacement separate from the CLI-versus-direct decision; it has no demonstrated benefit for this foundation. [WASI SDK](https://github.com/WebAssembly/wasi-sdk), [LLVM WASM linker](https://lld.llvm.org/WebAssembly.html)

Adapt the pinned ffmpeg.wasm build machinery to a minimal single-thread LGPL configuration. The first implementation commit must record exact wrapper/bindings/FFmpeg revisions, verified source archive hashes, Emscripten version, container digest/platform, and JS bundler version. Start from a combination that the upstream integration supports, then verify the complete custom build. Do not encode a floating `latest`, branch name, or an untested newer-FFmpeg substitution. Pin upgrades are reviewed changes; published artifacts are never rebuilt in place.

Changes to FFmpeg, the toolchain, patches, configuration, bindings, or packaged wrapper/worker require a new core version. Application-only changes can reuse the existing artifact. Treat wrapper/core compatibility as part of the pinned artifact contract; do not invent a new bridge ABI or worker protocol.

The initial configuration should express these policies, with the final complete command recorded in the artifact:

```text
--disable-everything
--disable-autodetect
--disable-programs
--disable-doc
--disable-network
--disable-pthreads
--disable-w32threads
--disable-os2threads
--disable-gpl
--disable-nonfree
--disable-version3
--enable-static
--disable-shared
--enable-small
```

Supply the Emscripten cross-compilation compiler/archiver/target arguments explicitly. `--disable-everything` disables component groups; it does not remove all libraries. Retain the minimum framework libraries needed by the actual CLI/bindings, expected to include `libavutil`, `libavcodec`, `libavformat`, and `libavfilter`; verify whether `libswresample` or other support is structurally required. Disable unused libraries where the selected CLI permits it. This supersedes the earlier `--disable-all`/`libavutil`-only direct-library recipe. Inspect the resolved configuration and final link map. [FFmpeg configure source](https://github.com/FFmpeg/FFmpeg/blob/master/configure)

The upstream build uses `--disable-programs` while building FFmpeg's libraries, then separately compiles/links the patched CLI sources into WASM. Preserve that distinction: the produced core still contains the CLI. Trim the final source/library/export list as well as configure flags. In particular, omit `ffprobe.c` and its native export, SDL, external codecs, and unused libraries from the upstream broad recipe. Adjust generated binding/export lists as needed; hide the unsupported `ffprobe` method in our public subset rather than retaining its native implementation. Verify wrapper load, filesystem operations, and `exec` still work. [Upstream WASM link recipe](https://github.com/ffmpegwasm/ffmpeg.wasm/blob/main/build/ffmpeg-wasm.sh)

Use a modularized ESM wasm32 build targeting workers, with filesystem support, WORKERFS, memory growth, and `DYNAMIC_EXECUTION=0`. Preserve the native exports/runtime methods needed by the upstream `exec`, filesystem, logging, progress, timeout, and reset bindings. Do not enable pthreads, SharedArrayBuffer, an additional multithread artifact, or speculative SIMD variants. Apply size optimization and dead-code elimination while retaining the diagnostic CLI commands used to verify the skeleton. Emscripten documents explicit WORKERFS linkage and a setting that suppresses generated `eval`/`new Function`. [Filesystem support](https://emscripten.org/docs/api_reference/Filesystem-API.html#file-systems), [compiler settings](https://emscripten.org/docs/tools_reference/settings_reference.html#dynamic-execution)

Generate one manifest from the actual build, containing:

- Core artifact version `0.1.0` and exact wrapper/bindings revisions compatible with it.
- FFmpeg/toolchain/bundler pins, recipe and patch hashes, complete configure/link arguments, required framework libraries, and resolved enabled components.
- Runtime payload filenames, byte sizes, and SHA-256 values; corresponding-source archive name and SHA-256. The manifest does not hash itself; outer `SHA256SUMS` covers it and the archives.
- Reported FFmpeg license and third-party notice inventory.

Use deterministic archive metadata and stable build paths. Compare two clean builds before claiming reproducibility. Preserve build/configuration logs and a linker map in release reports. Record raw WASM, total runtime, compressed runtime, and final extension ZIP size; set the first reviewed budget from measurements, then fail unexplained growth against it. File hashes establish artifact identity, not legal compliance.

`capabilities.json` starts with empty media component lists. Later entries name the feature/API requiring each component and its regression fixture. Separate explicit components from configure-selected dependencies; review changes to both. Do not confuse a component that is compiled with a component merely present in the full corresponding-source archive.

**5. Runtime and file lifecycle**

Keep our API as a small session/lifecycle layer over upstream methods. A foundation smoke call looks like this:

```ts
const session = createFfmpegSession({ assetBaseUrl, expectedBuild });
try {
    const ffmpeg = await session.load({ signal });
    ffmpeg.on('log', onLog);
    await ffmpeg.exec(['-version']);
} finally {
    session.dispose();
}
```

Creation is cheap and side-effect free. `load` imports the upstream wrapper, loads our worker/core with explicit URLs, and returns the supported command/filesystem/event subset. Repeated loads on one session share initialization. Keep `ffprobe` and methods outside the supported build out of that subset. Use existing `exec` diagnostics (`-version`, `-buildconf`, and `-L`) to check the actual binary against build metadata, including an asbplayer core version marker supplied through the build configuration. Asset hashes and the pinned compatibility contract identify the full artifact. A failed or aborted session releases resources and can be replaced by a fresh session; a failed download must not poison future attempts.

Use the upstream wrapper's `createDir`, `mount(FFFSType.WORKERFS, ...)`, `unmount`, and cleanup methods. Files are sent as structured-cloned `File`/`Blob` objects, assigned a fixed internal filename under a session-owned directory, and mounted read-only. Never call `file.arrayBuffer()` or the wrapper's whole-file `readFile` on a complete media input. Verify the wrapper path with a tiny fixture. For large range reads, a test-only worker harness can import the same release core and exercise its underlying filesystem; no custom production RPC or native test operation is needed. WORKERFS performs reads of requested portions; it does not mean there are no intermediate copies or unlimited memory. [WORKERFS](https://emscripten.org/docs/api_reference/Filesystem-API.html#workerfs)

Normal completion/error unmounts input and deletes temporary outputs in `finally`, while the session is alive. Connect cancellation and disposal to upstream `FFmpeg.terminate()`, which stops the worker and rejects outstanding calls. Passing an `AbortSignal` to an upstream call can reject the waiting promise without stopping synchronous WASM work, so it is insufficient by itself. Handle an already-aborted signal before loading, remove our listeners/log callbacks in cleanup, and keep disposal idempotent. After termination, discard the instance rather than attempting filesystem cleanup through a dead worker. Verify worker-load errors/timeouts also settle the session without adding a second worker protocol. [Wrapper cancellation/termination implementation](https://github.com/ffmpegwasm/ffmpeg.wasm/blob/main/packages/ffmpeg/src/classes.ts)

Use a factory, without a process-wide singleton, to keep independent sessions possible. Initially use one session at a time per consumer and reject overlapping operations if needed. No pool, chunk scheduler, concatenation, or hardware-based concurrency policy is required. Multiple CPU compile jobs inside one build are separate from multiple runtime/core variants.

WORKERFS solves input staging, not output buffering. #1111 currently reads its generated output from MEMFS; assess that output size and peak memory with its real use case. Streaming chunks into a final in-memory Blob still consumes memory proportional to output. Validate large-file offsets through the actual CLI/demuxer/file-protocol path when the first media feature enables it. A demonstrated output-memory limitation can motivate later integration changes, including the direct-library option.

**6. Website and PWA integration**

Extend `client/vite.config.ts`'s existing static-copy setup to serve the prepared runtime in development and copy it to `dist/ffmpeg/0.1.0/` in production. Resolve URLs in the web adapter using the configured deployment base, never a hardcoded origin.

Use an explicit shared FFmpeg asset base for deployments with versioned app URLs, for example `/ffmpeg/` at the production site root and `/asbplayer-staging/ffmpeg/` for staging. An older app and a newer app referencing core `0.1.0` must request exactly the same absolute URLs. Cache reuse is within the same origin/storage context, not between staging and production or between website and extension.

The existing `deploy` command is `gh-pages -d dist`. Add a staging/deployment helper that preserves previously published FFmpeg version directories when constructing the next site output. Restrict preservation to this asset directory. Do not let an ordinary clean app deployment erase an older app's pinned core/source. Keep initial deployment to one version; document retention when a second version ships.

Explicitly exclude `**/ffmpeg/**` from Workbox precaching, including glue and worker JavaScript; a small skeleton WASM may fit under size thresholds, so size limits are not a lazy-loading policy. Exclude FFmpeg asset URLs from navigation fallback as well. The current app uses VitePWA's generated service worker, which supports both precache configuration and runtime caching. [Vite PWA generateSW](https://vite-pwa-org.netlify.app/workbox/generate-sw)

On the first explicit FFmpeg operation, the web adapter ensures all four executable assets (wrapper, worker, core glue, and WASM) are present in one dedicated Cache Storage cache, keyed by their full immutable URLs. Fetch missing files, check response success and pinned hashes, and store them. The generated service worker uses `CacheFirst` against that same cache for those asset paths, so module imports and worker/core loads use normal same-origin URLs. Do not fetch source archives or licenses as part of preparing the runtime. [Workbox caching strategies](https://developer.chrome.com/docs/workbox/modules/workbox-strategies)

This explicit preparation also populates storage if the first page is not yet controlled by the service worker; subsequent offline loads use the service worker once installed. Verify that first-visit sequence. If Cache Storage is unavailable/full, online execution may proceed and persistence is unavailable. A partial download does not count as offline availability. Offline operation requires all runtime assets and an active service worker; browser eviction can remove them. Keep the current PWA update prompt behavior.

Use a cache namespace independent of the app version. Do not copy #1111's policy of deleting every other core cache when opening the current one: older app tabs may still use them. Defer cache eviction policy until multiple core versions warrant it. No worker, runtime asset download, or WASM instantiation occurs during ordinary startup, PWA installation, About rendering, or file selection in this foundation PR.

**7. Extension integration**

Extend both WXT `build:publicAssets` and `prepare:publicPaths` to include the runtime files and notices. The current asset helper reads only one directory level; either enumerate manifest paths explicitly or add recursion for the versioned directory. Every Chromium, Firefox desktop, and Firefox Android package gets the same selected core bytes.

The extension adapter resolves all four packaged executable assets with `browser.runtime.getURL`. The shared session imports the packaged wrapper and supplies the local URLs to its loader from an extension-owned document, such as the existing extension app page. The skeleton's packaged browser smoke harness proves execution there. Future background-driven features can use an extension document/offscreen host appropriate to their lifecycle. Do not add a generic message bridge or send multi-GB files through background messaging in this PR.

All executable assets must be inside the submitted extension. Chrome treats JavaScript and WASM fetched for execution as remotely hosted code. Do not use a website/CDN runtime fallback. [Chrome policy](https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code)

Set `script-src 'self' 'wasm-unsafe-eval'; object-src 'self';` for extension pages, preserving any necessary existing directives. Use the MV3 object form and the MV2 string form according to the resolved build target. The installed WXT version defaults Firefox desktop to MV2, and Firefox Android scripts explicitly request MV2; checking Chrome alone is insufficient. Avoid `unsafe-eval` and blob worker exceptions. [Chrome CSP](https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy), [Firefox CSP syntax](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/content_security_policy)

Do not expose the FFmpeg asset directory to every website through `web_accessible_resources`: the initial consumer is an extension-owned page. Add any later content-script access only with a feature that needs it. Opening a settings view injected into an ordinary website must show metadata without attempting to start a worker there.

**8. Licensing, corresponding source, and replacement**

Keep asbplayer-owned source and the upstream `@ffmpeg/ffmpeg` wrapper under their MIT notices. Distribute the selected FFmpeg-containing core with LGPL-2.1-or-later notices, and preserve the separate notices for Emscripten runtime/support code, ffmpeg.wasm bindings, and any future dependencies. The wrapper's MIT license does not determine the core's license. Disable GPL, nonfree, and version-3 components and check the resulting build's license and dependency inventory. The PR discussion specifically requests exact corresponding source and attribution; loading from a CDN is not the compliance strategy. [Maintainer comment](https://github.com/asbplayer/asbplayer/pull/1111#issuecomment-5349497268), [FFmpeg legal guidance](https://ffmpeg.org/legal.html)

A standalone `.wasm` file is not proof of dynamic linking: this core contains statically linked CLI/library code and bindings. Provide the exact source and utilities needed to rebuild with modified FFmpeg, preserve modification/reverse-engineering rights, and document the applicable source/relinking route. Validate replacement in a self-hosted app and an unpacked/temporarily loaded extension, including regeneration of local hashes; a user-supplied binary picker is unnecessary for that procedure. Any later custom C/C++ bridge must be included in its corresponding rebuild materials too. These implementation measures follow LGPL 2.1 sections 4 and 6; a license flag alone is not a compliance guarantee. [LGPL 2.1 text](https://github.com/FFmpeg/FFmpeg/blob/master/COPYING.LGPLv2.1)

Build a corresponding-source archive from the actual inputs, containing the complete selected FFmpeg/fork source, ffmpeg.wasm bindings and original wrapper/worker source, patches with change information, our integration/build scripts, lockfiles, configuration/link commands, licenses, and rebuild/replacement instructions. Include original upstream sources even when the npm package contains only compiled JavaScript. Include source and notices for additional code incorporated into the binary, and preserve the pinned toolchain recipe and a usable way to obtain that toolchain. Do not substitute GitHub's automatic asbplayer source ZIP or just a list of upstream URLs. Make a clean rebuild from this archive an acceptance check.

Publish an independent GitHub release tagged `ffmpeg-v0.1.0`, explicitly not marked as the latest application release:

```text
asbplayer-ffmpeg-0.1.0-runtime.tar.gz
asbplayer-ffmpeg-0.1.0-source.tar.xz
manifest.json
SHA256SUMS
build-report.json
```

Host the corresponding-source archive beside the website's versioned binary assets too, without precaching it. GitHub holds the binary/source release pair; web hosting holds its binary/source pair. Include notices, exact core version, and a permanent source URL in extension packages and application release notes. Retain source for every distributed version. This follows FFmpeg's recommendation to provide matching source at the binary's distribution location. [FFmpeg distribution checklist](https://ffmpeg.org/legal.html)

Extend `common/components/About.tsx` with FFmpeg attribution, selected core version, license access, and a corresponding-source link, using static artifact metadata. List `@ffmpeg/ffmpeg` separately as an MIT dependency. The existing MIT statement should clearly identify asbplayer's own code. License text is packaged locally so installed extensions can display it offline; copy the small website license/notice files into its existing precached assets area, outside the excluded executable directory. External source downloads may require connectivity. Add attribution/source access to relevant download documentation and store listing/release text.

Firefox source submission is an additional delivery task. Extend WXT's source ZIP and the two Firefox release workflows so a reviewer receives the matching FFmpeg/bindings/wrapper build inputs and an explicit rebuild command, including material normally Git-ignored. Inspect the generated source ZIP, rather than assuming `sourcesRoot: '..'` includes it. Mozilla requires matching sources for applicable submissions and documented reproducible build steps. [Firefox source submission](https://extensionworkshop.com/documentation/publish/source-code-submission/)

**9. CI and first-release sequence**

Add a reusable FFmpeg build/verification workflow and a separate tagged-release workflow. Ordinary app CI downloads the exact released artifact and verifies `artifact-lock.json`; changes to build inputs compile a candidate instead. Build-cache keys include source, toolchain, recipe, patches, and wrapper/worker/bundler inputs. Website and extension jobs consume the same candidate output.

The foundation must not depend on a release that cannot exist until it merges. For its PR, build `0.1.0` as a candidate CI artifact and test/package both consumers from it. Prepare the exact source archive and release outputs at the same time, and commit their final hashes and intended release URLs in `artifact-lock.json` before merge. PR CI uses the candidate files and verifies them against that lock. After merge, publish those verified binary/source artifacts before any application deployment or store submission; this needs no follow-up lock-edit PR. Keep build-input hashes independent of the generated release lock to avoid circular hashes. Never fall back to an unpinned public binary to make bootstrap CI pass.

Update `.github/workflows/verify.yml` to prepare FFmpeg before current app/extension builds and include foundation checks. Update both Firefox release workflows for artifact preparation and complete reviewer sources. Application release workflows must refuse a public release when the selected core's corresponding source is missing. No C compilation is added implicitly to Vite/WXT commands.

**10. Acceptance checks**

| Check                    | Evidence required before merge/release                                                                                                                                                             |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bare skeleton            | Resolved media component lists are empty; only documented CLI/framework dependencies are linked; no native ffprobe, SDL, or third-party codec libraries                                            |
| Real CLI runtime         | Pinned upstream wrapper/worker load the emitted WASM from explicit local URLs; `exec` version/configuration/license diagnostics match metadata and succeed repeatedly; incompatible artifacts fail |
| Input filesystem         | Production wrapper mounts/reads/unmounts a tiny real `File`; release-core harness verifies large selected-range reads without retaining input or allocating gigabytes in JS                        |
| Lifecycle                | Initialization failure, abort, disposal, and retry settle all pending promises and leave no worker/listener leak; two independent sessions do not share mounts                                     |
| Website lazy loading     | Production network trace and generated precache manifest show no FFmpeg executable download on startup, About, PWA install, or ordinary file selection                                             |
| Website offline          | Successful first load, reload offline, and second session succeed; first-ever offline use and partial/evicted cache produce recoverable failures                                                   |
| Version reuse            | Two app builds pinning one core use identical asset URLs/cache entries; another core cannot overwrite them; an old app's assets/source survive deployment                                          |
| Packaged extension       | Installed production Chrome MV3, Firefox MV2, and Firefox Android package resolve local assets and execute the skeleton offline with no CSP violation or remote runtime request                    |
| Compliance delivery      | License/source links identify the packaged core; web/release pairs contain exact source; Firefox source ZIP can rebuild it                                                                         |
| Size and reproducibility | Two clean runtime builds compare, all asset hashes verify, measured raw/compressed/ZIP sizes and reviewed budgets are recorded                                                                     |

Use real-browser integration coverage for WASM, workers, caching, and CSP; Jest mocks cannot demonstrate those behaviors. Add narrowly scoped Playwright coverage for website and Chromium extension where practical, with Firefox/Android browser checks recorded explicitly. Test fixtures and diagnostics remain outside distributed production assets. Run repository `yarn verify`, package typechecks, website production build, and all extension build targets after integration. Existing rendering/probing tests from #1111 remain for that feature PR.

Implement in this order: pin the upstream wrapper/bindings/toolchain and build a real CLI skeleton; establish source/replacement proof; add the thin session and WORKERFS helpers/harness; integrate both asset consumers and caching/CSP; wire About and release delivery; run the acceptance matrix and record sizes. These can be reviewable commits within the one foundation PR.

**11. Handoff to #1111 and subsequent features**

After the foundation merges, #1111 obtains the existing upstream wrapper through `@project/ffmpeg` and removes its direct dependency declaration, unpkg URLs, blob executable URLs, and private core cache. Adopt the shared session/file lifecycle helpers while retaining `exec` command construction and its feature-facing result/progress/cancellation contracts. The native processing pipeline remains upstream CLI code. Rebase still needs integration edits and component selection, but does not require rewriting its transcoder in C/C++. Make track selection explicit about audio-track ordinal versus FFmpeg absolute stream index; the current PR maps `0:a:<ordinal>`.

Its core update enables the input demuxers its supported file path actually uses, and the requested AC-3/E-AC-3/DTS/TrueHD/MLP decoders (`dca` is FFmpeg's DTS component name). Add the file protocol, chosen output encoder/muxer, and required parsers/internal dependencies; the CLI already links some framework libraries in the skeleton. Add `libswresample` if not already structurally required, and enable the CLI audio filters actually needed by these commands. Candidate plumbing includes `abuffer`, `abuffersink`, `aformat`, `anull`, `atrim`, and `aresample`; establish the precise set with the pinned build and real fixtures. Do not enable AVI just because the cheap TypeScript probe recognizes it.

Select output encoding in that feature PR. Opus is the starting candidate because #1111 reports better performance; the second summary's native AAC proposal removes an external encoder dependency but has not been benchmarked here, and FFmpeg's native AAC encoder is also available through the CLI. Measure size, conversion time, playback, seeking, and mining on supported browsers before choosing. Ship one output path initially unless a demonstrated supported-browser gap requires another. Vorbis/AAC fallback chains and concat support are not inherited automatically. CLI plumbing filters needed by an active command count as used dependencies.

Begin with one worker. The session factory leaves later independent workers possible, but #1111's automatic chunking and concatenation need their own measured justification, memory budget, and timing tests before being restored. Streaming output/backpressure and long-file memory requirements belong to that first actual media operation, with no claim that WORKERFS solves output memory.

The likely future capability groups remain useful for prioritization: audio extraction/mining, track enumeration/selection, text subtitle and attachment extraction, then video/frame/animation operations. None grants permission to compile those components early. Each future PR updates its consumer, capability inventory, fixtures, notices/source archive, size report, and independent core version together.

**12. Future direct-library integration: reference, not foundation scope**

Revisit a direct interface only for an explicit concern: an unacceptable measured package/download size, a demonstrated performance bottleneck, excessive peak memory, required output streaming/control unavailable through the present integration, an FFmpeg upgrade/maintenance obstacle, or another concrete requirement. Define success criteria before building a comparison. First evaluate whether the CLI configuration, wrapper, or I/O strategy can address the issue more cheaply. Do not add a dormant second core, custom bridge, or backend-selection layer now.

For equivalent audio functionality, the discussion offered **0.5–1.5 MB less uncompressed WASM** as a low-confidence engineering guess for direct integration. It is not measured, promised, or a size budget; compressed savings would be smaller. Most expected reduction from the stock broad core comes from disabling unused components, which the CLI build also does. Comparing a version-only `libavutil` build to a functioning audio CLI would not measure interface overhead fairly.

Any comparison must use equivalent supported operations, codecs/settings, threading, inputs, and build optimizations, and record raw/compressed/extension sizes, load time, processing time, peak memory, and output correctness. If FFmpeg/toolchain versions necessarily differ, report that confounder rather than attributing the entire difference to the interface. Do not assume an encoding speedup from removing the CLI: both routes can use the same codecs. Better buffering is a design change that must be implemented and measured. Balance a demonstrated gain against native-code ownership and migration work.

The retained direct design would look like:

```text
TypeScript feature API, e.g. transcodeAudioTrack(...)
    → dedicated worker
    → asbplayer C-compatible exports implemented in C++
    → required FFmpeg libraries
```

For example, add `ffmpeg/native/asb_ffmpeg.cpp` and a purpose-specific worker handler. TypeScript calls an operation such as `transcodeAudio({ file, audioTrack, bitrate })`; C++ uses `avformat_open_input`, stream selection, decoder send/receive calls, resampling, encoding, and muxing. The C++ implementation may use RAII and custom-deleter smart pointers to manage FFmpeg contexts. Include FFmpeg's C headers with appropriate C linkage and expose a small `extern "C"` boundary to WASM; the implementation does not have to be written in C.

This would add **asbplayer-owned C++ media processing code**, beyond build scripts and upstream patches. The CLI currently handles timestamps, pipeline setup, packet/frame draining, errors, and cleanup; a direct backend must implement and test the needed behavior. Keep Emscripten and the explicit container build unless a separate toolchain change has its own motivation. Normal frontend contributors still use prebuilt artifacts.

For an audio operation, the native library set might be `libavformat`, `libavcodec`, `libswresample`, and `libavutil`, with no CLI or filter framework if the operation does not need it. Keep WORKERFS input and worker termination for cancellation. A custom `AVIOContext` could forward output chunks to JavaScript, but bounded total memory additionally requires a consuming sink/backpressure strategy; collecting all chunks in a Blob is still proportional to output size.

Preserve feature-facing TypeScript contracts where feasible, replace the command runner behind them, and update source/rebuild materials, ABI metadata, capability inventories, versions, and browser coverage. Retire the replaced CLI artifact from current consumers when migration is complete. Any temporary coexistence must have active consumers and a measured justification. The initial CLI choice does not prevent this migration; it postpones the additional native implementation until a concrete benefit warrants it.

**Proposed foundation PR title:** `Add a minimal LGPL FFmpeg CLI runtime for the website and extension`

**Proposed PR description:** asbplayer needs a shared FFmpeg build and distribution path before media features can depend on it. This reuses the existing ffmpeg.wasm wrapper with an independently versioned minimal LGPL CLI core, with no enabled media formats, WORKERFS support, lazy website caching, packaged extension assets, and matching license/source/rebuild materials. It establishes the dependency for #1111, which retains command-based transcoding while adopting the shared integration. A custom C/C++ backend is deferred until a measured requirement justifies it. Attach the completed acceptance matrix and measured artifact sizes when implementation is ready for review.
