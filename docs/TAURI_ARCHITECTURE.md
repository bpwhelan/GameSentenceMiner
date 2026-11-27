# Tauri architecture and development

This document records the migration at the time it was written. For current source locations and development commands, see the [repository map](AI_AGENT_MAP.md).

## Recovery checkpoint

The complete pre-redesign tree is commit **7a87ee32** (`Tauri rewrite`) on
`codex/tauri-rewrite`, branched from `main` at `cc3e429e`. The redesign lives on
`codex/tauri-architecture` as **uncommitted changes**. No user data migration is
part of this change.

To inspect the original without disturbing this work:

```powershell
git worktree add ../GSM-tauri-checkpoint codex/tauri-rewrite
git diff codex/tauri-rewrite -- src-tauri package.json scripts
```

To restore an individual implementation after saving any wanted edits, use
`git restore --source=7a87ee32 -- <paths>` with the paths listed below. Do not
restore the entire checkout unless you intend to discard all redesign work.

## Ownership

The Tauri core (`gsm-desktop`) is a pure-Rust host with zero Node runtime and
owns application/service lifetimes. UI windows consume those services through
commands; hiding a window does not shut down a shared dictionary engine. For
the full subsystem-by-subsystem responsibility catalogue across Rust crates,
PyO3 `_native`, standalone native helpers, Python, and WebView UIs, see
[AI_AGENT_MAP.md](AI_AGENT_MAP.md) and [RUST_MIGRATION.md](RUST_MIGRATION.md).

| Owner | Responsibility | Lifetime |
| --- | --- | --- |
| `AppLifecycle` & `gsm-runtime` | Pure-Rust startup/shutdown, message bus broker, 256-item text outbox, backend/helper process supervision, trays, notifications, updates | Application |
| `gsm-settings` & `gsm-packages` | Data roots, desktop preferences, hook profiles, managed Python/uv install, hook/Agent package updates, backups, data relocation | Application |
| `obs/*`, `gsm-capture`, `ocr.rs`, `texthook`, `agent` | OBS supervision/scenes/switcher/session/outputs, shared WGC/xcap capture, native OCR tab, LunaHook/Textractor CLI, Agent (`gsm-agent-host`) | Application / session |
| `gsm-history`, `word_index.rs`, `anki_*.rs`, `cron.rs` | Serialized SQLite writer + read pool, stats/search/tokenization/Anki reports, Sudachi word indexing, AnkiConnect polling/edits/merges/sync, cron scheduler | Application / backend session |
| `DictionaryManager` | Extension profiles, storage, migration, Yomitan/Hachidori/Jiten engines | Application |
| `dictionary_service.rs` | Background preparation and backend dictionary requests | Application |
| `reader_service.rs` | Lookup, search windows, dictionary/Anki setup | On demand, independent of overlay |
| `OverlayHost` presentation | Transparent view and deferred dictionary attachment | First use; retained for 30 seconds after disable |
| `OverlayHost::start/stop` | Capture session, sockets, hotkeys, pause ownership, tray and companions | Enabled session |
| React (`electron-src/renderer/src/`) | Desktop Hub presentation and user intent | Window |
| Python (`GameSentenceMiner.gsm` + `_native`) | Live text actor & TextFeed/WS servers, replay/VAD/FFmpeg mining & Anki orchestration, Flask HTTP server & unmigrated routes (goals, games CRUD, imports/exports, Yomitan dicts), AI, cloud/3rd-party sync, leased crons, PyQt6 dialogs, mining config schema | Backend (or one-shot Qt dialog host) |

Overlay enable/status/settings and reader lookup use typed Tauri commands in
`commands.rs`, selected by `nativeCommands.ts`. Existing compatibility channels
remain adapters for legacy pages. They must not grow into another application
service runtime. Commands retain the existing window/token authorization checks.

Dictionary preparation and extension migration no longer delay creation of the
overlay view. The renderer-ready handshake attaches dictionaries asynchronously.
The selected reader and Hachidori engine also prepare in the background at normal
application startup. Errors are logged and reported by explicit dictionary
operations; enabling an overlay is not a prerequisite for recovery.

Disabling the overlay stops its session and native capture, releases hotkeys and
pause owners, clears native presentation, destroys companion windows and removes
its tray. The main view stays hidden and noninteractive for 30 seconds, then is
released. Late show/capture requests cannot activate a disabled session.
Re-enabling during this grace period reuses the document; later activation creates
a new one and reattaches the shared dictionary service.
Guide initialization is background work, outside activation. Application quit
still disposes the view and services. Startup no longer prepares an unused overlay
view. Cold application startup and first-time dictionary imports remain real work.
See [Tauri memory behavior](TAURI_MEMORY.md) for the November 15 measurements and
the idle-window/engine lifecycle.

Python dictionary and Anki setup prefer authenticated `dictionary.setup` and
`dictionary.ankiSetup` requests to the native desktop. Only the backend identity
can invoke these bus routes, and requests retain deadlines. A request that times
out is never replayed on another transport. The old overlay transport remains for
standalone configurations without the desktop bus; it is not used by Tauri.

