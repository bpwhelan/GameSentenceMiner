# BGI / Ethornell built-in engine hook

Status: **shipped.** `electron-src/assets/engine_hooks/bgi-ethornell` carries the manifest and
payload, `bgi_decoder.ts` the decoder, and the whole path — payload, protocol sanitizer, decoder —
is live-validated on two builds through `scripts/engine-hooks/run-support.mjs`.

Read "Per-glyph screen geometry, resolved" and "The decoder" first: they supersede the compositing
sections that precede them, two of which recorded wrong conclusions that are kept only so the dead
ends are not re-explored.

## What ships

| Piece | Where |
| --- | --- |
| Manifest, payload, attribution | `electron-src/assets/engine_hooks/bgi-ethornell/` |
| Decoder and tests | `electron-src/main/engine_hooks/bgi_decoder{,.test}.ts` |
| Protocol variant | `layout: { kind: 'bgi-v1', candidates, glyphs }` in `protocol.ts` |
| Target matching | `target.versionMarkers` in `support.ts` |
| Live runner | `node scripts/engine-hooks/run-support.mjs --support=bgi-ethornell --pid=<pid>` |

The package configures **no addresses**: four signatures, and everything else — copy variants,
surface geometry, glyph extents, the coordinate origin — is read from the running game.

This document records what has been proven against a live process, so the work can be resumed
without repeating the investigation. Numbers here are observations from the tested build, not
configured constants.

## Tested build

| Property | Value |
| --- | --- |
| Game | 放課後シンデレラ２ (HOOKSOFT) |
| Executable | `放課後シンデレラ２.exe` |
| Version resource `OriginalFilename` | `BGI.exe` |
| Version resource `FileDescription` | `Ethornell - BURIKO General Interpreter` |
| Company | BURIKO Co.,Ltd. |
| Engine version string | `Version : 1.667.1 - Compatibility : 1.72` |
| Architecture | PE32 / i386 (Frida `ia32`) |
| ASLR (`DYNAMICBASE`) | enabled — module base is not `0x400000` at runtime |
| Link timestamp | `0x630CD190` = 2022-08-29 14:47:44 UTC |
| SHA-256 | `63f7f3ea807c644038919812a51b78869591464641db375c251245614499b098` |
| Observed module size | `0x1b7000` |
| Windowed client area | 1280x720 |

Engine files beside the executable: `BGI.gdb`, `BGI.hvl`, `sysgrp.arc`, `sysprg.arc`, `system.arc`.

## Runtime resolution

Two Textractor-derived signatures resolve **uniquely** in the live executable ranges, which
satisfies the fail-closed requirement for signature selection:

- BGI3: `55 8B EC 83 E4 F8 81 EC 84 00 00 00` -> module offset `0xa2a0`
- BGI4: `55 8B EC 53 56 57 33 FF E8 ?? ?? ?? ?? 8B F0` -> module offset `0xa4500`

BGI2 and BGI5 do not match this build. Static scanning of the on-disk `.text` section and live
scanning of the mapped `r-x` ranges produce identical offsets.

Note: Frida rejects a match pattern that ends in a wildcard, so the BGI5 pattern must be trimmed
before use.

## Text capture

The displayed dialogue is carried by the **BGI4** variant at `0xa4500`, read as UTF-16 from `eax`
on entry. Live capture during normal play produced clean lines, for example:

```text
TEXT  BGI4  caller=0x3bb9a  "イブキ"
TEXT  BGI4  caller=0x3bb9a  "「王様ゲームがしたいです！！」"
TEXT  BGI4  caller=0xc9168  "昸¿sࣼ昸¿"
TEXT  BGI4  caller=0x3bb9a  "「じゃあ、俺が王様な？」"
TEXT  BGI4  caller=0x3bb9a  "授業終わりの、ちょっとした休憩時間。"
```

Two call sites reach the same function:

- `0x3bb9a` — displayed dialogue and speaker names. Speaker names arrive as their own event
  immediately before the line.
- `0xc9168` — non-dialogue noise that decodes to garbage.

**Caller offset is this engine's capture filter**, playing the same role as `capture.acceptedModes`
does for MAGES. A support package must accept `0x3bb9a` and reject everything else, rather than
filtering on text content.

## Dialogue layout routine

`0x3ba50` is a thin wrapper that forwards eleven stack arguments to the real routine at
**`0x3ba90`**, which is where the BGI4 call and the control-code walk both live.

Observed argument shape at `0x3ba90` for dialogue (`caller=0x3ba7f`):

| Argument | Observed | Reading |
| --- | --- | --- |
| `arg0` | text pointer | source string (Shift-JIS bytes; BGI4 yields the UTF-16 form) |
| `arg2` | `0x1381c0` | pointer to a module-global font/layout config struct |
| `arg5` | `0x21` (33) | font size; the non-dialogue call site uses `0x2a` (42) |
| `arg9` | `0xffffff` | text colour |
| `arg3`, `arg4`, `arg10`, `arg11` | caller stack addresses | output structures |

Inside the routine, the string is walked one UTF-16 unit at a time:

```text
movzx eax, word ptr [eax]          ; current character
add   eax, -2
cmp   eax, 9
ja    0x3bcc8                      ; normal character
jmp   dword ptr [eax*4 + 0x3e510]  ; control-code jump table
```

`[ebp-0x1cec]` is the character cursor (`+= 2` per step) and `[ebp-0x1cf8]` a running index. The
walk terminates when the current unit is `>= 0x0e`, so `0x0e` acts as a terminator.

### Control-code jump table

