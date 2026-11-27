# Contributing to GameSentenceMiner

GSM uses a Tauri/Rust desktop, a React frontend, and native Rust services.
Start with [the repository map](../docs/AI_AGENT_MAP.md).

## Quick start

Install Node.js compatible with package.json, stable Rust, and the
[Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/).
From the repository root, run `npm ci`, then `npm run dev`.

Tauri starts the frontend server and watches native changes. Frontend edits use
hot reload. Use `npm start` for a stable app you can rebuild and gracefully
restart while it is running. Existing user profiles are reused unless you pass
an explicit --profile path; use a separate profile for isolated experiments.

## Verification

Run checks appropriate to your change:

- `npm run check:desktop` and `npm run test:desktop` for Rust changes.
- `npm run test:ts` for frontend changes.
- `npm run build:tauri`, then `node scripts/test-native-desktop.mjs overlay yomitan hachidori` for native integration.

Follow [AGENTS.md](../AGENTS.md) for localization, vendor source ownership and
[restart handoff](../docs/AGENT_RESTART.md). Yomitan and Hachidori output must be
regenerated from their sources, not patched in place.
