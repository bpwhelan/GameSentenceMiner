# Dependency audit

## Summary

| Scope | Audited | Removed | Kept | Flagged for review |
| --- | ---: | ---: | ---: | ---: |
| Project packages and integrations | 395 | 14 | 366 | 15 |
| GitHub Actions and Linux runner packages | 34 | 0 | 32 | 2 |
| **Total** | **429** | **14** | **398** | **17** |

Counts cover direct declarations before and after pruning, including the overlay’s replacement declaration for `dirs`. A package used by two independent projects counts twice. Cargo build and development declarations count separately from runtime declarations. Versions are the resolved versions in the owning project’s lockfile. Platform alternatives in one Debian dependency count once. The Rust table groups consumers that resolve the same version.

The inventory covers the root, overlay and texthooker JavaScript projects, the root Cargo workspace, the input server and its language crate, Windows audio capture, and the initialized OneShotOCR submodule. Shared Rust source compiled by these crates is included. The standalone Python extension and Python environment are outside this pass.

Other direct inputs include the three CMake projects, the pinned Git submodule, the Nix flake, Debian runtime requirements, native agent devkit and the bundled dictionary integrations. Platform SDK libraries come with the host toolchain. The asset catalog in [`native/gsm-downloads/assets.json`](native/gsm-downloads/assets.json) separately records hashes for icons, fonts and OCR model data.

## Manifest inventory

| Owner | Manifest and lockfile |
| --- | --- |
| Desktop JavaScript | [`package.json`](package.json) · [`package-lock.json`](package-lock.json) |
| `GSM_Overlay` | [`GSM_Overlay/package.json`](GSM_Overlay/package.json) · [`GSM_Overlay/package-lock.json`](GSM_Overlay/package-lock.json) |
| `texthooker` | [`texthooker/package.json`](texthooker/package.json) · [`texthooker/pnpm-lock.yaml`](texthooker/pnpm-lock.yaml) |
| Desktop Cargo workspace | [`Cargo.toml`](Cargo.toml) · [`Cargo.lock`](Cargo.lock) |
| Desktop member manifests | [`native/gsm-agent/Cargo.toml`](native/gsm-agent/Cargo.toml)<br>[`native/gsm-capture/Cargo.toml`](native/gsm-capture/Cargo.toml)<br>[`native/gsm-db/Cargo.toml`](native/gsm-db/Cargo.toml)<br>[`native/gsm-dictionary-transfer/Cargo.toml`](native/gsm-dictionary-transfer/Cargo.toml)<br>[`native/gsm-downloads/Cargo.toml`](native/gsm-downloads/Cargo.toml)<br>[`native/gsm-history/Cargo.toml`](native/gsm-history/Cargo.toml)<br>[`native/gsm-intake/Cargo.toml`](native/gsm-intake/Cargo.toml)<br>[`native/gsm-mining/Cargo.toml`](native/gsm-mining/Cargo.toml)<br>[`native/gsm-overlay/Cargo.toml`](native/gsm-overlay/Cargo.toml)<br>[`native/gsm-packages/Cargo.toml`](native/gsm-packages/Cargo.toml)<br>[`native/gsm-runtime/Cargo.toml`](native/gsm-runtime/Cargo.toml)<br>[`native/gsm-settings/Cargo.toml`](native/gsm-settings/Cargo.toml)<br>[`native/gsm-text-preview/Cargo.toml`](native/gsm-text-preview/Cargo.toml)<br>[`native/gsm-texthook/Cargo.toml`](native/gsm-texthook/Cargo.toml)<br>[`native/gsm-web/Cargo.toml`](native/gsm-web/Cargo.toml)<br>[`src-tauri/Cargo.toml`](src-tauri/Cargo.toml) |
| Input server and language workspace | [`GSM_Overlay/input_server/Cargo.toml`](GSM_Overlay/input_server/Cargo.toml) · [`GSM_Overlay/input_server/language/Cargo.toml`](GSM_Overlay/input_server/language/Cargo.toml) · [`GSM_Overlay/input_server/Cargo.lock`](GSM_Overlay/input_server/Cargo.lock) |
| Standalone Windows audio helper | [`native/windows-audio-capture/Cargo.toml`](native/windows-audio-capture/Cargo.toml) · [`native/windows-audio-capture/Cargo.lock`](native/windows-audio-capture/Cargo.lock) |
| Reference OCR utility | [`.gitmodules`](.gitmodules) · `scripts/OneShotOCR/Cargo.toml` · `scripts/OneShotOCR/Cargo.lock` (inside the pinned submodule) |
| CMake | [`native/game-background-hooks/CMakeLists.txt`](native/game-background-hooks/CMakeLists.txt)<br>[`native/windows-speech-recognition/CMakeLists.txt`](native/windows-speech-recognition/CMakeLists.txt)<br>[`native/vita-ocr/CMakeLists.txt`](native/vita-ocr/CMakeLists.txt) |
| Nix | [`texthooker/flake.nix`](texthooker/flake.nix) · [`texthooker/flake.lock`](texthooker/flake.lock) |
| Platform packages and source pins | [`src-tauri/tauri.bundle.conf.json`](src-tauri/tauri.bundle.conf.json)<br>[`native/vita-ocr/desktop-source-lock.json`](native/vita-ocr/desktop-source-lock.json)<br>[`native/vita-ocr/source-lock.json`](native/vita-ocr/source-lock.json)<br>[`GSM_Overlay/third_party/jiten-parser/manifest.json`](GSM_Overlay/third_party/jiten-parser/manifest.json) |

## Removed Dependencies

| Declaration | Package and previous version | Reason |
| --- | --- | --- |
| `native/gsm-dictionary-transfer/Cargo.toml` | `chrono` 0.4.45 | The snapshot code uses std::time::SystemTime. No target in the crate uses Chrono. |
| `native/gsm-overlay/Cargo.toml` | `directories` 6.0.0 | The model directory and Google Vision credential fallback need only the home path. Both now call the model helper backed by the existing `dirs` 6.0.0. |
| `native/gsm-mining/Cargo.toml` | `ndarray` 0.17.2 | The VAD builds ORT tensors from shape and data tuples. No target constructs an ndarray. |
| `native/gsm-texthook/Cargo.toml` | `serde` 1.0.229 | The protocol uses serde_json values and macros directly. There are no Serde derives or trait imports in the crate. |
| `GSM_Overlay/input_server/Cargo.toml` | `tungstenite` 0.21.0 | The handshake request and message type come from tokio-tungstenite’s public re-export. The async transport still pins the protocol implementation. |
| `package.json` | `acorn` 8.19.0 | The native dictionary host extracts page scripts itself. No live JavaScript parser import remains. |
| `package.json` | `@types/ws` 8.18.1 | The ws clients in this tree are JavaScript. No compiled TypeScript source imports ws or requests these declarations. |
| `GSM_Overlay/package.json` | `electron-squirrel-startup` 1.0.1 | No entry point requires the module to process Squirrel lifecycle events. The Forge maker is a separate packaging dependency. |
| `GSM_Overlay/package.json` | `concurrently` 10.0.6 | The dev script delegates to the root Tauri command. No overlay script starts concurrent processes with this CLI. |
| `GSM_Overlay/package.json` | `cross-env` 10.1.0 | No overlay command invokes it to set environment variables. |
| `GSM_Overlay/package.json` | `nodemon` 3.1.14 | The old watch command is gone. Tauri now owns the development restart loop. |
| `GSM_Overlay/package.json` | `wait-on` 9.1.0 | No script waits for the renderer with this CLI. |
| `texthooker/package.json` | `@types/dom-screen-wake-lock` 1.0.3 | The pinned TypeScript DOM library already declares Navigator.wakeLock, WakeLock and WakeLockSentinel. |
| `texthooker/package.json` | `tslib` 2.8.1 | The application does not import compiler helpers. RxJS retains its own transitive declaration. |

The overlay also dropped its @tootallnate/once override. No package in the final overlay lock requests it. The @electron/rebuild and tmp overrides still constrain transitive packages. Overrides are outside the direct-declaration count.

## Kept Dependencies

Runtime includes libraries compiled into the shipped web interfaces. Their usage entries identify declarations in devDependencies. Build-time CSS plugins and tools used for the compatibility host stay in development. The root tar entry is listed with its transfer test. Cargo sections follow the owning crate’s normal, build and test targets.

### Production and runtime

#### JavaScript

| Package | Purpose | Usage | Justification |
| --- | --- | --- | --- |
| `@mdi/js` 7.4.47 | SVG icon paths | texthooker · [`texthooker/src/stores/stores.ts`](texthooker/src/stores/stores.ts) (bundled from devDependencies) | Supplies the Material Design path data rendered by texthooker components. |
| `@xterm/addon-fit` 0.11.0 | Terminal sizing | Root · [`electron-src/renderer/src/App.tsx`](electron-src/renderer/src/App.tsx) (bundled from devDependencies) | Fits the embedded terminal grid to the available panel. |
| `@xterm/xterm` 6.0.0 | Terminal emulation | Root · [`electron-src/renderer/src/App.tsx`](electron-src/renderer/src/App.tsx) (bundled from devDependencies) | Renders the embedded terminal and interprets terminal control sequences. |
| `archiver` 7.0.1 | ZIP creation | Root · [`electron-src/main/services/log_archive.ts`](electron-src/main/services/log_archive.ts) | Streams archives for runtime packaging and dictionary fixtures. |
| `axios` 1.20.0 | HTTP requests | Root · [`electron-src/main/services/reader.ts`](electron-src/main/services/reader.ts) | Electron services depend on its response, error and request configuration APIs. |
| `fuse.js` 7.5.0 | Fuzzy search | Root · [`electron-src/main/agent_script_resolver.ts`](electron-src/main/agent_script_resolver.ts) | Ranks agent-script candidates against game metadata. |
| `koffi` 3.1.6 | Foreign-function interface | GSM_Overlay · [`GSM_Overlay/magpie_native.js`](GSM_Overlay/magpie_native.js) | Calls the native Windows APIs used by the Electron overlay. |
| `pinyin-pro` 3.29.3 | Chinese reading generation | GSM_Overlay · [`GSM_Overlay/reading_overlay_utils.js`](GSM_Overlay/reading_overlay_utils.js) | Computes tone-marked readings for the Electron overlay. |
| `react` 19.2.8 | UI component runtime | Root · [`electron-src/renderer/src/App.tsx`](electron-src/renderer/src/App.tsx) (bundled from devDependencies) | Implements state, hooks and component rendering in the bundled desktop UI. |
| `react-dom` 19.2.8 | Browser rendering | Root · [`electron-src/renderer/src/main.tsx`](electron-src/renderer/src/main.tsx) (bundled from devDependencies) | Mounts the React application into its document and supports portals. |
| `react-markdown` 10.1.0 | Markdown rendering | Root · [`electron-src/renderer/src/components/WhatsChangedDialog.tsx`](electron-src/renderer/src/components/WhatsChangedDialog.tsx) (bundled from devDependencies) | Renders release notes as React components. |
| `rehype-sanitize` 6.0.0 | Markup sanitization | Root · [`electron-src/renderer/src/components/WhatsChangedDialog.tsx`](electron-src/renderer/src/components/WhatsChangedDialog.tsx) (bundled from devDependencies) | Applies the release-notes HTML allowlist. |
| `remark-gfm` 4.0.1 | GitHub-flavored Markdown | Root · [`electron-src/renderer/src/components/WhatsChangedDialog.tsx`](electron-src/renderer/src/components/WhatsChangedDialog.tsx) (bundled from devDependencies) | Supports the tables, task lists and related syntax used in release notes. |
| `rxjs` 7.8.2 | Reactive streams | texthooker · [`texthooker/src/util.ts`](texthooker/src/util.ts) (bundled from devDependencies) | Provides observable state and subscriptions used in the socket and store adapters. |
| `semver` 7.8.5 | Release version handling | Root · [`electron-src/main/services/update_manager.ts`](electron-src/main/services/update_manager.ts) | Compares and validates versions in settings and catalog generation. |
| `sortablejs` 1.15.7 | Drag-and-drop sorting | texthooker · [`texthooker/src/components/ReplacementSettingsList.svelte`](texthooker/src/components/ReplacementSettingsList.svelte) | Implements reordering in the replacement settings list. |
| `svelte` 5.57.2 | UI compiler and runtime | texthooker · [`texthooker/src/main.ts`](texthooker/src/main.ts) (bundled from devDependencies) | Builds the text feed's components and provides reactive stores. |
| `ws` 8.21.3 | Node WebSocket transport | Root · [`scripts/restart-gsm.mjs`](scripts/restart-gsm.mjs)<br>GSM_Overlay · [`GSM_Overlay/main.js`](GSM_Overlay/main.js) | Provides the socket client or server for service and overlay communication. |
| `yauzl` 3.4.0 | ZIP extraction | Root · [`scripts/dictionary-fixture.mjs`](scripts/dictionary-fixture.mjs) | Reads ZIP entries lazily for extraction and validation. |