Table base RVA `0x3e510`, ten entries covering codes `0x02`-`0x0b`:

| Code | Handler | Code | Handler |
| --- | --- | --- | --- |
| `0x02` | `0x3bbe5` | `0x07` | `0x3bc93` |
| `0x03` | `0x3bc0a` | `0x08` | `0x3bc9f` |
| `0x04` | `0x3bc2f` | `0x09` | `0x3bcc8` (normal path) |
| `0x05` | `0x3bc56` | `0x0a` | `0x3bcc8` (normal path) |
| `0x06` | `0x3bc87` | `0x0b` | `0x3bca6` |

Semantics per code still need to be established before a decoder can be written.

### Scale and metrics

After the walk, the routine computes character cell width and height from the font struct at
`arg2`, scaled by a percentage:

```text
imul ecx, [ebp-0x1d88]      ; field * scale
mov  eax, 0x51eb851f
imul ecx
sar  edx, 5                  ; divide by 100
```

`0x51eb851f` with `sar 5` is the standard divide-by-100 sequence, so the engine holds a **percent
scale**, not a float. A mode selector at `[font]` of `1` or `2` doubles the cell width. Related
module globals observed in this path: `0x1381b4`, `0x1381bc`, `0x1381c0`, `0x138200`, `0x138204`.

This is the most likely source for a dynamic coordinate provider, but it has **not** yet been
proven against two client sizes, and no provider is declared until it is.

## Rendering pipeline

Established by elimination, each step from live evidence:

- **GDI rasterizes, it does not position.** `TextOutW` is called once per character from
  `main+0x33d21`, always at `x=0, y=0`: each glyph is drawn into its own cache cell. It fires only
  for characters not already cached, which is why an early probe saw zero calls on a scene whose
  glyphs were warm. `GetGlyphOutlineW` is reached indirectly through `mov esi, [IAT]` at `0x33fa5`.
- **Direct3D 9 composites whole layers, not glyphs.** The live device issues `BeginScene`,
  `EndScene` and `Present` once per frame and **no** `DrawPrimitive*` traffic at all; the only
  surface traffic is two `UpdateSurface` calls per frame. Per-glyph rectangles never reach the GPU
  API.

  Note when locating the device: `d3d9.dll` contains several device implementations, so taking the
  first heap object with a 119-entry vtable can select an unused one. Identify the live device by
  which vtable actually receives `Present`.
- **The engine composites glyphs itself**, in module code, between those two layers.

### Glyph placement call path

Backtrace from the rasterization site, outermost last:

```text
main+0x33d21   TextOutW, one call per uncached character, always (0,0)
main+0x34643   glyph cell producer      (function entry 0x33ba0)
main+0xa0aa                             (function entry 0xa090)
main+0x3914b                            (function entry 0x39040)
main+0x3d6d4 (draw pass) | main+0x3b3dd (measurement pass, entry 0x3b310)
main+0x3ba7f   dialogue layout routine  (function entry 0x3ba90)
```

### Per-glyph state

`0x39040` is invoked **once per character**, from two call sites: `0x3d6d4` is the draw pass and
`0x3b3dd` the measurement pass. Filtering on the draw caller yields exactly the displayed glyphs.

| Location | Meaning | Observed |
| --- | --- | --- |
| stack arg 0 | Unicode codepoint | `26032`=新, `12300`=「, `12363`=に, `8230`=…, `12540`=ー |
| stack arg 2 | colour | `0xffffff` |
| `ecx + 0x54` | **pen X** | `0, 40, 80, 120, 160, 200, 240, 280` then resets per run |
| `ecx + 0x04` | run width | `240` for the speaker name, `200` for dialogue |
| `ecx + 0x08` | font size | `60` name, `50` dialogue |
| `edx + 0x00` | codepoint of the glyph record | matches the stack argument |
| `edx + 0x14` | advance/black-box width | `27, 13, 14, 26, 18, 11, 20, 23` |
| `edx + 0x18` | cell dimension | `44` name, `36` dialogue |
| `edx + 0x1c`..`0x24` | float metrics | `1.75, 2.0, 3.5, 0.25, 0.5, 0.75, 1.25` |

Codepoints are already Unicode, so **no character table or charset resource is required** — unlike
MAGES, which needs a custom charset and compound-character map.

A capture of 40 consecutive draw-pass glyphs decoded to correct dialogue:

```text
アイ「ねぇ、イブキ」アイ「あんたも女の子になりたい？」イブキ「ヒィィィ！！」
```

The speaker-name run and the dialogue run are separate passes with their own pen origin, matching
the separate speaker-name text events seen at the BGI4 hook.

## Remaining work

Everything this document set out to establish is done and the support package ships. What is left is
verification breadth, not investigation:

1. Confirm one RPC advances exactly one line. The package uses `foreground-key` with `Enter`
   (VK `0x0d`, scan `0x1c`), which advanced dialogue reliably in every test, but the one-to-one
   property has not been asserted.
2. Exercise a client size other than 1280x720. Both test builds present at that size, so the locked
   pitch of 8192 was never varied. Nothing assumes it — the pitch comes from the lock and the origin
   from the chain — but it has not been observed differing.
3. Test more BGI titles. Two builds agree on every signature; the third will be the real test of the
   version-resource matcher.

The pen fields of the layout routine (`ecx+0x38`, `ecx+0x40`, `ecx+0x5c`) no longer need chasing:
that path carries pre-wrap layout, and the glyph draw supplies post-wrap screen positions directly.

## Second build: Jewelry Hearts Academia

