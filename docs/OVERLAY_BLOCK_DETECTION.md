# Overlay text grouping

`GSM_Overlay/block_detection.js` groups text using OCR word geometry. The renderer calls `prepareTextLines()` once, then passes the resulting lines to `detectTextBlocks()` and all rendering, translation, and enrichment consumers. Returned line indexes refer to that prepared array. The original OCR payload is not mutated.

## Geometry pipeline

1. Use the union of visible word quadrilaterals rather than padded OCR line bounds. Preserve the original line when its text no longer matches its word list, or word geometry is unavailable.
2. Reconstruct visual runs at word boundaries. Split when words move onto another row, change font size substantially, or leave an unusually large horizontal gap. Preserve the original text, whitespace, word objects, and reading order. Vertical CJK text uses the same rules with the axes exchanged.
3. Join fragments on the same baseline using character advance and observed word gaps. Horizontal distances are compared with horizontal measurements, not text height in a different percentage coordinate system. Punctuation and thin single glyphs can inherit the surrounding font size.
4. Compare only neighboring rows with compatible fonts and overlapping text columns. Keep consistently spaced rows together; a larger gap relative to the neighboring row gaps starts a new paragraph. Unrelated text elsewhere on screen does not determine the spacing threshold.
5. Separate likely character names from dialogue and retain the existing recent-block history, latest-dialogue marker, and navigation metadata.

The renderer includes block membership and orientation in its reuse signature. A retry that changes grouping therefore rebuilds the containers even if the text itself is unchanged. Block indicators continue to use rendered word bounds, including calibration and Magpie transforms.

## Limits

OCR words remain the smallest reliable geometric unit. A single word rectangle cannot reveal the actual gaps between its characters, so the detector estimates character advance within it rather than inventing exact glyph positions. Name classification remains a conservative geometry heuristic; ambiguous short openings can resemble speaker names.

`tests/fixtures/nameplate-dialogue-oneocr.json` contains actual local OneOCR output from the reported screenshot. Fresh OCR of that image already separated the name with the previous heuristic; it is preservation coverage. Additional tests cover padded boxes, character fragments, and one OCR line containing both visual rows to exercise segmentation differences.

## Validation

From the repository root:

```powershell
node --test GSM_Overlay/tests/block_geometry.test.cjs GSM_Overlay/tests/block_screenshot.test.cjs GSM_Overlay/tests/block_layout_render.test.cjs
node node_modules/vitest/vitest.mjs run --config vitest.config.ts electron-src/main/ui/overlay-block-detection.test.ts electron-src/main/ui/overlay-block-translation.test.ts electron-src/main/ui/gamepad-bindings.test.ts
```

Restart or reload the overlay after changing its JavaScript to test the new implementation in a running game.
