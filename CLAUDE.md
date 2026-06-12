# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What GSM is

GameSentenceMiner (GSM) is a hybrid **Electron (TypeScript) + Python** desktop app for Japanese
language learning. It sits between a game and Anki: it captures text (via text hooks or OCR),
records voice-line audio with Voice Activity Detection (VAD), takes screenshots, and builds Anki
cards automatically. It also ships a transparent in-game Yomitan overlay and an immersion stats
dashboard.

The repo is large and contains several cooperating sub-applications (see Architecture). Most of
the interesting logic is split between the Electron `main` process (orchestration, process
lifecycle, native OS integration) and the Python backend (text/audio/OCR pipelines, web UI).

## Commands

All commands run from the **repo root** (TS config files — `tsconfig.electron.json`,
`vitest.config.ts`, `package.json` — live at root, not in `electron-src/`).

### Run / build the app
```powershell
npm install
npm run start        # build TS + renderer, then launch Electron
npm run dev          # watch mode: tsc --watch + vite dev + electron (auto-reload)
npm run app:dist     # build a distributable installer into dist/ (electron-builder)
```

### Python
Python is **downloaded and managed by Electron** (`electron-src/main/python/python_downloader.ts`)
into a per-user venv; deps are installed with the bundled `uv` from `pyproject.toml` + `uv.lock`.
There is no manual venv setup for *running the app* — local edits to `GameSentenceMiner/` are
picked up immediately. The repo's own `.venv` is used for running tests/ruff locally.

```powershell
uv run ruff format GameSentenceMiner tests scripts   # ALWAYS run after Python changes
uv sync                                               # sync the local .venv from the lockfile
```
Lockfiles (`uv.lock`, `requirements.lock`) are generated in CI — only `uv lock` locally to test
lock changes. Use `.\run.ps1 add <package>` to add a dependency.

### Tests
```powershell
# Python (pytest) — must use .venv
.\.venv\Scripts\python.exe -m pytest                 # full suite (also: .\run.ps1 test)
.\.venv\Scripts\python.exe -m pytest tests/test_vad.py::test_name   # single test

# TypeScript / Electron (vitest, from repo root)
npm run test:ts                                      # vitest run
npm run test:ts:watch
npx vitest run electron-src/main/runtime/message_bus.test.ts   # single file
```
Python tests live in `tests/` (`pytest.ini` sets `testpaths = tests`). TS tests are colocated as
`*.test.ts(x)` next to the code they cover.

## Architecture

```
electron-src/          Electron app (TypeScript)
  main/                Main process: lifecycle, OS integration, spawns Python
    main.ts            Entry point
    runtime/           Message bus broker + ProcessManager (process supervision)
    communication/     Renderer/process state
    services/          App-level services (install sessions, updates, python ops, data relocate)
    ui/*.ts            Per-feature IPC handlers (obs, ocr, texthook, vn, steam, yuzu, agent, overlay)
    python/            Managed-Python download/version management
  renderer/src/        React + Vite UI (tabs: Home, Launcher, OCR, TextHook, Settings, TextProcessing)
  preload/             Preload bridge

GameSentenceMiner/     Python backend (package root)
  gsm.py               Backend entry: asyncio loop + PyQt6 GUI on main thread
  gametext.py          Text capture (clipboard, websockets from texthooker/Agent/Textractor)
  vad.py               Voice Activity Detection (faster-whisper / Silero); trims voice lines
  anki.py              Anki-Connect card creation
  ocr/                 OCR pipeline (OneOCR, owocr/Google-Lens fork, two-pass system)
  owocr/               Vendored + modified OwOCR
  web/                 Flask web server: stats dashboard, DB browser, goals, texthooking page, APIs
  ui/                  PyQt6 dialogs (config GUI, screenshot/area selectors, Anki confirmation)
  util/                Cross-cutting: config, database, communication, stats, overlay, platform, ...
  mecab/               Vendored MeCab controller

GSM_Overlay/           Separate Electron app: transparent in-game Yomitan overlay + live stats widget
texthooker/            Vendored + modified Svelte texthooker UI (build with build_for_gsm.ps1)
```

