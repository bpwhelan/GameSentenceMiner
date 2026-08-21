# Aokana built-in engine hook

Support package: `electron-src/assets/engine_hooks/aokana-steam/`
Decoder: `unity-tmp-v1` (`electron-src/main/engine_hooks/unity_tmp_decoder.ts`)

This is the first Unity game in the catalog, so it adds an engine decoder as well as
a package. It has no Agent dependency and no Agent fallback: the payload talks only
to Frida and to the Mono runtime the game already loads.

One package covers all three shipped Aokana titles. They are the same game code on
two very different Unity versions, which is exactly the case the decoder was built
for: nothing about any build is baked into the package, so one manifest and one
payload drive all of them.

## Supported builds

Recorded from the live processes, without modifying them:

| | Aokana | Aokana EXTRA1 | Aokana EXTRA2 |
| --- | --- | --- | --- |
| Process | `Aokana.exe` | `AokanaEXTRA1.exe` | `AokanaEXTRA2.exe` |
| Steam app id | 1044620 | 1340130 | 2206340 |
| Architecture | `windows`/`ia32` | `windows`/`ia32` | `windows`/`ia32` |
| Unity | 2018.2.19f1 | 2018.2.19f1 | 2021.3.15f1 (e8e88683f834) |
| Executable SHA-256 | `9c6a9381…8721eb91` | `30ac4631…52b83c46` | `1ca61a58…eb71ac77` |
| Mono runtime | `Mono\EmbedRuntime\mono.dll` | `Mono\EmbedRuntime\mono.dll` | `MonoBleedingEdge\EmbedRuntime\mono-2.0-bdwgc.dll` |
| Text stack | TextMeshPro + `Assembly-CSharp.dll` | TextMeshPro + `Assembly-CSharp.dll` | TextMeshPro + `Assembly-CSharp.dll` |

Full hashes, as recorded in the manifest:

```text
Aokana        9c6a938189d4e18dfdbd1891204e35d7b3ed1f8325f24386d354b5838721eb91
AokanaEXTRA1  30ac46318f2f92885fa5387abaec04b563f229a094acd21eb0caea7052b83c46
AokanaEXTRA2  1ca61a5859818360326a0f7988bc9f65e3e0e2925cdee91b4ec7ba7ceb71ac77
```

`UnityPlayer.dll` for the EXTRA2 build is
`1808a42e83819f04c22673a6b6585bcc16daf21255bda505ebdaeffd27ce5f41`.

The hashes are recorded to prefer this package, not to gate it: a later patch of
either title will still be tried, and the managed-name checks below decide whether it
is compatible.

### What differs between the two, and why none of it is configured

EXTRA1 matches the base game in every respect below; the contrast is between the two
Unity versions, not between the three titles.

| | Aokana / EXTRA1 | Aokana EXTRA2 |
| --- | --- | --- |
| Mono runtime module | `mono.dll` | `mono-2.0-bdwgc.dll` |
| `mono_assembly_get_name` exported | no | yes |
| `TMP_CharacterInfo` array stride | 316 | 356 |
| `character` / `lineNumber` offsets | 0 / 44 | 0 / 48 |
| `origin` / `xAdvance` offsets | 264 / 280 | 268 / 272 |
| `ascender` / `descender` offsets | 268 / 276 | 276 / 284 |
| `TMP_Text.m_textInfo` offset | 236 | 256 |

Every one of those is read from the runtime at injection time, so the package carries
none of them. The struct layout even reorders fields between TextMeshPro versions —
`xAdvance` moves from after `descender` to before it — which is precisely why
resolving offsets through Mono beats hard-coding them.

`UIAdv.ShowText(string, string, bool)`, the `advtext` field and
`TextMeshProUGUI.GenerateTextMesh()` are identical across both, so the manifest's
managed names need no per-build variation.

## Selection logic

`target.executableNames` lists all three executables and `target.knownExecutableSha256`
all three hashes, the same pattern the other per-game packages use.