#### Rust

| Package | Purpose | Usage | Justification |
| --- | --- | --- | --- |
| `anyhow` 1.0.104 | Contextual errors | [`native/gsm-dictionary-transfer/src/lib.rs`](native/gsm-dictionary-transfer/src/lib.rs)<br>[`native/gsm-overlay/src/models.rs`](native/gsm-overlay/src/models.rs)<br>[`scripts/OneShotOCR/src/ocr.rs`](scripts/OneShotOCR/src/ocr.rs) | Propagates errors across filesystem, model and decoder boundaries with the failing operation attached. |
| `arboard` 3.7.0 | System clipboard | [`src-tauri/src/ocr/inputs.rs`](src-tauri/src/ocr/inputs.rs) | Reads or writes native clipboard contents across desktop platforms. |
| `arboard` 3.6.1 | System clipboard | [`scripts/OneShotOCR/src/app.rs`](scripts/OneShotOCR/src/app.rs) | Reads or writes native clipboard contents across desktop platforms. |
| `ashpd` 0.11.1 | Linux desktop portals | [`src-tauri/src/ocr_selector.rs`](src-tauri/src/ocr_selector.rs) (linux) | Implements the portal request and response protocol for the Linux desktop session. |
| `ashpd` 0.13.13 | Linux desktop portals | [`GSM_Overlay/input_server/src/main.rs`](GSM_Overlay/input_server/src/main.rs) (linux) | Implements the portal request and response protocol for the Linux desktop session. |
| `base64` 0.22.1 | Base64 encoding | [`src-tauri/src/ocr.rs`](src-tauri/src/ocr.rs)<br>[`native/gsm-agent/src/core.rs`](native/gsm-agent/src/core.rs)<br>[`native/gsm-capture/src/obs.rs`](native/gsm-capture/src/obs.rs)<br>[`native/gsm-history/src/game_archive/write.rs`](native/gsm-history/src/game_archive/write.rs)<br>[`native/gsm-web/src/library.rs`](native/gsm-web/src/library.rs)<br>[`native/gsm-overlay/src/engines/remote.rs`](native/gsm-overlay/src/engines/remote.rs) | Converts binary media, hashes or credentials to the wire representation expected by their consumers. |
| `block2` 0.6.2 | Objective-C blocks | [`native/gsm-overlay/src/engines/livetext.rs`](native/gsm-overlay/src/engines/livetext.rs) (macos) | Bridges the native completion callback used by Apple Live Text. |
| `bytes` 1.12.1 | Shared byte buffers | [`native/gsm-mining/src/gateway.rs`](native/gsm-mining/src/gateway.rs) | Provides the body type passed through the HTTP gateway without copying each chunk. |
| `caseless` 0.2.2 | Unicode case folding | [`src-tauri/src/anki_group.rs`](src-tauri/src/anki_group.rs)<br>[`native/gsm-history/src/tadoku.rs`](native/gsm-history/src/tadoku.rs)<br>[`native/gsm-text-preview/src/hook_ranking/comparison.rs`](native/gsm-text-preview/src/hook_ranking/comparison.rs) | Preserves Unicode-insensitive comparisons that simple lowercasing would change. |
| `chrono` 0.4.45 | Calendar and local time | [`src-tauri/src/cron.rs`](src-tauri/src/cron.rs)<br>[`native/gsm-db/src/lib.rs`](native/gsm-db/src/lib.rs)<br>[`native/gsm-history/src/lib.rs`](native/gsm-history/src/lib.rs)<br>[`native/gsm-intake/src/model.rs`](native/gsm-intake/src/model.rs)<br>[`native/gsm-mining/src/text.rs`](native/gsm-mining/src/text.rs)<br>[`native/gsm-web/src/lib.rs`](native/gsm-web/src/lib.rs) | Supplies typed calendar arithmetic, parsing and local-time conversions used by scheduling or history. |
| `clap` 4.6.1 | Command-line parser | [`GSM_Overlay/input_server/src/main.rs`](GSM_Overlay/input_server/src/main.rs) | Derives and validates the input server's command-line interface. |
| `cpal` 0.18.2 | Linux audio backends | [`src-tauri/Cargo.toml`](src-tauri/Cargo.toml) (linux) | Enables the pulseaudio feature for Rodio through Cargo feature unification. |
| `crc32c` 0.6.9 | Castagnoli CRC | [`native/gsm-dictionary-transfer/src/clone.rs`](native/gsm-dictionary-transfer/src/clone.rs) | Verifies the checksum format used by the dictionary storage log. |
| `csv` 1.4.0 | CSV parsing | [`native/gsm-history/src/exstatic.rs`](native/gsm-history/src/exstatic.rs) | Handles quoted and multiline fields in imported reading records. |
| `dirs` 6.0.0 | Platform directory discovery | [`src-tauri/src/main.rs`](src-tauri/src/main.rs)<br>[`native/gsm-settings/src/paths.rs`](native/gsm-settings/src/paths.rs)<br>[`native/gsm-mining/src/config.rs`](native/gsm-mining/src/config.rs)<br>[`native/gsm-overlay/src/models.rs`](native/gsm-overlay/src/models.rs)<br>[`native/gsm-overlay/src/engines/remote.rs`](native/gsm-overlay/src/engines/remote.rs) | Resolves home, data or cache directories across supported operating systems. |
| `fancy-regex` 0.17.0 | Extended regular expressions | [`native/gsm-history/src/search.rs`](native/gsm-history/src/search.rs)<br>[`native/gsm-text-preview/src/replacements.rs`](native/gsm-text-preview/src/replacements.rs)<br>[`native/gsm-overlay/src/ocr/replacements.rs`](native/gsm-overlay/src/ocr/replacements.rs) | Handles lookarounds or backreferences in user-provided patterns. |
| `fast_image_resize` 6.1.0 | Image resampling | [`native/gsm-capture/src/lib.rs`](native/gsm-capture/src/lib.rs) | Resizes capture frames on the OCR path using the selected filter. |
| `flate2` 1.1.11 | DEFLATE, gzip and zlib streams | [`native/gsm-db/src/backup.rs`](native/gsm-db/src/backup.rs)<br>[`native/gsm-history/src/stats.rs`](native/gsm-history/src/stats.rs)<br>[`native/gsm-mining/src/gateway/report_http.rs`](native/gsm-mining/src/gateway/report_http.rs)<br>[`native/gsm-packages/src/python.rs`](native/gsm-packages/src/python.rs) | Reads or produces the compressed representation expected by the consumer. |
| `form_urlencoded` 1.2.2 | Form query decoding | [`native/gsm-web/src/lib.rs`](native/gsm-web/src/lib.rs) | Parses percent escapes and repeated query parameters in report requests. |
| `fs2` 0.4.3 | Cross-process file locking | [`native/gsm-downloads/src/lib.rs`](native/gsm-downloads/src/lib.rs) | Serializes downloads to the same destination. The shared client also serves a crate declaring Rust 1.83. |
| `futures-util` 0.3.34 | Async stream and sink adapters | [`src-tauri/src/anki_media.rs`](src-tauri/src/anki_media.rs)<br>[`native/gsm-mining/src/ai.rs`](native/gsm-mining/src/ai.rs)<br>[`native/gsm-runtime/src/lib.rs`](native/gsm-runtime/src/lib.rs) | Provides the stream polling and sink extensions used with async sockets and requests. |
| `futures-util` 0.3.32 | Async stream and sink adapters | [`GSM_Overlay/input_server/src/main.rs`](GSM_Overlay/input_server/src/main.rs) | Provides the stream polling and sink extensions used with async sockets and requests. |
| `fuzzy-regex` 0.2.0 | Approximate regex matching | [`native/gsm-history/src/sessions_fuzzy.rs`](native/gsm-history/src/sessions_fuzzy.rs) | Implements fuzzy matching in reading-session patterns. |
| `gilrs` 0.10.10 | Gamepad event handling | [`GSM_Overlay/input_server/src/main.rs`](GSM_Overlay/input_server/src/main.rs) | Maps device events to the overlay server's buttons and axes. |
| `global-hotkey` 0.8.0 | Global shortcut registration | [`scripts/OneShotOCR/src/app.rs`](scripts/OneShotOCR/src/app.rs) | Delivers the OCR utility's activation shortcut outside its own window. |
| `gsm-agent` 0.1.0 | Agent controller | [`src-tauri/src/agent.rs`](src-tauri/src/agent.rs) | Exposes the controller used to manage the external agent process. |
| `gsm-capture` 0.1.0 | Native image capture | [`src-tauri/src/ocr.rs`](src-tauri/src/ocr.rs) | Provides window and OBS image acquisition for OCR. |
| `gsm-db` 0.1.0 | SQLite schema and migration | [`src-tauri/src/cron.rs`](src-tauri/src/cron.rs)<br>[`native/gsm-history/src/lib.rs`](native/gsm-history/src/lib.rs) | Uses the same database initialization and migration code as the desktop. |
| `gsm-dictionary-transfer` 0.1.0 | Dictionary migration | [`src-tauri/src/dictionary_host.rs`](src-tauri/src/dictionary_host.rs) | Reads and identifies existing browser dictionary stores during transfer. |
| `gsm-downloads` 0.1.0 | Verified asset downloads | [`native/gsm-overlay/src/models.rs`](native/gsm-overlay/src/models.rs)<br>[`native/gsm-packages/src/lib.rs`](native/gsm-packages/src/lib.rs) | Shares the download, lock and integrity checks across asset installers. |
| `gsm-history` 0.1.0 | Reading history service | [`src-tauri/src/cron.rs`](src-tauri/src/cron.rs)<br>[`native/gsm-web/src/lib.rs`](native/gsm-web/src/lib.rs) | Provides report queries and scheduled history operations. |
| `gsm-intake` 0.1.0 | Text intake and correlation | [`src-tauri/src/recycled_lines.rs`](src-tauri/src/recycled_lines.rs) | Uses the shared data model and decisions for incoming text. |
| `gsm-mining` 0.1.0 | Mining and media service | [`src-tauri/src/cron.rs`](src-tauri/src/cron.rs) | Provides the gateway and mining operations called by the desktop. |
| `gsm-overlay` 0.1.0 | OCR and overlay engines | [`src-tauri/src/ocr.rs`](src-tauri/src/ocr.rs) | Runs the native recognition and overlay-processing pipeline. |
| `gsm-packages` 0.1.0 | Package management | [`src-tauri/src/main.rs`](src-tauri/src/main.rs) | Provides asset location, installation and update operations. |
| `gsm-runtime` 0.1.0 | Native service lifecycle | [`src-tauri/src/backend.rs`](src-tauri/src/backend.rs)<br>[`native/gsm-packages/src/python.rs`](native/gsm-packages/src/python.rs) | Implements process or service coordination for desktop callers. |
| `gsm-settings` 0.1.0 | Profiles and settings | [`src-tauri/src/cron.rs`](src-tauri/src/cron.rs)<br>[`native/gsm-db/src/backup.rs`](native/gsm-db/src/backup.rs)<br>[`native/gsm-text-preview/src/lib.rs`](native/gsm-text-preview/src/lib.rs)<br>[`native/gsm-mining/src/config.rs`](native/gsm-mining/src/config.rs)<br>[`native/gsm-web/src/lib.rs`](native/gsm-web/src/lib.rs)<br>[`native/gsm-packages/src/lib.rs`](native/gsm-packages/src/lib.rs) | Shares profile paths, defaults and configuration persistence. |
| `gsm-sudachi` 0.1.0 | Japanese language service | [`src-tauri/src/cron.rs`](src-tauri/src/cron.rs)<br>[`GSM_Overlay/input_server/src/main.rs`](GSM_Overlay/input_server/src/main.rs) | Exposes the tokenization and vocabulary service to the host. |
| `gsm-text-preview` 0.1.0 | Text cleaning and matching | [`src-tauri/src/smoke_test.rs`](src-tauri/src/smoke_test.rs)<br>[`native/gsm-intake/src/lib.rs`](native/gsm-intake/src/lib.rs) | Shares normalization, preview and correlation behavior between callers. |
| `gsm-texthook` 0.1.0 | Text-hook controller | [`src-tauri/src/texthook.rs`](src-tauri/src/texthook.rs) | Owns lifecycle and protocol state for the desktop text service. |
| `gsm-web` 0.1.0 | Report pages and APIs | [`native/gsm-mining/src/gateway.rs`](native/gsm-mining/src/gateway.rs) | Supplies the report handlers mounted in the mining gateway. |
| `gtk` 0.18.2 | Linux native window toolkit | [`src-tauri/src/window_platform.rs`](src-tauri/src/window_platform.rs) (linux) | Accesses GTK window properties through the Linux desktop host. |
| `hashbrown` 0.14.5 | Hash-table storage | gsm-history · [`native/gsm-native/src/recycled_index.rs`](native/gsm-native/src/recycled_index.rs) | Backs the shared recycled-line index compiled into history. |
| `hashlink` 0.9.1 | Ordered hash map | gsm-intake · [`native/gsm-native/src/dialogue_journal.rs`](native/gsm-native/src/dialogue_journal.rs) | Maintains the dialogue journal's lookup and insertion order. |
| `http` 1.5.0 | HTTP request and status types | [`native/gsm-mining/src/gateway.rs`](native/gsm-mining/src/gateway.rs) | Uses the same typed headers and status codes as the gateway stack. |
| `http-body-util` 0.1.5 | HTTP body adapters | [`native/gsm-mining/src/gateway.rs`](native/gsm-mining/src/gateway.rs) | Constructs and collects the bodies consumed by Hyper. |
| `http-range-header` 0.4.2 | Byte-range parsing | [`native/gsm-mining/src/gateway/report_http.rs`](native/gsm-mining/src/gateway/report_http.rs) | Validates media ranges before serving partial content. |
| `httpdate` 1.0.3 | HTTP date formatting | [`native/gsm-mining/src/gateway/report_http.rs`](native/gsm-mining/src/gateway/report_http.rs) | Formats file timestamps for HTTP cache headers. |
| `hyper` 1.12.0 | HTTP/1 client and server | [`native/gsm-mining/src/gateway.rs`](native/gsm-mining/src/gateway.rs) | Implements the gateway protocol and connection upgrades. |
| `hyper-util` 0.1.21 | Hyper runtime adapters | [`native/gsm-mining/src/gateway.rs`](native/gsm-mining/src/gateway.rs) | Connects Tokio I/O to the gateway's Hyper implementation. |
| `ico` 0.6.0 | Windows icon decoding | [`src-tauri/src/windows_tray.rs`](src-tauri/src/windows_tray.rs) (windows) | Reads the images and sizes in the desktop tray icon. |
| `image` 0.25.10 | Image codecs and pixel buffers | [`src-tauri/src/ocr.rs`](src-tauri/src/ocr.rs)<br>[`native/gsm-capture/src/wgc.rs`](native/gsm-capture/src/wgc.rs)<br>[`native/gsm-web/src/yomitan_characters/portraits.rs`](native/gsm-web/src/yomitan_characters/portraits.rs)<br>[`native/gsm-overlay/src/ocr.rs`](native/gsm-overlay/src/ocr.rs)<br>[`scripts/OneShotOCR/src/ocr.rs`](scripts/OneShotOCR/src/ocr.rs) | Uses shared image buffers and format-specific encoders or decoders in the referenced pipeline. |
| `indexmap` 2.14.2 | Insertion-ordered maps | [`native/gsm-history/src/kanji.rs`](native/gsm-history/src/kanji.rs)<br>[`native/gsm-text-preview/src/hook_ranking.rs`](native/gsm-text-preview/src/hook_ranking.rs) | Keeps stable iteration order while supporting indexed lookups. |
| `jiff` 0.2.43 | Named time zones | [`native/gsm-web/src/lib.rs`](native/gsm-web/src/lib.rs) | Evaluates reading goals using the selected time zone and its offset transitions. |
| `jsonwebtoken` 10.4.0 | Signed JWTs | [`native/gsm-overlay/src/engines/remote.rs`](native/gsm-overlay/src/engines/remote.rs) | Signs service-account assertions for the remote OCR provider. |
| `leveldb-core` 0.1.2 | LevelDB table reader | [`native/gsm-dictionary-transfer/src/clone.rs`](native/gsm-dictionary-transfer/src/clone.rs) | Reads browser dictionary table records during migration. |
| `libc` 0.2.191 | Unix platform interface | [`src-tauri/src/process_probe.rs`](src-tauri/src/process_probe.rs) (macos)<br>[`native/gsm-overlay/src/scheduling.rs`](native/gsm-overlay/src/scheduling.rs) (unix)<br>[`native/gsm-runtime/src/process.rs`](native/gsm-runtime/src/process.rs) (unix) | Calls OS-specific process and scheduling functions unavailable through portable Rust APIs. |
| `libloading` 0.8.9 | Dynamic library loading | [`native/gsm-overlay/src/models.rs`](native/gsm-overlay/src/models.rs)<br>[`scripts/OneShotOCR/src/ocr/oneocr.rs`](scripts/OneShotOCR/src/ocr/oneocr.rs) (optional) | Loads optional native recognition libraries at runtime. |
| `lzma-rust2` 0.15.8 | XZ decompression | [`native/gsm-agent/src/wine.rs`](native/gsm-agent/src/wine.rs) (optional) | Unpacks the compressed Wine agent distribution. |
| `memmap2` 0.9.10 | Memory-mapped files | [`GSM_Overlay/input_server/language/src/sudachi.rs`](GSM_Overlay/input_server/language/src/sudachi.rs) | Maps large Sudachi dictionaries for the language engine. |
| `mime_guess` 2.0.5 | File MIME inference | [`src-tauri/src/assets.rs`](src-tauri/src/assets.rs) | Chooses a response content type for local desktop assets. |
| `minijinja` 3.0.0 | HTML template engine | [`native/gsm-web/src/pages.rs`](native/gsm-web/src/pages.rs) | Renders the existing report templates in the native web service. |
| `multer` 3.1.0 | Multipart form parser | [`native/gsm-mining/src/gateway/file_import.rs`](native/gsm-mining/src/gateway/file_import.rs) | Streams and limits files uploaded to the import gateway. |
| `num-bigint` 0.4.8 | Arbitrary-precision integers | [`native/gsm-dictionary-transfer/src/values.rs`](native/gsm-dictionary-transfer/src/values.rs) | Decodes large integer values stored in browser dictionaries. |
| `objc2` 0.6.5 | Objective-C runtime bridge | [`native/gsm-overlay/src/engines/livetext.rs`](native/gsm-overlay/src/engines/livetext.rs) (macos) | Calls the native Apple recognition APIs from Rust. |
| `objc2-app-kit` 0.3.2 | AppKit bindings | [`src-tauri/src/window_platform.rs`](src-tauri/src/window_platform.rs) (macos) | Accesses the desktop host's native NSWindow. |
| `objc2-foundation` 0.3.2 | Foundation bindings | [`native/gsm-overlay/src/engines/livetext.rs`](native/gsm-overlay/src/engines/livetext.rs) (macos) | Marshals strings, data and geometry into Apple's Live Text APIs. |
| `open` 5.4.5 | Default application launcher | [`src-tauri/src/native.rs`](src-tauri/src/native.rs) | Opens a validated destination using the OS-selected application. |
| `ort` 2.0.0-rc.12 | ONNX Runtime bindings | [`native/gsm-mining/src/vad.rs`](native/gsm-mining/src/vad.rs)<br>[`native/gsm-overlay/src/inference.rs`](native/gsm-overlay/src/inference.rs) | Executes local inference sessions for recognition or voice activity detection. |
| `pcre2` 0.2.11 | Perl-compatible regular expressions | [`native/gsm-history/src/sessions.rs`](native/gsm-history/src/sessions.rs) | Supports the Perl-compatible matching path for reading sessions. |
| `pep440_rs` 0.7.3 | Package version parsing | [`native/gsm-settings/src/profile_config.rs`](native/gsm-settings/src/profile_config.rs) (optional) | Compares historical profile versions under their original ordering rules. |
| `percent-encoding` 2.3.2 | Percent decoding | [`native/gsm-web/src/lib.rs`](native/gsm-web/src/lib.rs) | Decodes URL components consumed by native web handlers. |
| `prost` 0.14.5 | Protocol Buffers | [`native/gsm-overlay/src/engines/lens.rs`](native/gsm-overlay/src/engines/lens.rs) | Encodes and decodes the message format required by the Lens client. |
| `prost` 0.14.4 | Protocol Buffers | [`scripts/OneShotOCR/src/lens.rs`](scripts/OneShotOCR/src/lens.rs) | Encodes and decodes the message format required by the Lens client. |
| `rand` 0.10.3 | Random number generation | [`native/gsm-overlay/src/engines/lens.rs`](native/gsm-overlay/src/engines/lens.rs) | Generates values required by Lens request messages. |
| `rand` 0.10.2 | Random number generation | [`scripts/OneShotOCR/src/lens.rs`](scripts/OneShotOCR/src/lens.rs) | Generates values required by Lens request messages. |
| `rand_core` 0.6.4 | Operating-system randomness | [`src-tauri/src/dictionary_host.rs`](src-tauri/src/dictionary_host.rs) (windows) | Provides a compatible random source for RSA key generation. |
| `rapidfuzz` 0.5.0 | Fuzzy string matching | [`native/gsm-text-preview/src/hook_ranking/comparison.rs`](native/gsm-text-preview/src/hook_ranking/comparison.rs)<br>[`native/gsm-mining/src/text.rs`](native/gsm-mining/src/text.rs) | Computes string similarity for matching text and ranking candidates. |
| `rdev` 0.5.3 | Global input events | [`GSM_Overlay/input_server/src/main.rs`](GSM_Overlay/input_server/src/main.rs) | Receives system keyboard events outside the focused application. |
| `regex` 1.13.1 | Regular expressions | [`src-tauri/src/obs/scenes.rs`](src-tauri/src/obs/scenes.rs)<br>[`native/gsm-history/src/search.rs`](native/gsm-history/src/search.rs)<br>[`native/gsm-text-preview/src/lib.rs`](native/gsm-text-preview/src/lib.rs)<br>[`native/gsm-mining/src/ai.rs`](native/gsm-mining/src/ai.rs)<br>[`native/gsm-web/src/goal_edit.rs`](native/gsm-web/src/goal_edit.rs)<br>[`native/gsm-packages/src/python.rs`](native/gsm-packages/src/python.rs)<br>[`native/gsm-texthook/src/protocol.rs`](native/gsm-texthook/src/protocol.rs) | Compiles and evaluates the text or protocol patterns in the listed modules. |
| `regex` 1.12.3 | Regular expressions | [`GSM_Overlay/input_server/language/src/mining.rs`](GSM_Overlay/input_server/language/src/mining.rs) | Compiles and evaluates the text or protocol patterns in the listed modules. |
| `regex-syntax` 0.8.11 | Regex syntax tree | [`native/gsm-text-preview/src/language.rs`](native/gsm-text-preview/src/language.rs) | Inspects parsed expressions when determining supported language patterns. |
| `regress` 0.11.1 | ECMAScript regular expressions | [`src-tauri/src/obs/switcher.rs`](src-tauri/src/obs/switcher.rs) | Preserves JavaScript pattern semantics for desktop matching rules. |
| `reqwest` 0.12.28 | HTTP client | [`src-tauri/src/cron.rs`](src-tauri/src/cron.rs)<br>[`native/gsm-agent/src/wine.rs`](native/gsm-agent/src/wine.rs) (optional)<br>[`native/gsm-mining/src/ai.rs`](native/gsm-mining/src/ai.rs)<br>[`native/gsm-web/src/tadoku/client.rs`](native/gsm-web/src/tadoku/client.rs)<br>[`native/gsm-overlay/src/models.rs`](native/gsm-overlay/src/models.rs)<br>[`native/gsm-downloads/src/lib.rs`](native/gsm-downloads/src/lib.rs)<br>[`native/gsm-packages/src/lib.rs`](native/gsm-packages/src/lib.rs)<br>[`GSM_Overlay/input_server/language/src/sudachi.rs`](GSM_Overlay/input_server/language/src/sudachi.rs) | Handles HTTP transport, TLS and the response or streaming APIs used by these clients. |
| `reqwest` 0.13.4 | HTTP client | [`scripts/OneShotOCR/src/lens.rs`](scripts/OneShotOCR/src/lens.rs) | Handles HTTP transport, TLS and the response or streaming APIs used by these clients. |
| `rfd` 0.15.4 | Native file and message dialogs | [`src-tauri/src/native.rs`](src-tauri/src/native.rs) | Presents interactive desktop dialogs through the platform toolkit. |
| `rodio` 0.23.0 | Audio playback | [`src-tauri/src/card_dialog/editor.rs`](src-tauri/src/card_dialog/editor.rs) | Plays sound in the card editor using the desktop audio device. |
| `rsa` 0.9.10 | RSA keys | [`src-tauri/src/dictionary_host.rs`](src-tauri/src/dictionary_host.rs) (windows) | Generates key material used for browser dictionary identity. |
| `rusqlite` 0.32.1 | SQLite bindings | [`native/gsm-db/src/lib.rs`](native/gsm-db/src/lib.rs)<br>[`native/gsm-dictionary-transfer/src/lib.rs`](native/gsm-dictionary-transfer/src/lib.rs)<br>[`native/gsm-history/src/lib.rs`](native/gsm-history/src/lib.rs)<br>[`GSM_Overlay/input_server/language/src/vocabulary.rs`](GSM_Overlay/input_server/language/src/vocabulary.rs) | Executes typed SQLite queries, migrations or fixture setup against the application schema. |
| `rustix` 1.1.6 | Linux system calls | [`src-tauri/src/linux_wine.rs`](src-tauri/src/linux_wine.rs) (linux) | Reads process identity and OS parameters for Wine process discovery. |
| `sdl2` 0.38.0 | Native controller support | [`GSM_Overlay/input_server/src/sdl_gamepad.rs`](GSM_Overlay/input_server/src/sdl_gamepad.rs) (windows) | Supplies the Windows controller backend alongside XInput. |
| `semver` 1.0.28 | Semantic version comparison | [`src-tauri/src/update_manager.rs`](src-tauri/src/update_manager.rs)<br>[`native/gsm-packages/src/updates.rs`](native/gsm-packages/src/updates.rs) | Parses and compares release versions using SemVer precedence. |
| `serde` 1.0.229 | Typed serialization | [`src-tauri/src/ocr.rs`](src-tauri/src/ocr.rs)<br>[`native/gsm-db/src/imports.rs`](native/gsm-db/src/imports.rs)<br>[`native/gsm-history/src/lib.rs`](native/gsm-history/src/lib.rs)<br>[`native/gsm-intake/src/model.rs`](native/gsm-intake/src/model.rs)<br>gsm-text-preview · [`native/gsm-native/src/correlation.rs`](native/gsm-native/src/correlation.rs)<br>[`native/gsm-mining/src/ai.rs`](native/gsm-mining/src/ai.rs)<br>[`native/gsm-web/src/mokuro.rs`](native/gsm-web/src/mokuro.rs)<br>[`native/gsm-overlay/src/pipeline.rs`](native/gsm-overlay/src/pipeline.rs)<br>[`native/gsm-downloads/src/lib.rs`](native/gsm-downloads/src/lib.rs)<br>[`native/gsm-packages/src/ffmpeg.rs`](native/gsm-packages/src/ffmpeg.rs) | Derives or implements serialization for persisted data and messages. |
| `serde` 1.0.228 | Typed serialization | [`GSM_Overlay/input_server/language/src/lib.rs`](GSM_Overlay/input_server/language/src/lib.rs)<br>[`GSM_Overlay/input_server/src/main.rs`](GSM_Overlay/input_server/src/main.rs) | Derives or implements serialization for persisted data and messages. |
| `serde_json` 1.0.154 | JSON encoding and decoding | [`src-tauri/src/ocr.rs`](src-tauri/src/ocr.rs)<br>[`native/gsm-agent/src/wine.rs`](native/gsm-agent/src/wine.rs)<br>[`native/gsm-capture/src/obs.rs`](native/gsm-capture/src/obs.rs)<br>[`native/gsm-db/src/frequency.rs`](native/gsm-db/src/frequency.rs)<br>[`native/gsm-settings/src/lib.rs`](native/gsm-settings/src/lib.rs)<br>[`native/gsm-dictionary-transfer/src/lib.rs`](native/gsm-dictionary-transfer/src/lib.rs)<br>[`native/gsm-history/src/lib.rs`](native/gsm-history/src/lib.rs)<br>[`native/gsm-intake/src/lib.rs`](native/gsm-intake/src/lib.rs)<br>[`native/gsm-text-preview/src/lib.rs`](native/gsm-text-preview/src/lib.rs)<br>[`native/gsm-mining/src/ai.rs`](native/gsm-mining/src/ai.rs)<br>[`native/gsm-web/src/lib.rs`](native/gsm-web/src/lib.rs)<br>[`native/gsm-overlay/src/ocr.rs`](native/gsm-overlay/src/ocr.rs)<br>[`native/gsm-downloads/src/lib.rs`](native/gsm-downloads/src/lib.rs)<br>[`native/gsm-packages/src/lib.rs`](native/gsm-packages/src/lib.rs)<br>[`native/gsm-runtime/src/lib.rs`](native/gsm-runtime/src/lib.rs)<br>[`native/gsm-texthook/src/protocol.rs`](native/gsm-texthook/src/protocol.rs) | Reads and writes the JSON values used at configuration, storage or service boundaries. |
| `serde_json` 1.0.150 | JSON encoding and decoding | [`GSM_Overlay/input_server/language/src/lib.rs`](GSM_Overlay/input_server/language/src/lib.rs)<br>[`GSM_Overlay/input_server/src/main.rs`](GSM_Overlay/input_server/src/main.rs) | Reads and writes the JSON values used at configuration, storage or service boundaries. |
| `sha2` 0.10.9 | SHA-2 digests | [`src-tauri/src/obs/runtime.rs`](src-tauri/src/obs/runtime.rs)<br>[`native/gsm-agent/src/wine.rs`](native/gsm-agent/src/wine.rs) (optional)<br>[`native/gsm-capture/src/obs.rs`](native/gsm-capture/src/obs.rs)<br>[`native/gsm-dictionary-transfer/src/values.rs`](native/gsm-dictionary-transfer/src/values.rs)<br>[`native/gsm-history/src/kechimochi.rs`](native/gsm-history/src/kechimochi.rs)<br>[`native/gsm-mining/src/ai.rs`](native/gsm-mining/src/ai.rs)<br>[`native/gsm-web/src/yomitan_characters.rs`](native/gsm-web/src/yomitan_characters.rs)<br>[`native/gsm-overlay/src/models.rs`](native/gsm-overlay/src/models.rs)<br>[`native/gsm-downloads/src/lib.rs`](native/gsm-downloads/src/lib.rs)<br>[`native/gsm-packages/src/python.rs`](native/gsm-packages/src/python.rs)<br>[`GSM_Overlay/input_server/language/src/sudachi.rs`](GSM_Overlay/input_server/language/src/sudachi.rs) | Computes the hash required by the asset, protocol or integrity check at the cited site. |
| `shell-words` 1.1.1 | Shell argument parsing | [`src-tauri/src/obs/process.rs`](src-tauri/src/obs/process.rs)<br>[`native/gsm-mining/src/ffmpeg.rs`](native/gsm-mining/src/ffmpeg.rs) | Preserves quoted arguments when splitting user-specified options. |
| `smallvec` 1.16.5 | Inline vectors | [`native/gsm-history/src/recycled.rs`](native/gsm-history/src/recycled.rs)<br>gsm-intake · [`native/gsm-native/src/dialogue_journal.rs`](native/gsm-native/src/dialogue_journal.rs) | Keeps short, frequently allocated text or journal buffers inline. |
| `snap` 1.1.2 | Snappy decompression | [`native/gsm-dictionary-transfer/src/values.rs`](native/gsm-dictionary-transfer/src/values.rs) | Reads Snappy-compressed dictionary values during transfer. |
| `softbuffer` 0.4.8 | Software-rendered window buffers | [`scripts/OneShotOCR/src/overlay.rs`](scripts/OneShotOCR/src/overlay.rs) | Displays the standalone OCR selector's pixel buffer. |
| `sudachi` 0.6.10 | Japanese morphological analysis | [`GSM_Overlay/input_server/language/src/sudachi.rs`](GSM_Overlay/input_server/language/src/sudachi.rs) | Loads dictionaries and splits Japanese text into tokens. |
| `tar` 0.4.46 | Tar archive reader | [`native/gsm-packages/src/python.rs`](native/gsm-packages/src/python.rs) | Unpacks runtime distributions shipped in tar archives. |
| `tauri` 2.12.5 | Native desktop host | [`src-tauri/src/ocr.rs`](src-tauri/src/ocr.rs) | Provides the window lifecycle, command bridge, menus and tray integration. |
| `tauri-plugin-clipboard-manager` 2.5.0 | Clipboard command integration | [`src-tauri/src/main.rs`](src-tauri/src/main.rs) | Makes the host clipboard service available through the Tauri bridge. |
| `tauri-plugin-global-shortcut` 2.4.1 | Desktop shortcut integration | [`src-tauri/src/main.rs`](src-tauri/src/main.rs) | Registers the application's OS-level shortcut handlers. |
| `tauri-plugin-notification` 2.8.1 | Desktop notifications | [`src-tauri/src/main.rs`](src-tauri/src/main.rs) | Registers the notification service with the native application. |
| `tauri-plugin-single-instance` 2.5.5 | Single-instance handling | [`src-tauri/src/main.rs`](src-tauri/src/main.rs) | Routes repeat launches back to the existing desktop process. |
| `tauri-plugin-updater` 2.14.1 | Desktop updates | [`src-tauri/src/main.rs`](src-tauri/src/main.rs) | Registers signed-update handling with the native application. |
| `tempfile` 3.27.0 | Temporary files and directories | [`src-tauri/src/cron.rs`](src-tauri/src/cron.rs)<br>[`native/gsm-db/src/backup.rs`](native/gsm-db/src/backup.rs)<br>[`native/gsm-dictionary-transfer/src/lib.rs`](native/gsm-dictionary-transfer/src/lib.rs)<br>[`native/gsm-history/src/lib.rs`](native/gsm-history/src/lib.rs)<br>[`native/gsm-mining/src/vad.rs`](native/gsm-mining/src/vad.rs)<br>[`native/gsm-web/src/yomitan_characters/portraits.rs`](native/gsm-web/src/yomitan_characters/portraits.rs)<br>[`native/gsm-overlay/src/models.rs`](native/gsm-overlay/src/models.rs)<br>[`native/gsm-downloads/src/lib.rs`](native/gsm-downloads/src/lib.rs)<br>[`native/gsm-packages/src/speech.rs`](native/gsm-packages/src/speech.rs) | Owns cleanup of staging files, downloads and isolated test directories. |
| `tokio` 1.54.1 | Asynchronous runtime | [`src-tauri/src/cron.rs`](src-tauri/src/cron.rs)<br>[`native/gsm-mining/src/ai.rs`](native/gsm-mining/src/ai.rs)<br>[`native/gsm-runtime/src/lib.rs`](native/gsm-runtime/src/lib.rs) | Drives timers, sockets, tasks or synchronization used in the referenced module. |
| `tokio` 1.52.3 | Asynchronous runtime | [`GSM_Overlay/input_server/language/src/sudachi.rs`](GSM_Overlay/input_server/language/src/sudachi.rs)<br>[`GSM_Overlay/input_server/src/main.rs`](GSM_Overlay/input_server/src/main.rs) | Drives timers, sockets, tasks or synchronization used in the referenced module. |
| `tokio-tungstenite` 0.28.0 | Async WebSockets | [`src-tauri/src/smoke_test.rs`](src-tauri/src/smoke_test.rs)<br>[`native/gsm-mining/src/gateway.rs`](native/gsm-mining/src/gateway.rs)<br>[`native/gsm-runtime/src/lib.rs`](native/gsm-runtime/src/lib.rs) | Provides WebSocket connections that integrate with Tokio. |
| `tokio-tungstenite` 0.21.0 | Async WebSockets | [`GSM_Overlay/input_server/src/main.rs`](GSM_Overlay/input_server/src/main.rs) | Provides WebSocket connections that integrate with Tokio. |
| `toml` 1.2.1+spec-1.1.0 | TOML parsing | [`native/gsm-settings/src/profile_config/legacy.rs`](native/gsm-settings/src/profile_config/legacy.rs) (optional) | Reads TOML metadata for legacy profile import or package management. |
| `toml` 0.8.2 | TOML parsing | [`native/gsm-packages/src/python.rs`](native/gsm-packages/src/python.rs) | Reads TOML metadata for legacy profile import or package management. |
| `tower-http` 0.6.11 | HTTP file services | [`native/gsm-mining/src/gateway/reader_audio.rs`](native/gsm-mining/src/gateway/reader_audio.rs) | Serves reader audio through the existing file service. |
| `tracing` 0.1.44 | Structured diagnostics | [`GSM_Overlay/input_server/language/src/sudachi.rs`](GSM_Overlay/input_server/language/src/sudachi.rs)<br>[`GSM_Overlay/input_server/src/main.rs`](GSM_Overlay/input_server/src/main.rs) | Emits diagnostic events for input and language operations. |
| `tracing-subscriber` 0.3.23 | Tracing output subscriber | [`GSM_Overlay/input_server/src/main.rs`](GSM_Overlay/input_server/src/main.rs) | Connects the server's tracing events to formatted log output. |
| `trash` 5.2.9 | System trash integration | [`src-tauri/src/mining/clip_library.rs`](src-tauri/src/mining/clip_library.rs) | Moves deleted media to the user's recoverable trash. |
| `tray-icon` 0.24.2 | Native tray menus | [`scripts/OneShotOCR/src/app.rs`](scripts/OneShotOCR/src/app.rs) | Exposes the standalone OCR application's tray controls. |
| `tungstenite` 0.28.0 | Synchronous WebSockets | [`src-tauri/src/ocr/inputs.rs`](src-tauri/src/ocr/inputs.rs)<br>[`native/gsm-capture/src/obs.rs`](native/gsm-capture/src/obs.rs) | Provides the socket and message types used by synchronous capture clients. |
| `unicode-normalization` 0.1.26 | Unicode normalization | [`native/gsm-intake/src/stats.rs`](native/gsm-intake/src/stats.rs)<br>[`native/gsm-text-preview/src/lib.rs`](native/gsm-text-preview/src/lib.rs)<br>[`native/gsm-overlay/src/ocr.rs`](native/gsm-overlay/src/ocr.rs) | Normalizes text before matching, indexing or tokenization. |
| `unicode-normalization` 0.1.25 | Unicode normalization | [`GSM_Overlay/input_server/language/src/vocabulary.rs`](GSM_Overlay/input_server/language/src/vocabulary.rs) | Normalizes text before matching, indexing or tokenization. |
| `url` 2.5.8 | URL parsing and construction | [`src-tauri/src/agent.rs`](src-tauri/src/agent.rs)<br>[`native/gsm-history/src/kechimochi/metadata.rs`](native/gsm-history/src/kechimochi/metadata.rs)<br>[`native/gsm-mining/src/gateway/media_search.rs`](native/gsm-mining/src/gateway/media_search.rs) | Validates, encodes and resolves URLs using a structured representation. |
| `uuid` 1.29.2 | Unique identifiers | [`src-tauri/src/ocr.rs`](src-tauri/src/ocr.rs)<br>[`native/gsm-agent/src/core.rs`](native/gsm-agent/src/core.rs)<br>[`native/gsm-settings/src/lib.rs`](native/gsm-settings/src/lib.rs)<br>[`native/gsm-dictionary-transfer/src/lib.rs`](native/gsm-dictionary-transfer/src/lib.rs)<br>[`native/gsm-history/src/kizuna.rs`](native/gsm-history/src/kizuna.rs)<br>[`native/gsm-intake/src/lib.rs`](native/gsm-intake/src/lib.rs)<br>[`native/gsm-mining/src/policy.rs`](native/gsm-mining/src/policy.rs)<br>[`native/gsm-web/src/kechimochi.rs`](native/gsm-web/src/kechimochi.rs)<br>[`native/gsm-overlay/src/models.rs`](native/gsm-overlay/src/models.rs)<br>[`native/gsm-packages/src/speech.rs`](native/gsm-packages/src/speech.rs)<br>[`native/gsm-runtime/src/lib.rs`](native/gsm-runtime/src/lib.rs) | Creates identifiers for records, jobs, temporary names or transfer snapshots. |
| `web_atoms` 0.3.0 | HTML parsing tables | [`src-tauri/src/anki_group/markup.rs`](src-tauri/src/anki_group/markup.rs) | Provides the standard character-reference replacements used for Anki markup. |
| `webview2-com` 0.39.1 | Windows WebView2 bindings | [`src-tauri/src/memory.rs`](src-tauri/src/memory.rs) (windows) | Calls the embedded browser's native controller APIs. |
| `winapi` 0.3.9 | Windows SDK bindings | [`GSM_Overlay/input_server/src/main.rs`](GSM_Overlay/input_server/src/main.rs) (windows)<br>[`native/windows-audio-capture/src/main.rs`](native/windows-audio-capture/src/main.rs) | Calls Windows input and audio interfaces from the standalone helpers. |
| `windows` 0.62.2 | Windows platform APIs | [`src-tauri/src/tray.rs`](src-tauri/src/tray.rs) (windows)<br>[`native/gsm-capture/src/wgc.rs`](native/gsm-capture/src/wgc.rs) (windows)<br>[`native/gsm-overlay/src/models/oneocr.rs`](native/gsm-overlay/src/models/oneocr.rs) (windows)<br>[`native/gsm-texthook/src/target.rs`](native/gsm-texthook/src/target.rs) (windows) | Uses typed Win32 or WinRT operations for the referenced desktop feature. |
| `windows-sys` 0.61.2 | Low-level Win32 bindings | [`native/gsm-settings/src/lib.rs`](native/gsm-settings/src/lib.rs) (windows)<br>[`native/gsm-runtime/src/process.rs`](native/gsm-runtime/src/process.rs) (windows) | Provides the native process, library or window operations used on Windows. |
| `windows-sys` 0.59.0 | Low-level Win32 bindings | [`native/gsm-overlay/src/scheduling.rs`](native/gsm-overlay/src/scheduling.rs) (windows)<br>[`scripts/OneShotOCR/src/overlay.rs`](scripts/OneShotOCR/src/overlay.rs) (windows) | Provides the native process, library or window operations used on Windows. |
| `winit` 0.30.13 | Window and event loop | [`scripts/OneShotOCR/src/app.rs`](scripts/OneShotOCR/src/app.rs) | Drives standalone OCR selection windows and native input events. |
| `xcap` 0.9.10 | Screen and window capture | [`src-tauri/src/overlay.rs`](src-tauri/src/overlay.rs)<br>[`native/gsm-capture/src/lib.rs`](native/gsm-capture/src/lib.rs) | Enumerates or captures the selected monitor or window. |
| `xcap` 0.9.7 | Screen and window capture | [`scripts/OneShotOCR/src/capture.rs`](scripts/OneShotOCR/src/capture.rs) | Enumerates or captures the selected monitor or window. |
| `zip` 4.6.1 | ZIP archives | [`src-tauri/src/smoke_test.rs`](src-tauri/src/smoke_test.rs)<br>[`native/gsm-history/src/game_archive.rs`](native/gsm-history/src/game_archive.rs)<br>[`native/gsm-web/src/yomitan_frequency.rs`](native/gsm-web/src/yomitan_frequency.rs)<br>[`native/gsm-packages/src/lib.rs`](native/gsm-packages/src/lib.rs) | Reads or writes packaged assets, exports, dictionaries or backups. |
| `zip` 2.6.1 | ZIP archives | [`native/gsm-overlay/src/models.rs`](native/gsm-overlay/src/models.rs) | Reads or writes packaged assets, exports, dictionaries or backups. |
| `zip` 2.4.2 | ZIP archives | [`GSM_Overlay/input_server/language/src/sudachi.rs`](GSM_Overlay/input_server/language/src/sudachi.rs) | Reads or writes packaged assets, exports, dictionaries or backups. |

