# Hoshidicts todo

This is the implementation and validation checklist for the Hoshidicts feature branch.

## Dictionary import and management

- [x] Allow selecting and importing multiple Yomitan dictionary ZIPs in one file-picker operation.
- [x] Keep import progress beside the dictionary import controls instead of at the top of settings.
- [x] Put Yomitan imports at the bottom of settings in a dedicated Backups section.
- [x] Import dictionaries from a Yomitan dictionary backup.
- [x] Import supported settings from a Yomitan settings backup.
- [x] Avoid JavaScript `Invalid string length` failures when large dictionary backups are parsed.
- [x] Collapse Recommended dictionaries when at least one dictionary is installed; expand them when none are installed.
- [x] Add a three-dot dictionary menu with Move to position.
- [x] Add Rename dictionary to each dictionary's three-dot menu and persist the display name without changing its native identity.
- [x] Export a complete Hoshidicts backup from the Backups section.
- [x] Restore a complete Hoshidicts backup from the Backups section.
- [x] Include every installed dictionary, dictionary order/enabled/favourite/name state, reader settings, themes, popup dimensions, mining settings, audio settings, and custom dictionary data in the backup.
- [x] Make restore transactional: validate the entire archive first and leave the current installation unchanged on failure.

## Lookup correctness

- [x] Support simultaneous lookup across multiple enabled dictionaries.
- [x] Verify current Jitendex contains `我輩` / `吾輩` with reading `わがはい`.
- [x] Verify full-width katakana `ワガハイ` resolves through a real current Jitendex Yomitan import.
- [x] Match Yomitan's width-before-kana normalization so visually equivalent half-width `ﾜｶﾞﾊｲ` also resolves to `わがはい`.
- [x] Keep regression coverage for full-width, half-width, decomposed, hiragana, and kanji forms while preserving the original matched text.
- [ ] Add useful diagnostics which distinguish no enabled term dictionary, no dictionary entry, normalization failure, and lookup transport failure.

## Popup rendering and appearance

- [x] Import the current default Jitendex and preserve its structured definitions, stylesheet, links, and media through native lookup and popup rendering.
- [ ] Compare JMdict/JMnedict/KANJIDIC rendering side by side against current Yomitan and native Hoshidicts.
- [x] Test a real CharacterDictionary.tokyo v17 archive through import, lookup, structured-content rendering, inline styles, and media loading.
- [x] Render supported Yomitan structured-content elements, inline styles, images, ruby, tables, lists, tags, links, and collapsible sections cleanly.
- [x] Support Jitendex hyperlinks/cross-references to other dictionary definitions and open them as child Hoshidicts lookups without closing the parent popup.
- [x] Distinguish internal definition links from genuine external attribution/source links; keep external links usable without treating them as dictionary queries.
- [x] Scope dictionary CSS to its dictionary card so it cannot visually corrupt another dictionary or the popup shell.
- [x] Provide attractive fallback styling when a dictionary has no stylesheet.
- [x] Keep the popup at a stable configured width and height instead of resizing for each word.
- [x] Add user-configurable popup width and height settings with sensible limits and a reset action.
- [x] Keep popup placement inside the viewport at every configured size and for horizontal and vertical text.
- [x] Treat a parent popup and its child popup chain as one hover-safe region: moving into a child does not close the parent, and leaving the chain prunes it after the configured delay.
- [x] Cover direct parent-to-child and child-to-parent pointer travel, delayed hiding, re-entry, nested depth limits, and live pruning with regression tests.
- [ ] Add exhaustive sibling-child pointer-travel coverage across every supported nesting depth.
- [x] Add Hoshidicts themes in settings, including Default, High contrast, Autumnal, and Cyber.
- [x] Reuse GSM theme tokens where they fit while keeping dictionary-provided CSS readable in every theme.
- [x] Check contrast, keyboard focus, hover states, nested popups, media, and long definitions in every theme.

## Mining, duplicates, blur, and audio

- [x] Center the popup mining action and use distinct add/overwrite/duplicate states.
- [x] Add collection-, deck-, and note/model-level duplicate checks and Yomitan-style duplicate behaviours.
- [x] Reveal blurred definitions on hover for every blur mode.
- [x] Allow hover-only reveal when timed reveal is disabled, and timed-plus-hover reveal when it is enabled.
- [x] Import supported Yomitan audio settings, including custom local-audio-server URLs.
- [x] Validate a restored backup preserves duplicate, blur, mining, and audio behaviour end to end.

## Required validation

