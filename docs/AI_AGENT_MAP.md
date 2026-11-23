# GameSentenceMiner (GSM) Architecture & Responsibility Map

Last updated: 2026-11-19\
Repository: `https://github.com/bpwhelan/GameSentenceMiner`

For a clean restart after changes, see [Agent restart workflow](AGENT_RESTART.md).
For desktop backend ownership after the November 21 cutover, see [Pythonless desktop](PYTHONLESS_DESKTOP_AUDIT.md).
For detailed Python-to-Rust migration history and benchmarks, see [Incremental Rust migration](RUST_MIGRATION.md).
For Tauri service lifetimes and development workflows, see [Tauri architecture](TAURI_ARCHITECTURE.md).

## 1. What GSM is

GameSentenceMiner is a desktop application for language learners that captures in-game text (via text hooks, OCR, speech recognition, or clipboard), aligns it with OBS replay/audio/screenshot context, updates Anki cards with trimmed voice audio and screenshots, renders an interactive in-game dictionary overlay, and provides immersion analytics, vocabulary tracking, and optional encrypted cloud sync.

## 2. High-level runtime architecture

The shipped desktop application is a **pure-Rust Tauri shell** (`gsm-desktop`) with **zero Node/Electron runtime**. Node.js is used only at build, staging, and test time.

```text
Tauri Native Desktop (src-tauri -> gsm-desktop, pure Rust, zero Node runtime)
  |- Linked Rust crates:
  |    gsm-settings, gsm-history, gsm-packages, gsm-runtime, gsm-agent (client),
  |    gsm-texthook, gsm-capture, gsm-overlay, gsm-text-preview, gsm-sudachi,
  |    gsm-downloads
  |- Owns:
  |    Hub/Settings/Overlay/Reader/VN Guide WebViews (gsm:, gsm-yomitan:, gsm-hachidori:, gsm-jiten:)
  |    Localhost authenticated WebSocket message bus (gsm-runtime) + 256-item text outbox
  |    OBS supervision, v5 client, scene switcher, game-session tracking, recording/longplay outputs
  |    Native OCR tab worker, overlay OCR worker, shared WGC/xcap/OBS capture, Win32 screen picker
  |    LunaHook/Textractor CLI sessions + Hook Finder ranking + package/updater management
  |    Managed Python/uv installer, backend supervision, Qt one-shot dialog supervision
  |    SQLite writer + read pool (gsm-history), Sudachi word indexer, AnkiConnect services, cron scheduler
  |    Game launcher, auto-launcher, privilege helper, trays, notifications, desktop updater
  |
  |- Spawns standalone native helpers as needed:
  |    gsm-agent-host          (Rust + Frida Core 17.16.4, downloaded on first use; + Wine bridge)
  |    windows-audio-capture (Rust) + windows-speech-recognition (C++ Live Captions / SAPI)
  |    gsm_overlay_server      (Rust: passive keyboard listener, gamepad server, Sudachi RPC)
  |    gsm-game-background-*   (C++/MinHook Windows background-focus/input hooks)
  |
  |- Spawns & supervises Python backend: python -m GameSentenceMiner.gsm
       |- In-process Rust PyO3 extension: GameSentenceMiner._native (native/gsm-native)
       |    dialogue correlation, skip detection, live dialogue journal, card matching,
       |    OCR text/layout/overlay kernels, text cleanup/matching, verified downloads
       |- Owns:
       |    Live text actor & projections (gametext.py, text_pipeline/*)
       |    Mining/replay/media/VAD/FFmpeg/clip/longplay pipeline (anki.py, replay_handler.py, vad.py)
       |    Flask/Waitress HTTP server (:7275) + WebSocket servers (/ws/texthooker, /ws/overlay, /ws/plaintext)
       |    AI translation/prompting, encrypted cloud sync, external APIs (Jiten/VNDB/AniList/IGDB/Kechimochi/Tadoku/Discord)
       |    Remaining Python cron runners, PyQt6 dialogs, mining profile schema (config.json)
       |    Standalone/non-Tauri fallbacks (legacy OCR/overlay/DB/Anki/cron paths)
```

## 3. Master catalogue of responsibilities

