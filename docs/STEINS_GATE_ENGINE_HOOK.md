# STEINS;GATE built-in engine hook

Status: implemented and live-validated on 2026-08-13.

This integration supports the x86 Steam release of `STEINS;GATE` through GSM's standalone engine-hook service. It captures dialogue text, exact per-glyph layout, and can advance dialogue. It does not load or communicate with Agent.

## Validated build

| Property | Value |
| --- | --- |
| Executable | `Game.exe` |
| Architecture | x86 / Frida `ia32` |
| File version | `1.0.0.1` |
| SHA-256 | `CBBC5DAB18EDC344D05C01D4D08819FBC0A68A78741956831752986009B69E16` |
| Steam launch argument observed | `mages_sgate` |
| Package id | `mages-steins-gate-steam` |

The package is in `electron-src/assets/engine_hooks/mages-steins-gate-steam/`.

## Runtime resolution

The live module is scanned for two unique signatures:

- Text builder: `55 8b ec 81 ec 94 01 00 00 a1 ?? ?? ?? ?? 33 c5 89 45 fc 8b 45 18 8b 55 0c 53 56 8b 75 08`
- Line layout: `55 8b ec 81 ec f0 01 00 00 a1 ?? ?? ?? ?? 33 c5 89 45 fc 8b 45 08 8b 4d 20 53 8d 1c 40 c1 e3 04`

On the validated process they resolved to module offsets `0x496a0` and `0x48ae0`. The package also describes the layout arrays by RVA for this build. The payload refuses to start if either code signature is missing or ambiguous.

MAGES performs a measurement pass at mode `1`, commonly producing `(0, 0)` working coordinates, before the displayed dialogue pass at mode `0`. The manifest accepts mode `0` only. This prevents off-screen measurement text from reaching GSM.

## Text and geometry

The decoder handles the game's custom MAGES character table, compound characters, speaker markers, spaces, and ruby controls. Ruby base text is retained and ruby readings are suppressed from the primary dialogue text.

MAGES glyph positions are not window-client pixels. They are authored in an internal logical canvas and scaled during rendering. The package reads the current client dimensions with `GetClientRect` and reads the engine's live X/Y render-scale floats from the build-specific data RVAs `0x121dc28` and `0x121dc2c`. The host then derives the source space for each event:

```text
logical width  = round(client width  / engine scale X)
logical height = round(client height / engine scale Y)
```

No coordinate width or height is stored in the manifest. Fixed and bare `window-client` coordinate claims are rejected by the host.

At a 1920×1080 client size, both live engine scale values were `1.5`, dynamically deriving a 1280×720 logical coordinate space. This explains why mapping raw `(161, 522)` directly into a 1920×1080 client placed the box too far up and left: the rendered position is approximately `(242, 783)` before capture/window offsets. At a 1280×720 client size, the scale is `1.0` and the same logical glyph positions map one-to-one.

In live validation, the line

```text
とんでもない大物か、とんでもないバカかのどちらかだな。
```

produced 27 glyphs with a logical line rectangle of `(x=161, y=522, width=840, height=32)`. The first glyph was `(161, 522, 32, 32)` and the final punctuation was `(981, 522, 20, 32)`. Those numbers are validation observations, not configured dimensions or production defaults.

## Advance behavior

The RPC activates the target window and performs a held left click at `(0.5, 0.8)` of the client area. Holding the button for 60 ms is intentional: the engine can miss a down/up pair delivered within one polling frame. The cursor is restored after the click.

## Resources and attribution

`charset.utf8` and `compound_chars.map` come from Committee of Zero's MIT-licensed `sc3tools`; the full notice is included beside the assets. External MAGES implementations were consulted only as engine-format references. The payload, protocol, session service, and GSM integration were implemented independently and have no Agent dependency.

## Known limits

- The tips/lore page emits its text with style `7`, but its glyph coordinates are
  panel-local rather than game-canvas coordinates. GSM keeps capturing that text
  while suppressing its precomputed glyph-position payload so the overlay can use
  its normal fallback positioning.
- The hash listed above identifies the live-validated build; other builds may be tried, but their data RVAs and capture behavior are not guaranteed.
- Other MAGES games may share concepts, but should receive their own package, signatures, capture filters, and live validation when their layout differs.
- Alternate dialogue windows, backlog screens, and unusual ruby/layout modes need explicit live testing before being declared supported.
