# Repository Instructions

## Yomitan Edit Workflow

- Do not edit built/compiled files under `GSM_Overlay/yomitan/` directly.
- For Yomitan logic changes, edit source files in `C:\Users\Beangate\GSM\yomitan-gsm\ext\` (for example: `ext/js/language/text-scanner.js`).
- After source edits, rebuild and sync the overlay copy by running:
  - `C:\Users\Beangate\GSM\yomitan-gsm\local-build-chrome-overlay.ps1`

## pytest
- Always use .venv for running pytest to ensure dependencies are correctly managed.
- If possible, make tests first, making sure they fail before implementing functionality, and then iterate on your solution until tests pass.
- Increment coverage where possible.

## Ruff
- Always run Ruff after Python changes.
- Use `.venv\Scripts\python -m ruff check GameSentenceMiner tests scripts` from the repo root.