A second BGI title was tested to check whether the approach generalises rather than fitting one
build.

| Property | Houkago Cinderella 2 | Jewelry Hearts Academia |
| --- | --- | --- |
| Executable | `放課後シンデレラ２.exe` | `jeweha.exe` |
| Engine version | `1.667.1` / compat `1.72` | `1.665` / compat `1.72` |
| SHA-256 | `63f7f3ea...4499b098` | `3479a25c...2cbd03a1` |
| Module size | `0x1b7000` | `0x1c8000` |
| BGI3 signature | unique `0xa2a0` | unique `0xa270` |
| BGI4 signature | unique `0xa4500` | unique `0xa3ad0` |
| Dialogue caller | `0x3bb9a` | `0x3b9aa` |
| Glyph routine | `0x39040` | `0x38e90` |
| Draw call site | `0x3d6d4` | `0x3d4d4` |
| Measurement call site | `0x3b3dd` | `0x3b1fd` |
| Pen X field | `ecx+0x54` | `ecx+0x58` |
| Full-width advance | 40 | 36 |
| Client size | 1280x720 | 1280x720 |

What this establishes:

- The Textractor-derived signatures resolve **uniquely on both builds**, and BGI4 carries clean
  dialogue on both. Signature-based selection generalises.
- The whole discovery recipe generalises: backtrace from `TextOutW` gives the same six-frame chain
  on both builds, and the enclosing-function distances are identical (`+267` to the glyph routine,
  `+26`, `+2723`), so these are the same compiler output at different link addresses.
- **Every offset differs between builds**, including the pen X field inside the context struct.
  Nothing may be shared across builds except the signatures and the discovery method; all offsets
  must be hash-pinned per build, or resolved at runtime from the signatures.
- The dialogue caller offset also differs per build, so the capture filter cannot be a manifest
  constant. It has to be derived at runtime, for instance as the call site that sits inside the
  signature-resolved layout routine.

### Run structure

Text arrives as runs; a run ends where the pen X resets to zero. A run is one displayed text unit:

| Run | Text | Glyphs | Pen X max | `ecx+0x60` |
| --- | --- | --- | --- | --- |
| 0 | そこには、しびれを切らした一匹の獣が立っていた。 | 24 | 828 | 16 |
| 1 | ソーマ | 3 | 72 | 0 |
| 2 | 「危ないなあ、ヴェオ。僕に当たったらどうするの」 | 24 | 828 | 44 |
| 5 | メデューサ兵 | 6 | 180 | 0 |
| 6 | 「な、なんだこいつは……どうやってここに入ってきた！？」 | 28 | 972 | 44 |

`ecx+0x60` is `0` for a speaker name, `16` for narration and `44` for quoted dialogue.

### The wrap: measured, and unresolved (historical)

Superseded by "The wrap problem is gone": this section describes the layout path, which carries
pre-wrap positions. The glyph draw sits after the break and has no such problem.

A deliberately captured two-line message settles what `ecx+0x60` is, and it is **not** a pen Y:

```text
run0 n=3  xmax=72   +0x60=0   ソーマ
run1 n=41 xmax=1440 +0x60=44  「そんな……！　ぐふっ──早く、彼女に会わせてくれ……もう体力も限界なんだ……！」
```

On screen that message occupies two lines, breaking between glyph 34 (な) and glyph 35 (ん). In the
captured state it is a **single run**: pen X advances monotonically to 1440 straight through the
break and `+0x60` stays `44` throughout. So `+0x60` is a per-style constant, and this call path
carries **pre-wrap** layout only.

This means per-glyph screen geometry cannot be read off this path alone. Reconstructing it would
mean reimplementing the engine's line breaking, which is not acceptable: Japanese kinsoku rules
forbid a line beginning with characters such as `」`, `。` or `、`, so a naive
`floor(penX / wrapWidth)` will disagree with the engine exactly where punctuation lands near a
break. The break positions have to come from the engine.

Ruled out along the way:

- `ecx+0x1c` is not a run descriptor; it points at unrelated buffers.
- The second call site (`0x3b1fd` / `0x3b3dd`) is the measurement pass. It sees only characters that
  matter to line breaking (`「`, `、`, `。`, `──`, `！？`), which makes it the likely home of the
  kinsoku decision and therefore a promising place to recover break positions from engine state.
- `ecx+0x94` flips `1` -> `2` near the break but one glyph late, so it is not confirmed as a line
  index.
- The glyph routine has exactly two per-glyph callees, `0xa060` (leads to rasterization) and
  `0xa3a20`. Neither receives destination coordinates; `0xa3a20` is shared with other call sites and
  its arguments interleave.

### The wrapped-line record array

Static disassembly of the layout routine resolved this. Two corrections to earlier assumptions came
out of it:

- `0x38e90` is not a placement routine. It is a **glyph-record filler**: it keys the codepoint
  (`or edi, 0x80000000`), looks the glyph up through `0xa3a20`, rasterizing into the cache on a miss,
  and writes a record through `edx` — codepoint at `+0x00`, width and height at `+0x14` / `+0x18`
  (from `0x38e10` / `0x38e30`, each less one). It carries no position. The context and the record are
  both **stack locals of the layout routine**, and the record is a single reused slot.
- The layout routine parses markup. The pointer table built at `ebp-0x1b88`..`ebp-0x1b38` holds
  **tag-name strings**, and `ebp-0x418` is the buffer holding the tag currently being parsed: the
  code at `0x3c123` and `0x3c18a` runs `wcscmp`-style comparisons of that buffer against each table
  entry. This matches the `<ns>` / `<N/S>` markup visible in captured source text.