### Electron ↔ Python communication
The current transport is a **localhost WebSocket message bus**: a broker runs in the Electron main
process (`electron-src/main/runtime/message_bus.ts`), supervised by `process_manager.ts`. Both the
GSM backend and the OCR subprocess connect via `GameSentenceMiner/util/communication/bus_client.py`
using `GSM_BROKER_PORT` / `GSM_BROKER_TOKEN` / `GSM_CLIENT_ID` env vars injected at spawn.

A **legacy stdout/stdin line protocol still exists as a fallback**: messages prefixed `GSMMSG:`
(Python→Electron) / `GSMCMD:` (Electron→Python) followed by JSON. See
`util/communication/electron_ipc.py` (`send_message`). When touching IPC, account for both paths.

### Key data flows
- **Text:** game → clipboard/websocket → `gametext.py` → `util/text_log.py` → SQLite → Flask web UI
- **Anki:** "Mine" in web UI → `anki.py` confirmation (PyQt6) → Anki-Connect (port 8765)
- **OCR:** `ui/ocr.ts` starts/stops → Python `ocr/` (`two_pass_ocr.py`, OneOCR/owocr) → text to bus
- **Audio/VAD:** OBS records → `vad.py` trims the voice line → saved to `temp/` → attached to card

### Two separate config systems
- **Python config** — `GameSentenceMiner/util/config/configuration.py` (`Config`/`MasterConfig`
  dataclasses), persisted as TOML (`master_config.toml`). Supports multiple per-game **profiles**.
  Always read via `get_config()`; never touch a module-global `config` directly.
- **Electron store** — `electron-src/main/store.ts`, separate from Python config. Plus
  `electron-src/main/gsm_config.ts` bridges Electron ↔ Python config.

## Conventions

### Python
- **Logging:** `from GameSentenceMiner.util.config.configuration import logger` (loguru), not the
  stdlib `logging` module.
- **Threading:** `gsm.py` runs an asyncio loop while **Qt owns the main thread**. Never block the Qt
  thread — use `run_new_thread()` or `asyncio.create_task()`. Use `pyqtSignal` for cross-thread UI.
- **DB:** access through `GameSentenceMiner/util/database/db.py`; per-feature table modules live
  alongside it (`*_table.py`).
- Comments: keep them terse — one short line on *why*, not multi-line explanations.

### TypeScript
- Each feature registers a `register*IPC()` handler in `electron-src/main/ui/*.ts`, called from
  `main.ts`.
- When spawning Python, use the sanitized env helper (strips the dev venv) and the path helpers in
  `electron-src/main/util.ts` rather than hardcoding paths.

### Localization (renderer — enforced)
All user-facing strings in Electron renderer components must use `t("key")` from `useTranslation()`;
never hardcode English in JSX. Locale files: `electron-src/renderer/src/i18n/` — add the key to
`en.json` first (the fallback locale), then other locales. See `docs/LOCALIZATION.md`.

### Yomitan overlay edits
Do **not** edit built files under `GSM_Overlay/yomitan/`. Edit source in the separate
`yomitan-gsm` repo (`ext/...`), then rebuild/sync with
`yomitan-gsm/local-build-chrome-overlay.ps1`. See `AGENTS.md`.

## Platform & environment notes
- **Windows-first.** macOS/Linux support is WIP; several features are Windows-only (`pygetwindow`,
  `pywin32`, `windows-capture`, `pynput`). macOS uses a Homebrew Python venv (not the managed uv
  flow); Linux text hooking runs Windows hookers via Wine/Proton.
- **Node:** use Node 21 (NVM); newer majors have caused issues despite `engines` saying `>=18`.
- **External tools at runtime:** Anki-Connect (port 8765), optional OBS Studio via `obsws-python`
  (port 4455), and a text source (Agent / Textractor / built-in OCR).
- **No torch.** VAD deliberately uses faster-whisper (+ its ONNX Silero VAD); do not reintroduce
  torch / WhisperX.
- The backend is bundled and version-locked to the app — there is no PyPI/branch backend update path.
