# Native desktop package ownership

`npm run app:dist` builds the renderer and native helpers, stages resources, and
produces the Tauri installer and portable archive. `npm run app:dist:signed`
additionally creates signed updater artifacts. These commands package native
desktop resources and leave publication to the release workflow.

Tauri packages exclude the Qt host wheel, `pyproject.toml`, `uv.lock` and
`.python-version`. See [Electron to Tauri first install](ELECTRON_TO_TAURI.md)
for the legacy environment marker and Windows installer handoff.

Build reporting, asset collection and package smoke tests resolve Cargo's
`target_directory`, including `.cargo/config.toml` and `CARGO_TARGET_DIR`
overrides. Bundles are under `<target_directory>/release/bundle`. Collected
installers and portable ZIPs are written to `dist/native-release/<platform>-<arch>`.

## Desktop CI

- **Development checks** run on desktop pull requests and pushes to `main`.
  A Linux job builds the renderer and runs the full Vitest suite. Renderer-only
  changes finish there. Changes to Rust, shared code, packaging or
  resources also run the Rust workspace tests and development desktop
  smoke tests on Linux, Windows and Apple Silicon. A new commit cancels the
  superseded development run.
- **Preview and release builds** share the same renderer artifact across Windows
  x64, Linux x64, Apple Silicon and Intel macOS. Each platform stages its native
  helpers and builds the shipping desktop once. Full builds run the desktop
  scenarios against that executable and its staged resources outside the
  checkout. Workspace unit tests run concurrently on the three operating
  systems. Cargo tests the standalone Agent separately so its Frida build cannot
  supply SQLite to the desktop test binary. Publication waits for the tests and
  all four packages.
- **Rust caching** uses a pinned toolchain and `sccache` with GitHub Actions
  storage. Each OS, architecture and Cargo profile restores a disk cache capped
  at 1 GiB. A successful compile can save the archive before GUI smoke tests.
  The post-job statistics report actual compiler hits, misses and uncached work.
- **Overlay latency** is recorded during the dictionary reopen smoke test.
  To check the five-sample median against the 500 ms budget on a controlled
  machine, set `GSM_BENCHMARK_WARM_ACTIVATION=1` before running
  `node scripts/test-native-desktop.mjs yomitan` (on Linux, use
  `bash scripts/test-native-linux.sh yomitan`).

## Development build storage

Cargo development builds and tests in this checkout use line-table debug
information for local crates, disable debug symbols for third-party
dependencies (`[profile.dev.package."*"] debug = false`), skip the incremental
compiler cache, and enable Cargo's automatic 7-day cache GC for `CARGO_HOME`.
All desktop and `native/gsm-*` crates share a root Cargo workspace (`Cargo.toml`)
and lockfile so dependency builds are not duplicated per crate.

To reclaim stale development artifacts and prune old `desktop-runs` snapshots,
run:

```powershell
npm run clean:rust -- --dry-run
npm run clean:rust
```

To centralize Cargo output across checkouts or put it on another drive, set the
`CARGO_TARGET_DIR` environment variable (and optionally `sccache` via
`~/.cargo/config.toml`). Helper builds and staging resolve Cargo's configured
target directory automatically, and `npm run build:tauri` automatically prunes
old launch snapshots in `src-tauri/target/desktop-runs`.

## Agent / Frida downloads

Current installers do not contain Frida or `gsm-agent-host`. Staging builds a
separate `gsm-agent-runtime-<platform>-<SHA-256>.zip` with the native helper and
its license notices, then includes only `native/agent-runtime.json` in the app.
Asset collection publishes that ZIP with the matching desktop release. Release
validation requires all four platform ZIPs and checks their hashes before the
release can be published. These changes supersede the historical Frida/Node
payload measurements below.

Starting Agent for the first time downloads, verifies and extracts the pinned
runtime into `<shared data>/texthook/frida/<Frida version>/<platform>/<SHA-256>`.
Later sessions verify and reuse that copy without a network request. Profiles
share it with the normal/relocated installation, alongside Luna and Textractor.
Only a changed runtime payload requires a new download. Existing detached
sessions retain their executable. Ordinary native Luna/Textractor sessions,
status checks, reconnects and Stop do not trigger a download; Wine PID discovery
uses the same runtime as Agent. Wine's Windows Frida server also uses shared data.

The installer pins both archive and extracted-file hashes. Failed downloads or
extractions never activate a partial runtime, concurrent profiles serialize the
same installation, and corrupt caches are repaired on the next start. Stopping
Agent while a download is underway prevents a later attach.

Development builds prepare a local runtime ZIP and manifest, then exercise the
same installation/cache path on first use without downloading unpublished code.
The runtime is no longer copied into every immutable desktop build directory.