A writer at `0x3f470` appends that buffer to a global array:

```text
edi = [0x1358ac]                  ; record count, capped at 0x10
esi = 0x1358b0 + (edi << 7)       ; 0x80-byte records
memset(esi, 0, 0x60)
memcpy(esi, text, min(len, 0x5f)) ; the wrapped line, byte string
[esi + 0x78] = <layout value 1>
[esi + 0x7c] = <layout value 2>
[0x1358ac]   = edi + 1
```

**This array is not the displayed-line state.** It was initially read as one, and live testing
disproved it: the count global reads `0` both at the title screen and with a two-line message on
screen, and hooking the writer directly recorded **zero** calls while dialogue advanced. Combined
with the tag-buffer finding above, `0x3f470` stores markup/history state on a branch that displayed
dialogue does not take. The RVAs are recorded here only so the dead end is not re-explored:

Polling the array read `0` throughout, and hooking the writer recorded no calls at all.

### Where the search stood (historical)

Every location that could plausibly hold per-glyph screen geometry has now been checked against a
live process, and each is ruled out by evidence rather than by reasoning:

| Candidate | Verdict |
| --- | --- |
| GDI text APIs | Rasterize only, always at `(0,0)` into a cache cell |
| Direct3D 9 draw calls | None issued; compositing is two whole-layer `UpdateSurface` per frame |
| Layout routine stack frame | No coordinate array in the sampled frame |
| Glyph routine `0x38e90` | Fills codepoint plus width/height; carries no position |
| Its two callees | No destination coordinates; one is shared with unrelated call sites |
| Context `ecx+0x60` | Per-style constant (0 name / 16 narration / 44 dialogue), not a pen Y |
| Context `ecx+0x94` | Changes near a wrap but one glyph late; unconfirmed |
| Global record array `0x1358b0` | Markup/history, never written during dialogue |

What is solid: the engine composites glyph cells into a text layer in its own code, and that layer
reaches the GPU through `UpdateSurface`. The destination of that software copy is therefore computed
somewhere not yet located, and it is the only remaining place the geometry can live.

### The compositing pipeline

Capturing the Direct3D device at creation resolved the long-standing dead end, and the rendering
path is now mapped end to end.

**Why every heap scan failed.** The device vtable is **not inside `d3d9.dll`**: modern `d3d9.dll`
builds a per-device thunk table on the heap. Searching the module for a device-shaped vtable can
therefore never succeed, which invalidates the earlier arity-scan results. Spawning suspended and
hooking `Direct3DCreate9` -> `IDirect3D9::CreateDevice` (slot 16) yields the genuine device.

Once the device is genuine, the rest follows:

- The engine composites the **entire frame in software** into a system-memory Direct3D texture,
  which it locks whole every frame. Direct3D issues no drawing at all; it only presents the result.
- The locked layer on the tested build is 2048 pixels wide, 32bpp, holding the 1280x720 frame at
  origin. **The width is never assumed**: `LockRect` returns the pitch, and `width = pitch / 4`, so a
  payload reads the coordinate space live. Another BGI title may well use a different layer width.
- `IDirect3DTexture9::LockRect` sits at a fixed offset inside `d3d9.dll`, so it can be hooked
  directly on a running process. No respawn and no device pointer are needed once that offset is
  known for the installed `d3d9.dll`.
- The engine wraps the lock in its own surface object: pitch at `+0x18`, pixel pointer at `+0x1c`,
  texture at `+0x48`, locked flag at `+0x4c` (see the wrapper at `0x4ad00`).

**Write watchpoints work here and are the tool of choice.** Guarding the locked layer and re-arming
(a guarded page faults only once, so the layer clear otherwise masks everything after it) identified
the writer of the dialogue rows as `main+0xbf33` — a `movntq` store inside a generic MMX block
blitter entered at **`0xbdd0`**:

```text
ecx -> destination: +0x00 pointer, +0x04 stride
edx -> source:      +0x00 pointer, +0x08 width in pixels,
                    +0x0c row count, +0x14 bytes per pixel
```

Subtracting the live layer base from the destination pointer converts any blit into a rectangle.
Doing that for a displayed message reproduces the on-screen layout exactly:

| Rectangle | Meaning |
| --- | --- |
| `(204,517) 268x49` | speaker nameplate |
| `(69,573)`..`(69,681)`, `1161x12` strips | the message text area, copied as full-width bands |
| `(1137,619) 58x61` | the next-line indicator, re-blitted every frame |

The routine identified here as "the blitter" is one variant of a five-member copy family; the
"separate message-window layer roughly 1320 pixels wide" was in fact the text bitmap's backup
buffer. See "Per-glyph screen geometry, resolved".

**The blitter is not the glyph draw.** Text reaches the frame as full-width strips whose source is a
separate message-window layer roughly 1320 pixels wide, so glyphs are composited into that layer
first. The blitter is a plain copy and cannot blend, whereas glyphs come from the 8bpp alpha atlases
(`224x336`, `224x168`, `192x144`, `128x96`, all created at `main+0x338de`). The remaining unknown is
therefore a single alpha-blending routine writing into the message-window layer.

### The full compositing chain

Gating the blit recorder on the BGI4 text event (`probe-bgi-compose-window.mjs`) captures exactly
one message being composed, instead of the per-frame traffic that swamps steady-state sampling. That
resolved the chain:

```text
glyph cells -> 1110x98 dialogue text bitmap   (writer NOT yet identified)
            -> 1320-wide message-window layer (blitter 0xbdd0, caller 0x31470, one 1110x98 copy)
            -> 2048-wide frame layer          (blitter 0xbdd0, caller 0xbbeb, 1161x12 strips)
            -> Direct3D texture               (locked whole, LockRect)
            -> Present
```

The dialogue text bitmap is a stable, dedicated buffer copied **once per message** as a single
`1110x98` blit whose caller is `0x31470` — distinct from the `0xbbeb` site that copies strips into
the frame. `1110x98` is two lines of dialogue, which matches the two-line message used for testing.

Per-glyph blits do exist through `0xbdd0`, but they are **not** dialogue: a run of `28x28` cells plus
labels of `51x28`, `53x28`, `65x28`, `68x28`, `73x28` into a 552-wide buffer, whose destinations step
by exactly `0x70` (28 pixels). Those are the bottom menu bar (`Save Load Q.save Q.load System` and its
icons), confirmed against a screenshot. Dialogue glyphs never appear as individual blits, so the
routine that draws them into the `1110x98` bitmap is a different, blending routine.

### Watchpoint limits, established by experiment

Guarding the *frame* layer works and is how `0xbdd0` was found. Everything beyond that ran into hard
limits of guard pages on Windows, all confirmed live:

| Attempt | Result |
| --- | --- |
| Message layer, ~1.5 MB, re-arm 40 ms | **Hung the target** — alive but not responding, had to be killed |
| Glyph atlas, 6 pages, no re-arm | 0 faults: the 8bpp DIBs are touched only when GDI rasterizes a new glyph, not at composite time |
| Message layer, 6 pages, no re-arm | 6 faults, all **reads** from the blitter's per-frame strip copy |
| Dialogue text bitmap, 12 pages, no re-arm | 12 faults, all **reads** from the blitter's once-per-message copy |
| Dialogue text bitmap, 12 pages, re-arm 200 ms | 0 faults — the disable/enable cycle races with the accesses |

The root cause is that `MemoryAccessMonitor` cannot filter by operation: a guarded page fires once,
for whichever accessor reaches it first, and a reader always does. Re-arming is the only way around
that, and re-arming is either unreliable (slow) or hangs the process (fast). **Guard pages should be
treated as a tool for locating a buffer's consumer, not its producer.**

### The glyph draw: `0x30e70`

Found by call-count correlation rather than watchpoints. Every function entry in the text-renderer
region (`0x30800`-`0x32400`, 68 entries) was hooked, counting was gated on the BGI4 text event so
only one message composition was measured, and the counts were correlated against character count
across six messages of lengths 41, 29, 3, 38, 8 and 41. Three routines came back at **exactly 2.00x
the character count with zero variance**; `0x30e70` is the one that performs the draw.

```text
0x30e70   thiscall on the dialogue text renderer
  ecx      the renderer object; owns the text bitmap descriptor at +0x194
  arg1     destination X within the text bitmap
  arg2     destination Y within the text bitmap
  arg3     pointer to the glyph cell
  arg4     blend mode
```

It is called **twice per character**, from two call sites: `0x3efbf` with mode `64` (outline pass)
and `0x3efd9` with mode `1` (fill pass). De-duplicating on `(x, y)`, or filtering on the caller,
yields exactly one record per glyph. That explains the 2.00 ratio precisely.

Live confirmation:

| Message | Length | Draws | Unique | X sequence | Y |
| --- | --- | --- | --- | --- | --- |
| `「……あ？」` | 6 | 12 | 6 | 33, 47, 75, 101, 136, 158 | 13 |
| `──メコ、と。` | 7 | 14 | 7 | 16, 44, 73, 102, 130, 160, 186 | 13 |
| `そして──` | 5 | 10 | 5 | 18, 49, 73, 100, 128 | 13 |

X advances 26-31 pixels per glyph, matching the proportional font rather than a fixed pitch, and Y
is constant within a line. The glyph cell at `arg3` carries per-glyph metrics
(`[ptr, w, h, 42, 2, 4, 0, 0]`, the `42` being constant across cells).

Note `0x31cb0`, one of the other two perfectly-correlated routines, only returns the clip rectangle
of the drawing area (`[0, 0, 1041, 89]`, constant); it is called by `0x30e70`, not a glyph producer.

**It generalises.** The `0x30e70` prologue resolves as a **unique** signature in both builds, so the
glyph draw is a signature target rather than a hash-pinned RVA, exactly like the text hooks and the
block blitter:

| Function | Jewelry Hearts (1.665) | Houkago Cinderella 2 (1.667.1) |
| --- | --- | --- |
| Glyph draw | `0x30e70` unique | `0x30f40` unique |
| Block blitter | `0xbdd0` (loop `0xbf23`) unique | `0xbe00` (loop `0xbf53`) unique |
| BGI4 text | `0xa3ad0` unique | `0xa4500` unique |

Signature patterns for the payload, taken from the prologues:

```text
glyph draw : 55 8b ec 83 e4 f0 83 ec 38 56 57 8b f9 8d 44 24 10 50 0f 10 87 94 01 00 00
blit loop  : 0f 6f 01 8d 04 0f 0f 18 81 00 10 00 00
```

### Cross-build verification on Houkago Cinderella 2

The signature-resolved glyph draw was tested live on the second build, not merely matched
statically. It behaves identically:

| Message | Length | Unique glyphs | Y |
| --- | --- | --- | --- |
| `今日の日直はピースとヨル。` | 13 | 13 | 15 |
| `こういった先生のお手伝いも日直の一環だ。` | 20 | 20 | 15 |

