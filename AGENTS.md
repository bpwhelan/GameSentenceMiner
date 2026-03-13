# Repository Instructions

## Project Overview

GameSentenceMiner (GSM) is a hybrid Electron (TypeScript) + Python desktop app for
Japanese language learning. It automates Anki flashcard creation from games by
capturing text (text hooks or OCR), recording audio with VAD, taking screenshots,
and sending everything to Anki via Anki-Connect.

Instead of deprecating API endpoints, we can just remove them from the code.

## Build & Run Commands

### Python

Package manager is `uv`. Python >=3.10, <3.14. Dependencies in `pyproject.toml`.

```bash
uv sync --extra dev          # Install all deps including test deps
uv run pytest -ra            # Run all Python tests
uv run pytest tests/ocr/test_coordinate_math.py              # Single file
uv run pytest tests/ocr/test_coordinate_math.py::test_name   # Single test
uv run pytest -k "keyword"                                    # By keyword match
uv run pytest -x            # Stop on first failure
```

On Linux, Qt tests require a virtual display: `xvfb-run -a uv run pytest -ra`

Smoke-test the entry point: `uv run python -m GameSentenceMiner.gsm --help`

### Benchmarking

Use the dedicated stats benchmark script for performance work on the Flask stats endpoints:

```bash
uv run python scripts/benchmark_stats.py
uv run python scripts/benchmark_stats.py --endpoints game
uv run python scripts/benchmark_stats.py --db-mode direct-ro
uv run python scripts/benchmark_stats.py --db-path "%APPDATA%\\GameSentenceMiner\\gsm.db" --json-out .tmp_test_env/benchmark_stats.json
```

- Default mode is `snapshot`: the script creates a disposable copy of the database before timing requests.
- Use `direct-ro` only for quick local checks when timing stability matters less than startup speed.
- The benchmark covers `/api/stats`, `/api/today-stats`, and `/api/game/<game_id>/stats`.
- `today-stats` is benchmarked against the latest activity day by default, not literal today, so an empty current day does not understate the endpoint cost.
- The script measures Flask handler execution and JSON serialization time. It does not measure browser rendering.
- Use this script instead of ad-hoc imports of the full desktop app when investigating stats performance.

### Electron / TypeScript

Node.js 21 required (24 does NOT work). Use nvm: `nvm use 21`.

```bash
npm install                  # Install Node dependencies
npm run start                # Build TS + launch Electron
npm run dev                  # Watch mode (tsc --watch + Vite dev server)
npm run build                # Full production build (TS + Vite)
npm run test:ts              # Run TypeScript tests (vitest)
npm run test:ts:watch        # Vitest in watch mode
npm run app:dist             # Create distributable via electron-builder
```

### Linting / Formatting

- **Python**: Ruff is available (`.ruff_cache/` exists) but has no project config.
  No enforced formatter. Run ad-hoc: `uvx ruff check GameSentenceMiner/`
- **TypeScript/JS**: Prettier configured in `.prettierrc.json` (100 char width,
  single quotes, 4-space indent). Run: `npx prettier --check .`
- **No pre-commit hooks** are configured.

## Testing Conventions

### pytest (Python)

- Config: `pytest.ini` — test discovery restricted to `tests/` directory.
- `tests/conftest.py` sandboxes all OS paths (APPDATA, HOME, TMP) into
  `.tmp_test_env/`, sets `GAME_SENTENCE_MINER_TESTING=1`, and stubs out
  `GameSentenceMiner.util.logging_config` with a no-op logger.
- Custom `tmp_path` fixture overrides pytest's built-in (uses `.tmp_test_env/`).
- Benchmark tests are smoke and output-shape checks only. Do not assert absolute timing thresholds in pytest.
- **TDD preferred**: write failing tests first, then implement, then iterate.
- **Increment test coverage** where possible.

### Test Patterns

- Pure pytest functions (no `unittest.TestCase`). Classes used only for grouping.
- Primary mocking: `monkeypatch` fixture. Secondary: `unittest.mock.MagicMock/patch`.
- Heavy `sys.modules` stubbing to isolate from large dependencies (torch, Qt, etc).
- Use `@pytest.mark.parametrize` for data-driven tests.
- `autouse=True` fixtures for per-test state reset are common.

### vitest (TypeScript)

- Config: `vitest.config.ts` — tests in `electron-src/main/**/*.test.ts`.
- Setup file: `electron-src/main/test/setup.ts` (sets `GSM_ENABLE_CHAOS=1`).

