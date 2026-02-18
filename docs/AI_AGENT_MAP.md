# GameSentenceMiner (GSM) AI Agent Map

Last updated: 2026-02-14  
Repository: `https://github.com/bpwhelan/GameSentenceMiner`

## 1. What GSM is

GameSentenceMiner is a desktop app for language learners that captures in-game text, matches it to replay/audio/screenshot context, and updates Anki cards with rich media and metadata.

Core capabilities:

- Text intake from websocket sources (Textractor/Luna/Agent), clipboard, and OCR.
- Replay buffer capture and timing alignment through OBS.
- VAD-based audio trimming and optional fallback logic.
- Automatic Anki note updates (fields, tags, media upload, optional AI translation).
- Overlay for in-game word boxes + dictionary UX.
- Stats, goals, search, and game metadata management via local web UI.
- Optional cloud sync for mined lines.

## 2. High-level architecture

```text
Electron shell (main + renderer)
  |- spawns Python backend: python -m GameSentenceMiner.gsm
  |- spawns OCR worker:     python -m GameSentenceMiner.ocr.owocr_helper
  |- can launch GSM_Overlay executable
  |
  |- IPC to GSM over stdio: GSMCMD:/GSMMSG:
  |- IPC to OCR over stdio: OCRCMD:/OCRMSG:
  v
Python backend (GameSentenceMiner.gsm)
  |- Flask/Waitress server (texthooker + stats APIs) on :55000 by default
  |- WebSocket servers:
      :55001 texthooker comm (read/write)
      :55002 plaintext output (write-only, default derived)
      :55499 overlay channel (read/write callback path)
  |- listens to OCR websocket input on :9002
  |- OBS websocket client (default 7274)
  |- SQLite database in appdata (gsm.db)
  |- file watcher for replay folder
  |- background cron scheduler + optional cloud sync/auth loops
```

## 3. Repository map (important locations)

### Core Python backend

- `GameSentenceMiner/gsm.py`  
  Main backend entrypoint and app lifecycle orchestration.
- `GameSentenceMiner/gametext.py`  
  Text ingestion, websocket listeners, clipboard monitor, rate limiting, and logging flow.
- `GameSentenceMiner/anki.py`  
  AnkiConnect integration, field policy logic, media upload/update pipeline.
- `GameSentenceMiner/replay_handler.py`  
  Replay file watcher + extraction pipeline into Anki updates.
- `GameSentenceMiner/vad.py`  
  Silero/Whisper VAD processing and validation gates.
- `GameSentenceMiner/obs.py`  
  OBS connection/service/state and replay/record/screenshot control.

### Web server and APIs

- `GameSentenceMiner/web/texthooking_page.py`  
  Flask app setup, page routes, core texthooker endpoints.
- `GameSentenceMiner/web/__init__.py`  
  Route registration entrypoint.
- `GameSentenceMiner/web/database_api.py`  
  DB management/search/dedupe/merge endpoints.
- `GameSentenceMiner/web/stats_api.py`  
  Stats and heatmap endpoints.
- `GameSentenceMiner/web/goals_api.py`  
  Goal tracking endpoints.
- `GameSentenceMiner/web/anki_api_endpoints.py`  
  Anki-derived stats endpoints.
- `GameSentenceMiner/web/yomitan_api.py`  
  Yomitan dict/index endpoints.
- `GameSentenceMiner/web/jiten_database_api.py` + `GameSentenceMiner/web/routes/*`  
  Jiten/VNDB/AniList game metadata and linking APIs.
- `GameSentenceMiner/web/cloud_sync_api.py`  
  Localhost-only cloud sync control endpoints.
- `GameSentenceMiner/web/gsm_websocket.py`  
  Internal websocket server manager.
- `GameSentenceMiner/web/overlay_handler.py`  
  Overlay-originated request handling.

### Config and persistence

- `GameSentenceMiner/util/config/configuration.py`  
  Primary config dataclasses, loading/saving, runtime singletons.
- `GameSentenceMiner/util/config/electron_config.py`  
  Python-side reader for Electron store config.
- `GameSentenceMiner/util/database/db.py`  
  SQLite base and tables (`game_lines`, `goals`, `ai_models`) + migrations.
