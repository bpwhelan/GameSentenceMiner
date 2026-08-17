# MAGES Text Position Hooking: Implementation Handoff

> Historical POC note: this handoff predates the standalone implementation and recommends an Agent-based route that was intentionally rejected. The implemented design is documented in `docs/ENGINE_HOOKS.md` and `docs/STEINS_GATE_ENGINE_HOOK.md`; it does not use Agent.

Status: historical feasibility notes; superseded by the standalone implementation

Last verified: 2026-08-13

Test target: Steam `STEINS;GATE` (`Game.exe`, app 412830), 32-bit MAGES engine

## Purpose

This document records the live reverse-engineering results needed to add engine-provided text geometry to GameSentenceMiner (GSM). The tested game exposes exact per-glyph layout data. It is therefore possible to capture both the dialogue text and its position without estimating a rectangle from OCR or intercepting Direct3D draw calls.

The current Luna `MAGES_text` hook only returns text. The recommended implementation is a MAGES-specific extension to GSM's Agent/Frida path, followed by a small structured-payload change through the Electron and Python text-ingress layers.

## Executive summary

- The existing MAGES text hook fires while the SC3 string is being parsed, before final layout.
- A later function writes an `(x, y)` pair for every glyph into a dedicated array.
- A companion metrics array contains the glyph's base width, font size, effective advance, and height.
- Text and layout were observed on the same game thread in the same millisecond, so they can be correlated reliably without screenshot timing.
- Coordinates use the game's internal `1280 x 720` space in the tested build.
- The live MAGES layout hook is preferable to D3D interception: it is earlier, semantically meaningful, and already contains per-glyph positions.
- The runtime executable is unpacked/decrypted in memory. Signature discovery must inspect the live module, not only `Game.exe` on disk.

## Scope and limitations

The findings below apply to the tested Steam build of `STEINS;GATE`. They are strong evidence for similar 32-bit MAGES titles, but the signatures, structure addresses, dialogue-window indexes, coordinate space, and control codes must be validated per game/build.

Do not treat any PID, module base, absolute address, or RVA in this document as a stable production constant. They are landmarks for reproducing the investigation and building a runtime resolver.

This work does not make Luna's existing text-only protocol position-aware. Either:

1. implement the feature through GSM Agent/Frida, which is recommended; or
2. separately extend Luna's native output protocol and GSM's Luna parser.

The second option is substantially broader and was not investigated.

## Existing GSM code path

The relevant files are:

- `.agent_scripts/PC_Steam_MAGES_Steins;Gate.js`
  - Selects the MAGES helper, decodes the game's character table, and sends text through `trans.send`.
- `.agent_scripts/libPCMAGES.js`
  - Finds the MAGES dialogue parser using a live-memory signature.
  - Decodes SC3 strings.
  - Recognizes `SetFontSize` (`0x0C`), `SetTopMargin` (`0x11`), and `SetLeftMargin` (`0x12`), but currently skips their two-byte arguments.
- `electron-src/main/ui/agent.ts`
  - Receives Agent messages.
  - `cmd === "copy"` currently extracts only `payload.text`.
  - `AgentTextPayload` has no geometry field.
- `electron-src/main/main.ts`
  - `TextHookLinePayload` and `sendTextHookLine` submit texthook observations.
- `electron-src/main/runtime/text_ingress.ts`
  - `TextIngressPayload` permits additional fields through its index signature and will transport them.
- `GameSentenceMiner/gametext.py`
  - `ingest_text_v2_payload` currently copies only `hookId`, `hookFunction`, `engine`, and `exeName` into `metadata_extra`. Geometry would be dropped here unless explicitly preserved.
- `GameSentenceMiner/text_pipeline/models.py`
  - `TextObservation` and `TextRecordSnapshot` can hold arbitrary metadata.
  - `TextRecordSnapshot.to_serializable()` currently omits metadata, so a downstream wire consumer will not receive geometry without another change.
- `GameSentenceMiner/text_pipeline/coordinator.py`
  - A same-source revision replaces the record's metadata with the newest observation metadata. This behavior must be considered when text fragments are merged.

## Verified runtime landmarks

