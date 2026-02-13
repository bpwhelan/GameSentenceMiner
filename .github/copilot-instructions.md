# GameSentenceMiner (GSM) AI Coding Agent Instructions

## Overview
GSM is a hybrid Electron + Python desktop application for Japanese language learning that automates flashcard creation from games. The app captures text (via text hooks or OCR), records audio with Voice Activity Detection (VAD), takes screenshots, and sends everything to Anki.

**Core Architecture**: Electron frontend (TypeScript) ↔ Python backend (spawned process) ↔ Flask web server (for UI pages)

## Project Structure & Key Boundaries

```
GameSentenceMiner/
├── electron-src/main/          # Electron main process (TypeScript)
│   ├── main.ts                 # Entry point, process lifecycle, Python spawning
│   ├── communication/          # Python IPC via stdin/stdout (GSMMSG: protocol)
│   ├── ui/                     # IPC handlers for each feature (yuzu, vn, steam, ocr, obs)
│   └── python/                 # Python installer/version management
├── GameSentenceMiner/          # Python backend (package root)
│   ├── gsm.py                  # Python main entry, async event loop, Qt GUI integration
│   ├── gametext.py             # Text capture (clipboard, websockets from texthooker/Agent)
│   ├── vad.py                  # Voice Activity Detection (Silero/Whisper processors)
│   ├── anki.py                 # Anki-Connect integration
│   ├── ocr/                    # OCR engines (OneOCR, Google Lens fork)
│   ├── web/                    # Flask app for web UI (database browser, stats)
│   ├── ui/                     # PyQt6 dialogs (config, screenshot selector, Anki confirmation)
│   └── util/                   # Config (TOML), database (SQLite), logging
├── GSM_Overlay/                # Separate Electron app for transparent overlay (Yomitan integration)
└── texthooker/                 # Forked Svelte UI for game text hooking
```

## Communication Patterns

### Electron ↔ Python IPC
- **Protocol**: Stdout messages prefixed with `GSMMSG:` followed by JSON: `{"function": "event_name", "data": {...}}`
- **Implementation**: `electron-src/main/communication/pythonIPC.ts` (GSMStdoutManager) parses stdout
- **Python side**: `GameSentenceMiner/util/communication/electron_ipc.py` sends messages via `print(f"GSMMSG:{json.dumps(msg)}")`
- **Key events**: `cleanup_complete`, `start`, `anki_result`, `open_settings`, `obs_started`, etc.

### Python Internal Architecture
- **Main loop**: `gsm.py::async_main()` runs asyncio event loop + Qt on main thread
- **Text pipeline**: `gametext.py` monitors clipboard/websockets → `add_line_to_text_log()` → `util/text_log.py` → Flask web UI
- **Audio pipeline**: OBS records → VAD trims → stored in `temp/` → sent to Anki
- **Configuration**: Single source of truth in `GameSentenceMiner/util/configuration.py` (Config dataclass), saved as TOML

## Critical Developer Workflows

### Running the App (Development)
```powershell
# Quick start (recommended)
npm install
npm run start  # Builds TypeScript + launches Electron

# Alternative: Watch mode for TS changes
npm run dev    # Terminal 1: tsc --watch
npm run start  # Terminal 2: Run app

# Restart Python backend without restarting Electron
# Use "Restart Python App" from app menu (File → Restart Python)
```

### Building for Distribution
```powershell
npm run app:dist  # Creates installer in dist/ using electron-builder
```

### Python Development
- **NO manual Python setup needed**: Electron downloads/manages Python via `electron-src/main/python/python_downloader.ts`
- **Dependencies**: Managed by `uv` (bundled), installed automatically on first run
- **Local edits**: Changes to `GameSentenceMiner/` are picked up immediately (uses local files, not installed package)
- **Package management**: `pyproject.toml` defines deps, `uv sync` installs them

### Configuration Management
- **Master config**: `GameSentenceMiner/util/configuration.py::MasterConfig` + `Config` dataclass
- **Storage**: `~/.gsm/` (default) or app directory, saved as `master_config.toml`
- **Profile system**: Multiple game profiles (e.g., "Default", "Game1"), switched via `switch_profile_and_save()`
- **UI**: PyQt6 config window (`GameSentenceMiner/ui/config_gui_qt.py`), opened via hotkey or menu

## Project-Specific Conventions