- `GameSentenceMiner/util/database/games_table.py`  
  `games` table model + game-linking logic.
- `GameSentenceMiner/util/database/cron_table.py`  
  Scheduled task table model.
- `GameSentenceMiner/util/database/stats_rollup_table.py`  
  Daily rollup table model.

### OCR + overlay

- `GameSentenceMiner/ocr/owocr_helper.py`  
  OCR runtime process, OCR IPC command handling, OCR websocket compatibility layer.
- `GameSentenceMiner/ocr/gsm_ocr_config.py`  
  OCR area config model and loader (`ocr_config/*.json`).
- `GameSentenceMiner/util/overlay/get_overlay_coords.py`  
  Overlay OCR and coordinate extraction pipeline.
- `GameSentenceMiner/util/platform/window_state_monitor.py`  
  Window focus/fullscreen/process-pause/magpie compatibility logic.

### UI

- `GameSentenceMiner/ui/config_gui_qt.py`  
  Main Qt settings window and tabs.
- `GameSentenceMiner/ui/qt_main.py`  
  Qt app lifecycle + thread-safe dialog manager.
- `GameSentenceMiner/ui/config/tabs/*`  
  Settings tab builders.

### Electron app

- `electron-src/main/main.ts`  
  Electron main process boot, Python process management, updates.
- `electron-src/main/communication/pythonIPC.ts`  
  GSM stdio framing/parser (`GSMMSG`, `GSMCMD`).
- `electron-src/main/communication/ocrIPC.ts`  
  OCR stdio framing/parser (`OCRMSG`, `OCRCMD`).
- `electron-src/main/ui/ocr.ts`  
  OCR process lifecycle and renderer IPC bindings.
- `electron-src/main/ui/front.ts`  
  Home/game launcher IPC and overlay launcher hook.
- `electron-src/main/services/python_ops.ts`  
  Strict uv lock/environment sync logic.
- `electron-src/renderer/src/App.tsx`  
  Renderer tab shell and embedded legacy/stats iframes.

### Overlay project

- `GSM_Overlay/*`  
  Separate overlay app, heavily integrated with GSM and Yomitan.

### Legacy texthooker UI source (vendored)

- `texthooker/*`  
  Forked texthooker UI source and build assets.

### Tests

- `tests/*` (pytest only, per `pytest.ini`)

## 4. Runtime processes and boundaries

### Process inventory

- Electron main process (`main.ts`)
- Electron renderer process (React UI)
- Python GSM backend (`GameSentenceMiner.gsm`)
- Python OCR worker (`GameSentenceMiner.ocr.owocr_helper`)
- Optional overlay executable (`GSM_Overlay/out/...`)

### Process communication channels

- Electron <-> GSM backend: stdio framed JSON (`GSMCMD:` in, `GSMMSG:` out)
- Electron <-> OCR worker: stdio framed JSON (`OCRCMD:` in, `OCRMSG:` out)
- OCR worker -> GSM backend text ingress: websocket to `advanced.ocr_websocket_port` (default `9002`)
- Browser/renderer/clients -> GSM Flask: HTTP on `general.texthooker_port` (default `55000`)
- Overlay <-> GSM backend: websocket `overlay.websocket_port` (default `55499`)

## 5. Startup and lifecycle

## 5.1 Electron startup path

1. `electron-src/main/main.ts` boots and creates window/tray/menu.
2. Resolves Python runtime (`getOrInstallPython`), checks updates.
3. Performs strict environment sync/repair via `services/python_ops.ts`.
4. Spawns backend with `python -m GameSentenceMiner.gsm`.
5. Listens for `GSMMSG` events (`initialized`, `cleanup_complete`, etc.).
6. Optionally starts OCR process and overlay based on settings/start args.

## 5.2 Python backend startup path

`GameSentenceMiner/gsm.py` `GSMApplication.run()`:

1. `initialize()`:
   - registers Flask routes (`GameSentenceMiner/web/__init__.py`)
   - temp dir cleanup
   - optional Windows dependency downloads (OBS/FFmpeg/OneOCR assets)
   - migration/rollup checks
   - optional OBS launch
   - start Electron IPC stdin listener and announce connect
