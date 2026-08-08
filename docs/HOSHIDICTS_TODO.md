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
- [ ] Add Rename dictionary to each dictionary's three-dot menu and persist the display name without changing its native identity.
- [ ] Export a complete Hoshidicts backup from the Backups section.
- [ ] Restore a complete Hoshidicts backup from the Backups section.
- [ ] Include every installed dictionary, dictionary order/enabled/favourite/name state, reader settings, themes, popup dimensions, mining settings, audio settings, and custom dictionary data in the backup.
- [ ] Make restore transactional: validate the entire archive first and leave the current installation unchanged on failure.

## Lookup correctness

- [x] Support simultaneous lookup across multiple enabled dictionaries.
- [x] Verify current Jitendex contains `我輩` / `吾輩` with reading `わがはい`.
- [x] Verify full-width katakana `ワガハイ` resolves through a real current Jitendex Yomitan import.
- [ ] Match Yomitan's width-before-kana normalization so visually equivalent half-width `ﾜｶﾞﾊｲ` also resolves to `わがはい`.
- [ ] Keep regression coverage for full-width, half-width, decomposed, hiragana, and kanji forms while preserving the original matched text.
- [ ] Add useful diagnostics which distinguish no enabled term dictionary, no dictionary entry, normalization failure, and lookup transport failure.

## Popup rendering and appearance

- [ ] Compare default Jitendex/JMdict/JMnedict/KANJIDIC rendering against current Yomitan and native Hoshidicts.
- [ ] Test CharacterDictionary.tokyo structured content and media through import, lookup, and nested popup rendering.
- [ ] Render all supported Yomitan structured-content elements, styles, images, ruby, tables, lists, tags, links, and collapsible sections cleanly.
- [ ] Scope dictionary CSS so one dictionary cannot visually corrupt another dictionary or the popup shell.
- [ ] Provide attractive fallback styling when a dictionary has no stylesheet.
- [ ] Keep the popup at a stable configured width and height instead of resizing for each word.
- [ ] Add user-configurable popup width and height settings with sensible limits and a reset action.
- [ ] Keep popup placement inside the viewport at every configured size and for horizontal and vertical text.
- [ ] Treat a parent popup and all of its child popups as one hover-safe chain: moving into a child must not close the parent, and hide/prune only after the cursor has left both the parent and every descendant.
- [ ] Cover parent-to-child pointer travel, child-to-parent travel, sibling children, nested depth, delayed hiding, and re-entry with regression tests.
- [ ] Add Hoshidicts themes in settings, including Default, High contrast, Autumnal, and Cyber.
- [ ] Reuse GSM theme tokens where they fit while keeping dictionary-provided CSS readable in every theme.
- [ ] Check contrast, keyboard focus, hover states, nested popups, media, and long definitions in every theme.

## Mining, duplicates, blur, and audio

- [x] Center the popup mining action and use distinct add/overwrite/duplicate states.
- [x] Add collection-, deck-, and note/model-level duplicate checks and Yomitan-style duplicate behaviours.
- [x] Reveal blurred definitions on hover for every blur mode.
- [x] Allow hover-only reveal when timed reveal is disabled, and timed-plus-hover reveal when it is enabled.
- [x] Import supported Yomitan audio settings, including custom local-audio-server URLs.
- [ ] Validate a restored backup preserves duplicate, blur, mining, and audio behaviour end to end.

## Required validation

- [ ] Import multiple ordinary Yomitan ZIPs in one selection.
- [ ] Import a large Yomitan dictionary backup without `Invalid string length`.
- [ ] Import and render the current default recommended dictionaries.
- [ ] Import and render a CharacterDictionary.tokyo archive with its real stylesheet and media.
- [ ] Compare representative entries side by side with Yomitan.
- [ ] Exercise lookup, media, nested lookup, mining, duplicate checks, rename, reorder, enable/disable, export, destructive restore rollback, and successful restore.
- [ ] Run native Hoshidicts tests, Rust bridge tests, Electron main/renderer tests, overlay reader tests, builds, and changed-file lint/format checks.
- [ ] Commit each coherent feature batch and push the feature branch.