| Domain / Subsystem | Tauri & Rust Crates (`src-tauri/`, `native/*`) | PyO3 Extension (`native/gsm-native`) | Standalone Native Helpers | Python Backend (`GameSentenceMiner/`) | WebView UI / Extensions |
| --- | --- | --- | --- | --- | --- |
| **Desktop shell, windows, trays, updates, logs** | Full owner: Tauri app lifecycle (`app_lifecycle.rs`), single-instance, trays (`tray.rs`, `overlay_tray.rs`), notifications + `rodio` audio, desktop updater, agent restart, changelog, log redaction/archive, resource usage (`resource_usage.rs`), WebView2 memory lifecycle (`memory.rs`), data relocation & backups. | — | — | Emits backend status/notifications over bus; owns Python loguru files; standalone `pystray` fallback only when launched without Tauri. | React Hub (`electron-src/renderer/src/`), `xterm.js` Logs tab, Setup Wizard, Changelog/Update modals. |
| **Settings & persistence** | `gsm-settings` owns data-dir resolution, bootstrap pointer, desktop preferences (`electron/config.json`), hook profiles (`texthook/profiles.json`), notification/onboarding prefs, and workspace text-processing/exclusions/speech files (narrow locked patches). | — | — | Owns mining profile schema (`config.json` via `Config`/`MasterConfig`), profile switching, and legacy read-only desktop pref view. | React Settings / Text Processing / Speech tabs; PyQt6 Mining Settings GUI (`config_gui_qt.py`). |
| **Python env & package management** | `gsm-packages` + `python_install.rs` + `python_ops.rs` + `install_session.rs` own managed Python/uv install, lockfile sync, backend updates/repairs, CUDA/custom packages, install-session progress/retries, LunaHook/Textractor/Agent script updates, and `gsm-downloads` verified asset fetches. | `download_file`, `ensure_download_asset`, `cached_download_asset` (`gsm-downloads`). | — | Legacy/standalone tool downloaders (`util/downloader/`) and model download helpers when run standalone. | React Python/GPU/InstallSession UI. |
| **IPC & process supervision** | `gsm-runtime` owns the authenticated localhost WebSocket message bus, backend/OCR child Job Objects & crash recovery, and the 256-item acknowledged text outbox (`text.ingress.v2`). | — | — | `BusClient` (`util/communication/bus_client.py`) connects to broker; legacy stdio `GSMCMD:`/`GSMMSG:` fallback; `AsyncTransportRuntime` for Flask/WS servers. | Tauri typed commands (`commands.rs`) + transitional `desktop_call` bridge (`desktop_services.rs`). |
| **OBS & capture** | `obs/*` + `obs_service.rs` own OBS portable install/update, supervision, v5 client, scene CRUD, window scene switcher, game-session target tracking & profile selection (`obs/session.rs`), and recording/longplay start/stop (`obs/outputs.rs`). `gsm-capture` owns shared WGC/xcap capture, desktop snapshots, and OBS screenshot fallback. | — | — | Direct OBS calls retained for low-latency Anki replay saves, replay-only toggles, event listeners, profile reconfiguration, mining screenshots, and standalone launch fallback (`obs/`). | React Home / Capture Target Picker / Scene Switcher / OBS Updates UI. |
| **Text hooking & Agent** | `gsm-texthook` + `texthook_coordinator.rs` own LunaHook/Textractor CLI sessions, UTF-16 pipe framing, fragment buffering, Win32 discovery. `gsm-agent` (client) + `agent.rs` supervise detached/attached Agent sessions & script control windows. `gsm-text-preview` ranks Hook Finder candidates against ScreenAI blocks. | — | `gsm-agent-host` hosts Frida Core 17.16.4 + optional Wine Frida bridge (`--gsm-wine-bridge`). | Receives acknowledged hooked lines via `text.ingress.v2` bus topic; legacy `texthook.rank` fallback for older desktops. | React Text Hook tab + Hook Finder + Agent script control window. |
| **OCR (OCR Tab & Overlay OCR)** | `ocr.rs`, `ocr_coordinator.rs`, `overlay.rs`, and `gsm-overlay` own both OCR workers, native engines (OneOCR + portable OneOCR, MeikiOCR, ScreenAI, VOCR ONNX, MIDA, Google Lens, macOS LiveText, Bing, Google Vision, VOCR+Lens composite), area masking/packing, adaptive crop, presence monitoring, hook-delay learning, retries, clipboard-image OCR, and Win32 GDI crop picker (`ocr_selector.rs`). | OCR text filtering, layout ordering, spatial text, overlay language/size/exclusion filters, coordinate projection, payload copy, `SequenceMatcher` metrics (used by Python/standalone paths). | `gsm_overlay_server` provides passive keyboard & gamepad OCR shortcuts. | Supplies lightweight scene/window context (`ocr.native.context`) and ingests finished text (`ocr.native.result` / overlay completion); hosts macOS/Linux portable OneOCR Python inference when configured; retains standalone `ocr/gsm_ocr.py`, `owocr/`, `vita_ocr.py`, and `get_overlay_coords.py` fallbacks. | React OCR tab, area editor, preview & text feed; Overlay WebView; Flask `/select_areas` & Qt OCR selectors. |
| **Speech recognition (Windows)** | `mining_workspace/speech.rs` supervises both helpers, watches the OBS target, and sends partial/final events to native intake. `gsm-packages::speech` locates and installs model assets. | — | `windows-audio-capture` (Rust loopback capture) + `windows-speech-recognition` (C++ Live Captions / SAPI). | Standalone/Electron compatibility supervisor. | React Speech Recognition tab. |
| **Live dialogue pipeline & TextFeed** | `gsm-text-preview` previews text-processing rules in desktop UI; `text_correlation.rs` serves fallback `text.classify` for older wheels. | `classify_dialogue`, `compact_dialogue`, `DialogueSkipDetector`, `DialogueJournal` (live record index, retry FIFO, source prefix history, bounded TextFeed tail reads), `remove_repeated_chars/lines`. | — | Owns `AuthoritativeTextRuntime` (`TextCoordinatorActor`, `TextProjectionActor`), `TextRecord`/`IngressAck` creation, speech freeze scheduling, clipboard & external WebSocket intake, live text-processing execution, live stats tracking, and TextFeed v2 / plaintext / overlay WebSocket servers (`web/gsm_websocket.py`). | React Home transcript (`ReadingPane.tsx`), Overlay Text Feed, Svelte Texthooker UI (`texthooker/`). |
| **Overlay presentation & dictionaries** | `OverlayHost` owns overlay + companion windows (Settings, Offset Helper, VN Guide HUD, Text Feed, Custom Page), click-through/mouse policy, Magpie integration, and Jiten broker/cache. `DictionaryManager`, `dictionary_service.rs`, and `reader_service.rs` own WebView2 extension profiles/migration, Yomitan/Hachidori/Jiten setup, Home Shift-lookup, and lookup/search windows. | — | `gsm_overlay_server` owns passive keyboard hotkeys, gamepad navigation, and Sudachi tokenization RPC. | Handles overlay-originated AI translation requests, focus/pause callbacks, recycled-line & overlay-only ingestion feedback (`web/overlay_handler.py`); calls desktop `dictionary.setup` / `dictionary.ankiSetup` over bus; builds custom Yomitan/frequency ZIP dicts (`util/yomitan_dict/`). | `GSM_Overlay/` renderer & settings HTML/JS; bundled Yomitan, Hachidori, and Jiten Reader extensions. |
| **Database (`gsm.db`), history, stats & search** | `gsm-history` owns the serialized SQLite writer (lent to backend), read-only connection pool, dialogue capture writes, mined-line updates, game linking, daily/per-game rollup rebuilds, Sudachi word/kanji indexing & backfill (`word_index.rs`, `gsm-sudachi`), sentence/duplicate search, games list, text-deletion/dedup previews & execution, dashboard/game/overview/today/heatmap/kanji/maturity/Anki-game/retention/earliest/note-kanji reports, and all tokenization & word-novelty queries. | `count_kanji` (batched CJK counter for Python fallback paths). | — | Owns Flask HTTP routing/templates (`:7275`) and SQLite schema migrations/backups; delegates migrated read/write routes to `gsm-history` with standalone fallbacks; still fully owns Goals APIs (`goals_api.py`, `goals_projection_api.py`), game metadata CRUD/linking (`web/routes/*`), remaining DB mutations (`delete-sentence-lines`, `delete-games`, `merge_games`, `migrate-lines`, `delete-regex-in-game-lines`, archiving), imports/exports (`import_api.py`, `third_party_stats_api.py`, `stats_export_api.py`), and custom advanced-regex rollup fallbacks. | Embedded Flask HTML/JS dashboard pages (`/overview`, `/stats`, `/goals`, `/search`, `/games`, `/anki_stats`, `/database`, `/tools`). |
| **Anki integration & card mining** | `anki_connect.rs`, `anki_poll.rs`, `anki_monitor.rs`, `anki_cards.rs`, `anki_edit.rs`, `anki_group.rs`, `anki_media.rs`, and `anki_sync.rs` own AnkiConnect polling/backoff, connectivity status, note reads, ordered field/tag edits, duplicate search & grouped merges, 48 KiB streaming media uploads, and full/incremental collection sync into `gsm.db`. | `rank_card_lines` (fuzzy card-to-line matching for live history, overlay mines, and saved clips). | — | Owns high-level mining orchestration (`anki.py`): replay save trigger, card object construction & field policy, media prefetch, incoming Anki Beacon HTTP payloads (`/api/anki/events`), session review (`session_review.py`), and Qt confirmation/grouping dialog flow. Standalone fallback retains direct AnkiConnect path. | PyQt6 Anki Confirmation, Duplicate-Field Grouping, Session Review, and Recommended Anki Setup dialogs. |
| **Replay, media, VAD, clips & longplay** | `obs/outputs.rs` coordinates recording/longplay start/stop on the shared OBS session. | — | — | **Almost entirely Python**: replay folder watchdog (`replay_handler.py`), FFmpeg audio/screenshot/WebP/AVIF extraction (`util/media/*`), Silero ONNX / faster-whisper VAD (`vad.py`), pause-gap handling, clip creation/cards (`clip_cards.py`, `web/clips_api.py`), and longplay SRT generation (`longplay_handler.py`). | PyQt6 Screenshot Selector & audio waveform widget; Flask `/play-audio`, `/trim-video`, `/create-media`, `/save-clip`. |
| **Scheduled jobs (cron)** | `cron.rs` + `gsm-history::schedule` own the scheduler loop, priority/deadline ordering, manual triggers, and direct Rust execution of `populate_games`, `tokenize_backfill`, and retired `anki_word_sync`. | — | — | Pulls single job leases over bus for Python-dependent jobs (`jiten_sync`, `jiten_upgrader`, `daily_goals_completion`, `tadoku_sync`, `kechimochi_sync`, `database_maintenance`) and thin wrappers that dispatch `daily_stats_rollup` and `anki_card_sync` back to Rust. Standalone fallback retains local scheduler. | — |
| **AI translation & external sync/APIs** | — | — | — | **Entirely Python**: AI providers (`ai/`: Gemini, OpenAI, Groq, Ollama, DeepL, Zai), prompt builder/presets, character context/summary, translation cache; Encrypted Cloud Sync (`util/cloud_sync/`); Kechimochi & Tadoku sync; Jiten/VNDB/AniList/IGDB clients; Discord RPC. | Flask translation/sync endpoints; PyQt6 AI/Prompt/Sync dialogs. |
| **Game launching, automation & background hooks** | `game_launcher.rs`, `auto_launcher.rs`, `game_privileges.rs`, `game_background.rs`, `launchers_ui.rs` own game launching, auto-attach/auto-overlay, privilege checks, Wine/Proton launch wiring, and background-hook supervision. | — | `gsm-game-background-helper` + x64/x86 MinHook DLLs (`native/game-background-hooks`). | — | React Game Settings / Automation tab & privilege notices. |
| **Desktop dialogs (Qt6)** | `gui_dialog.rs` exposes typed `open_python_dialog` command; routes to running backend's Qt main thread or supervises a one-shot Python Qt host when backend is stopped. | — | — | `ui/qt_main.py`, `ui/desktop_dialog.py`, and `ui/*_qt.py` implement the 14 PyQt6 windows (Settings, Anki confirmation, Field grouping, Screenshot selector, Session review, Sync settings, Prompt help, Anki setup, Furigana preview, OCR area/monitor/min-size selectors, Text input, Scene selection). | PyQt6 native windows (styled with shared GSM theme). |