## Code Style Guidelines

### Python

**Imports**:
- Absolute imports using full package path: `from GameSentenceMiner.util.config.configuration import ...`
- Relative imports only in vendored code (`mecab/`, `owocr/`).
- Group: stdlib → third-party → local `GameSentenceMiner.*`.
- Use parenthesized multi-line imports (preferred over backslash continuation):
  ```python
  from GameSentenceMiner.util.communication.electron_ipc import (
      FunctionName,
      announce_connected,
      register_command_handler,
  )
  ```
- Conditional/deferred imports are common for platform guards (`if is_windows()`)
  and circular-dependency avoidance (import inside function body).

**Naming**:
- Functions/variables: `snake_case`
- Private members: `_leading_underscore`
- Classes: `PascalCase`
- Constants: `UPPER_SNAKE_CASE`

**Type Hints**:
- Newer modules use `from __future__ import annotations` with modern syntax
  (`X | None`, `list[X]`). Older modules use `Optional[X]`.
- Fully type-annotate new code. At minimum, annotate function signatures.
- Use `@dataclass(frozen=True)` for immutable data containers (see `ai/contracts.py`).
- Use `Protocol` for structural typing where appropriate (see `ai/providers/base.py`).

**Formatting**:
- 4-space indentation.
- No enforced line length, but aim for readable lines (~120 chars).

**Docstrings**:
- Not consistently used. When writing new code, add a brief docstring to
  non-trivial public functions. Plain English, no specific framework required.

**Logging**:
- Use loguru via: `from GameSentenceMiner.util.logging_config import logger`
  (or re-exported from `configuration`). NEVER use stdlib `logging` or `print()`.
- Levels: `logger.debug()`, `logger.info()`, `logger.warning()`, `logger.error()`,
  `logger.exception()` (with traceback), `logger.success()` (milestones).
- Custom level `logger.background()` exists for background task messages.

**Error Handling**:
- Catch specific exceptions when possible, fall back to `except Exception as e`.
- Always log errors: `logger.error(f"Description: {e}")` or `logger.exception(...)`.
- Use `AIError(message, transient=bool)` in the AI subsystem for retry semantics.
- Silent `except: pass` only for truly non-critical cleanup.

**Configuration**:
- Always access config via `get_config()`. Never cache or store the config object.

**Concurrency**:
- Use `run_new_thread()` from `util/gsm_utils` for background work.
- Qt must run on the main thread. Use `pyqtSignal` for cross-thread communication.
- `gsm.py` runs an asyncio event loop alongside Qt.

### TypeScript / Electron

- Target: ESNext, module: node16, strict mode.
- Prettier: 100-char lines, single quotes, 4-space indent.
- IPC handlers: each feature has `register*IPC()` in `electron-src/main/ui/`.
- Use `getSanitizedPythonEnv()` when spawning Python processes.
- Use `getResourcesDir()`, `getAssetsDir()`, `getGSMBaseDir()` for paths.

## Key Architecture Notes

- **Electron ↔ Python IPC**: stdout messages prefixed with `GSMMSG:` + JSON.
  Python side: `util/communication/electron_ipc.py`. Electron side:
  `electron-src/main/communication/pythonIPC.ts`.
- **Text pipeline**: `gametext.py` → `text_log.py` → SQLite → Flask web UI.
- **Audio pipeline**: OBS records → VAD trims (`vad.py`) → `temp/` → Anki.
- **Config**: `util/config/configuration.py`, saved as TOML in `~/.gsm/`.
- **Database**: SQLite via `util/db.py::SentenceDatabase`, at `~/.gsm/gsm.db`.

## Yomitan Edit Workflow

- Do NOT edit built files under `GSM_Overlay/yomitan/` directly.
- For Yomitan logic changes, edit source files in the `yomitan-gsm` repo
  (e.g., `ext/js/language/text-scanner.js`), then rebuild and sync.

## Copilot / AI Agent Notes

See `.github/copilot-instructions.md` for full architecture details including
communication protocols, data flows, debugging tips, and release process.

### Common Pitfalls

- Mutable default arguments (e.g., `def f(tags=[])`): use `None` + internal init.
- Module-level mutable globals are widespread — be careful with test isolation.
- Mixed async paradigms: asyncio event loop + raw threading. Use
  `asyncio.run_coroutine_threadsafe()` to bridge when needed.
- `from __future__ import annotations` is required in new files using `X | None`
  syntax if supporting Python 3.10+.