These values came from two live sessions and are documentation landmarks only.

| Item | Tested value |
| --- | ---: |
| Process architecture | x86 |
| Runtime module base | `0x008F0000` |
| Dialogue parser function start | RVA `0x496A0` |
| Existing MAGES text hook | RVA `0x4970D` / runtime `0x0093970D` |
| Outer dialogue layout function | RVA `0x47D80` / runtime `0x00937D80` |
| Per-line/per-glyph layout function | RVA `0x48AE0` / runtime `0x00938AE0` |
| Internal coordinate space | `1280 x 720` |
| Tested client size | `1920 x 1080` |

The on-disk bytes around these RVAs did not resemble the live instructions. The game unpacks or decrypts its code before the hook is usable. `Memory.scanSync` against the live main module is therefore required for production signature resolution.

## Verified layout state

The following relocated absolute addresses were observed in the tested runtime. Resolve equivalent operands dynamically; do not hardcode these values.

| State | Tested address and layout | Notes |
| --- | --- | --- |
| Glyph count | `0x01BE51B4`, `uint32` | Observed counts were small; engine capacity appears to be 2,000 glyphs. Clamp every read to a safe maximum. |
| Character/control codes | `0x01BE51B8 + 2*i`, `uint16` | Codes with bit `0x8000` set are controls rather than visible glyphs. A trailing `0x8003` was observed. |
| Glyph metrics | `0x01BE8098 + 16*i` | Four signed 32-bit fields. See below. |
| Glyph coordinates | `0x01BEFD98 + 8*i` | Signed 32-bit `x` followed by signed 32-bit `y`. |
| Glyph flags | `0x01BF4BB8 + i`, `uint8` | Includes line/control state used by wrapping/layout. |

Observed metric structure:

| Offset | Meaning | Evidence |
| --- | --- | --- |
| `+0x00` | Base glyph width | Loaded from the character-width table during parsing. |
| `+0x04` | Font size | Initialized to `0x20` for normal dialogue and changed by font controls. |
| `+0x08` | Effective horizontal advance | Used by the wrapping and coordinate-generation routines. |
| `+0x0C` | Glyph height | Normal dialogue glyphs were `32` high. |

For normal glyphs in the observed lines, all four metric fields were frequently `32`. Narrow punctuation had smaller width/advance values such as `20`, `24`, or `27`.

## Live proof

Four consecutive Auto-mode dialogue events produced the following same-thread pairs. The `text` and `layout` callbacks had identical millisecond timestamps in every case.

| Event | Glyph count | Visible glyphs | Engine-space union rectangle |
| ---: | ---: | ---: | --- |
| 1 | 23 | 22 | `(x=161, y=522, width=652, height=32)` |
| 2 | 22 | 19 | `(x=161, y=522, width=521, height=164)` |
| 3 | 24 | 23 | `(x=161, y=522, width=712, height=32)` |
| 4 | 41 | 40 | `(x=161, y=522, width=928, height=82)` |

One captured line began with these glyph records:

```text
index 0: x=161, y=522, width=32, height=32
index 1: x=193, y=522, width=32, height=32
index 2: x=225, y=522, width=32, height=32
```

The varying union heights show why the implementation should preserve per-glyph or per-line geometry instead of assuming a fixed 32-pixel-high textbox. Multi-line text, ruby, control entries, and alternate windows need explicit handling.

## Recommended hook sequence

### 1. Keep the existing text signature

`libPCMAGES.js::setHookDialog` already scans the live module for the parser signature and returns the resolved hook address. Continue using this as the text source.

At the text hook:

- decode the SC3 string with the existing game table;
- allocate a monotonically increasing event sequence;
- store a pending record keyed by `Process.getCurrentThreadId()`;
- do not emit a text-only observation immediately if the rich event will follow;
- record a short deadline so a missing layout callback can fall back to text-only output.

Suggested pending state:

```js
pendingByThread.set(threadId, {
    sequence,
    text,
    capturedAt: Date.now(),
    sourcePointer: address.toString(),
});
```

### 2. Resolve the layout routine at runtime

Do not encode `module.base.add(0x47D80)` or `module.base.add(0x48AE0)` in the final script.