#### Native, packaging and vendor inputs

| Package | Purpose | Usage | Justification |
| --- | --- | --- | --- |
| `Hachidori` 0.5.0 | Dictionary lookup | [`GSM_Overlay/hachidori/manifest.json`](GSM_Overlay/hachidori/manifest.json) | The overlay integrates this extension through the GSM Hachidori bridge. |
| `Jiten Reader` 1.3.3 | Reader integration | [`GSM_Overlay/jiten.reader/manifest.json`](GSM_Overlay/jiten.reader/manifest.json) | The overlay ships the reader extension and its lookup scripts. |
| `Jiten.Parser rewrite rules` a2fd4a6ccbbc | Japanese morphological rewrite rules | [`GSM_Overlay/third_party/jiten-parser/manifest.json`](GSM_Overlay/third_party/jiten-parser/manifest.json) | The input server applies the imported rules in language/src/jiten_rules.rs. |
| `libasound2t64 or libasound2` distribution version | ALSA output | [`src-tauri/tauri.bundle.conf.json`](src-tauri/tauri.bundle.conf.json) | Provides the audio library on both sides of the distribution ABI transition. |
| `libayatana-appindicator3-1` distribution version | System tray | [`src-tauri/tauri.bundle.conf.json`](src-tauri/tauri.bundle.conf.json) | Exposes the Linux tray indicator. |
| `libwebkit2gtk-4.1-0` distribution version | Linux webview | [`src-tauri/tauri.bundle.conf.json`](src-tauri/tauri.bundle.conf.json) | Renders the Tauri UI on GTK. |
| `libxdo3` distribution version | Desktop input integration | [`src-tauri/tauri.bundle.conf.json`](src-tauri/tauri.bundle.conf.json) | Supplies the shared X11 input library declared by the bundle. |
| `Microsoft.CognitiveServices.Speech` 1.41.1 | Windows embedded speech recognition | [`native/windows-speech-recognition/CMakeLists.txt`](native/windows-speech-recognition/CMakeLists.txt) | The helper links the SDK and delay-loads its core DLL. The pinned ABI matches the embedded speech runtime. |
| `MinHook` 1.3.4 | Native hook support | [`native/game-background-hooks/CMakeLists.txt`](native/game-background-hooks/CMakeLists.txt) | Compiled into the Windows helper DLL. The vendored version and license are recorded in NOTICE.md. |
| `vita-vn-ocr` b02e81205fa4 / 205f47ec4e56 | OCR recognizer and spotter | [`native/vita-ocr/CMakeLists.txt`](native/vita-ocr/CMakeLists.txt) | The C targets compile verified upstream sources. desktop-source-lock.json and source-lock.json pin the desktop and original source revisions. |
| `Yomitan` 26.11.10.0 | Dictionary lookup | [`GSM_Overlay/yomitan/manifest.json`](GSM_Overlay/yomitan/manifest.json) | The overlay loads the vendored extension and its dictionary assets. |