```powershell
node --test scripts/package-agent-runtime.test.mjs scripts/native-package-policy.test.mjs
cargo test --locked --manifest-path native/gsm-packages/Cargo.toml agent_runtime
```

## Windows x64 measurements, 2026-11-12

Measured against the original `GSM_2026.11.0_x64-setup.exe` in this checkout:

| Payload | Before | After |
| --- | ---: | ---: |
| NSIS installer / native Windows update download | 398.2 MiB | 127.1 MiB |
| Application resources | 1108.1 MiB | 431.2 MiB |
| Desktop executable | 158.2 MiB | 38.9 MiB |
| Renderer resources | 98.6 MiB | 2.6 MiB |

The installer is 68.1% smaller. The new portable ZIP is 180.4 MiB. The remaining
largest files are Frida (112.6 MiB uncompressed), Node (83.0 MiB), and offline
language/dictionary assets. Removing those requires replacing active services
or changing offline capabilities, rather than a packaging exclusion.

A subsequent current-release-only changelog pass reduced its payload from
7,798,867 to 288,684 bytes (five files: manifest, current notes and three images).
Total staged resources are now 424.0 MiB in 5,026 files. The table above records
the first optimization pass. The rebuilt installer is 120.4 MiB (126,274,913 bytes),
another 6.7 MiB smaller; its archive contains only the current notes and three images.

The final NSIS archive was extracted and all 5,069 application files matched
the staged files by SHA-256. Its executable matches the built executable except
for Tauri's expected three-byte NSIS bundle marker. Offline Japanese tokenization
also passed using the extracted MeCab files. Local evidence and hashes are saved
under `build/size-audit/`; those generated files are not committed or packaged.

## What is shipped

- Tauri owns windows, capture, native OCR, menus, clipboard and updates. Capture
  source identities include executable paths from Rust; game detection and
  preview matching no longer load `node-window-manager` or `extract-file-icon`.
- The ordinary Node sidecar still runs GSM's existing services. Frida is retained
  for text hooking, along with the Node libraries those services actually use.
  Electron packages remain development dependencies for legacy migration tests;
  none are installed into the application resource directory.
- React, Markdown rendering and xterm dependencies are build dependencies. Their
  production output is already in the renderer, so their npm packages are not
  installed a second time for the Node sidecar.
- The renderer is served through the `gsm:` resource protocol. Tauri's
  `frontendDist` points at a minimal host document so it does not embed a duplicate
  renderer and legacy asset tree in the executable. The remaining legacy OCR
  replacement editor is copied with only its stylesheet and shared script.
- VOCR's four verified models are shared files under
  `GameSentenceMiner/assets/vocr`, used by Rust and Python. MeCab data, both
  dictionary readers, their fonts, model notices and license files remain
  available offline. Only MeCab executables for the target OS are shipped.
- Only the installed release's notes and referenced images/animations are bundled
  for offline use. The packaged manifest contains only that release; historical
  notes and media stay in the source repository and published GitHub releases.
  Prerelease builds prefer exact-version notes, falling back to the matching base
  release. If neither exists, an empty manifest allows the viewer's online fallback.

The abandoned `native/gsm-runtime` directory is never staged. It contained an
unused executable, FFmpeg distribution and DirectML DLL totaling about 449 MiB
in the audited checkout. Build objects, symbols, source maps, package tests and
fixtures are excluded as well, along with the hardcoded overlay window diagnostic.

## Checks and size limits

Staging writes `build/native-desktop/size-report.json` with totals and the largest
files. `scripts/native-package-policy.mjs` governs resource filtering and audits
the staged tree. Current limits are 6 MiB for renderer resources, 300 MiB for
Windows resources, 50 MiB for the stable Windows desktop executable, and 160 MiB for
the Windows installer. Published Tauri previews allow 88 MiB for the executable.
The November preview binary measured 73 MiB, including 49 MiB of native code.
A failed check
stops the build. Change a limit only after reviewing the added payload.

```powershell
node --test scripts/build-native.test.mjs scripts/native-package-policy.test.mjs
node scripts/verify-native-package.mjs
node scripts/test-native-package.mjs
```

The package smoke test copies the release executable and application resources
outside the checkout. On macOS it runs the executable inside the shipped
`.app` with its own Info.plist, resources and frameworks. Use `node scripts/test-native-package.mjs --all`
to exercise the same scenarios as the full release workflow. On Linux,
`bash scripts/test-native-linux.sh package --all` provides Xvfb, the window
manager and the D-Bus session.

Unsigned rebuilds remove an earlier installer's signature, and collection removes
stale output signatures. Release publication still signs and verifies the final
bytes through the existing release workflow.