Build a second live-memory resolver. Useful validation characteristics from the tested build are:

- the outer layout function iterates the shared glyph count and character arrays;
- it references glyph flags and metrics;
- it calls a function that writes two signed 32-bit values per glyph to an array with an eight-byte stride;
- the coordinate-writing function also reads the metrics array with a 16-byte stride;
- the outer function begins with an ordinary x86 prologue and was reached after the text parser and wrapping helpers;
- the existing text hook, outer layout callback, and coordinate writer all ran on the same thread.

A practical resolver can start from the existing parser's surrounding call chain, then validate candidate functions by their references to the discovered count/character/metrics/coordinate operands. Reject the result unless exactly one candidate passes all structural checks.

If a signature fails, log a clear Agent warning and continue with text-only capture. A layout update must never prevent ordinary text extraction.

### 3. Snapshot geometry after outer layout returns

In the tested build, the outer function at RVA `0x47D80` had finished populating the coordinate array by `onLeave`. Its first argument selected the dialogue configuration/window:

- index `0` produced the actual dialogue coordinates, such as `(161, 522)`;
- index `9` was also called during measurement/layout and frequently used `(0, 0)` working coordinates.

Treat those indexes as observations, not universal constants. Initially log the index, input position, visible glyph count, and union rectangle. Add a per-game selector only after verifying the same distinction across saves and UI modes.

Snapshot rules:

- clamp count to `0..2000`;
- verify every resolved range is readable before use;
- ignore control codes where `(code & 0x8000) !== 0` when computing visible bounds;
- reject absurd dimensions or coordinates rather than forwarding corrupt memory;
- retain visible glyph records for multi-line/ruby processing;
- group glyphs into lines using their `y` positions with a small engine-space tolerance;
- compute a union rectangle from visible glyphs only;
- correlate with the pending record for the current thread and sequence;
- emit at most once per selected dialogue window for a pending text event.

Illustrative extraction logic:

```js
function snapshotGeometry(state) {
    const count = state.count.readU32();
    if (count === 0 || count > 2000) return null;

    const glyphs = [];
    for (let i = 0; i < count; i += 1) {
        const code = state.characters.add(i * 2).readU16();
        if ((code & 0x8000) !== 0) continue;

        const metric = state.metrics.add(i * 16);
        const position = state.coordinates.add(i * 8);
        const glyph = {
            engineIndex: i,
            code,
            x: position.readS32(),
            y: position.add(4).readS32(),
            width: metric.readS32(),
            height: metric.add(12).readS32(),
        };
        if (isSaneGlyph(glyph)) glyphs.push(glyph);
    }
    return buildGeometry(glyphs);
}
```

The addresses in `state` must come from the runtime resolver.

### 4. Preserve a text-only fallback

Layout discovery can fail because of a different executable build, an unsupported MAGES variant, or a non-dialogue string. Preserve the pending text event and emit it without geometry after a short timeout. Geometry support should be additive, never a new failure mode for texthooking.

## Proposed payload

Prefer one versioned, source-agnostic geometry envelope rather than MAGES-specific top-level fields. Keep engine coordinates as the authoritative values and include enough viewport data for consumers to map them later.

```ts
interface TextGeometryV1 {
    schema: 'gsm_text_geometry_v1';
    coordinateSpace: {
        kind: 'engine';
        width: number;   // 1280 in the tested build
        height: number;  // 720 in the tested build
    };
    bounds: { x: number; y: number; width: number; height: number };
    lines: Array<{
        bounds: { x: number; y: number; width: number; height: number };
        glyphStart: number;
        glyphEnd: number;
    }>;
    glyphs?: Array<{
        engineIndex: number;
        x: number;
        y: number;
        width: number;
        height: number;
    }>;
    producer: {
        kind: 'mages-agent';
        version: 1;
        dialogueWindow?: number;
    };
}
```

Suggested rich Agent message:

```js
send({
    cmd: 'copy',
    text,
    textGeometry,
    capturedAt,
    sourceSequence: sequence,
});
```