## 4. Repository map

### Native Tauri desktop (`src-tauri/`)

- `src-tauri/src/main.rs` — Process entry, profile isolation, custom URI schemes, Tauri managed state wiring, shutdown order.
- `src-tauri/src/app_lifecycle.rs` — Startup/shutdown lifecycle, Hub window, bus request dispatch from Python backend, notifications, agent restart handling.
- `src-tauri/src/commands.rs` — Typed public Tauri commands (`overlay_lifecycle`, `dictionary_service`, `backend_lifecycle`, `desktop_resource_usage`, `open_python_dialog`, `python_environment`, `installation_session`, `mining_workspace`, `hook_profiles`, `hook_updates`).
- `src-tauri/src/desktop_services.rs` — Transitional authorized `desktop_call` channel router for renderer/overlay requests.
- `src-tauri/src/obs/` & `src-tauri/src/obs_service.rs` — OBS v5 client, portable runtime/updater, scenes, window switcher, game session/profile tracker (`session.rs`), recording/longplay outputs (`outputs.rs`).
- `src-tauri/src/ocr.rs`, `ocr_coordinator.rs`, `ocr_selector.rs` — Native OCR tab worker, coordinator, Win32 GDI screen crop picker.
- `src-tauri/src/overlay.rs`, `overlay_host.rs`, `overlay_*.rs`, `dictionary_host.rs`, `dictionary_service.rs`, `reader_service.rs` — Native overlay worker, window host, Magpie/Jiten/VN Guide/pointer/tray owners, shared WebView2 dictionary manager.
- `src-tauri/src/anki_*.rs`, `mining_history.rs`, `word_index.rs`, `cron.rs`, `text_correlation.rs` — Desktop bus handlers for AnkiConnect, SQLite history, Sudachi word indexing, cron scheduling, and fallback dialogue classification.
- `src-tauri/src/texthook.rs`, `texthook_coordinator.rs`, `agent.rs`, `agent_scripts.rs`, `hook_updates.rs` — Text hooking & Agent supervision.
- `src-tauri/src/backend.rs`, `runtime.rs`, `python_install.rs`, `python_ops.rs`, `install_session.rs`, `gui_dialog.rs` — Python runtime/environment/dialog supervision.
- `src-tauri/src/game_launcher.rs`, `auto_launcher.rs`, `game_privileges.rs`, `game_background.rs`, `input_server.rs` — Game automation & native helper supervision.