Unique `(x, y)` pairs equal the character count, with proportional advances, from `0x30f40` — the
address the signature resolved to on this build. The argument layout, the `+0x194` descriptor and the
text hook all transfer unchanged.

Two differences confirm that these values must be read at runtime rather than stored:

- Baseline Y is `15` here versus `13` on Jewelry Hearts, and the glyph-cell constant is `37` versus
  `42`. These are font metrics and differ per build.
- **Draw counts are not a reliable multiple of the character count.** Jewelry Hearts draws each glyph
  twice (outline then fill); Houkago re-renders the whole line every frame during the typewriter
  reveal, producing 744 draws for 13 glyphs. **De-duplicate on `(x, y)`** — do not count passes.

The locked layer pitch is `8192` on both builds, so this test did not exercise a differing
coordinate space. That is expected rather than reassuring: both titles present at 1280x720 and 2048
is simply the next power of two above 1280. A BGI title at a higher resolution will allocate a wider
layer, so the pitch must still be read from `LockRect`. The lock call site is build-specific
(`main+0x4af99` here versus `main+0x4ad29`).

### The next step, without watchpoints (historical)

Both plans below were overtaken: the glyph draw was found by call-count correlation, and the frame
surface comes from the engine's own lock wrapper, so no Direct3D device has to be located at all.
The practical hazards at the end of this section still apply to any probing session.

`0x31470` copies the finished `1110x98` dialogue bitmap. The function containing it owns that bitmap,
so the routine that draws glyphs into it is almost certainly reached from the same owner. Enumerating
that function's callees and counting which fires once per character — the call-count correlation
technique that had already worked on the layout routine — should name the glyph draw without
touching guard pages at all.

Also note a practical hazard that cost one run: several probes attached to the same process and
hooking the same address interfere with each other, and one probe advanced dialogue with
`keybd_event` from inside the target **without focusing the window**, so the input went elsewhere and
the capture was empty. Stop leftover probes, and focus the window before synthesizing input.

### Identify the device deterministically first (historical)

Every Direct3D attempt so far has been undermined by the same weakness: the live device was located
by scanning the heap for an object whose vtable has at least 119 entries pointing into `d3d9.dll`.
That test is not sound. Runs of adjacent function pointers in the DLL's read-only data satisfy it,
so the scan yields dozens of false positives; hooking slot 30 across them produced 2585 calls in a
few seconds with nonsensical arguments, and the resulting "caller" resolved to unrelated getter
stubs. Any conclusion drawn from that path is unreliable, including the earlier report that a vtable
showed `Present`/`BeginScene`/`EndScene` at 210 calls each.

The device must instead be captured **at creation**, which is deterministic:

1. Spawn the game suspended with Frida rather than attaching to a running one.
2. Hook the `Direct3DCreate9` export to obtain the `IDirect3D9` factory.
3. Hook `IDirect3D9::CreateDevice` (vtable slot 16) and record the device written to its out
   parameter.

With a genuine device pointer, `UpdateSurface`, `StretchRect` and the surface `LockRect` can be
hooked correctly. If the engine locks a sub-rect per glyph, that rectangle is the destination box;
if it locks the whole layer, its backing pointer and pitch are what a Frida `MemoryAccessMonitor`
should be armed over, so the first write faults back with the address of the compositing
instruction and identifies the routine directly instead of by search.

This requires restarting the game under Frida, and therefore reloading a save to reach dialogue.

### Coordinate space evidence

Pen X reaches 972 on a 28-glyph line and 1476 on a 42-glyph one, both single visual lines inside a
1280 px client. Those are the **layout routine's** pen positions, in a wider logical canvas, and
they are not what reaches the screen. The glyph draw at `0x30e70` uses a different, smaller space,
and that one does map to client pixels — see below.

## Per-glyph screen geometry, resolved

This section supersedes "The compositing pipeline" and "The full compositing chain" above. Both
were built on the assumption that the block blitter carries dialogue between layers, and it does
not.

### One copy family, five variants, one dispatcher

Every surface-to-surface copy in the engine goes through routines taking the same descriptor pair —
`ecx` destination, `edx` source, with `+0x00` pixels, `+0x04` stride, `+0x08` width, `+0x0c` rows,
`+0x10` pixel format and `+0x14` bytes per pixel. A dispatcher selects among five of them on the
two format fields:

```text
0xc240   copy dispatcher            switch on [edx+0x10] then [ecx+0x10]
  -> 0xbe00   MMX block copy        the routine the earlier sections called "the blitter"
  -> 0xc480   SSE alpha blend       how glyph cells and text bitmaps are composited
  -> 0xc300, 0xc090, 0xc290         further format variants
```

**Do not signature-match the variants individually.** The alpha blend's prologue matches uniquely on
Houkago Cinderella 2 and **not at all** on Jewelry Hearts. The dispatcher's own prologue matches
uniquely on both, so the variants are read out of its `call` targets instead, which is build
independent by construction:

| Build | Dispatcher | Variants |
| --- | --- | --- |
| Jewelry Hearts (1.665) | `0xc210` unique | `0xc450`, `0xc2d0`, `0xc060`, `0xbdd0`, `0xc260` |
| Houkago Cinderella 2 (1.667.1) | `0xc240` unique | `0xc480`, `0xc300`, `0xc090`, `0xbe00`, `0xc290` |

The two sets differ by a uniform `+0x30`, so this is the same compiler output relocated, and
`0xbdd0` / `0xbe00` — the previously documented block blitter — is simply one member of the family.

```text
copy dispatcher : 51 8b 42 10 83 e8 00 74 ?? 83 e8 01 74 ?? 83 e8 01 75
```