The bundled `trans._copy` helper currently sends only `{cmd: "copy", text}`. A game script can send the richer message directly, or the loader API can gain a documented rich-send helper. Avoid making a one-off edit to the minified loader unless its source/build workflow is identified first.

Per-glyph data is useful but can be large. Keep it optional or bounded. For the first implementation, bounds plus per-line rectangles may be sufficient; retain a development option that includes glyphs for validation.

## Coordinate conversion

The tested game reported `1280 x 720` engine coordinates while its client area was `1920 x 1080`, producing a scale of `1.5` on both axes.

For the first captured rectangle:

```text
engine bounds: (161, 522, 652, 32)
client bounds: (241.5, 783, 978, 48)
```

At the time of the probe, the client origin was screen `(323, 196)`, making the approximate screen bounds `(564.5, 979, 978, 48)`.

Do not store only screen coordinates. A window can move between capture and consumption. Forward engine-space geometry and map it using the target window's current client rectangle.

For a matching aspect ratio:

```text
scaleX = clientWidth / engineWidth
scaleY = clientHeight / engineHeight
clientX = engineX * scaleX
clientY = engineY * scaleY
```

For letterboxed or pillarboxed output, first determine the actual game viewport. A common fallback is:

```text
scale = min(clientWidth / engineWidth, clientHeight / engineHeight)
viewportWidth = engineWidth * scale
viewportHeight = engineHeight * scale
offsetX = (clientWidth - viewportWidth) / 2
offsetY = (clientHeight - viewportHeight) / 2
```

Validate this against games that permit non-16:9 resolutions. If the engine stretches non-uniformly, retain independent X/Y scales instead.

## End-to-end implementation plan

### Phase 1: Agent-only proof of concept

1. Add a game-specific layout resolver and hook to the Steins;Gate Agent script/helper.
2. Correlate text and geometry by thread and source sequence.
3. Log structured geometry without changing normal text emission.
4. Verify dialogue, multi-line text, speaker names, ruby, phone/mail UI, backlog, choices, and alternate message windows.
5. Restart the game several times and verify the resolver without relying on the previously observed base address.

### Phase 2: Electron transport

1. Add an optional `textGeometry` field to `AgentTextPayload` in `electron-src/main/ui/agent.ts`.
2. Validate/sanitize the Agent-provided object before forwarding it. Do not trust arbitrary nested sizes or numbers from an injected script.
3. Preserve `capturedAt` and `sourceSequence` from the rich Agent message.
4. Add the optional field to `TextHookLinePayload` in `electron-src/main/main.ts`.
5. Forward geometry on `texthook.text` only if a renderer consumer needs it.
6. Add Agent-host unit tests for valid geometry, malformed geometry, oversized glyph arrays, and text-only fallback.

`TextIngressPayload` already supports extra properties, but an explicit shared TypeScript type is preferable to relying only on its index signature.

### Phase 3: Python ingress and runtime

1. Update `GameSentenceMiner/gametext.py::ingest_text_v2_payload` to validate and copy `textGeometry` into `metadata_extra`.
2. Decide whether geometry is transient or must survive authoritative text events.
3. If it must reach wire consumers, extend the relevant serialization explicitly; `TextRecordSnapshot.to_serializable()` currently omits metadata.
4. Define merge behavior. The coordinator currently replaces metadata with the newest same-source revision, which is usually correct for a progressively updating text line but must be tested.
5. Avoid persisting large glyph arrays in the database unless a concrete feature requires it.

### Phase 4: Consumer

Choose the intended consumer before extending every boundary. Possible consumers include:

- positioning an overlay lookup near the current line;
- selecting a screenshot/crop region without OCR;
- anchoring per-glyph dictionary interaction;
- debugging or visualizing engine layout.

For a line-level overlay, bounds and line rectangles are probably enough. Per-glyph interaction requires a reliable mapping between decoded Unicode text and engine glyph indexes, including compound characters and ruby. Do not assume JavaScript string indexes equal engine glyph indexes.

## Tests to add

Follow the repository rule to write failing tests first where practical.

### TypeScript