### Workspace Rust crates & native helpers (`native/` & `GSM_Overlay/input_server/`)

- `native/gsm-settings` — Paths, desktop preferences, hook profiles, notifications, onboarding, workspace config/exclusions/speech files.
- `native/gsm-history` — Serialized SQLite writer, read pool, capture/mining writes, rollups, search, maintenance, stats/Anki/tokenization/novelty reports, cron schedule queries.
- `native/gsm-packages` — Python/uv installer & maintenance, install sessions, hook/Agent package updaters, Anki Beacon packaging, backups, data relocation, logs, changelog.
- `native/gsm-runtime` — Localhost WebSocket broker, child process/Job Object supervisor, 256-item acknowledged text outbox.
- `native/gsm-agent` — Agent supervisor/protocol + separate `gsm-agent-host` binary (Frida Core 17.16.4 + Wine bridge).
- `native/gsm-texthook` — LunaHook/Textractor CLI session actor & Win32 discovery.
- `native/gsm-capture` — Shared WGC/xcap capture registry, desktop snapshots, OBS screenshot fallback.
- `native/gsm-overlay` — Native OCR engines (`oneocr`, `meiki`, `screenai`, `vocr`, `mida`, `lens`, `livetext`, `remote`, `composite`), preprocessing, replacements, adaptive crop, presence, retries.
- `native/gsm-text-preview` — Text-processing preview engine & Hook Finder ranker.
- `native/gsm-downloads` — Verified asset/file downloader (R2 → GitHub `gsm-assets-v1` → origin, SHA-256 checked).
- `native/gsm-native` — PyO3 (`abi3`) Python extension `GameSentenceMiner._native`.
- `GSM_Overlay/input_server` — Standalone `gsm_overlay_server` binary (passive keyboard, gamepad, Sudachi) + `gsm-sudachi` library crate (`language/`).
- `native/game-background-hooks` — C++/MinHook Windows background-focus/input helper & x64/x86 DLLs.
- `native/windows-audio-capture` — Rust Windows process loopback audio capture helper.
- `native/windows-speech-recognition` — C++ Windows Live Captions & SAPI speech recognition helpers.
- `native/vita-ocr` — C bridge for legacy/Python Vita OCR.