### The chain, and how it is followed

Each copy is a rectangle move, so it maps an address in one surface to an address in another.
Recording every copy and following a glyph's address through them needs no knowledge of the chain's
shape:

```text
glyph cell            -> alpha blend into the dialogue text bitmap    (renderer +0x194 descriptor)
text bitmap (x,y)     -> alpha blend into the message display surface (per glyph, typewriter reveal)
message display       -> copy into the locked Direct3D texture        (horizontal bands)
locked texture        -> client pixels                                (LockRect base and pitch)
```

Two traps in doing this:

- The text bitmap is also copied to a **same-size backup buffer** every message. That is a dead end,
  so the search must explore alternatives rather than take the first matching copy. It was this
  backup that earlier reads mistook for the composite into a message-window layer.
- **Several textures are locked**, and their heap allocations can sit close together. Every distinct
  `LockRect` result has to be recorded and a destination attributed to the right one; attributing
  against a single remembered base yields coordinates that are silently wrong.

### The result: a pure translation

Once the chain is followed, the glyph draw's `(x, y)` maps to client pixels by **translation only**,
with no scaling — measured across every message captured on both builds:

| Build | Client | Origin | Text bitmap | Verified |
| --- | --- | --- | --- | --- |
| Houkago Cinderella 2 | 1280x720 | `(257, 576)` | 787x114, stride 3148 | 14 messages, `unmapped=0` |
| Jewelry Hearts | 1280x720 | `(120, 581)` | 1110x114, stride 4440 | 6 messages, `unmapped=0` |

The origin is **not** a constant to store: it differs per build, and it differs per frame while the
message window animates in (a mid-transition capture produced `(1281, 562)`, off-screen, which is
correct for that frame). A payload must derive it from the live chain each time, and should map all
glyphs of a message against one frame's copies.

Boxes were checked against screenshots on both builds and land tightly on the characters.

### The wrap problem is gone

The earlier analysis concluded that per-glyph geometry could not be recovered because the layout
path carries only pre-wrap positions, and that reconstructing the break would mean reimplementing
Japanese kinsoku rules. The glyph draw is downstream of the break, so it does not have that problem:
a wrapped message simply produces two distinct `y` values.

```text
Houkago   37 glyphs   rows: y=591 x34, y=624 x3
Jewelry   41 glyphs   rows: y=594 x35, y=637 x6
```

Both wraps came out with a single origin for the whole message and `unmapped=0`, and the Jewelry
Hearts case was confirmed against a screenshot with both lines boxed.

### Glyph extent

The rectangle of the copy that moves a glyph out of the text bitmap **is** the glyph's extent
(`16x60`, `36x60`, `10x42` and so on, proportional per character). The glyph-cell dwords at the draw
routine's `arg3` are not usable as width and height — reading `cell[1]`/`cell[2]` that way produces
values four times too large.

### Probes

Three probes are kept, one per question a future build can raise:

```powershell
node scripts/engine-hooks/probe-bgi-signatures.mjs <pid>                          # do the hooks resolve?
node scripts/engine-hooks/probe-bgi-transform.mjs --pid=<pid> --seconds=30 --window=3000   # are the boxes right?
node scripts/engine-hooks/probe-bgi-decode-input.mjs --pid=<pid> --seconds=60     # does the text pair?
```

`probe-bgi-signatures.mjs` needs no dialogue on screen, so checking a new title costs seconds.
`probe-bgi-transform.mjs` resolves everything by signature, records the copies, follows each glyph to
the screen and prints client-space boxes plus the origin and row breakdown; its `--window` must
exceed the typewriter reveal, or long messages report `text bitmap never copied in window`.
`probe-bgi-decode-input.mjs` dumps the raw code units of every captured string against the drawn
glyph count.

The one-shot probes written during discovery were removed once their findings were recorded here.
Two techniques from them are worth restating, because they are what actually cracked this:

- **Call-count correlation.** Hook every function entry in a region, gate counting on the text event
  so exactly one message is measured, and correlate counts against character count across messages
  of differing length. This named the glyph draw when no watchpoint could.
- **The guard-page climb.** Arm a guard over a buffer **after** its known consumer has run, and the
  next accessor is the one being looked for. `MemoryAccessMonitor` reports the operation, so writers
  and readers are distinguishable. This named the alpha blend.

### The surface lock

The payload must not hook `IDirect3DTexture9::LockRect` at a `d3d9.dll` offset — that offset belongs
to the installed Windows build, not to the game. The engine wraps the lock in its own routine, which
is inside the module and so resolves by signature like everything else:

```text
0x4ad00   thiscall, ecx = the engine's surface object
  +0x48   the texture              +0x4c  locked flag
  +0x18   pixel pointer            +0x1c  pitch
  calls   [vtable+0x4c], which is IDirect3DTexture9 slot 19, LockRect
```

The field order is **pixels then pitch** — the reverse of what an earlier revision of this document
claimed. The engine stores the `D3DLOCKED_RECT` members in the order Direct3D returns them, and
reading them the other way round yields a pitch of ~258 MB and coordinates in the millions.

| Build | Lock wrapper | Lock call site |
| --- | --- | --- |
| Jewelry Hearts | `0x4ad00` unique | `0x4ad29` |
| Houkago Cinderella 2 | `0x4af70` unique | `0x4af99` |

Only one surface is locked through it on both builds, so the "several textures" caution above is a
property of attributing raw `LockRect` calls, not of this path.

## The decoder

