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

The catalog lives under `electron-src/assets/engine_hooks/`. Each directory is one versioned support package. At startup, `resolveEngineHookSupport` matches the executable name, process architecture, and—when available—the SHA-256 executable hash. Runtime signatures then fail closed unless each required function has exactly one match.

Host-side responsibilities are split deliberately:

- `electron-src/main/engine_hooks/support.ts` validates manifests, resources, path containment, the support catalog, and target selection.
- `electron-src/main/engine_hooks/protocol.ts` accepts only bounded, versioned messages from injected code.
- `electron-src/main/engine_hooks/session.ts` owns Frida attach/detach, diagnostics, text forwarding, settings, and the advance RPC.
- Engine decoders such as `mages_decoder.ts` turn engine-specific codes into Unicode and exact glyph records.
- `electron-src/main/ui/text_geometry.ts` sanitizes source-agnostic geometry and converts it to GSM's precomputed overlay-coordinate payload.

## Support-package contract

A package contains:

- `manifest.json`: identity, decoder, supported targets/builds, signatures, layout memory description, capture filters, a dynamic coordinate provider, and advance strategy. It never contains coordinate width or height.
- `payload.js`: a standalone Frida payload. It receives the manifest through `globalThis.__GSM_ENGINE_HOOK_CONFIG__` and exports `advance` and `diagnostics` RPCs.
- Decoder resources, when required, such as a character table or compound-character map.
- `NOTICE.md`: provenance and licensing for copied resources.

Payloads send `gsm_engine_hook_message_v1` messages. `text-layout` events include a sequence, timestamp, call metadata, a live coordinate-space measurement, and bounded engine glyph records. For scaled engines, the payload reports the current window-client dimensions and engine render scale; the host derives the logical coordinate space used by the raw glyph positions.

## Safety and compatibility rules

- Scan only relevant executable ranges in the target module. Never use a blocking full-heap scan in a live game.
- Use ASLR-safe runtime signatures and require unique matches. RVAs may describe data operands for one hash-pinned build, but absolute addresses and PIDs are never production constants.
- Clamp all target-controlled counts before reading memory. The host validates every message again.
- Separate measurement/layout passes from displayed dialogue with manifest capture filters verified against live evidence.
- Every text event must carry a freshly measured coordinate transform. Do not assume that raw engine glyphs use window-client pixels: many engines author UI in a logical canvas and scale it at render time.
- The current manifest schema accepts `window-client-over-memory-scale`. It reads live X/Y engine scale values from hash-pinned data RVAs and derives `logical width/height = client width/height / scale`. It deliberately has no fixed-resolution mode and no manifest width/height fields.
- Treat advance input as a held input across multiple frames; an immediate down/up pair can be missed by polling-based engines.
- A different executable hash or ambiguous package match must produce a clear error instead of attaching approximately.

## Developer validation

Build the Electron main process before using the standalone runner:

```powershell
npm run build:main
node scripts/engine-hooks/run-support.mjs --support=<package-id> --pid=<game-pid> --advance --timeout=12000
```

Success requires a `ready` event followed by one displayed `text-layout` event whose Unicode text matches the game and whose glyph rectangles align after the declared transform. Validate at two client sizes when the game permits it; measuring only `GetClientRect` is insufficient when the engine has a logical canvas. Run the engine-hook Vitest files, the Electron builds, and any affected Python tests before delivery.