Dictionary storage remains at the existing profile location. Moving it merely to
rename an `overlay` directory would risk extension IDs and existing IndexedDB
data, so this pass changes lifetime ownership without relocating dictionaries.

## Development commands

| Command | Use |
| --- | --- |
| `npm run dev` | Tauri CLI starts Vite, watches native sources, rebuilds/relaunches the desktop; React uses hot reload |
| `npm run dev:renderer` | Browser-only UI work |
| `npm run build:helpers` | Rebuild the input service and Agent helper after helper changes |
| `npm run check:desktop` | Rust type/compile check |
| `npm run test:desktop` | Native desktop unit tests, serially |
| `npm run build:tauri` | Build renderer and native executables, stage a stable launch copy |
| `npm start` | Build and launch the stable app for normal use/restart handoff |
| `npm run test:native` | Full native smoke suite against the staged executable |

`tauri.dev.conf.json` owns the development URL and additional watched engine
source folders. Its pre-development hook syncs shared UI assets and builds native
helpers once; it does not build a production renderer before starting Vite.
Changes to a helper executable require `build:helpers` and a dev-session restart.
Changes to shared overlay/vendor assets still follow their documented sync steps.

The Cargo target directory is shared by Tauri CLI and stable desktop builds.
Frequently edited desktop Rust uses normal unoptimized debug compilation. OCR,
capture and image-processing crates retain their optimized development profiles.
Release optimization is unchanged. The stable launcher keeps its copied binary
because Windows locks running executables; this permits building while the normal
app is open. Tauri CLI owns restarts in `dev`, so do not run agent restart there.
Use an isolated profile (`npm run dev -- -- -- --profile <absolute-path>`) if a normal
GSM instance is already open and you want an independent development instance.

## Removal and restoration ledger

| Removed/replaced | Reason | Restoration breadcrumbs |
| --- | --- | --- |
| `dev:main`, `dev:desktop`, prebuild + concurrently/nodemon/wait-on chain | Electron main compilation and a second native watcher duplicate Tauri CLI | Restore `package.json`, `package-lock.json`; remove `tauri.dev.conf.json`; old commands are at checkpoint |
| Root dev dependencies `concurrently`, `nodemon`, `wait-on`, `cross-env` | No longer used by root scripts | Restore package manifests and run `npm ci`; overlay's separate dependencies remain intact |
| Duplicate helper build code in `build-native-dev.mjs` | Both stable and dev modes need the same helper build | Restore that script; replacement is `build-native-helpers.mjs` |
| Full optimization of the desktop crate in debug | Slow shell edit/build cycle | Restore `[profile.dev.package.gsm-desktop] opt-level = 3` in `src-tauri/Cargo.toml` |
| Destroy/recreate main overlay on every disable; synchronous dictionary loading on enable | Coupled UI activation to expensive shared services | Restore `overlay_host.rs`; remove startup preparation in `main.rs` and corresponding smoke expectations together |
| Overlay stop/start after dictionary selection | Discards capture/input state unnecessarily | Restore the `settings.onboarding.dictionary` branch in `desktop_services.rs` |
| Tauri Python setup's dependency on the overlay socket | Dictionary operations belong to desktop services | Restore `util/anki_yomitan.py`, `web/onboarding_api.py`, bus dispatch in `app_lifecycle.rs`; new adapter is `util/communication/dictionary_client.py` |
| Root `audit-invalid-suite`, `foundation`, `hachidori`, `home`, `input`, `notifications`, `ocr-flow`, `overlay`, `settings`, `windows`, `workspace`, `yomitan` | Accidental fixture ZIPs written by an imported helper using the test's argument | Restore named files from checkpoint; intentional fixture creation is `node scripts/dictionary-fixture.mjs <output.zip>` |
| Root `.tmp-native-oneocr.json` | One-off OCR diagnostic output | Restore that exact path from checkpoint if needed |
| Obsolete Electron development instructions in `.github/CONTRIBUTING.md` | Described a development flow the app no longer uses | Restore that file; this document replaces its workflow guidance |

No user-facing mining, OCR, OBS, hook, dictionary, import or migration feature was
intentionally removed. Old Electron sources are retained as reference and for
remaining test fixtures. They are not required to run the native desktop.

## Boundaries still to improve

This is a soft redesign, not a claim of a completed idiomatic Tauri rewrite.
Legacy overlay HTML still uses a narrow CommonJS/Electron-shaped compatibility
preload. The generic `desktop_call` router, JavaScript event dispatch, large
`OverlayHost`, Jiten cache placement, permissive legacy CSP, and extension bridge
remain follow-up work. Converting these safely requires focused permission and
content tests; blindly deleting them would break dictionary extensions and
existing overlay features. Prefer new typed commands and app-owned state for
future work, then retire each adapter with its consumers.