### Python backend (`GameSentenceMiner/`)

- `GameSentenceMiner/gsm.py` — Main backend entrypoint, Qt main-thread loop + `AsyncBackgroundRunner`, Flask/WS startup, cleanup.
- `GameSentenceMiner/native/` — Typed Python facades (`history.py`, `anki_*.py`, `cron.py`, `ocr.py`, `overlay.py`, `text.py`, `text_correlation.py`, `downloads.py`, `runtime.py`) wrapping `_native` and Tauri bus calls with rollout/fallback controls (`GSM_NATIVE_MODE`, `GSM_NATIVE_*_MODE`).
- `GameSentenceMiner/gametext.py` & `GameSentenceMiner/text_pipeline/` — Live text ingestion, `AuthoritativeTextRuntime`, `TextCoordinatorActor`, `TextProjectionActor`, skip detection & journal facades.
- `GameSentenceMiner/anki.py`, `replay_handler.py`, `vad.py`, `clip_cards.py`, `longplay_handler.py`, `session_review.py` — Card mining, replay watcher, VAD audio trimming, FFmpeg media pipeline, clips, longplay SRT.
- `GameSentenceMiner/obs/` — Python OBS actions/service + `desktop_session.py` read-only projection of Tauri's game session.
- `GameSentenceMiner/web/` — Flask/Waitress HTTP app (`texthooking_page.py`), WebSocket manager (`gsm_websocket.py`), overlay callback handler (`overlay_handler.py`), and API route modules (delegating history/stats/search/tokenization/Anki queries to `gsm-history` where migrated, serving goals/games/DB/imports/exports/sync/Yomitan/runtime routes directly).
- `GameSentenceMiner/ai/` — LLM/translation providers, prompt presets/builder, character context/summary, translation cache.
- `GameSentenceMiner/util/` — Config (`config/`), SQLite ORM & migrations (`database/`), bus/IPC clients (`communication/`), actor/QoS helpers (`concurrency/`), cron runners (`cron/`), FFmpeg/media (`media/`), encrypted cloud sync (`cloud_sync/`), external API clients (`clients/`), Kechimochi/Tadoku sync, Yomitan dict builders (`yomitan_dict/`), standalone overlay/platform fallbacks (`overlay/`, `platform/`).
- `GameSentenceMiner/ui/` — PyQt6 settings, confirmation, grouping, screenshot, review, and selector dialogs + `desktop_dialog.py` one-shot host.
- `GameSentenceMiner/ocr/` & `GameSentenceMiner/owocr/` — Native OCR context bridge (`native_context.py`), macOS/Linux portable OneOCR runtime, and standalone/legacy Python OCR fallbacks.
- `GameSentenceMiner/windows_speech_recognition.py` — Standalone/Electron speech supervisor.