No `target.moduleName` is declared, and the decoder deliberately does not require one.
On a Unity game the executable is only a launcher — the code the hook needs lives in
the Mono runtime's managed heap — and Unity renames that runtime by version
(`mono.dll` through 2019, `mono-2.0-bdwgc.dll` since 2020). A package spanning both
cannot name one, so the payload identifies the runtime by what it is rather than what
it is called: the single loaded module that exports `mono_get_root_domain`. More than
one match, or none, fails closed with the module names listed.

No version markers are declared. A Unity launcher's version resource names Unity, not
the game, so it would not identify these titles.

## Signatures: managed names instead of byte patterns

A Mono game does not need byte patterns, and using them would be strictly worse. Every
address is resolved through the runtime's own metadata, which is ASLR-safe by
construction, survives a rebuild that moves code, and fails loudly when a name is
absent:

- `mono_image_loaded` finds an already-loaded assembly image by name, falling back to
  `mono_assembly_foreach` + `mono_image_get_name`. Neither re-opens an assembly by
  path, which can fail or duplicate it. The older runtime does not export
  `mono_assembly_get_name`, so the image's own name is used instead of the assembly's.
- `mono_class_from_name` resolves a class from an assembly image, a namespace, and a
  name. The manifest supplies all three, so a mismatch names the missing class.
- `mono_class_get_method_from_name` resolves a method by name **and parameter count**,
  which is what makes the match unique across overloads.
- `mono_class_get_field_from_name` + `mono_field_get_offset` give field offsets from
  the loaded class layout, so no offset is hard-coded in the package.
- `mono_compile_method` returns the JIT entry point that `Interceptor.attach` hooks.

Missing names fail closed with a usable diagnostic, verified live against this build:

```text
Error: The class UIAdvNotHere is not in Assembly-CSharp.
Error: The method GenerateTextMeshNope/0 was not found.
```

No absolute address and no PID is stored anywhere in the package. The offsets below
are recorded as evidence only; the payload reads them from the runtime every time.

Field offsets observed on the tested build (`ready` diagnostics):

```json
{"textComponent":40,"textInfo":256,"characterCount":40,"lineCount":60,
 "characterInfo":12,"lineInfo":24,"characterStride":356,"lineStride":92}
```

Array-element offsets inside `TMP_CharacterInfo` / `TMP_LineInfo`, after subtracting
the Mono object header that `mono_field_get_offset` includes for a value type:

```json
{"character":0,"lineNumber":48,"origin":268,"xAdvance":272,"ascender":276,"descender":284}
{"ascender":44,"descender":52}
```

## The displayed-text lifecycle

`UIAdv.ShowText(string txin, string dispnamein, bool updateonly)` is where one
displayed line begins. Inside it the engine:

1. splits `txin` per language with `UtilText.SplitLangStr`. The script stores all four
   localisations in one string separated by U+0002, so the raw argument is **not** the
   displayed text — capturing it would mine English, Japanese and both Chinese
   variants at once;
2. rewrites markup in `prepTextTags` (`--` → `—`, `-` → U+2011, `\n` → newline, and a
   spacer after `</i>`);
3. hands the result to `EnsureTextFit`, which assigns it to `advtext` and shrinks the
   font until it fits;
4. clears `advtext`, then reveals the line with `TextFader`.

`TextFader` is the reason the geometry is available immediately. It does not add
characters over time — it emits the **whole** string every frame with per-character
`<alpha=#xx>` tags, and at the end assigns the untagged string. Every character is
therefore laid out from the first revealed frame, with its final position.

This also rules out reading the string argument or the component's `m_text`: both
carry rich-text markup and, during the reveal, colour and alpha tags. The characters
TextMeshPro actually drew are read instead, so the mined text never contains markup.

### Where the layout is final

`TextMeshProUGUI.GenerateTextMesh()` is the layout pass. Its `onLeave` is the first
point at which `TMP_TextInfo.characterInfo` and `TMP_TextInfo.lineInfo` are complete
for the current string, so that is where cells are read.

### Excluding everything that is not the displayed line

