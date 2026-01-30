# Agent Change Log

Purpose: short, repeatable instructions so future agents can re-apply these changes safely.

## Change 1: Force showParseButton to always be false

Files:
- GSM_Overlay/jiten.reader/js/ajb.js

Steps:
1) Search for getConfiguration('showParseButton') in `GSM_Overlay/jiten.reader/js/ajb.js`.
2) Replace each occurrence with `const show = false;`.
3) Result: the parse button is never shown, even if config changes.

## Change 2: Remove the Show Parse Button setting

Files:
- GSM_Overlay/jiten.reader/views/settings.html

Steps:
1) Find the checkbox block with:
   - `<input type="checkbox" id="showParseButton" name="showParseButton" />`
2) Delete the entire surrounding `<div>` that contains the checkbox and its label.
3) Result: the setting no longer appears in the UI.

Notes:
- This repo bundles built files in `GSM_Overlay/jiten.reader/js/ajb.js`. Edits here are expected.
- If the source-of-truth exists elsewhere, repeat the same logical changes there too.