### Frontend UIs, extensions & build-only/legacy code

- `electron-src/renderer/src/` — React + Vite + Tailwind Hub UI (tabs: Home, OCR, Text Hook, Text Processing, Speech, Stats iframe, Game Settings, Settings, Logs).
- `GSM_Overlay/` — Overlay & companion WebView HTML/CSS/JS, Hachidori GSM bridge (`integrations/hachidori/`), Jiten Reader (`jiten.reader/`). Yomitan source lives in sibling repo `../yomitan-gsm/ext/`.
- `texthooker/` — Vendored Svelte texthooker UI built for Flask serving.
- `electron-src/main/` — **Preserved legacy Electron/Node reference & test fixtures only**; excluded from staged native packages and not executed at runtime.
- `scripts/` — Build, staging, packaging, benchmark, and smoke-test tooling (Node/Python — build/dev only).

## 5. Communication boundaries & ports

### Transport channels

| Channel | Endpoints | Purpose |
| --- | --- | --- |
| **Tauri IPC** | WebViews ↔ `gsm-desktop` | Typed commands (`commands.rs`) + authorized `desktop_call` (`desktop_services.rs`) + Tauri events. |
| **Desktop Message Bus** | `gsm-desktop` (`gsm-runtime`) ↔ Python backend | Authenticated localhost WebSocket (`GSM_BROKER_PORT`, `GSM_BROKER_TOKEN`, `GSM_CLIENT_ID`). Carries `text.ingress.v2`, `mining.history`, `mining.wordIndex`, `mining.cron`, `anki.*`, `obs.outputs`, `game.session`, `game.profile.select`, `ocr.native.*`, `dictionary.*`, `text.classify`, `gui.*`, `backend.event`, `app.agent.*`. |
| **HTTP API & Web UI** | Browsers / Stats iframe / Anki Beacon → Rust gateway → remaining Flask routes | Default `http://127.0.0.1:7275` (`general.single_port`). |
| **Backend WebSockets** | Overlay / Texthooker / Plaintext clients ↔ Python | Multiplexed on `:7275` (`/ws/texthooker`, `/ws/overlay`, `/ws/plaintext`), with legacy port support (`55001`, `55002`, `55499`). |
| **Input Server** | `gsm-desktop` / Overlay / Python ↔ `gsm_overlay_server` | Localhost WebSocket for passive keyboard chords, gamepad events, and Sudachi tokenization. |
| **OBS WebSocket v5** | `gsm-desktop` (`obs_service.rs`, `gsm-capture`) & Python (`obs/`) → OBS | Default `127.0.0.1:7274` (configurable). |
| **AnkiConnect HTTP** | `gsm-desktop` (`anki_connect.rs`) & standalone Python → Anki | Default `http://127.0.0.1:8765`. |