- **Other components.** `GenerateTextMesh` runs for every TextMeshPro object in the
  game — the speaker name, the backlog, the menus, the config screens. Only the
  instance held in `UIAdv.advtext` is accepted, and that pointer is read from the
  `UIAdv` instance the dialogue call was made on, so it is the live component rather
  than a guess.
- **Measurement passes.** `EnsureTextFit` queries `preferredHeight` up to five times
  to pick a font size. Those go through TMP's preferred-values path, not
  `GenerateTextMesh`, so they never reach the hook.
- **The clearing pass.** `ShowText` sets `advtext.text = ""` before the reveal. That
  produces a layout with `characterCount == 0`, which is treated as "the line is still
  to come" and leaves the pending line armed.
- **Redraws.** Only the first layout after a dialogue call is emitted; the pending line
  is cleared once used, so the reveal's remaining frames — which repeat the same
  positions — are ignored.
- **Re-application.** `UIAdv.ReapplyText` calls `ShowText(..., updateonly: true)` when
  the player changes language, font or text speed. That is the same line again, so it
  is reported as capture mode `1` and `capture.acceptedModes` (`[0]`) drops it.
- **Stale pairing.** A pending line older than five seconds is discarded rather than
  paired with an unrelated later redraw of the same component.

## Geometry

`TMP_CharacterInfo` gives, per character, the pen positions `origin` and `xAdvance`
and the glyph's own box, all in the text component's **local** space —
not in client pixels, and not in any fixed design resolution.

The package resolves them through the engine's own state:

1. `Component.get_transform` → `Transform.get_localToWorldMatrix` puts a local point
   into world space. Unity stores the matrix column-major, so the translation is at
   linear indices 12–14.
2. `Graphic.get_canvas` → `Canvas.get_worldCamera` finds the camera that draws the
   canvas. On this build the ADV canvas is `Game`, render mode `1`
   (*Screen Space – Camera*), drawn by `TopCamera` with `targetTexture == null`.
3. A UI canvas is a plane, so world-to-screen over it is affine regardless of canvas
   scale or camera placement. Three reference points — local `(0,0)`, `(1,0)`, `(0,1)`
   — through `Camera.WorldToScreenPoint` pin that map down exactly, at three managed
   calls per line instead of two per character.
4. `Camera.get_pixelRect` gives the viewport those screen points live in. Cells are
   normalised by it and scaled to the client area from `GetClientRect`, called
   **inside** the game process so the values are the physical pixels the game renders
   at. The engine's Y grows up from the bottom of the viewport; the overlay's grows
   down from the top of the client area, so Y is flipped at this point.

`Canvas.get_scaleFactor` is deliberately **not** used as the transform. It is observed
(1.9 at 3648×2052, 0.833 at 1600×900) and it is already folded into the matrix in
step 1; applying it again would double-count it.

A `GetClientRect` result on its own would not have proved the space, and neither
would the canvas scale factor. The derivation above was checked against screenshots
at two client sizes (below), which is what actually proves it.

If a future Unity target uses a *Screen Space – Overlay* canvas, `worldCamera` is
null; the payload then treats world X/Y as screen pixels, which is Unity's own
convention for that mode, and uses `Screen.width`/`Screen.height` as the viewport.
That path is implemented but is not exercised by this game.

### Cell shape

Each cell spans `origin` → `xAdvance` horizontally and the **line's** ascender →
descender vertically. Using the line band rather than each glyph's own ink box means
every cell on a line shares one vertical strip, so the cells tile the line, the
overlay gets uniform hit boxes, and the decoder can recover lines from a flat list.

### Reported coordinate space

The payload resolves cells to client pixels itself, so `coordinateSpace.provider` is
`payload-client-pixels` and the measurement it sends is
`{clientWidth, clientHeight, scaleX: 1, scaleY: 1}`. No width or height is stored in
the manifest. Every text event carries a freshly measured client area and a freshly
derived transform, so resizing the window mid-session is handled.

Corrupt geometry fails closed: a non-finite matrix, an empty viewport, a coordinate
beyond ±32768, or a negative or oversized cell drops the whole layout and emits an
`error` diagnostic rather than sending a rectangle.