### Python Patterns
1. **Logging**: Use `from GameSentenceMiner.util.logging_config import logger`, NOT `logging` module. The logging system uses loguru for enhanced functionality.
2. **Config access**: ALWAYS use `get_config()`, NEVER access global `config` directly
3. **Database**: `GameSentenceMiner/util/db.py::SQLiteDB` for thread-safe ops, `SentenceDatabase` for main DB
4. **Async/Sync mixing**: `gsm.py` runs asyncio loop, Qt on main thread. Use `run_new_thread()` for blocking ops
5. **Error handling**: Errors in `gsm.py::async_main()` call `handle_error_in_initialization()` to keep process alive for Electron

### TypeScript Patterns
1. **IPC registration**: Each feature has `register*IPC()` function in `electron-src/main/ui/*.ts` (called from `main.ts`)
2. **Process spawning**: Use `getSanitizedPythonEnv()` when spawning Python (strips virtual env vars)
3. **Electron store**: `electron-src/main/store.ts` persists Electron-side settings (separate from Python config)
4. **Path handling**: Use `getResourcesDir()`, `getAssetsDir()`, `getGSMBaseDir()` for portable paths

### Key Data Flows
1. **Text capture**: Game → Clipboard/Websocket → `gametext.py::handle_new_text_event()` → `text_log.py::add_text_line()` → SQLite → Web UI
2. **Anki card creation**: User clicks "Mine" in web UI → `anki.py::show_anki_confirmation()` → PyQt6 dialog → `anki_connect.send_to_anki()` → Anki-Connect
3. **OCR**: `electron-src/main/ui/ocr.ts` starts/stops → Python `ocr/oneocr.py` or `owocr/` (Google Lens fork) → sends text via clipboard
4. **VAD**: `vad.py::VADManager::trim_audio_with_vad()` → processor (Silero/Whisper) → trimmed audio saved

## Integration Points & External Dependencies

### Required External Tools
- **Anki**: Anki-Connect add-on must be running (port 8765)
- **OBS Studio**: Optional, for recording. Managed via `obsws-python` websocket (default port 4455)
- **Text sources**: Agent, Textractor, or built-in OCR

### WebSocket Servers
- **Texthooker**: Svelte app in `texthooker/`, connects to Python via websocket (port read from settings)
- **Agent/Textractor**: External tools, send text to GSM via websocket
- **Python listener**: `gametext.py::listen_websockets()` accepts connections

### Database Schema
- **Main DB**: `~/.gsm/gsm.db` (SQLite)
  - `mined_sentences`: `(game, sentence, screenshot, audio, timestamp, ...)`
  - `kanji_knowledge`: Kanji tracking for stats
  - `games`: Game metadata
- **Access**: Via `util/db.py::SentenceDatabase`

## Common Gotchas & Debugging

### Debugging Python Issues
- **Logs**: Check `~/.config/GameSentenceMiner/logs/gamesentenceminer.log` (or use the logging_config module)
- **Dev mode**: Set `is_dev = True` in `configuration.py` for verbose logging
- **Crashes**: `crash_log.txt` in project root (if `faulthandler` enabled for beangate dev)
- **IPC issues**: Check stdout parsing in `pythonIPC.ts`, ensure messages start with `GSMMSG:`

### Electron Issues
- **Dev tools**: Automatically open in dev mode (`isDev()` check)
- **Process cleanup**: Electron kills Python on quit via `cleanup()` in `gsm.py`
- **Updater**: `electron-src/main/update_checker.ts` checks GitHub releases

### Qt GUI Threading
- **CRITICAL**: Qt must run on main thread. Async operations in `qt_main.py::QtAsyncRunner` use worker threads
- **Signals**: Use PyQt signals (`pyqtSignal`) for cross-thread communication
- **Blocking ops**: Never block Qt thread; use `run_new_thread()` or `asyncio.create_task()`

## Testing & Validation
- **No formal test suite** (manual testing only)
- **Test utilities**: `test/` folder has ad-hoc scripts (e.g., `window_names.py` for window detection)

## Release Process
1. Update version in `package.json` and `pyproject.toml`
2. Build: `npm run app:dist`
3. Publish: `npm run app:deploy` (requires GitHub token in env)
4. Auto-updater checks GitHub releases via `electron-updater`

## Additional Notes
- **Submodules**: `texthooker/` and `GSM_Overlay/` are separate repos, use `git clone --recurse-submodules`
- **Node version**: Use NVM with Node 21 (22+ NOT supported)
- **Windows-first**: macOS/Linux support is WIP (some features Windows-only, e.g., `pygetwindow`, `pywin32`)
- **Localization**: I18n files in `GameSentenceMiner/locales/*.json`, loaded in PyQt config GUI
