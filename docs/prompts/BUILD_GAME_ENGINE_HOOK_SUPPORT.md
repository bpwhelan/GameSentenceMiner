# Reusable agent prompt: build a standalone game engine hook

Copy the prompt below and replace the bracketed fields.

---

You are adding built-in Frida support for `[GAME TITLE / BUILD]` to GameSentenceMiner (GSM).

Target information:

- Game executable or launch instructions: `[PATH / COMMAND]`
- Expected engine, if known: `[ENGINE OR UNKNOWN]`
- Required features: capture displayed text, capture exact text coordinates, and advance dialogue.
- Available save/state and reproduction steps: `[DETAILS]`

Non-negotiable boundary: implement this through GSM's standalone `electron-src/main/engine_hooks/` architecture. Do not open, copy, import, modify, invoke, or route through any Agent script or Agent helper. Do not use Agent message formats. Existing Agent-related work in the worktree is out of scope.

Work autonomously from live evidence and repository tests. Preserve unrelated dirty changes and obey `AGENTS.md`. Do not port NDLOCR-Lite.

Required workflow:

Before starting hook discovery or validation, disable GSM stats gathering with `POST /set_stats_gathering_enabled` and `{"enabled": false}`; re-enable it with `{"enabled": true}` when the work is finished.

1. Read `docs/ENGINE_HOOKS.md` and inspect the existing engine-hook manifest, protocol, catalog, session, decoder, tests, and standalone validation runner. You can inspect existing agent scripts at %APPPDATA%/GameSentenceMiner/agent-scripts for your implementation, but it make sure to give credit in our script work.
2. Inventory the target without mutating it: process name, full executable path, architecture, file/product version, command line, module names/sizes, and SHA-256. Record the exact tested build.
3. Add failing tests for any new manifest fields, decoder behavior, control codes, geometry conversion, or protocol variant before implementing them.
4. Create discovery probes under `scripts/engine-hooks/` when needed. Scan relevant live module ranges asynchronously or in bounded chunks. Never perform a blocking full-heap scan. If a probe destabilizes the target, stop using that strategy, restart safely, and document it.
5. Discover the displayed-text lifecycle independently:
   - locate the source buffer or builder;
   - determine the encoding and control-code semantics;
   - distinguish displayed dialogue from measurement, backlog, menu, history, and duplicate passes;
   - identify the final layout point where coordinates are complete.
6. Discover geometry from semantic engine state when possible. Capture per-glyph text/index, x, y, width, and height; preserve multi-line layout. Determine whether those values are physical client pixels or an internal logical canvas. A `GetClientRect` result alone does not prove the raw coordinate space. Trace the engine's viewport/render scale or projection state, then prove the transform with screenshots at two sizes when practical. Do not guess a fixed resolution or report destination dimensions as the raw source space.
7. Implement advance through the injected payload. Prefer a declarative manifest strategy. Verify that one RPC call causes exactly one progression. Hold inputs across frames when the engine polls state; restore focus/cursor state when practical.
8. Add a self-contained package at `electron-src/assets/engine_hooks/[SUPPORT-ID]/` containing:
   - `manifest.json` with schema/id/name/engine/decoder, target executable names, architecture, known SHA-256 hashes, signatures, bounded memory layout, capture filters, a dynamic coordinate provider, and advance strategy. Never store a coordinate width or height in the manifest;
   - a standalone `payload.js` using only Frida APIs and the injected manifest;
   - the minimum decoder resources required;
   - `NOTICE.md` with source and license attribution for every copied resource.
9. Use ASLR-safe live signatures and require unique matches. Never ship an absolute address or PID. Record known hashes for package preference and disambiguation, and document any build-specific data RVAs. Allow a unique package to be tried on an unknown hash, but fail closed with a useful diagnostic on a missing signature, ambiguous match, invalid count, or corrupt coordinate.
10. Extend the generic protocol/catalog only when the new engine truly requires it. Keep target-specific decoding isolated behind a named, tested decoder. Bound and sanitize all injected messages again in the Electron host.
11. Route exact `gsm_text_geometry_v1` glyph data through the existing precomputed overlay payload. Only trusted `producer.kind = "engine-hook"`, versioned integration payloads may force OCR bypass.
12. Add or update renderer UI only if users need a new choice or control. Every renderer string must use `t("key")`, with English, Japanese, and Ukrainian locale entries.
13. Live-validate the packaged artifact—not a throwaway probe—with:

```powershell
npm run build:main
node scripts/engine-hooks/run-support.mjs --support=<package-id> --pid=<pid> --advance --timeout=12000
```

Adapt the runner generically if the new decoder requires it. Capture evidence showing: package/build identity, unique signature offsets, one advance result, exact decoded text, current coordinate-space dimensions, line bounds, glyph count, and first/last glyph boxes. Confirm visually that the text and boxes match the displayed game.

14. Run focused Vitest tests, full relevant Electron builds, `.venv` pytest for changed Python paths, and `uv run ruff format GameSentenceMiner tests scripts` after Python changes. Re-run tests after formatting.
15. Write `docs/[GAME]_ENGINE_HOOK.md` with the supported hash, signatures/selection logic, encoding/control behavior, geometry evidence, advance behavior, attribution, limitations, and exact validation commands.

Acceptance criteria:

- The built-in hook starts by catalog selection for the exact supported build.
- It has no Agent dependency or fallback.
- One advance RPC advances exactly once.
- Displayed dialogue is decoded correctly and duplicates/measurement passes are excluded.
- Glyph and line coordinates align after the declared dynamic coordinate transform; no coordinate width or height is hard-coded.
- Unknown builds and ambiguous signatures fail safely.
- Tests and builds pass, licensing is recorded, and the final report includes concrete live evidence rather than only static reasoning.

---
