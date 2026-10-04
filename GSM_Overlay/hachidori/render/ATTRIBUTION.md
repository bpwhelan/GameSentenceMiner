# Popup renderer attribution

`glossary.js`, `popup.js`, and `reader.css` in this directory contain or adapt
GPL-licensed work from the projects below. Each file carries its own
`SPDX-License-Identifier: GPL-3.0-or-later` header and the upstream copyright
lines; the repository's root `LICENSE` has the full GNU GPL version 3 text.

- **GameSentenceMiner PR #549** — the direct source of all three files.
  `glossary.js` is extracted from `GSM_Overlay/features/hoshidicts/reader.js`
  (structured-content renderer, furigana segmentation, pitch-accent ruby,
  dictionary style scoping). `popup.js` is
  `GSM_Overlay/features/hoshidicts/popup.js` with the Anki mining, custom
  definition, and audio surfaces removed. `reader.css` is
  `GSM_Overlay/features/hoshidicts/reader.css`. GameSentenceMiner is licensed
  under GPL-3.0-or-later.

- **[Hoshi Reader](https://github.com/Manhhao/Hoshi-Reader/tree/c31c9d0ce376ff83bf6a91d908bf9f8e0fb4947b/Features/Popup)**
  — the popup structure (headword, glossary cards, tab strip, metadata capsule)
  and the furigana segmentation algorithm (`segmentFurigana`,
  `segmentizeFurigana`, `getFuriganaKanaSegments`). Licensed under
  GPL-3.0-or-later.

- **[Yomitan](https://github.com/yomidevs/yomitan)** and its predecessor
  **[Yomichan](https://github.com/FooSoft/yomichan)** — the structured-content
  schema that `appendStructuredValue` renders, the `gloss-*` class names and
  image-container markup it emits, and the allowed-tag, allowed-style, and
  `data-sc-*` attribute conventions. Since #364 the glossary markup follows
  Yomitan's `DisplayGenerator` and `StructuredContentGenerator`, `reader.css`
  ports the glossary part of `display.css`, `structured-content.css` and
  `display-pronunciation.css`, and `glossary.js` ports `PronunciationGenerator`
  and the pitch helpers and `distributeFurigana` of `language/ja/japanese.js`, all at
  yomidevs/yomitan@67db60d. Outside this directory, `../anki-glossary.js` ports
  `CssStyleApplier.applyClassStyles` and `../vendor/yomitan/structured-content-style.js`
  is Yomitan's `structured-content-style.json`, unchanged. Both are licensed
  under GPL-3.0-or-later.

- **[hoshidicts](https://github.com/Manhhao/hoshidicts)** — the engine whose
  lookup JSON these files render, vendored as the `third_party/hoshidicts`
  submodule. Licensed under GPL-3.0.

- **[Yomitan GSM](https://github.com/bpwhelan/yomitan-gsm)** — the dark popup
  palette adapted by `reader.css`. Licensed under GPL-3.0-or-later.

- **[Microsoft Fluent System Icons](https://github.com/microsoft/fluentui-system-icons)**
  — native action and status icons use the 20px Regular SVG subset in
  `../icons/fluent/`. That directory includes the MIT license and a
  `sources.json` manifest pinning the upstream revision and original paths.
  `scripts/vendor-fluent-icons.py` generates the local `../icons.css` masks;
  icons inherit theme colors and require no runtime external requests.

Dictionary archives are not redistributed. Imported dictionaries keep whatever
source, license, and attribution metadata their own index carries, and any CSS a
dictionary ships is applied by `applyDictionaryStyles` scoped to that
dictionary's own glossary content: through `@scope` in the popup, and by
Yomitan's selector prefixing on Anki cards.