### Development, build and test

#### JavaScript

| Package | Purpose | Usage | Justification |
| --- | --- | --- | --- |
| `@electron-forge/plugin-fuses` 8.0.1 | Packaging fuse plugin | GSM_Overlay · [`GSM_Overlay/forge.config.js`](GSM_Overlay/forge.config.js) | Imported when package-config tests load the Forge configuration. |
| `@electron/asar` 3.4.1 | ASAR inspection | Root · [`scripts/verify-overlay-package.mjs`](scripts/verify-overlay-package.mjs) | Extracts files from packaged Electron archives during verification. |
| `@electron/fuses` 2.1.3 | Fuse settings and enums | GSM_Overlay · [`GSM_Overlay/forge.config.js`](GSM_Overlay/forge.config.js) | The Forge config and its plugin share this API when selecting binary fuses. |
| `@sveltejs/vite-plugin-svelte` 7.3.1 | Svelte compilation | texthooker · [`texthooker/svelte.config.js`](texthooker/svelte.config.js) | Compiles Svelte components through Vite for both app and library builds. |
| `@tailwindcss/vite` 4.3.3 | Tailwind build integration | Root · [`electron-src/renderer/vite.config.ts`](electron-src/renderer/vite.config.ts)<br>texthooker · [`texthooker/vite.main.config.ts`](texthooker/vite.main.config.ts) | Adds Tailwind CSS compilation to the Vite build. |
| `@tauri-apps/cli` 2.12.4 | Native desktop CLI | Root · [`scripts/build-native-desktop.mjs`](scripts/build-native-desktop.mjs) | Runs the configured Tauri development and packaging commands. |
| `@tsconfig/svelte` 5.0.8 | Compiler settings | texthooker · [`texthooker/tsconfig.json`](texthooker/tsconfig.json) | Supplies the base TypeScript configuration extended by texthooker. |
| `@types/archiver` 7.0.0 | Archive API declarations | Root · [`electron-src/main/services/log_archive.ts`](electron-src/main/services/log_archive.ts) | Type-checks archiver calls in Electron main-process code. |
| `@types/node` 26.4.0 | Node API declarations | Root · [`tsconfig.electron.json`](tsconfig.electron.json) | Provides types for Node built-ins, streams and the Electron build scripts. |
| `@types/react` 19.2.18 | React and JSX declarations | Root · [`electron-src/renderer/src/App.tsx`](electron-src/renderer/src/App.tsx) | Type-checks JSX elements, component props and hooks. |
| `@types/react-dom` 19.2.3 | DOM renderer declarations | Root · [`electron-src/renderer/src/main.tsx`](electron-src/renderer/src/main.tsx) | Types createRoot and DOM portal calls. |
| `@types/semver` 7.7.1 | Version parser declarations | Root · [`electron-src/main/services/update_manager.ts`](electron-src/main/services/update_manager.ts) | Types version parsing and comparison in the main process. |
| `@types/sortablejs` 1.15.9 | SortableJS declarations | texthooker · [`texthooker/src/components/ReplacementSettingsList.svelte`](texthooker/src/components/ReplacementSettingsList.svelte) | Types list-reorder callbacks in the Svelte settings component. |
| `@types/yauzl` 3.4.0 | ZIP reader declarations | Root · [`electron-src/main/services/zip_extract.ts`](electron-src/main/services/zip_extract.ts) | Types entry and stream callbacks in the main-process ZIP reader. |
| `@vitejs/plugin-react` 6.1.0 | React build integration | Root · [`electron-src/renderer/vite.config.ts`](electron-src/renderer/vite.config.ts) | Transforms JSX and provides React refresh in Vite. |
| `daisyui` 5.7.22 | UI theme and components | Root · [`electron-src/renderer/src/theme.css`](electron-src/renderer/src/theme.css) | Supplies the component classes and themes loaded by the stylesheet. |
| `daisyui` 5.7.50 | UI theme and components | texthooker · [`texthooker/src/app.css`](texthooker/src/app.css) | Supplies the component classes and themes loaded by the stylesheet. |
| `electron` 43.8.3 | Electron desktop host | Root · [`electron-src/main/main.ts`](electron-src/main/main.ts)<br>GSM_Overlay · [`GSM_Overlay/main.js`](GSM_Overlay/main.js) | Provides the legacy host APIs and executable used by integration tests. |
| `electron-log` 5.4.4 | Desktop logging | Root · [`electron-src/main/main.ts`](electron-src/main/main.ts) | Routes legacy main-process diagnostics through the configured logging transports. |
| `electron-store` 11.0.2 | Persistent settings | Root · [`electron-src/main/store.ts`](electron-src/main/store.ts) | Reads and writes settings in the compatibility host. |
| `electron-updater` 6.8.9 | Electron update client | Root · [`electron-src/main/update.ts`](electron-src/main/update.ts) | Implements the legacy update flow that remains compiled and tested. |
| `frida` 17.17.0 | Native instrumentation bindings | Root · [`electron-src/main/engine_hooks/session.ts`](electron-src/main/engine_hooks/session.ts) | Provides the native session API used by the legacy main process. |
| `jsdom` 30.0.1 | DOM test environment | Root · [`tests/web/tadoku_sync.test.cjs`](tests/web/tadoku_sync.test.cjs) | Runs browser-component tests under Node with document and event APIs. |
| `jsdom` 30.1.3 | DOM test environment | texthooker · [`texthooker/vitest.config.ts`](texthooker/vitest.config.ts) | Runs browser-component tests under Node with document and event APIs. |
| `png-to-ico` 3.0.2 | Windows icon encoder | Root · [`scripts/generate_icons.js`](scripts/generate_icons.js) | Builds the multi-resolution Windows icon from source PNGs. |
| `prettier` 3.9.10 | Source formatting | texthooker · [`texthooker/.prettierrc`](texthooker/.prettierrc) | Applies the checked-in texthooker formatting configuration for contributors. |
| `sharp` 0.35.5 | Image processing | Root · [`scripts/generate_icons.js`](scripts/generate_icons.js) | Resizes source artwork to the resolutions required by the icon generator. |
| `svelte-check` 4.7.7 | Svelte diagnostics | texthooker · [`.github/workflows/test_texthooker.yml`](.github/workflows/test_texthooker.yml) | CI checks component markup, bindings and TypeScript together. |
| `tailwindcss` 4.3.3 | CSS generation | Root · [`electron-src/renderer/src/styles.css`](electron-src/renderer/src/styles.css)<br>texthooker · [`texthooker/src/app.css`](texthooker/src/app.css) | Compiles the utility classes referenced by the UI. |
| `tar` 7.5.22 | Tar extraction | Root · [`scripts/test-native-transfer.mjs`](scripts/test-native-transfer.mjs) (test script, declared in dependencies) | Unpacks archives for the native transfer check. |
| `typescript` 6.0.3 | TypeScript compiler | Root · [`tsconfig.electron.json`](tsconfig.electron.json)<br>texthooker · [`texthooker/tsconfig.json`](texthooker/tsconfig.json) | Checks the project's types or emits its main-process JavaScript. |
| `vite` 8.3.5 | Web build and dev server | Root · [`electron-src/renderer/vite.config.ts`](electron-src/renderer/vite.config.ts)<br>GSM_Overlay · [`GSM_Overlay/package.json`](GSM_Overlay/package.json)<br>texthooker · [`texthooker/vite.main.config.ts`](texthooker/vite.main.config.ts) | Builds or serves the renderer with the project's configured plugins. |
| `vite-plugin-singlefile` 2.3.4 | Single-file output | texthooker · [`texthooker/vite.main.config.ts`](texthooker/vite.main.config.ts) | Inlines the bundle so GSM can serve the text feed from a single HTML template. |
| `vitest` 4.1.12 | Component and unit tests | Root · [`vitest.config.ts`](vitest.config.ts)<br>texthooker · [`texthooker/vitest.config.ts`](texthooker/vitest.config.ts) | Discovers the configured suites and supplies mocks and assertions. |