### Data directory & key files

Default active root (`%APPDATA%\GameSentenceMiner` on Windows, `~/.config/GameSentenceMiner` on Linux/macOS; overridable via `--profile` or `GSM_PROFILE_DIR`):

- `config.json` — Python mining profiles (`MasterConfig` / per-profile `Config`); desktop text-processing writes narrow patches here.
- `electron/config.json` — Desktop preferences owned by `gsm-settings::preferences` (Python reads read-only).
- `obs-service.json` — Native OBS updater & window scene-switcher settings.
- `texthook/profiles.json` — Hook profiles owned by `gsm-settings`.
- `gsm.db` — Primary SQLite database (tables: `game_lines`, `games`, `goals`, `daily_stats_rollup`, `game_daily_rollup`, `cron_table`, `anki_notes`, `anki_cards`, `anki_reviews`, `words`, `word_occurrences`, `kanji`, `kanji_occurrences`, `reading_breaks`, `third_party_stats`, `sync_game_line_changes`, `ai_models`, etc.).
- `ocr_config/*.json` — Per-scene OCR area configs.
- `logs/`, `temp/`, `downloads/v1/` (in shared data), `texthook/frida/` (shared Agent runtime cache).

## 6. Retired or explicitly deferred components

- **Node/Electron runtime sidecar**: Removed from the shipped desktop (`scripts/native-package-policy.mjs` rejects `node`, `node_modules`, `desktop-runtime`, and `dist/main`).
- **`user_plugins` cron runner**: Retired; upgrade removes old schedules and leaves `plugins.py` untouched on disk.
- **`anki_word_sync` cron**: Retired and superseded by `anki_card_sync`; Rust completes any leftover schedule row cleanly.
- **Built-in Frida engine hooks (`electron-src/main/engine_hooks/`)**: Explicitly deferred/retired from runtime and packages; source retained for reference.
- **MeCab runtime**: Replaced by Sudachi (`gsm-sudachi`).

## 7. Build, test, and run commands

- **Dev mode (Vite + Tauri watch)**: `npm run dev`
- **Stable build & launch**: `npm start` (or `npm run start:optimized`)
- **Agent graceful restart**: `npm run agent:restart -- --handoff --reason "..."` (add `--build` after desktop/renderer changes)
- **Rust checks & unit tests**: `npm run check:desktop`, `npm run test:desktop`, `cargo test --locked --manifest-path native/<crate>/Cargo.toml`
- **Frontend TS tests**: `npm run test:ts`
- **Python tests & formatting**: `.venv\Scripts\python.exe -m pytest`, `uv run ruff format GameSentenceMiner tests scripts`
- **Native desktop smoke suite**: `npm run test:native` (or `node scripts/test-native-desktop.mjs <suite>`)
- **Distributable installer & portable archive**: `npm run app:dist`

## 8. Minimal mental model

```text
Text source (native Agent/LunaHook/OCR, Windows speech, clipboard, or external WS)
  -> gsm-runtime outbox (text.ingress.v2) -> Python TextCoordinatorActor + _native (classify/skip/journal)
  -> Python projects to TextFeed/Overlay/LiveStats & writes gsm.db via Tauri gsm-history writer (+ async Sudachi word_index)
  -> Tauri anki_monitor polls AnkiConnect (or Flask receives Anki Beacon) -> Python anki.py matches via _native rank_card_lines
  -> Python saves OBS replay -> replay_handler + vad.py + ffmpeg extract audio/media -> optional Qt confirmation
  -> Tauri anki_media / anki_edit / anki_group commit media, fields, tags, or grouped merge to AnkiConnect
  -> Flask serves UI/APIs; migrated stats/search/Anki/tokenization/maintenance routes execute in Tauri gsm-history
```