`electron-src/main/engine_hooks/bgi_decoder.ts`, covered by `bgi_decoder.test.ts`.

### What the text hook actually delivers

The BGI4 string is **already displayed text**, not an encoded charset — unlike MAGES, no charset or
compound-character resource is needed. It carries markup but, across 54 captured events, **no
control units** except one stray `0x01` inside an unrelated internal string. The `0x02`-`0x0b`
jump table documented earlier belongs to the layout routine's own source string, which the payload
never reads.

Markup seen live is ruby: `<r READING>BASE</r>`, the reading packed into the tag with no separator.

```text
「<rアルベア>愚者の構え</r>──霧雨・サジタリウス」
だが……世の中には２<rカーメイル>ｋｍ</r>先からだって匂いを嗅ぎつけられる人種も存在するのだ。
```

Any other tag is dropped as non-displayed markup, and an unterminated `<r>` discards its reading
rather than swallowing the rest of the line.

### Pairing text with glyphs, without a caller constant

Several text events fire per displayed line, and which is the dialogue **cannot** be pinned to a
call site: the dialogue caller is `0x3b9aa` on Jewelry Hearts and `0x3bb9a` on Houkago, and the
others (`0x3a561`, `0x3a7f2`, `0x3a800`, `0xc8738`) vary too. A ruby line emits, in order:

```text
0x3b9aa   「<rセリオン>獣人</r>か──クソっ！…」    the dialogue, with markup
0x3a800   蟩醷鿧³릂씀…                             an internal string, decodes to noise
0x3a561   セリオン                                  the ruby reading on its own
          ...glyph drawing begins
```

So the decoder is handed the events since the previous line **in emission order** and takes the
first one whose glyph arithmetic works out:

```text
glyphs drawn == displayed characters + characters of ruby reading
```

Count alone is not enough — a three-character internal string reconciles with a three-character line
just as well — so emission order breaks the tie, the dialogue always being first. The caller must
drop the buffer once a line is paired, or a stale message can win the next one. When nothing
reconciles, the decoder returns null and no overlay is produced, which is the intended failure mode.

Speaker names arrive as their own text event and draw **no** glyphs through this routine at all
(the nameplate is composed elsewhere), so they never pair and never appear as boxes.

### Ruby geometry

Ruby is drawn through the same routine, on its own row above the body, in a smaller cell, and
**interleaved with the body in draw order**:

```text
(33,13)「 (45,13)愚 (55,0)ア (72,13)者 (90,0)ル (101,13)の (128,13)構 (125,0)ベ (157,13)え (160,0)ア …
```

Two consequences the decoder depends on:

- Glyphs must be ordered by position, `(y, x)`, never by draw order.
- The body is the **tallest** height class (42 against 15 on the tested builds). Do not take the
  most common class: a line of 12 characters carrying 13 characters of reading exists in the wild,
  and counting picks the ruby.

### Validation

Replayed over live captures from both builds — 34 messages including ruby lines, wrapped lines and
both games — every message reconciles and yields the correct text and per-character boxes.

One capture produced five "lines" for a sixteen-character single-line message. That is not a decoder
fault: those glyphs were mapped against different frames while the message window was sliding in, so
their rows genuinely differed. **A payload must accumulate glyph positions in text-bitmap space and
apply the frame transform once**, rather than transforming each glyph as it is drawn.

Still unproven, and cheap to check when convenient: behaviour at a client size other than 1280x720.
Both builds tested present at 1280x720, so the locked pitch of 8192 was never exercised against a
different one. Nothing in the approach assumes it — the pitch is read from `LockRect` and the origin
from the chain — but it has not been observed differing.

## Engine-wide support

Every BGI game ships its executable named after the game title, so `target.executableNames` cannot
identify the engine. The stable fingerprint is the version resource: `OriginalFilename` is `BGI.exe`
and `FileDescription` contains `Ethornell - BURIKO General Interpreter` on every build.

The manifest therefore matches on `target.versionMarkers`, and the package declares no executable
name at all. Matching is a UTF-16 substring probe over the executable rather than a parsed version
resource — the marker is an engine banner that appears nowhere else, and parsing the resource
directory would buy nothing. Both test executables match, under their two different names.

No hash pinning is needed anywhere, because the package pins no data RVAs.

## Attribution

The BGI1-BGI6 signature set and the text-argument conventions come from **Textractor**'s BGI engine
support, reached here through the local `UniversalOtakuHooker` port at
`scripts/engines/bgi.js`. Those sources provide text extraction only and contain no geometry work;
the layout routine, control-code table, metric/scale analysis and capture filtering documented above
were derived independently from this build. Licence attribution lives in the support package's
`NOTICE.md`.

## Reproducing the investigation

The three surviving probes are listed under "Probes" above. The one-shot scripts this section used to
list were deleted with the rest of the discovery tooling; the findings they produced are recorded
throughout this document, and the techniques worth reusing are summarised under "Probes".

The game must be focused and dialogue advancing while a probe runs: BGI stops rendering when the
window is in the background, which silences the composite and rasterization paths.

For reading a routine end to end, disassemble the mapped image of a running process — offsets then
match what every probe reports, and no PE parsing is involved:

```powershell
node scripts/engine-hooks/disassemble.mjs <pid> +0xc240 80
```

It prints instruction bytes alongside the mnemonics, which is what signature patterns are built
from. A static `capstone` script would need `pefile`, and buys nothing over reading the live image.

No probe destabilized either target during this work. Both game processes were lost once to an
unrelated host BSOD, not to instrumentation.

All probes are read-only, scan only the target module's executable ranges, and bound every capture.