#### Rust

| Package | Purpose | Usage | Justification |
| --- | --- | --- | --- |
| `flate2` 1.1.11 | DEFLATE, gzip and zlib streams | [`native/gsm-web/build.rs`](native/gsm-web/build.rs) (build) | Reads or produces the compressed representation expected by the consumer. |
| `gsm-db` 0.1.0 | SQLite schema and migration | [`native/gsm-mining/src/gateway.rs`](native/gsm-mining/src/gateway.rs)<br>[`native/gsm-web/examples/report_benchmark.rs`](native/gsm-web/examples/report_benchmark.rs) | Uses the same database initialization and migration code as the desktop. |
| `rusqlite` 0.32.1 | SQLite bindings | [`src-tauri/src/cron.rs`](src-tauri/src/cron.rs)<br>[`native/gsm-web/examples/report_benchmark.rs`](native/gsm-web/examples/report_benchmark.rs) | Executes typed SQLite queries, migrations or fixture setup against the application schema. |
| `serde_json` 1.0.154 | JSON encoding and decoding | [`native/gsm-web/build.rs`](native/gsm-web/build.rs) (build) | Reads and writes the JSON values used at configuration, storage or service boundaries. |
| `sha2` 0.10.9 | SHA-2 digests | [`native/gsm-agent/build.rs`](native/gsm-agent/build.rs) (build)<br>[`native/gsm-web/build.rs`](native/gsm-web/build.rs) (build) | Computes the hash required by the asset, protocol or integrity check at the cited site. |
| `tauri-build` 2.7.4 | Tauri build integration | [`src-tauri/build.rs`](src-tauri/build.rs) (build) | Generates the native application resources and build-time configuration. |
| `tauri-winres` 0.3.7 | Windows resource generation | [`GSM_Overlay/input_server/build.rs`](GSM_Overlay/input_server/build.rs) (build) | Builds the input server's Windows executable resources. |
| `tempfile` 3.27.0 | Temporary files and directories | [`native/gsm-settings/src/paths.rs`](native/gsm-settings/src/paths.rs)<br>[`native/gsm-text-preview/tests/hook_ranking.rs`](native/gsm-text-preview/tests/hook_ranking.rs) | Owns cleanup of staging files, downloads and isolated test directories. |
| `tokio` 1.54.1 | Asynchronous runtime | [`native/gsm-intake/examples/clipboard_notify.rs`](native/gsm-intake/examples/clipboard_notify.rs) (windows)<br>[`native/gsm-mining/src/ai.rs`](native/gsm-mining/src/ai.rs) | Drives timers, sockets, tasks or synchronization used in the referenced module. |
| `windows` 0.62.2 | Windows platform APIs | gsm-intake · [`src-tauri/src/text_intake/clipboard_windows.rs`](src-tauri/src/text_intake/clipboard_windows.rs) (windows) | Uses typed Win32 or WinRT operations for the referenced desktop feature. |