- [x] Import multiple ordinary Yomitan ZIPs in one selection.
- [x] Import a large Yomitan dictionary backup without `Invalid string length`.
- [x] Import and exercise the current default Jitendex archive with real lookups, CSS, links, AVIF, and SVG media.
- [x] Import and render the remaining default/recommended dictionaries.
- [x] Import and exercise a real CharacterDictionary.tokyo archive with structured inline styles and media. The tested v17 archive does not contain a separate `styles.css`.
- [ ] Compare representative entries side by side with Yomitan.
- [x] Exercise lookup, media, nested lookup, mining, duplicate checks, rename, reorder, enable/disable, export, destructive restore rollback, and successful restore.
- [x] Run native Hoshidicts tests, Rust bridge tests, Electron main/renderer tests, overlay reader tests, builds, and changed-file lint/format checks.
- [x] Commit each coherent feature batch and push the feature branch.

### Real-data evidence (2026-08-08)

- Direct multi-ZIP import used Jitendex `2026.07.09.0` (38,545,572-byte ZIP; 540,565,403 bytes uncompressed) and CharacterDictionary.tokyo v17 revision `001786225697` (1,448,063-byte ZIP; 81,896,926 bytes uncompressed).
- The combined import completed with 433,885 Jitendex terms and 250 media records plus 28,220 Character Dictionary terms and 13 media records. Both dictionaries activated together in their selected order without `Invalid string length`.
- A schema-faithful 85,687,766-byte Yomitan Dexie backup containing all 28,220 real Character Dictionary entries and representative Jitendex entries, CSS, internal/external links, AVIF, and SVG data reconstructed into ZIPs, imported, activated, and searched successfully.
- Live `ワガハイ` and half-width `ﾜｶﾞﾊｲ` lookups both resolved first to `我輩` / `わがはい` while preserving the original matched spelling. `麻の葉`, `締め切り日`, `アルハラ`, and `少年` verified AVIF, SVG, internal-link, and Character Dictionary structured-content paths respectively.
- Native media retrieval passed for 262/262 real assets with no failures: 201 AVIF, 48 SVG, and 13 JPEG files. Jitendex also returned its complete 6,444-byte scoped stylesheet.
- The other six defaults were imported from their current archives: BCCWJ (1,000,219 frequency entries), JMnedict (667,821 terms), JPDBv2 kana (338,814 frequencies), Jiten (587,544 frequencies), KANJIDIC (10,384 kanji), and Kanjium (124,137 pitch entries). Together with Jitendex and Character Dictionary, all eight activated and searched simultaneously.
- Representative full-stack lookups returned Jitendex and JMnedict terms for `東京`, BCCWJ/JPDB/Jiten frequencies and Kanjium pitch data for `食べる`, and KANJIDIC data for `食`.
- A complete 250,397,880-byte Hoshidicts backup containing 524,563,155 payload bytes across 46 files was exported, fully validated, restored into eight fresh generations in 2.381 seconds, activated, and searched. The real BCCWJ bloom filter exposed and now permanently covers a large-deflate stream regression which the small fixtures missed.
- Live post-restore checks returned 16 results for half-width `ﾜｶﾞﾊｲ`, four for `食べる`, twelve for `東京`, the KANJIDIC entry for `食`, and the complete Jitendex stylesheet from all eight restored dictionaries.
- Default, High contrast, Autumnal, and Cyber popup renders were inspected in headless Chromium at the stable default 560 by 420 pixel size; theme tokens, definition cards, controls, and overflow remained legible and contained.
- The final Hoshidicts TypeScript matrix passed 368/368 tests across 16 files. The Rust bridge passed 62/62 tests, the standalone native Hoshidicts C++ test passed, both Electron builds completed, `cargo fmt --check` and `git diff --check` passed, and the only build warning was Vite's existing large-chunk advisory.
- The repository-wide TypeScript run passed 715/741 tests. Its 26 failures are outside Hoshidicts: nine Windows-path fixtures run under Linux and seventeen texthook tests cannot load Frida's native binding for Node 26 on this checkout.
- Final edge-case regressions cover visible move positions with the hidden custom dictionary, aliases on kanji/frequency/pitch-only dictionaries, Recommended collapse with only a custom dictionary, Yomitan progress in Backups, backup filename normalization and replacement, recovery over a corrupt current manifest, and popup fitting on viewports smaller than the configured size.
- Remaining evidence gaps: the tested Dexie backup was generated from the official archives in Yomitan's exported schema rather than created by clicking Export in a live Yomitan browser profile, and a screenshot-based side-by-side comparison with Yomitan has not yet been completed.