## Decoding

`unity_tmp_decoder.ts` is a pure, tested module. TextMeshPro already names the
character at every position, so nothing is reconciled against a candidate string and
no character table ships with the package. The decoder only has to:

- drop what TMP lays out but never draws — control characters, `U+200B`–`U+200D`,
  `U+FEFF`, `U+2028`, `U+2029` — which carry positions and would otherwise put empty
  cells over the text;
- recover lines. The payload gives every cell on a line the same vertical band, so a
  change of `y` is exactly a line break. Contiguous runs are used rather than grouping
  by value, so a band the engine returns to starts a new line;
- trim the padding spaces at both ends of a line while keeping interior ones;
- join line texts with `\n`.

Reading order is preserved as the engine reported it; cells are never sorted by
position, so a centred or reordered line is not scrambled.

## Advance

`advance.method` is `foreground-key` with `virtualKey` 13 (`VK_RETURN`) and
`scanCode` 28. `UIFlow.OnGUI` acts on `EventType.KeyUp` for `KeyCode.Return`,
`KeyCode.KeypadEnter` and `(KeyCode)10`, calling `EngineMain.UserInputClick`, so a key
release is what progresses the game.

The payload activates the window (`AttachThreadInput` → `ShowWindow` →
`BringWindowToTop` → `SetForegroundWindow`), waits 50 ms, holds the key for 60 ms so a
polling frame cannot miss it, releases it, then detaches the input queues it attached.
The RPC resolves with `{delivery, activated, foregroundAtDelivery}`.

One RPC call is one progression. Verified live: with `--lines=2`, a single advance
produced exactly one `text-layout` and the runner then timed out waiting for a second.

```text
{"type":"advance","window":"0x1d0294","delivery":"foreground-keyboard","activated":1,"foregroundAtDelivery":true}
  "text": "「そんなことあるよ」"
Error: No text layout arrived within 9000 ms.
```

## Live validation

```powershell
npm run build:main
node scripts/engine-hooks/run-support.mjs --support=aokana-steam --pid=<pid> --advance --timeout=12000
```

`ready` on the tested build:

```json
{"integrationId":"aokana-steam","module":"mono-2.0-bdwgc.dll","moduleSize":6467584,
 "assemblies":42,"dialogue":"UIAdv.ShowText/3","layout":"TextMeshProUGUI.GenerateTextMesh/0",
 "offsets":{"textComponent":40,"textInfo":256,"characterCount":40,"lineCount":60,
 "characterInfo":12,"lineInfo":24,"characterStride":356,"lineStride":92},"maximumGlyphs":600}
```

EXTRA1, at a 1280×720 client:

```json
{"mode":0,"style":0,
 "coordinateMeasurement":{"kind":"scaled-window-client","clientWidth":1280,"clientHeight":720,"scaleX":1,"scaleY":1},
 "text":"「真白と友達になれてホントに嬉しいっ！　はいっ、お肉どうぞ！」",
 "lines":[{"bounds":{"x":76,"y":552,"width":833,"height":41},"glyphStart":0,"glyphEnd":31}],
 "glyphCount":31,
 "firstGlyph":{"engineIndex":0,"text":"「","x":76,"y":552,"width":27,"height":41},
 "lastGlyph":{"engineIndex":30,"text":"」","x":882,"y":552,"width":27,"height":41}}
```

The base game, at a 3627×2040 client, three wrapped lines:

```json
{"text":"「保守的？　この言葉であってるのかわからないけど、変わることが怖いって
気持ちがずっとあって……。蚊取り線香の匂いで、それが蘇った、というか
……」",
 "lines":[{"x":216,"y":1564,"width":2665,"height":117},
          {"x":216,"y":1683,"width":2588,"height":117},
          {"x":216,"y":1802,"width":228,"height":117}],
 "glyphCount":72}
```

It was also checked at a 1600×900 client on the same build, where the boxes still
landed on the glyphs — the 2018 canvas rescales exactly as the 2021 one does.

### EXTRA2, 1600×900 client