#### Native, packaging and vendor inputs

| Package | Purpose | Usage | Justification |
| --- | --- | --- | --- |
| `flake-utils` 11707dc2f618 | Per-platform flake outputs | [`texthooker/flake.nix`](texthooker/flake.nix) (build) | eachDefaultSystem generates the build and development-shell outputs. |
| `Frida Core devkit` 17.16.4 | Native agent ABI | [`native/gsm-agent/build.rs`](native/gsm-agent/build.rs) (build) | The runtime-feature build verifies and links a platform-specific devkit. Its ABI pin is independent of the npm client. |

## Flagged for Review

### Needs review

| Declaration | Package | Evidence | Finding and recommendation |
| --- | --- | --- | --- |
| `package.json` | `koffi` 3.3.7 | [`GSM_Overlay/magpie_native.js`](GSM_Overlay/magpie_native.js) | The overlay directly declares the Windows FFI library. A root-only install can supply it to the hosted overlay via Node resolution. Test root-only Electron hosting on Windows before deduplicating. |
| `package.json` | `pinyin-pro` 3.29.5 | [`GSM_Overlay/reading_overlay_utils.js`](GSM_Overlay/reading_overlay_utils.js) | The Electron overlay resolves this optional import from its own or its parent install. Tauri embeds a vendor copy. Verify Chinese readings in both hosts with only root dependencies installed before removing the fallback. |
| `package.json` | `electron-builder` 26.18.0 | [`scripts/electron-dev-runtime.cjs`](scripts/electron-dev-runtime.cjs) | Restored after a clean install broke electron_dev_runtime.test.ts. The Windows branding helper calls app-builder-lib/out/util/resEdit.js and the test resolves resedit through app-builder-lib. Keep the override with the builder. A future refactor can depend directly on the resource editor. |
| `GSM_Overlay/package.json` | `@electron-forge/cli` 8.0.1 | [`GSM_Overlay/forge.config.js`](GSM_Overlay/forge.config.js) | The config and its tests still exist, but package and make delegate to Tauri. Confirm whether maintainers still invoke Forge directly. |
| `GSM_Overlay/package.json` | `@electron-forge/maker-deb` 8.0.1 | [`GSM_Overlay/forge.config.js`](GSM_Overlay/forge.config.js) | Forge resolves this configured platform maker by name. The normal packaging scripts now delegate to Tauri. Confirm the standalone Forge workflow before retiring it. |
| `GSM_Overlay/package.json` | `@electron-forge/maker-rpm` 8.0.1 | [`GSM_Overlay/forge.config.js`](GSM_Overlay/forge.config.js) | Forge resolves this configured platform maker by name. The normal packaging scripts now delegate to Tauri. Confirm the standalone Forge workflow before retiring it. |
| `GSM_Overlay/package.json` | `@electron-forge/maker-squirrel` 8.0.1 | [`GSM_Overlay/forge.config.js`](GSM_Overlay/forge.config.js) | Forge resolves this configured platform maker by name. The normal packaging scripts now delegate to Tauri. Confirm the standalone Forge workflow before retiring it. |
| `GSM_Overlay/package.json` | `@electron-forge/maker-zip` 8.0.1 | [`GSM_Overlay/forge.config.js`](GSM_Overlay/forge.config.js) | Forge resolves this configured platform maker by name. The normal packaging scripts now delegate to Tauri. Confirm the standalone Forge workflow before retiring it. |
| `GSM_Overlay/package.json` | `@electron-forge/plugin-auto-unpack-natives` 8.0.1 | [`GSM_Overlay/forge.config.js`](GSM_Overlay/forge.config.js) | Forge resolves this configured native-module unpacking plugin by name. The normal packaging scripts now delegate to Tauri. Confirm the standalone Forge workflow before retiring it. |
| `texthooker/package.json` | `eslint` 10.13.0 | [`texthooker/.eslintrc.cjs`](texthooker/.eslintrc.cjs) | ESLint 10 cannot discover the legacy configuration. Decide whether to migrate the linter or retire it. |
| `texthooker/package.json` | `eslint-config-prettier` 10.1.8 | [`texthooker/.eslintrc.cjs`](texthooker/.eslintrc.cjs) | The legacy config extends prettier and prettier/@typescript-eslint. Reassess both entries with the ESLint migration. |
| `texthooker/package.json` | `eslint-plugin-svelte3` 4.0.0 | [`texthooker/.eslintrc.cjs`](texthooker/.eslintrc.cjs) | Configured as the Svelte processor. Review its Svelte 5 and flat-config support together with the linter migration. |
| `texthooker/package.json` | `rollup` 4.65.0 | [`texthooker/vite.main.config.ts`](texthooker/vite.main.config.ts) | The locked single-file plugin declares Rollup as an optional peer and the pnpm importer resolves that peer. Verify output and plugin types without the peer before removing it. |
| `.gitmodules` | `OneShotOCR` c87f413ce502 | [`.gitmodules`](.gitmodules) | The selector cites the upstream implementation and benchmarks use the reference capture code. Confirm the benchmark workflow before dropping this checkout. |
| `texthooker/flake.nix` | `nixpkgs` 799ba5bffed0 | [`texthooker/flake.nix`](texthooker/flake.nix) | Supplies the stdenv, Node and pnpm fetcher. The pin selects Node 22.12.0, below the app’s minimum, and pnpm 11.9.0 rejects this Node version at startup. Review this toolchain and revalidate the dependency hash together. |
| `.github/workflows/native_desktop.yml` | `libnss3` (distribution version) | [`.github/workflows/native_desktop.yml`](.github/workflows/native_desktop.yml) | Explicit install for the Linux browser stack. Test the smoke suite on a clean Linux runner to establish whether the webview prerequisites already install it. |
| `.github/workflows/native_desktop.yml` | `libnspr4` (distribution version) | [`.github/workflows/native_desktop.yml`](.github/workflows/native_desktop.yml) | Explicit install for the Linux browser stack. Test the smoke suite on a clean Linux runner to establish whether the webview prerequisites already install it. |