- `electron-src/main/ui/agent.test.ts` or a new focused helper test:
  - accepts a valid `gsm_text_geometry_v1` payload;
  - rejects `NaN`, infinity, negative sizes, absurd coordinates, and excessive glyph counts;
  - preserves text when geometry is rejected;
  - preserves `capturedAt` and `sourceSequence`;
  - emits one rich event rather than a text event followed by an unrelated geometry event.
- `electron-src/main/runtime/text_ingress.test.ts`:
  - transports validated geometry unchanged.
- Run `npm run test:ts` from `electron-src` or according to `docs/TS_TESTING.md`.

### Python

- `tests/test_gametext_websocket.py`:
  - accepts valid geometry into observation metadata;
  - drops or rejects malformed geometry without dropping valid text.
- `tests/text_pipeline/test_text_coordinator.py`:
  - defines geometry behavior when provisional lines are revised or fragments merge.
- Use the repository `.venv` for pytest.
- Run Ruff after Python changes:

```powershell
uv run ruff format GameSentenceMiner tests scripts
```

### Live acceptance matrix

At minimum verify:

- one-line dialogue;
- automatic wrapping;
- explicit line breaks;
- ruby/furigana;
- speaker/name tag;
- dialogue without a speaker;
- choices;
- backlog/history;
- phone mail/messages;
- windowed and fullscreen modes;
- at least two client resolutions/aspect ratios;
- game restart and scene/save change;
- unsupported signature fallback to text-only capture;
- Agent detach/re-attach without leaving hooks behind.

During development, render debug rectangles over a captured frame and visually compare several glyph origins. Do not use OCR rectangles as the correctness oracle; they are only a rough visual cross-check.

## Resolver and memory-safety requirements

- Scan only the live main module and narrowly selected ranges.
- Avoid broad scans of all writable process memory; they were slow and unnecessary.
- Require unique signature matches and validate surrounding instructions.
- Resolve pointers from instruction operands after relocation.
- Check `Process.findRangeByAddress` (or equivalent) before reading each resolved state region.
- Clamp all engine counts and outgoing array sizes.
- Use signed 32-bit reads for coordinates and metrics.
- Reject non-finite derived rectangles and unreasonable viewport sizes.
- Keep per-thread pending state bounded and expire it quickly.
- Clear pending state on detach and when a new text event supersedes an old one.
- Never allow geometry failure to suppress the decoded text.

## Investigation paths that were not useful

A D3DX9 sprite-vtable candidate was located and hooked, but it received no draw calls during correlated text events. A broad scan for a D3D9 device object also timed out against the game's large writable address space.

Do not begin implementation with D3D interception. The MAGES layout array is already proven and provides better semantics. Consider D3D only if a different game/build has no accessible layout state after its text parser.

Likewise, disassembling the packed `Game.exe` on disk around the live RVAs produced invalid-looking instructions. Capture or inspect the initialized process instead.

## External references

- Impacto, an open-source MAGES reimplementation: <https://github.com/CommitteeOfZero/impacto>
- Impacto text layout: <https://github.com/CommitteeOfZero/impacto/blob/master/src/text/text.cpp>
- Impacto dialogue rendering: <https://github.com/CommitteeOfZero/impacto/blob/master/src/text/dialoguepage.cpp>
- Steins;Gate text extractor, showing the earlier string-lookup hook: <https://github.com/shiiion/steinsgate_textractor/blob/master/steinsgatetextractor/sg_text_extractor.cpp>

Impacto corroborates the observed architecture: text processing produces per-glyph destination rectangles, and dialogue rendering later applies message-window offsets. The live GSM investigation independently verified the equivalent coordinate arrays in this Steam build.

## Definition of done

The feature is complete only when all of the following are true:

- ordinary Agent text extraction remains unchanged for unsupported games;
- the Steins;Gate Agent script resolves both hooks without fixed runtime addresses;
- each rich text event carries validated engine-space bounds;
- multi-line text produces sensible line and union rectangles;
- malformed or missing layout data falls back to text-only output;
- geometry reaches the intended consumer, not merely the first Electron handler;
- coordinate conversion is verified at more than one window size;
- automated TypeScript and Python tests cover transport and revision behavior;
- live validation passes after restarting the game.