```json
{"mode":0,"style":0,
 "coordinateMeasurement":{"kind":"scaled-window-client","clientWidth":1600,"clientHeight":900,"scaleX":1,"scaleY":1},
 "coordinateSpace":{"kind":"engine-logical","width":1600,"height":900},
 "text":"「いや、あの……。さっきも言ってましたけど、あたしがいい試合したからっ\nていっぱい売れるとか、本当はそんなことないですよね？」",
 "lines":[{"bounds":{"x":95,"y":690,"width":1176,"height":51},"glyphStart":0,"glyphEnd":35},
          {"bounds":{"x":95,"y":741,"width":908,"height":51},"glyphStart":35,"glyphEnd":62}],
 "glyphCount":62,
 "firstGlyph":{"engineIndex":0,"text":"「","x":95,"y":690,"width":34,"height":51},
 "lastGlyph":{"engineIndex":61,"text":"」","x":969,"y":741,"width":34,"height":51}}
```

### EXTRA2, 3648×2052 client

```json
{"coordinateMeasurement":{"kind":"scaled-window-client","clientWidth":3648,"clientHeight":2052,"scaleX":1,"scaleY":1},
 "text":"「冗談ではなく。会場が盛り上がれば高揚した観客がいろいろ買ってくれるん\nだ。みさきちゃんだって買い物中にテンションが上がって無駄遣いしてしまっ\nた、そんな経験あるんじゃない？」",
 "lines":[{"x":217,"y":1573,"width":2681,"height":116},
          {"x":217,"y":1690,"width":2681,"height":116},
          {"x":217,"y":1806,"width":1226,"height":116}],
 "glyphCount":86,
 "firstGlyph":{"engineIndex":0,"text":"「","x":217,"y":1573,"width":77,"height":116},
 "lastGlyph":{"engineIndex":85,"text":"」","x":1366,"y":1806,"width":77,"height":116}}
```

Every capture above was confirmed visually: the decoded text matched the dialogue box
character for character, and every cell drawn from these rectangles landed on its
glyph, with the line bands covering exactly the rows the game rendered. Across the
EXTRA2 pair the canvas scale factor differs (1.9 versus 0.833) and the client-pixel
results still line up, which is what shows the transform is measured rather than
assumed. The same held on the 2018 builds at two sizes.

To draw the boxes over a screenshot yourself, the same package can be dumped in full:

```powershell
node scripts/engine-hooks/dump-support-boxes.mjs --support=aokana-steam --pid=<pid> --out=boxes.json --advance
```

## Discovery probe

`scripts/engine-hooks/probe-unity-mono.mjs` (with `probe-unity-mono.agent.js`) is the
probe this package was built from. It resolves the same managed members, dumps class
layouts and field offsets, and reports the canvas, camera, transform and raw cells for
each dialogue line. It reads only class metadata and the objects the hooks hand it —
there is no memory scan of any kind, blocking or otherwise, so it cannot destabilise
the target. No probe destabilised this game during development.

## Limitations

- Only the dialogue line is captured. The speaker name is a separate TextMeshPro
  component (`UIAdv.nametext`) and is not mined.
- Backlog, choices, menus and tooltips are deliberately excluded.
- `TMP_CharacterInfo.character` is a single UTF-16 code unit. The payload rejoins a
  surrogate pair when TextMeshPro emits one, but if a build truncates an astral code
  point into one cell it cannot be recovered. Japanese script is unaffected.
- Ruby/furigana is not handled, because this title does not use it.
- The dialogue call is game code, so this package covers the Aokana titles that share
  it. Another Unity + TextMeshPro game reuses `unity-tmp-v1` and the payload by
  shipping its own package naming that game's dialogue class, method and text field.
- The package assumes exactly one Mono runtime is loaded. A process that also hosts a
  second Mono is refused rather than guessed at.

## Attribution

See `electron-src/assets/engine_hooks/aokana-steam/NOTICE.md`. The package
ships no copied resources; the foreground-activation and held-key sequence follows
this repository's own `bgi-ethornell` package.