The direction follows Tauri's [process model](https://v2.tauri.app/concept/process-model/),
[managed state](https://v2.tauri.app/develop/state-management/), and
[commands/events model](https://v2.tauri.app/concept/inter-process-communication/).
See [capabilities](https://v2.tauri.app/security/capabilities/) before tightening
the remaining legacy bridges.

## Verification on 2026-11-14

- Desktop unit tests: **171 passed, 5 ignored** (external/environment-dependent checks).
- Affected renderer tests: **45 passed**; renderer type check and production build passed.
- Python dictionary/Anki/onboarding tests: **20 passed**, including four new regressions first observed failing with the overlay disabled.
- Build/fixture script tests: **8 passed**. Ruff left all 731 Python files unchanged.
- Final staged native binary: overlay smoke, Yomitan import/reopen and Hachidori import/reopen all passed. These include actual dictionary lookups before overlay creation and after disabling it, live reader switching, retained document identity, and inactive-session guards.
- Tauri CLI development mode: launched Vite and the native app using an isolated profile; native window smoke and two close-to-tray cycles passed. This validates startup and the development bridge; a physical edit/reload cycle was not measured.
- Four warm overlay enable calls measured **32.10, 33.02, 36.21 and 39.92 ms**. This measures the native enable operation on a prepared view, not first OCR output or cold dictionary loading. See [machine-readable results](benchmarks/tauri-architecture-2026-11-14.json).

The checked build is Windows-only. macOS/Linux runtime behavior and real-game
input/capture need their own acceptance. No dictionary data was relocated.

The integration runs exposed and fixed two readiness problems: document reload
racing overlay checks, and extension-page evaluation starting before navigation
finished. Lookup pages now await Tauri's page-load completion event. The dev
preload also uses the configured development origin instead of assuming
`localhost:5173`; production builds do not trust that dev origin. Restore
`reader_service.rs`, `overlay_preload.rs`, and `preloads/desktop_preload.js` from
the checkpoint to recover those former behaviors if investigating a regression.

## Home lookup follow-up

In the desktop window, Yomitan and Hachidori accept lookups only on Home
transcript lines and their translations, marked with `data-gsm-reader-scan="shift"`.
Holding Shift over a word opens its definition, including when the pointer is
stationary. Switching tabs dismisses the popup. The desktop preload disables
lookups in embedded pages such as Stats. The overlay uses its own reader settings.
The footer explains the gesture in all three desktop languages.

Removed two startup shortcuts that treated an enabled WebView2 extension as
proof that content scripts had attached to Home: the check in
`attach_home_dictionary` and a separate worker in `create_hub_window` that marked
Home attached without navigating or injecting anything. The second worker could
still suppress the actual attachment even after removing the first shortcut.
Background warmup can enable an extension after Home already loaded. The
dictionary manager now owns the first attachment/reload and deduplicates
subsequent mounts; its attachment setter is private so startup code cannot
prematurely mark a window attached. App-owned dictionary warmup remains intact.
The former shortcuts are in `reader_service.rs` and `app_lifecycle.rs` at
checkpoint `7a87ee32`; restore those blocks only when investigating the old
behavior, as they can suppress lookups.

To restore configurable Home gestures, remove the two marker attributes from
`ReadingPane.tsx` and the footer hint. Overlay and nested dictionary popups never
receive those markers. Yomitan source changes live in the sibling
`../yomitan-gsm/ext/js/language/text-scanner.js`, with regression tests in
`../yomitan-gsm/test/gsm-home-scan.test.js`; rebuild using that repository's
`local-build-chrome-overlay.ps1`. Hachidori's helper is in
`GSM_Overlay/integrations/hachidori/bridge.js` and all upstream hooks remain in
`scripts/hachidori-integration.mjs`; regenerate with the documented integration
command. Do not edit generated dictionary files to undo the behavior.

The native dictionary smoke suites now feed real transcript text to Home and
exercise Shift activation with the overlay disabled, ordinary hover suppression,
and repeated attachment without reloading. Smoke executables bypass the stable
development launcher so these isolated profiles can coexist with the running app.

After removing the second startup shortcut, native Yomitan and Hachidori
import/reopen suites passed with real Home Shift lookups while the overlay was
disabled. They also checked ordinary-hover suppression, repeated attachment
without a reload, and overlay lookup/lifecycle behavior. One preliminary Yomitan
reopen run timed out during the separate lookup-page warmup, before the Home
check; the same saved profile and a subsequent clean import/reopen run passed.
That intermittent warmup timeout was not independently fixed by this change.
The checked build is ready for the next manual launch; the user's running app
was not restarted for this follow-up.

## Stable launch copy follow-up

Windows development launches keep the desktop executable at its stable tray-icon
path, but resolve the Agent and input helpers from that desktop's immutable build
folder. A detached Agent helper can keep serving a game after GSM closes; trying
to overwrite its stable-folder executable caused `Access is denied` on the next
launch. The launcher now copies only the desktop and leaves existing helpers
alone. It still refuses to overwrite a running desktop, validates the complete
source build, and publishes its build marker last.

This removes helper replacement from `dev_launch::prepare`. To recover the former
layout for investigation, restore copying all three `FILES` there and resolve
debug helpers beside the desktop in `agent.rs` and `input_server.rs`. That layout
requires all detached helpers to exit before a new build can launch. No detached
hook functionality was removed, and no running helper is killed by this fix.
