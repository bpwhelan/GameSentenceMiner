# Memory audit — handoff (2026-11-23)

## Measured baseline (live, before changes)
- `GSM Preview.exe`: 309 MB private. `chrome_screen_ai.dll` (45 MB) was loaded even though the config uses `meikiocr`.
- WebView2 total was about 1.27 GB private. The biggest process was the **extension renderer (Yomitan + Hachidori), at 733 MB**. After that came 3 page renderers (193/79/18 MB), the GPU process (120 MB) and the browser process (90 MB).
- On disk: extension IndexedDB is 2.9 GB, and Hachidori dictionaries are 816 MB. With automatic index storage on Hachidori's OPFS backend, **Use less RAM by default** and **Low memory mode** can limit resident hash indexes. The user controls these settings.

## Changes made (uncommitted)
**Native**
- Sudachi dictionary is now memory-mapped (`memmap2`) instead of loaded into the heap. Status checks no longer load the dictionary or keep it alive. Downloads now stream to disk.
- OCR (`native/gsm-overlay`): ORT threads are capped at 4. Memory pattern is off for Mida, VOCR, and portable OneOCR. VOCR finder is shared. VOCR is verified by streaming the file instead of reading it whole. New telemetry registry `engines::loaded_models_snapshot()`.
- OCR idle unload: engines are dropped after 180 s (`ocr.rs`) or 120 s (`overlay.rs` watch) with no inference, even when frames are static. They lazy-reload when needed.
- `scan_scene_text` uses the configured engine or OneOCR before ScreenAI, so ScreenAI is no longer loaded just for this.
- VAD: no arena allocator or spinning, batch is 2048, idle unload after 3 min runs off the async loop (`memory.rs`), plus `loaded_models_snapshot()`.
- Bounded caches: reader-audio lines (64), intake expired rows (2000), Jiten vocabulary states (8000).
- The `gsm-reader-lookup` WebView is released after 120 s idle (`reader_service::release_idle_lookup`, with a lease so it is never released mid-lookup).

**WebView**
- The Jiten extension is disabled and reconciled when `enableJitenReader` is false. Secondary windows (settings, dialogs, VN guide, game-config, docs, agent UI) share the overlay profile, and the reader scope is turned off in them. `ajb.js` skips disabled scopes.
- Overlay `index.html`: no duplicate mouse handlers, memo capped, popup timer paused while hidden. `pinyin-pro` is lazy-loaded. Jiten segment pool is trimmed.
- Desktop renderer: OCR preview and terminal buffering pause while the native window is hidden. The eager dictionary-popup preload was removed from Desktop Home.

## Original verification status
- `cargo test` for `GSM_Overlay/input_server/language`: 30 passed, 5 ignored (earlier run).
- `cargo check` for `src-tauri`: **Finished** (after fixing a missing brace in `overlay_host.rs` VN guide builder). There are warnings: the unused `verified_model` in `vocr.rs` is only kept for its test.
- `npm run test:ts`: **24 failed / 1605 passed**. The failures are in 6 files: `agent_control`, `overlay-settings-keyboard-bindings`, `wine_frida`, `vocr_package`, `HomeTab`, `OCRTab`. With my renderer and overlay edits stashed, the 4 files I re-ran (`OCRTab`, `HomeTab`, `overlay-settings-keyboard-bindings`, `agent_control`) still fail, so they look pre-existing or environment-related. `wine_frida` and `vocr_package` were not re-checked.
- **Not yet run:** cargo tests for `native/gsm-overlay`, `gsm-mining`, `gsm-intake`, `src-tauri`, and `npm run build:renderer`. Use `$env:CARGO_TARGET_DIR="$env:TEMP\gsm-cargo-target"` and `$env:CMAKE_POLICY_VERSION_MINIMUM="3.5"` (drive G: is nearly full).

## Where the memory went in the running app

A later Windows sample of the existing process tree, taken before restarting with the new build, showed about **707 MiB of private resident RAM** and **1,001 MiB of private commit** for GSM and its observed helpers.

| Component | Private resident RAM (MiB) | Private commit (MiB) |
| --- | ---: | ---: |
| GSM desktop process | 236 | 308 |
| WebView2 subtotal | 454 | 671 |
| ↳ Extension renderers (two PIDs) | 183 | 232 |
| ↳ Page renderers (three PIDs) | 157 | 202 |
| ↳ GPU process | 44 | 140 |
| ↳ Browser and utility processes | 70 | 97 |
| Text hook and input helper | 17 | 22 |

The desktop process had used 370 MiB of private resident RAM earlier in the same session. `chrome_screen_ai.dll` was absent from its loaded modules at that earlier snapshot. WebView2's extension renderers together used 183 MiB in both follow-up samples. The opening 733 MB extension figure came from a different session state. There is no matched workload comparison for these figures. The IndexedDB and installed dictionary sizes in the baseline are disk usage.

## Resource usage in Settings

- **Resident RAM** measures private pages in physical memory. **Private commit** measures private memory charged against Windows' commit limit. Each WebView2 PID counts once in the WebView2 subtotal. A page renderer may serve multiple windows. The GPU process row measures host memory.
- **Loaded native models and dictionaries** shows the OCR and voice activity detection models GSM tracks, plus Sudachi when loaded. Load-time RAM deltas approximate a model's cost. A memory-mapped Sudachi file can use file-backed pages, so the file size gives the size of the mapping rather than its RAM footprint.
- **Browser extensions** shows enabled status when the dictionary profile controller is open. With Hachidori enabled, **Inspect dictionary memory** samples the WebAssembly heap capacity, the low-RAM setting, and resident hash indexes by dictionary. Heap capacity can exceed the engine's physical RAM usage. The hash indexes are part of the heap, and process totals already include the heap pages that Windows accounts for as private.

The Hachidori memory probe is generated from `GSM_Overlay/integrations/hachidori/` and its diagnostic window closes after each inspection.

## Completion checks

The renderer build and type check passed. All 14 Settings tests passed, including the legacy array response and the process subtotal test. The native Windows build passed. The Hachidori import and reopen fixtures verified WebView2 PID deduplication, renderer-to-window attribution, extension status, and the fixture dictionary's heap and hash-index diagnostics.

Rust tests passed for Sudachi (35, including the cases that use an installed dictionary), OCR and overlay (74, including the installed OneOCR unload and reload test), and intake (11). The mining suite reported 35 passes, one gateway HTTP caching failure, and three skips. The desktop suite reported 295 passes, one cron rollup retry failure, and ten skips. The TypeScript suite reported 1,606 passes and 24 failures across the same six files listed under Original verification status.
