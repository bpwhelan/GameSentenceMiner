# Zero Escape: Virtue's Last Reward built-in engine hook

Status: implemented and live-validated on 2026-08-15 against the x86 Steam
build below. The hook is a standalone GSM Frida package; it does not load or
fall back to Agent.

## Validated build

| Property | Value |
| --- | --- |
| Executable | `C:\Program Files (x86)\Steam\steamapps\common\Zero Escape The Nonary Games\ze2.exe` |
| Module | `ze2.exe` |
| Architecture | x86 / Frida `ia32` |
| File version | `1.0.0.5` |
| Product | `ZeroEscape: Virtue's Last Reward` |
| File size | `6,114,960` bytes |
| Module image size | `6,152,192` bytes |
| SHA-256 | `B5250963FEE0B6A24CD0B34FF61917FFEC31343E1AFF48F9218C38D4F3599C2A` |
| Observed command line | `ze2.exe render=0 window=2 msaa=2 width=2560 height=1440 vsync=0 filtering=0 hint=1` |
| Package id | `vlr-zero-escape-vlr-steam` |

The package is in
`electron-src/assets/engine_hooks/vlr-zero-escape-vlr-steam/`.

## Discovery and selection

The implementation extends the installed GSM Agent script's observations:

`%APPDATA%/GameSentenceMiner/agent-scripts/scripts/PC_Steam_Zero_Escape_The_Nonary_Games_Virtue's_Last_Reward.js`

That script identified the UTF-8 text-builder lifecycle and the `<K>` dialogue
terminator. Its code and runtime behavior are credited in the package
`NOTICE.md`; it is not a runtime dependency.

The payload scans only executable ranges of the main module and refuses to
attach unless every configured signature has exactly one match. On the tested
process, the unique module offsets were:

| Hook | Module offset |
| --- | --- |
| Agent-derived main text builder | `0xA1B43` |
| Agent-derived alternative text builder | `0xA1B80` |
| Main line layout | `0x2C89B0` |
| Alternative line layout | `0x2C7600` |

Early parallel discovery attachments destabilized the automode process. Those
attachments were stopped, the game was restarted through its normal launcher,
and all final package validation was serialized. No live full-heap scan was
used.

The layout object uses build-specific field RVAs, all represented
declaratively in the manifest: entries pointer `+0x17C`, count `+0x184`, glyph
height `+0x1DC`, maximum X/Y `+0x270/+0x274`, and 32-byte records. A visible
record has type `1`, X/Y at `+0x8/+0xC`, effective width at `+0x10`, and a UTF-16
code unit at `+0x14`. Counts, Unicode values, dimensions, and coordinates are
bounded in both payload and host.

## Text lifecycle and decoding

The Agent-derived builder receives UTF-8 strings. The VLR decoder accepts only
Japanese-containing strings ending in `<K>` or `<P>`, rejects `<N>` instruction
strings and the exact choice labels `はい`/`いいえ`, strips tags, and preserves
the displayed glyph order. The payload snapshots the finalized record array
when the line-layout function returns, where X, Y, width, and height are
complete. It deliberately does not intercept the per-glyph coordinate-writing
instructions: doing that stalled the game in a live regression. The text-builder
signatures remain build-identity checks but are not hooked. Measurement,
control, and style records are excluded by the type-1 filter.

The host decoder converts each validated UTF-16 code unit to Unicode, keeps
multiline Y positions, groups glyphs into lines, and forwards the result as
trusted `gsm_text_geometry_v1` data with `producer.kind = "engine-hook"` and
version `1`. The existing precomputed overlay path therefore receives exact
glyph boxes and may bypass OCR for this producer only.

## Geometry evidence

The raw glyph coordinates are an internal logical canvas, not client pixels.
The payload reads the current client rectangle and the live engine scale value
at RVA `0x4C6880` for both axes. The tested process reported:

```text
client:       2560 x 1440
engine scale: 2 x 2
logical space: 1280 x 720
```

The value at `0x4C6880` is read by the engine's layout code while applying
render/font scale, and the live hook reports it per text event. The host derives
`round(client dimension / live scale)`; no width or height is stored in the
manifest. A post-fix live event produced `見ればわかるだろう……？` with twelve
glyphs on one line:

```text
line bounds:  x=0, y=0, width=336, height=34
first glyph:  見 at (0, 0), 28 x 34
last glyph:   ？ at (308, 0), 28 x 34
```

The game window was visually showing Japanese dialogue during the capture.
The checked-in package does not include a screenshot artifact; the runner
output above is the recorded numeric geometry evidence.

## Advance behavior

The injected RPC activates the VLR window, moves to the declarative client
ratio `(0.5, 0.8)`, holds the left mouse button for 80 ms, restores the cursor,
and rejects overlapping advances. The live runner reported exactly one
accepted advance for the validation call. The click is intentionally held
across frames because VLR polls input state.

## Validation commands

The target was inventoried without modifying its files. Stats gathering was
not running, so no stats toggle was issued or restored.

```powershell
npm run build:main
node scripts/engine-hooks/run-support.mjs --support=vlr-zero-escape-vlr-steam --pid=<pid> --advance --timeout=12000
npx vitest run electron-src/main/engine_hooks/vlr_decoder.test.ts electron-src/main/engine_hooks/support.test.ts electron-src/main/engine_hooks/protocol.test.ts
```

The successful packaged run emitted the package identity, `ia32` ready state,
both unique line-layout offsets, the `post-layout-snapshot` capture strategy,
one advance result, the exact decoded text, the live coordinate measurement,
line bounds, glyph count, and first/last glyph boxes. Unknown hashes are
allowed only when catalog resolution remains unique;
an unknown x86 hash is currently ambiguous between the VLR and MAGES packages
and is rejected with a diagnostic. Missing or ambiguous signatures, invalid
counts, and corrupt coordinates fail closed.

## Limitations

- This package is validated only for the listed x86 Steam executable hash.
- The coordinate-scale evidence was collected at the running 2560×1440 client
  size; the transform is dynamic, but a second resized live capture was not
  performed in this session.
- Backlog, menus, instruction prompts, and alternate text windows are excluded
  unless they satisfy the displayed-dialogue terminator and visible-glyph
  checks.
