# Built-in engine hooks

Built-in engine hooks are self-contained Frida integrations for games whose text and layout data can be read more accurately inside the engine than through OCR. They are independent of GSM's Agent integration: they do not load Agent libraries, use Agent message formats, or require an Agent script path.

## Architecture

```text
support package manifest + payload + resources
                    |
                    v
engine_hooks/session.ts -- Frida attach, lifecycle, advance RPC
                    |
                    v
bounded gsm_engine_hook_message_v1 messages
                    |
                    v
engine decoder -> gsm_text_geometry_v1 -> overlay coordinates
```

The catalog lives under `electron-src/assets/engine_hooks/`. Each directory is one versioned support package. At startup, `resolveEngineHookSupport` selects packages by process architecture; executable names are retained as manifest metadata but do not gate injection. When available, the SHA-256 executable hash is used to prefer a matching package or disambiguate multiple packages; an unknown or unavailable hash does not block a unique package from being tried.

Host-side responsibilities are split deliberately:

- `electron-src/main/engine_hooks/manifest.ts` holds the engine-agnostic manifest types, the shared field validators, and the decoder-descriptor contract.
- `electron-src/main/engine_hooks/support.ts` validates the common manifest, resources, path containment, the support catalog, and target selection, then delegates the engine-specific half to the decoder registry.
- `electron-src/main/engine_hooks/decoders/` holds one descriptor per engine (`validateManifest`, optional `loadResources`, `decodeLayout`) plus `index.ts`, the registry that maps a manifest `decoder` id to its descriptor. An unregistered id fails loudly; there is no fallback decoder.
- `electron-src/main/engine_hooks/protocol.ts` accepts only bounded, versioned messages from injected code.
- `electron-src/main/engine_hooks/session.ts` owns Frida attach/detach, diagnostics, text forwarding, settings, and the advance RPC. It resolves the decoder through the registry and never branches on an engine id.
- Engine decoders such as `mages_decoder.ts` are pure modules that turn engine-specific codes into Unicode and exact glyph records; the descriptor is the only thing that knows how to feed them.
- `electron-src/main/ui/text_geometry.ts` sanitizes source-agnostic geometry and converts it to GSM's precomputed overlay-coordinate payload.

## Adding a game vs adding an engine

A **new game on an engine that already has a decoder** adds only new files:

1. `electron-src/assets/engine_hooks/<support-id>/` with `manifest.json`, `payload.js`, any decoder resources, and `NOTICE.md`.
2. `docs/<GAME>_ENGINE_HOOK.md`.

No shared file changes, so two contributors adding different games never conflict. The renderer's supported-target list, the catalog invariants test, and packaging all pick the package up from disk.

A **new engine** adds the above plus:

3. `electron-src/main/engine_hooks/<engine>_decoder.ts` — a pure decoder module with its own test file.
4. `electron-src/main/engine_hooks/decoders/<engine>.ts` — the descriptor: the manifest interface, `validateManifest`, `loadResources` when the package ships decoder data, and `decodeLayout`.
5. One sorted line in `electron-src/main/engine_hooks/decoders/index.ts`. This is the only shared file a new engine touches, and a conflict there is a keep-both-lines merge.

Manifest `name` and the optional `display.details` locale map are what the TextHook tab renders, served by the `texthook.builtInHookTargets` IPC. `display.details.en` is required when the block is present, because English is the renderer's fallback locale. Per-game strings therefore live in the package, not in `electron-src/renderer/src/i18n/*.json`.

## Support-package contract

A package contains:

- `manifest.json`: identity, decoder, supported targets/builds, signatures, layout memory description, capture filters, a dynamic coordinate provider, an advance strategy, and an optional `display.details` locale map for the renderer. It never contains coordinate width or height.
- `payload.js`: a standalone Frida payload. It receives the manifest through `globalThis.__GSM_ENGINE_HOOK_CONFIG__` and exports `advance` and `diagnostics` RPCs.
- Decoder resources, when required, such as a character table or compound-character map.
- `NOTICE.md`: provenance and licensing for copied resources.

Payloads send `gsm_engine_hook_message_v1` messages. `text-layout` events include a sequence, timestamp, call metadata, a live coordinate-space measurement, and bounded engine glyph records. For scaled engines, the payload reports the current window-client dimensions and engine render scale; the host derives the logical coordinate space used by the raw glyph positions.

## Safety and compatibility rules

- Scan only relevant executable ranges in the target module. Never use a blocking full-heap scan in a live game.
- Use ASLR-safe runtime signatures and require unique matches. RVAs may describe data operands for one validated build, but absolute addresses and PIDs are never production constants.
- Clamp all target-controlled counts before reading memory. The host validates every message again.
- Separate measurement/layout passes from displayed dialogue with manifest capture filters verified against live evidence.
- Every text event must carry a freshly measured coordinate transform. Do not assume that raw engine glyphs use window-client pixels: many engines author UI in a logical canvas and scale it at render time.
- The current manifest schema accepts `window-client-over-memory-scale`. It reads live X/Y engine scale values from build-specific data RVAs and derives `logical width/height = client width/height / scale`. It deliberately has no fixed-resolution mode and no manifest width/height fields.
- Treat advance input as a held input across multiple frames; an immediate down/up pair can be missed by polling-based engines.
- An ambiguous package match must produce a clear error. A unique package may be tried on a different executable build; runtime readiness and signature checks determine whether that build is compatible.

## Developer validation

Build the Electron main process before using the standalone runner:

```powershell
npm run build:main
node scripts/engine-hooks/run-support.mjs --support=<package-id> --pid=<game-pid> --advance --timeout=12000
```

The runner parses the manifest and decodes through the same registry the app uses, so it needs no per-engine change and refuses a package whose decoder is not registered.

Success requires a `ready` event followed by one displayed `text-layout` event whose Unicode text matches the game and whose glyph rectangles align after the declared transform. Validate at two client sizes when the game permits it; measuring only `GetClientRect` is insufficient when the engine has a logical canvas. Run the engine-hook Vitest files, the Electron builds, and any affected Python tests before delivery.