The native CI handoff also tested consolidating ZIP major versions and enabling Tokio for Linux portal dialogs. The existing ZIP readers are active. The removals in this audit do not require a major upgrade. Changing the portal features still needs a Linux file-chooser test. [Native dependency candidates](docs/NATIVE_CI_HANDOFF.md#native-dependency-candidates)

## Build and CI inputs

The native desktop workflow installs the GTK/WebKit, AppIndicator, RSVG, X11/XCB, GBM, PipeWire, ALSA, udev, Clang and NSS/NSPR development or runtime libraries. Its packaging and UI checks use patchelf, FUSE, Xvfb and Openbox. Release publication uses rclone. The standalone Linux input-server workflow also installs pkg-config and the X11/XTest development libraries. The Windows CMake targets link SDK-provided user32, dxguid, version, delayimp, ole32, windowsapp and SAPI. Unix OCR builds link libm. [`.github/workflows/native_desktop.yml`](.github/workflows/native_desktop.yml) · [`.github/workflows/build_overlay_server.yml`](.github/workflows/build_overlay_server.yml)

The CI subtotal counts each action and explicitly installed Linux package once across workflows. The action version column preserves all referenced tags and revisions.

| Action | Declared version or revision | Purpose | Workflow evidence |
| --- | --- | --- | --- |
| `actions/checkout` | `v4`, `v7`, `3d3c42e5aac5ba805825da76410c181273ba90b1` | Check out source and requested submodules | [`.github/workflows/build_overlay_server.yml`](.github/workflows/build_overlay_server.yml)<br>[`.github/workflows/build_vocr_runtime.yml`](.github/workflows/build_vocr_runtime.yml)<br>[`.github/workflows/generate-star-history.yml`](.github/workflows/generate-star-history.yml)<br>[`.github/workflows/native_desktop.yml`](.github/workflows/native_desktop.yml)<br>[`.github/workflows/test_texthooker.yml`](.github/workflows/test_texthooker.yml)<br>[`.github/workflows/update-hachidori.yml`](.github/workflows/update-hachidori.yml)<br>[`GSM_Overlay/.github/workflows/run_build.yml`](GSM_Overlay/.github/workflows/run_build.yml) |
| `dtolnay/rust-toolchain` | `stable` | Install the Rust compiler and required targets | [`.github/workflows/build_overlay_server.yml`](.github/workflows/build_overlay_server.yml)<br>[`.github/workflows/native_desktop.yml`](.github/workflows/native_desktop.yml) |
| `Swatinem/rust-cache` | `v2` | Restore Rust build caches | [`.github/workflows/build_overlay_server.yml`](.github/workflows/build_overlay_server.yml)<br>[`.github/workflows/native_desktop.yml`](.github/workflows/native_desktop.yml) |
| `actions/upload-artifact` | `v4` | Preserve test and release outputs | [`.github/workflows/build_overlay_server.yml`](.github/workflows/build_overlay_server.yml)<br>[`.github/workflows/build_vocr_runtime.yml`](.github/workflows/build_vocr_runtime.yml)<br>[`.github/workflows/native_desktop.yml`](.github/workflows/native_desktop.yml)<br>[`GSM_Overlay/.github/workflows/run_build.yml`](GSM_Overlay/.github/workflows/run_build.yml) |
| `signpath/github-action-submit-signing-request` | `b9d91eadd323de506c0c81cf0c7fe7438f3360fd` | Submit Windows release artifacts for signing | [`.github/workflows/build_overlay_server.yml`](.github/workflows/build_overlay_server.yml)<br>[`.github/workflows/native_desktop.yml`](.github/workflows/native_desktop.yml) |
| `actions/download-artifact` | `v4` | Collect outputs from other jobs | [`.github/workflows/build_overlay_server.yml`](.github/workflows/build_overlay_server.yml)<br>[`.github/workflows/native_desktop.yml`](.github/workflows/native_desktop.yml) |
| `softprops/action-gh-release` | `v2` | Publish compiled artifacts to GitHub Releases | [`.github/workflows/build_overlay_server.yml`](.github/workflows/build_overlay_server.yml) |
| `kitswas/generate-star-history` | `v1` | Generate the repository history graphic | [`.github/workflows/generate-star-history.yml`](.github/workflows/generate-star-history.yml) |
| `actions/setup-node` | `v4`, `820762786026740c76f36085b0efc47a31fe5020` | Select the configured Node runtime and dependency cache | [`.github/workflows/native_desktop.yml`](.github/workflows/native_desktop.yml)<br>[`.github/workflows/test_texthooker.yml`](.github/workflows/test_texthooker.yml)<br>[`.github/workflows/update-hachidori.yml`](.github/workflows/update-hachidori.yml)<br>[`GSM_Overlay/.github/workflows/run_build.yml`](GSM_Overlay/.github/workflows/run_build.yml) |
| `pnpm/action-setup` | `v4` | Install pnpm for texthooker CI | [`.github/workflows/test_texthooker.yml`](.github/workflows/test_texthooker.yml) |
| `peter-evans/create-pull-request` | `5f6978faf089d4d20b00c7766989d076bb2fc7f1` | Propose an upstream Hachidori sync | [`.github/workflows/update-hachidori.yml`](.github/workflows/update-hachidori.yml) |

### Linux runner packages

Versions come from the runner’s distribution. The input-server and desktop jobs both name libudev-dev.

| Package | Purpose and reason for installation | Workflow | Decision |
| --- | --- | --- | --- |
| `libwebkit2gtk-4.1-dev` | WebKitGTK headers for the embedded webview | [`.github/workflows/native_desktop.yml`](.github/workflows/native_desktop.yml) | Keep |
| `libayatana-appindicator3-dev` | Tray indicator headers | [`.github/workflows/native_desktop.yml`](.github/workflows/native_desktop.yml) | Keep |
| `librsvg2-dev` | SVG rendering support in the GTK stack | [`.github/workflows/native_desktop.yml`](.github/workflows/native_desktop.yml) | Keep |
| `libxdo-dev` | X11 input support | [`.github/workflows/native_desktop.yml`](.github/workflows/native_desktop.yml) | Keep |
| `libgbm-dev` | Graphics buffer management for desktop capture | [`.github/workflows/native_desktop.yml`](.github/workflows/native_desktop.yml) | Keep |
| `libpipewire-0.3-dev` | PipeWire capture and media integration | [`.github/workflows/native_desktop.yml`](.github/workflows/native_desktop.yml) | Keep |
| `libclang-dev` | Clang library for native binding generation | [`.github/workflows/native_desktop.yml`](.github/workflows/native_desktop.yml) | Keep |
| `libudev-dev` | Linux input-device discovery | [`.github/workflows/native_desktop.yml`](.github/workflows/native_desktop.yml)<br>[`.github/workflows/build_overlay_server.yml`](.github/workflows/build_overlay_server.yml) | Keep |
| `libxcb-randr0-dev` | X11 display and monitor geometry | [`.github/workflows/native_desktop.yml`](.github/workflows/native_desktop.yml) | Keep |
| `libxcb-shm0-dev` | X11 shared-memory screen capture | [`.github/workflows/native_desktop.yml`](.github/workflows/native_desktop.yml) | Keep |
| `libxcb-xfixes0-dev` | X11 cursor and window capture support | [`.github/workflows/native_desktop.yml`](.github/workflows/native_desktop.yml) | Keep |
| `libxcb-shape0-dev` | X11 window-shape support | [`.github/workflows/native_desktop.yml`](.github/workflows/native_desktop.yml) | Keep |
| `libnspr4` | Portable runtime used by the browser libraries | [`.github/workflows/native_desktop.yml`](.github/workflows/native_desktop.yml) | Review |
| `libnss3` | Browser security and certificate libraries | [`.github/workflows/native_desktop.yml`](.github/workflows/native_desktop.yml) | Review |
| `libasound2-dev` | ALSA headers for the desktop audio backend | [`.github/workflows/native_desktop.yml`](.github/workflows/native_desktop.yml) | Keep |
| `patchelf` | Set ELF metadata when bundling Linux binaries | [`.github/workflows/native_desktop.yml`](.github/workflows/native_desktop.yml) | Keep |
| `xvfb` | Virtual display for graphical smoke tests | [`.github/workflows/native_desktop.yml`](.github/workflows/native_desktop.yml) | Keep |
| `openbox` | Window manager for graphical smoke tests | [`.github/workflows/native_desktop.yml`](.github/workflows/native_desktop.yml) | Keep |
| `libfuse2` | Run packaged AppImages | [`.github/workflows/native_desktop.yml`](.github/workflows/native_desktop.yml) | Keep |
| `rclone` | Publish staged release files | [`.github/workflows/native_desktop.yml`](.github/workflows/native_desktop.yml) | Keep |
| `pkg-config` | Discover installed native libraries during the Rust build | [`.github/workflows/build_overlay_server.yml`](.github/workflows/build_overlay_server.yml) | Keep |
| `libx11-dev` | X11 client development headers | [`.github/workflows/build_overlay_server.yml`](.github/workflows/build_overlay_server.yml) | Keep |
| `libxtst-dev` | XTest input development headers | [`.github/workflows/build_overlay_server.yml`](.github/workflows/build_overlay_server.yml) | Keep |


## Verification

Verification on Windows used the working tree, including edits that were already present, and disposable installs for the final npm and pnpm graphs. The tracked lockfile comparison found **zero new package versions**. Fourteen declarations were removed. The overlay gained one declaration for the existing `dirs` version. The two npm locks shed 2 and 69 distinct package/version pairs respectively, including an extraneous overlay lock entry for the parent checkout. The pnpm lock shed one. The desktop Cargo lock dropped `directories` entirely. Other consumers retain the crates whose direct declarations were removed elsewhere.

| Check | Result |
| --- | --- |
| Desktop and helpers | `npm run build:tauri -- --debug`, `npm run build:main` and `npm run build:windows-helpers` passed. Both Vita OCR DLLs compiled from checksum-verified desktop source. |
| JavaScript installs | Clean `npm ci` passed for both npm projects. The texthooker install passed with pnpm 11.9.0 and `--frozen-lockfile`. The restored Electron branding test passed with the final root lock. |
| Texthooker | Both Vite builds passed. All 19 Node tests and 78 Vitest tests passed. `check:types` passed. `svelte-check` reported 0 errors and 24 warnings. |
| Rust tests | `cargo test --workspace --exclude gsm-agent --locked --no-fail-fast -- --test-threads=1 --skip python` passed 678 tests. A separate `cargo test -p gsm-agent --locked` passed 11. An all-members invocation unified the agent runtime with desktop SQLite and failed to link duplicate symbols. CI likewise tests the agent separately. |
| Standalone Rust and C++ | The input-server workspace passed 69 tests, Windows audio passed 7 and the game-background fixture checks passed across x86 and x64. OneShotOCR compiled and its all-features test target reported 0 tests. |
| Desktop Vitest | A clean final install with the matching generated theme passed **1,644 of 1,646**. Both failures are in `overlay-translation-controls.test.ts`, where the fixture lacks `setOverlaySettingValue`. Both also failed before pruning. With the checkout’s pre-existing installed packages, the same five files failed before and after pruning (11 failed tests and a Frida binding load error). |
| Node tests | All 19 web tests passed. Overlay had 730 passes, one skip and one failing Jiten highlight test. The failure also reproduced on the original overlay lock. Repository scripts passed 51 of 52. The Hachidori fingerprint assertion disagrees with the existing bridge edits. |
| Electron smoke tests | 12 of 13 scenarios passed at least once with the final overlay dependencies. The Magpie reorder assertion failed with both lockfiles. The VN guide failed intermittently with `UnknownVizError` on both graphs. Dictionary setup passed on retry. |
| Native desktop smoke tests | The default Windows stack overflowed in the settings scenario on both the pre-audit and rebuilt binaries. With `RUST_MIN_STACK=16777216`, 15 of 17 scenarios passed, including all four transfer cases. Yomitan and Hachidori home-screen checks still expected a transcript marker while the reader displayed the game-selection prompt. |
| Lint | Input-server Clippy passed with warnings. Workspace Clippy failed on the existing `while ready` loop at `src-tauri/src/text_intake/hotkeys.rs:116`. Texthooker ESLint failed before and after pruning because ESLint 10 expects a flat config and the project supplies `.eslintrc.cjs`. |
| Nix | Both the original and final Linux flake builds stalled during dependency fetching. In an isolated reproduction, the project’s pnpm 11.9.0 exited before installation on the flake’s Node 22.12.0 because pnpm requires Node 22.13 or later. Texthooker and its locked jsdom require at least Node 22.22.2 on the Node 22 line. Verifying the fixed-output hash requires a compatible Nix toolchain. |

The Windows build and the individual results above are verified. A repository-wide green build, lint and test result remains outstanding.
