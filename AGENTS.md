# Repository Instructions

## Agent Restart Workflow

- After completing and checking changes the user wants to try, use `npm run agent:restart -- --reason "Brief description of the changes"` to request a clean restart with a desktop warning.
- Add `--build` for Electron changes unless the main process and renderer have already been built. Complete any separate overlay/vendor/native build workflow first.
- Use `npm run agent:status` to check availability. GSM must have been launched once with restart support using `npm start`; `npm run dev` manages its own restart loop.
- The command waits for the new app and backend to be ready. Treat a nonzero exit as a failure; do not report success or use broad process-name kills as a fallback.
- See `docs/AGENT_RESTART.md` for timing options, startup behavior, and troubleshooting.

## Yomitan Edit Workflow

- Do not edit built/compiled files under `GSM_Overlay/yomitan/` directly.
- For Yomitan logic changes, edit source files in `C:\Users\Beangate\GSM\yomitan-gsm\ext\` (for example: `ext/js/language/text-scanner.js`).
- After source edits, rebuild and sync the overlay copy by running:
  - `C:\Users\Beangate\GSM\yomitan-gsm\local-build-chrome-overlay.ps1`

## pytest
- Always use .venv for running pytest to ensure dependencies are correctly managed.
- If possible, make tests first, making sure they fail before implementing functionality, and then iterate on your solution until tests pass.
- Increment coverage where possible.

## Hachidori Integration Workflow

- Treat `GSM_Overlay/hachidori/` as generated vendor output. Keep GSM logic in `GSM_Overlay/integrations/hachidori/` and shared modules in `GSM_Overlay/`.
- Regenerate local integration edits with `node scripts/hachidori-integration.mjs`.
- Import upstream updates with `node scripts/sync-hachidori.mjs <clean-upstream-checkout>`. The sync applies and validates GSM hooks automatically.
- Keep upstream touch points in `scripts/hachidori-integration.mjs`; fail if an anchor changes instead of silently skipping a hook.
- See `GSM_Overlay/HACHIDORI_BRIDGE.md` for the API, ownership, and validation commands.

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
