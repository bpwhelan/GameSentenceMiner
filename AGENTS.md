# Repository Instructions

## Do NOT port NDLOCR-Lite
- Do not port the `ndlocrlite` / NDLOCR-Lite engine from owocr into GSM (`GameSentenceMiner/owocr/owocr/ocr.py`).
- It was evaluated and rejected: ~1-2 seconds per scan on even a very small region at ~30% CPU. Too slow/heavy for the main OCR and for stability OCR alike.
- This is a final decision — don't re-attempt it.

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
- Use `uv run ruff format GameSentenceMiner tests scripts` from the repo root.

## Localization (i18n)
- All user-facing strings in Electron renderer components must use `t("key")` from `useTranslation()`. Never hardcode English text in JSX.
- Locale files live in `electron-src/renderer/src/i18n/` (`en.json`, `ja.json`, `ukr.json`).
- When adding new UI text, add the key to `en.json` first, then add translations to `ja.json` and `ukr.json`.
- Use `{variable}` interpolation for dynamic values: `t("key", { name: value })`.
- For module-scope constants (outside React components), store i18n key strings in a `labelKey` field or key-map object, then translate at render time with `t(item.labelKey)`.
- See `docs/LOCALIZATION.md` for the full guide, key naming conventions, and code patterns.
