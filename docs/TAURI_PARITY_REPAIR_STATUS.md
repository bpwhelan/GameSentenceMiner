# Tauri parity repair status

This is the follow-up to [the side-by-side audit](OVERLAY_PARITY_AUDIT.md), against released Electron `cc3e429e`. The workspace already contained the Tauri migration and extensive unrelated changes; this pass preserves them. Built-in engine hooks are explicitly deferred by the user. They remain unavailable; no engine-hook build step or additional bundler dependency is required.

## Repairs implemented

| Area | Changes |
| --- | --- |
| Settings access | Settings document readiness handshake, initial tab retention and aliases, visible-window fallback, actual visibility assertions. |
| Tray | Separate overlay tray and menus; serialized creation/update/removal to prevent duplicate icons; scoped menu IDs; two-cycle lifecycle assertions. |
| Click-through and manual mode | One mouse-policy owner; capture/manual/resize/popup gating; stale preference events rejected; held-key repeat does not toggle; release follows input edges; macOS cursor-ignore operation. |
| Hotkeys/controllers | Legacy defaults and feature gates; input-service hold routing; controller blacklist; navigation/pause/focus ownership; forwarding allowlist and target identity checked at both ends. |
| Jiten | Reader extension loads beside either dictionary; genuine extension options; portable preload; enabling takes effect immediately without reloading on every profile update. Extension and overlay requests share the native broker, including WebView2 service workers and portable extension fetch. Native parsing batches lines, preserves UTF-16 offsets, deduplicates cached reads, handles cancellation, refreshes account state, bounds vocabulary memory, and remembers grade receipts even for uncertain anonymous writes. Custom API bases and HTTP error status are preserved. |
| Dictionary switching | Serialized attach, progress, rollback and error reporting; refreshed portable reader context. Live-switch regression also exposed asynchronous lookup-window replacement and search windows retaining their old reader's navigation rules. Replacement now waits for destruction, search creation is serialized, and changed readers receive a fresh search window. |
| Translation and quick actions | Preserved response/request metadata and wrapped payloads; string action routing; translation request/toggle; current native text supplied to translation fallback. |
| OCR settings | Correct backend request shape; field-by-field coalescing; pending edits survive reconnect and restart until acknowledged. |
| Capture/visibility | Authoritative capture availability; disconnect resets interactions; old worker generations cannot overwrite a new session; selected OBS source and capture preference forwarded to native capture, with WGC-to-OBS fallback. |
| OCR presentation | Shared renderer history/nameplate grouping; bounded native backlog corrections retaining hit boxes; recycled-line and overlay-only ingestion feedback restored; VOCR+Lens composite crop batching. |
| Lifetime | Serialized start/stop; manual disable respected by automation; pause sources released on stop/reconnect; auxiliary windows destroyed on stop. |
| Focus | Manual background focus deferral; lookup focus preference and game return; navigation ownership; Anki confirmation return routing. |
| Auxiliary windows | Text Feed toggles and releases its pause owner; Custom Page remembers navigation, including fragments; Escape, back/forward and reload; narrowly scoped page-to-host dismissal. Both follow the overlay display bounds; changed/disabled pages are disposed; new-tab guide links stay in the managed page. |
| Timers/stats | Meaningful activity wakes AFK state; Pomodoro widget contract, elapsed-time countdown, pause retention; stats/goals visibility cycling. |
| Persistence | Legacy profile key, recommendation dismissals, indicator preferences and controller list migrated; Windows settings replacement no longer deletes the saved file before replacement. |
| Calibration/displays | Offset helper gets current text, settings and bounds; monitor topology rechecked; recommendation dialogs receive their initial data. |
| Adjacent desktop controls | Native routes for Text Hook test payload and opening the OCR temporary folder. The shared focus helper now reveals hidden windows on Windows too, fixing invisible dictionary search and other focus-only open paths. |
| Build | Removed the unfinished built-in-engine-hook build dependency. Standard native build and renderer build completed successfully. |

## Completed verification

- Overlay JavaScript: **705 passed, 1 skipped**, including repaired production-layout fixtures and settings readiness regression.
- Python overlay/config/focus/controller tests: **38 passed**.
- Native OCR/geometry: **49 passed, 1 ignored**. Fixed the Windows mock-server nonblocking socket inheritance that made two HTTP tests intermittent.
- Rust desktop: final serial run **171 passed, 5 ignored**. The focused Jiten round-trip regression also passed shared browser/overlay receipts and lost-response protection for anonymous grades.
- `npm run build:tauri` passed. The final native source rebuild and staged launch copy also completed successfully; desktop-window and overlay smoke passed against that executable.
- Native overlay smoke passed: visible first settings window, injected Windows settings shortcut, Hotkeys page, Jiten content bridge and real extension-page shared-cache hit, profiles, displays, capture visibility and two tray/start/stop cycles.
- Yomitan and Hachidori passed import, production overlay hover lookup and reopening. Both also passed switching to the other reader and back in the running overlay, a subsequent real hover lookup, and a visible search window. Both synthetic Electron-to-Tauri transfers passed, including unchanged source-data fingerprints.
- Native OBS, Text Hook, Agent and OCR service checks; desktop windows/settings/input/notifications/workspace; and OneOCR coordinator capture/recognition flow passed.
- Capture benchmark passed freshness, resizing, reopen, target changes and closure. Nine warm 1000×500 Meiki CPU samples measured **76.68 ms** native capture + OCR median versus **80.49 ms** Python. Cold model loading is excluded. See [benchmark details](NATIVE_OVERLAY.md#performance-investigation).
- Packaging/build-script policy tests: **11 passed**. Native OBS capture test: **1 passed**.

## Acceptance limits and handoff

The checked native launch copy is ready for the repository's restart handoff. `npm start` can also build and launch it normally. The incomplete engine-hook build step that imported unavailable `esbuild` has been removed; it is not part of native development or staging.

Windows is the available test environment. Packaged updates, click-through and physical controller/Magpie behavior with real games, live external accounts, and macOS/Linux need environment-specific acceptance. Passing fixtures must not be described as validation of those environments. Built-in engine hooks are the explicitly deferred feature; they are not required by the build.