2. Builds Qt settings window (`qt_main.get_config_window()`).
3. Starts background threads:
   - Anki monitor
   - old word folder migration
   - cloud auth/sync loops (if cloud preview enabled)
   - texthooker Flask/Waitress server
4. Registers hotkeys.
5. Starts async background loop (`AsyncBackgroundRunner`) and schedules:
   - post-init (`init_overlay_processor`, VAD init, file watcher)
   - cron scheduler loop
   - text monitor loop (websocket+clipboard listeners)
6. Sets signal handlers and tray.
7. Marks status ready and emits IPC `initialized`.
8. Enters Qt event loop.

## 5.3 Shutdown path

`GSMApplication.cleanup()`:

- stop OBS manager + replay buffer/disconnect
- stop websocket servers
- stop cloud loops
- terminate child processes tracked in app state
- stop tray + discord RPC
- stop replay folder observer
- cleanup temp video/process-pausing state
- shutdown Qt + async loop
- emit IPC `cleanup_complete`

## 6. Text ingestion and normalization pipeline

Main flow: `GameSentenceMiner/gametext.py`

Inputs:

- Clipboard (if enabled)
- User-configured websocket URIs (`general.websocket_uri`)
- Dedicated OCR websocket source on `advanced.ocr_websocket_port`

Key behaviors:

- Rate limiting anti-spam per source (`is_message_rate_limited`)
- Dynamic websocket URI config hot-reload
- Self-output port detection to avoid feedback loops
- Optional sequential merge mode for progressively expanding lines
- Text processing replacements via `util/text_processing.py`

On accepted line:

1. `add_line()` into in-memory `game_log` (`util/text_log.py`)
2. `add_event_to_texthooker()` pushes event and websocket notifications
3. `live_stats_tracker` update
4. optional overlay OCR matching request
5. OBS longplay subtitle update
6. DB insert into `game_lines` (plus game link through `GamesTable.get_or_create_by_name`)

## 7. Anki/replay/audio pipeline

Main files:

- `GameSentenceMiner/anki.py`
- `GameSentenceMiner/replay_handler.py`
- `GameSentenceMiner/vad.py`

Flow summary:

1. `anki.monitor_anki()` polls AnkiConnect for new cards.
2. Matching logic maps card sentence to recent GSM lines.
3. Queue item triggers OBS replay save.
4. Replay file watcher detects video file, calls `ReplayAudioExtractor.process_replay()`.
5. Extractor computes timings, screenshot time, audio, VAD trim.
6. Optional prefetch:
   - AI translation
   - screenshot/media/animated assets
7. `anki.update_anki_card()` updates fields/tags/media and DB state.

Notable details:

- sentence audio cache keyed by normalized sentence signature.
- deferred animation/video generation path for smoother UX.
- field-level overwrite/append/core policy is configurable.

## 8. OCR and overlay pipeline

### OCR worker (`ocr/owocr_helper.py`)

- Runs as separate Python process.
- Supports both:
  - new stdio IPC from Electron (`OCRCMD`/`OCRMSG`)
  - legacy websocket command compatibility.
- Sends recognized text to GSM OCR websocket server as JSON:
  - `sentence`, `time`, `process_path`, `source`, optional `dict_from_ocr`

Supported OCR IPC commands:

- `pause`
- `unpause`
- `toggle_pause`
- `get_status`
- `manual_ocr`
- `reload_config`
- `stop`
- `toggle_force_stable`
- `set_force_stable`

### Overlay processor (`util/overlay/get_overlay_coords.py`)

- Managed by `OverlayThread` with async loops.
- Uses OBS screenshots and/or MSS (config-dependent).
- Applies OCR area config scaling and OCR engine selection.
- Converts OCR boxes to overlay coordinate payloads.
- Handles periodic scans or on-demand scans from new lines/hotkeys.
- Uses `WindowStateMonitor` for focus/fullscreen/magpie/process pause interactions.

Overlay inbound message types handled in backend:

- `translate-request`
- `restore-focus-request`
- `process-pause-request` (`pause`/`resume`)

## 9. HTTP API map (Flask)

Base server: `http://localhost:<general.texthooker_port>` (`55000` default)

Core page/navigation routes:

- `/`
- `/texthooker`
- `/database`
- `/overview`
- `/stats`
- `/goals`
- `/search`
- `/anki_stats`

Core runtime endpoints:

- `/data`
- `/get_ids`
- `/clear_history`
- `/get-screenshot`
- `/play-audio`
- `/translate-line`
- `/translate-multiple`
- `/get_status`
- `/get_websocket_port`

Database APIs (from `database_api.py`):

- `/api/search-sentences`
- `/api/games-list`
- `/api/delete-sentence-lines`
- `/api/delete-games`
- `/api/settings` (GET/POST)
- `/api/preview-text-deletion`
- `/api/delete-text-lines`
- `/api/preview-deduplication`
- `/api/deduplicate`
- `/api/deduplicate-entire-game`
- `/api/search-duplicates`
- `/api/merge_games`
- `/api/migrate-lines`
- `/api/delete-regex-in-game-lines`
- `/api/database_backup`

Stats APIs:

- `/api/stats`
- `/api/mining_heatmap`
- `/api/goals-projection`
- `/api/import-exstatic`
- `/api/kanji-sorting-configs`
- `/api/kanji-sorting-config/<filename>`
- `/api/daily-activity`
- `/api/today-stats`
- `/api/kanji-frequency`

Goals APIs:

- `/api/goals/progress`
- `/api/goals/today-progress`
- `/api/goals/projection`
- `/api/goals/complete_todays_dailies`
- `/api/goals/current_streak`
- `/api/goals/latest_goals`
- `/api/goals/tomorrow-requirements`
- `/api/goals/reading-pace`
- `/api/goals/current`
- `/api/goals/update`
- `/api/goals/today`

Anki stats APIs:

- `/api/anki_earliest_date`
- `/api/anki_kanji_stats`
- `/api/anki_game_stats`
- `/api/anki_nsfw_sfw_retention`
- `/api/anki_mining_heatmap`
- `/api/anki_stats_combined`

Yomitan APIs:

- `/api/yomitan-dict`
- `/api/yomitan-index`

Jiten/game-metadata APIs (blueprints in `web/routes/*`):

- `/api/games-management`
- `/api/games/<game_id>` (PUT/DELETE)
- `/api/games/<game_id>/mark-complete`
- `/api/games/<game_id>/delete-lines`
- `/api/orphaned-games`
- `/api/games` (POST)
- `/api/games/<game_id>/link-jiten`
- `/api/games/<game_id>/repull-jiten`
- `/api/jiten-search`
- `/api/search/unified`
- `/api/cron/jiten-upgrader/run`
- `/api/debug-db`

Cloud sync control APIs (localhost-only guard):

- `/api/cloud-sync/status`
- `/api/cloud-sync/settings`
- `/api/cloud-sync/queue-existing`
- `/api/cloud-sync/reset-cursor`
- `/api/cloud-sync/run`

Swagger docs:

- `/api/docs` (if flasgger installed)

## 10. WebSocket map

Managed in `web/gsm_websocket.py`:

- `ID_HOOKER` (`advanced.texthooker_communication_websocket_port`, default `55001`)
  - read/write
  - receives client messages to queue (if unpaused)
  - sends text events/reset UI events
- `ID_OVERLAY` (`overlay.websocket_port`, default `55499`)
  - read with callback to `overlay_handler`
  - write for coordinates/translation/errors
- `ID_PLAINTEXT` (`advanced.plaintext_websocket_port`, default `55002`)
  - write-only plaintext output channel

OCR text ingress websocket:

- `advanced.ocr_websocket_port` default `9002`  
  GSM listens as a client to `ws://localhost:9002` for OCR result payloads.

## 11. stdio IPC contracts

### GSM <-> Electron

Python sends:

- Prefix: `GSMMSG:`
- Payload shape: `{"function": "...", "data": {...}, "id": optional}`

Python listens for:

- Prefix: `GSMCMD:`
- `function` values handled by backend:
  - `quit`
  - `quit_obs`
  - `start_obs`
  - `open_settings`
  - `open_texthooker`
  - `open_log`
  - `toggle_replay_buffer`
  - `restart_obs`
  - `exit`
  - `on_connect`

Important outbound messages:

- `initialized`
- `cleanup_complete`
- `notification` (routed by electron to native notifications)

### OCR <-> Electron

OCR sends:

- Prefix: `OCRMSG:`
- Payload shape: `{"event": "...", "data": {...}, "id": optional}`

OCR listens for:

- Prefix: `OCRCMD:`
- `command` values listed in section 8.

Important OCR events:

- `started`, `stopped`
- `paused`, `unpaused`
- `status`
- `error`
- `ocr_result`
- `config_reloaded`
- `force_stable_changed`

## 12. Database model and migrations

Primary DB: `gsm.db` in app directory (`%APPDATA%/GameSentenceMiner` on Windows).

Main tables:

- `game_lines` (`GameLinesTable`)
  - mined lines and media/translation linkage
  - includes `language`, `game_id`, `note_ids`, `last_modified`
- `games` (`GamesTable`)
  - game metadata, linking IDs (`deck_id`, `vndb_id`, `anilist_id`)
  - scene mapping via `obs_scene_name`
- `goals` (`GoalsTable`)
  - goal snapshots and version metadata
- `daily_stats_rollup` (`StatsRollupTable`)
  - pre-aggregated daily analytics
- `cron_table` (`CronTable`)
  - scheduled jobs
- `ai_models`
  - cached model lists

Sync tracking:

- `sync_game_line_changes` table + triggers:
  - `trg_game_lines_sync_insert`
  - `trg_game_lines_sync_update`
  - `trg_game_lines_sync_delete`

Cloud sync methods on `GameLinesTable`:

- `get_pending_sync_changes`
- `acknowledge_sync_changes`
- `queue_all_lines_for_sync`
- `apply_remote_sync_changes`

DB backups:

- gzipped rolling backups under appdata backup folder (5-day cleanup in current logic).

## 13. Config and state model

### App directory and key files

Default app root:

- Windows: `%APPDATA%\GameSentenceMiner`
- Linux/macOS: `~/.config/GameSentenceMiner`

Key files/folders:

- `config.json` (master/profile config)
- `gsm.db` (sqlite)
- `electron/config.json` (electron-store data)
- `ocr_config/*.json` (per-scene OCR area configs)
- `plugins.py` (user plugin entry)
- `temp/` (runtime scratch files)
- `logs/` (loguru log files)
- `suspended_pids.json` (process-pausing persistence)

### Config objects

Profile-heavy config in `configuration.py`:

- `General`, `TextProcessing`, `Paths`, `Anki`, `Features`,
  `Screenshot`, `Audio`, `OBS`, `Hotkeys`, `VAD`,
  `Advanced`, `Ai`, `Overlay`, `WIP`

Global/master config sections include:

- profile registry and current profile selection
- stats config, discord config, experimental/process-pausing settings

Runtime state singletons:

- `gsm_state` (`GsmAppState`)
- `gsm_status` (`GsmStatus`)
- `anki_results` (line-id keyed update result cache)

### Port defaults (important)

- Flask web: `7275`
- Texthooker websocket: `55001`
- Plaintext websocket: `55002` (derived if unset)
- OCR websocket: `9002`
- Overlay websocket: `55499`
- OBS websocket: `7274`
- AnkiConnect URL: `http://127.0.0.1:8765`

## 14. Cron and extension points

Scheduler: `util/cron/run_crons.py` (`CronScheduler`)

Known task names:

- `populate_games`
- `jiten_sync`
- `daily_stats_rollup`
- `user_plugins`
- `jiten_upgrader`

User plugin hook:

- File: `%APPDATA%/GameSentenceMiner/plugins.py`
- Auto-created template if missing.
- `main()` executed by `user_plugins` cron job.

## 15. Cloud sync subsystem

Core service: `util/cloud_sync/service.py`

Summary:

- incremental sync using local change tracking table
- identity-based `since_seq` cursor stored in local state table
- adaptive batching/timeouts for worker constraints
- optional auto-sync loop thread
- manual sync endpoint can trigger post-sync rollup

Related:

- auth warm-up loop: `util/gsm_cloud_auth_cache.py`
- local API controls: `web/cloud_sync_api.py` (localhost-only)

## 16. Electron renderer tab model

Main tabs in `electron-src/renderer/src/App.tsx`:

- Home (`obs`)
- OCR (`ocr`)
- Stats (`stats`)
- Game Settings (`launcher`)
- Settings (`settings`)
- Python (`python`)
- Console (`console`)

Notes:

- Stats panel embeds GSM local web page (`http://localhost:7275/<endpoint>`) in iframe.
- Renderer interacts with Electron main through extensive `ipcMain.handle/on` channels.

## 17. Testing map

Test framework:

- `pytest` (see `pytest.ini`, `tests` only)

Notable coverage areas:

- Anki update flow (`tests/test_anki.py`)
- Cloud sync service (`tests/util/cloud_sync/test_cloud_sync_service.py`)
- DB sync tracking (`tests/util/database/test_gameline_sync_tracking.py`)
- IPC parsers (`tests/util/communication/*`)
- OCR format/parsing (`tests/ocr/*`)
- text processing and shared utility behavior

Test environment setup:

- `conftest.py` rewires appdata/temp/home env vars to local temp dirs.
- logging module is stubbed with no-op logger for tests.

## 18. Build and run workflows

### Main app (Electron)

- `npm run dev`
- `npm run build`
- `npm run start`

### Python backend direct

- `python -m GameSentenceMiner.gsm`

### Tests

- `pytest`

### Convenience scripts

- `run.ps1`
- `run_gsm.ps1`

## 19. Frequent change targets (where to edit)

If you need to change text intake behavior:

- `GameSentenceMiner/gametext.py`
- `GameSentenceMiner/util/text_processing.py`
- `GameSentenceMiner/util/text_log.py`

If you need to change Anki field policy/media behavior:

- `GameSentenceMiner/anki.py`
- `GameSentenceMiner/replay_handler.py`
- `GameSentenceMiner/util/media/ffmpeg.py`

If you need to change OCR command/control behavior:

- `GameSentenceMiner/ocr/owocr_helper.py`
- `GameSentenceMiner/util/communication/ocr_ipc.py`
- `electron-src/main/ui/ocr.ts`

If you need to change web API behavior:

- `GameSentenceMiner/web/texthooking_page.py`
- `GameSentenceMiner/web/database_api.py`
- `GameSentenceMiner/web/stats_api.py`
- `GameSentenceMiner/web/goals_api.py`
- `GameSentenceMiner/web/routes/*`

If you need to change websocket behavior:

- `GameSentenceMiner/web/gsm_websocket.py`
- `GameSentenceMiner/web/overlay_handler.py`

If you need to change DB schema/migrations:

- `GameSentenceMiner/util/database/db.py`
- `GameSentenceMiner/util/database/games_table.py`
- `GameSentenceMiner/util/database/cron_table.py`
- `GameSentenceMiner/util/database/stats_rollup_table.py`

If you need to change startup/shutdown orchestration:

- `GameSentenceMiner/gsm.py`
- `electron-src/main/main.ts`

If you need to change settings UI:

- `GameSentenceMiner/ui/config_gui_qt.py`
- `GameSentenceMiner/ui/config/tabs/*`
- `electron-src/renderer/src/components/tabs/*`
- `electron-src/main/store.ts`

## 20. Important behavioral notes / gotchas

- `is_gsm_cloud_preview_enabled()` in `configuration.py` currently returns `True` immediately.  
  This effectively enables cloud-preview-gated code paths by default in current source.

- `migrate_populate_games_cron_job()` comment says one-time behavior, but currently creates schedule `'weekly'` in migration code.  
  Validate intended behavior before changing cron semantics.

- Text source loopback protection exists (output websocket ports are excluded as input URIs).  
  Preserve this when adding new ports.

- Overlay/OCR/window-state code has heavy Windows-specific logic; check guards before cross-platform changes.

- Renderer stats tab depends on local Flask availability and will poll until endpoint responds.

## 21. Minimal mental model for agents

If you remember only one path, remember this:

```text
Text arrives (websocket/clipboard/OCR)
-> gametext normalizes/logs/stores
-> user mines card in Anki
-> replay saved + watched
-> replay_handler extracts media + VAD
-> anki.py updates note/media/tags
-> stats/goals/db/cloud-sync consume stored lines
```

This is the backbone of GSM behavior.
