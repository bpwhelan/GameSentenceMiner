# GameSentenceMiner repository map

GSM runs its desktop and backend services in the Tauri process.

| Feature | Source |
| --- | --- |
| Desktop startup, commands, windows and tray | `src-tauri/src/main.rs`, `app_lifecycle.rs`, `commands.rs` and `desktop_services.rs` |
| Text capture and delivery | `src-tauri/src/text_intake/`, `native/gsm-intake/`, `native/gsm-text-preview/` and `native/gsm-texthook/` |
| Capture, OCR and overlay | `native/gsm-capture/`, `native/gsm-overlay/`, `src-tauri/src/ocr_coordinator.rs` and `src-tauri/src/overlay_host.rs` |
| Mining, VAD, OBS and Anki | `native/gsm-mining/` and the mining, OBS and Anki modules in `src-tauri/src/` |
| Web gateway, database and reading history | `native/gsm-web/`, `native/gsm-db/` and `native/gsm-history/` |
| Profiles, preferences and package management | `native/gsm-settings/` and `native/gsm-packages/` |
| Desktop UI | `electron-src/renderer/src/` (React) |
| Overlay UI and dictionary integrations | `GSM_Overlay/`. See [AGENTS.md](../AGENTS.md) for vendor source ownership. |
| Text feed | `texthooker/` builds the page in `resources/web/templates/index.html` |
| Shared resources | `resources/web/` for web templates and static files, `resources/assets/` for models and policies, `resources/locales/` for mining field labels |

The historical Electron main process in `electron-src/main/` supplies reference code and compatibility tests. The current app launches through `scripts/start-tauri.mjs`. See [contributing](../.github/CONTRIBUTING.md) for builds and tests.
