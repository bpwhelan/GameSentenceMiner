# GameSentenceMiner development

GSM captures game text, audio and screenshots for Anki. The desktop runs in Tauri. Follow [AGENTS.md](AGENTS.md) for the restart, localization and vendor workflows. The [repository map](docs/AI_AGENT_MAP.md) lists the current owners of each subsystem.

Use `npm start` to build and launch the app, `npm run dev` for development, and `npm run app:dist` to package a release. Run `npm run test:ts` for the renderer and `npm run test:desktop` for the host.
