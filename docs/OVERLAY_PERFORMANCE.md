# Overlay processing performance

This pass moves overlay coordinate projection, payload copying, minimum-size decisions, and exclusion-region decisions into the existing Rust extension. It also batches Chromium layout work and reduces the cost of matching retained dialogue against recent block history.

The reference revision is `90eb145b5b8dd1a91ba4c0eca99ec20984b46b64`. Measurements were taken on Windows 11 with Python 3.13.2, Node 22.23.1, and the locally installed Electron 42.3.2. The native extension was built in release mode. These are offline synthetic processing benchmarks; capture, OCR inference, network requests, and enrichment are outside the measured stages.

## Measurements

The dense renderer fixture contains 16 lines and 704 visible characters. At a fixed 1920 × 1080 CSS viewport, the median render time fell from **330.4 ms to 19.8 ms (16.7×)**. Chromium layout passes fell from **1,411 to 3**. Timings alternate implementation order over six rounds of four frames and include the final layout flush. DOM snapshot serialization is excluded from timing.

Backend timings below are milliseconds per frame, with 20 lines and 40 words per line. They are medians over seven alternating rounds of 30 deterministic frames. Fresh inputs for mutating operations are prepared outside the timed region.

| Processing stage | Before | After | Speedup |
| --- | ---: | ---: | ---: |
| OneOCR coordinate projection | 0.947 | 0.382 | 2.5× |
| Source-space coordinate projection | 5.129 | 0.781 | 6.6× |
| Absolute-screen coordinate projection | 5.018 | 0.793 | 6.3× |
| Payload copy | 4.100 | 0.431 | 9.5× |
| Overlay language filtering and reconstruction | 8.965 | 1.856 | 4.8× |
| Minimum-character-size filtering | 6.286 | 1.799 | 3.5× |
| Exclusion-region filtering, eight regions | 11.558 | 1.849 | 6.3× |

The smaller, three-line/20-word fixture also improved in every measured stage. Speedups ranged from 1.4× for in-place coordinate projection to 8.8× for copying.

Block detection with retained dialogue improved by approximately **10×** in the separate history replay benchmark. The 3-, 10-, and 24-line scenarios measured 10.2 → 1.0 ms, 37.9 → 3.6 ms, and 96.4 → 9.1 ms per frame respectively. These stages are measured independently; their speedups do not multiply into an end-to-end OCR speedup.

## Preserved behavior

- The renderer still measures real Chromium rectangles. It creates all boxes, reads their initial geometry together, applies the existing font and punctuation sizing, then reads final bounds. Glyph render plans and block translation text are built once per frame. DOM order, lookup text, indicators, calibration, and Magpie mapping are retained.
- History matching still normalizes complete candidate strings with NFKC and uses the original UTF-16 Levenshtein distance and 0.85 acceptance threshold. Normalized history is reused. A conservative edit-distance bound, equal-prefix/suffix trimming, and two reusable rows avoid unnecessary work without changing accepted scores or tie breaking.
- Rust projection retains the original order of floating-point operations, including monitor-origin addition and subtraction. OneOCR continues to mutate its input; precomputed-coordinate conversion continues to return independent copies. In-place frames are validated completely before any mutation. Aliased in-place boxes use the reference path.
- Native copies preserve shared references and cycles in built-in containers. Custom objects, subclasses, and unsupported metadata retain Python's `deepcopy` behavior. Diagnostic comparisons also handle cycles, and in-place projection never invokes custom copy protocols. Geometry decisions fall back for custom payloads, non-finite coordinates, and integer thresholds that cannot be represented exactly.
- The five original Python projection/filter implementations remain unchanged apart from their `_python` method names. Their ASTs were compared with the reference revision. Missing native capabilities automatically fall back, so an older installed extension remains usable.

The Python orchestration, OCR correction, normalization, and reference fallbacks remain. The migration covers processing kernels and avoids changes to capture timing, OCR engine output, network protocols, and vendored reader code.

## Validation

- Full Python suite: **2,869 passed, 50 skipped**.
- Overlay Node tests: **124 passed**; overlay TypeScript tests: **50 passed**.
- Rust unit tests: **9 passed**; Clippy with warnings denied passed.
- **792 exact Chromium comparisons** of DOM content, inline styles, text-box rectangles, and widget bounds against the reference renderer and block detector. Cases cover three viewport sizes, CJK/Latin/Ukrainian text, supplementary characters, punctuation, vertical text, retries, supplemental frames, pinned-window exclusion, calibration offsets, recycled indicators, and Magpie scaling.
- Deterministic randomized native parity tests cover coordinate conversion, copying, geometry filtering, numeric coercion, aliases, fallback modes, and the 50% exclusion threshold. History tests compare randomized and threshold-boundary results to the original unbounded edit-distance algorithm; the replay benchmark verifies all block metadata and history for 90 frames.
- The existing Electron gamepad smoke test passed. Ruff formatting, focused lint checks for new Python code, and dependency-lock validation passed.

## Reproduction

Run from the repository root, using the project's virtual environment. On Windows, close running GSM processes before replacing the extension binary.

```powershell
.venv/Scripts/python.exe -m pip install --no-deps -e .
.venv/Scripts/python.exe -m pytest -q
cargo test --manifest-path native/gsm-native/Cargo.toml
cargo clippy --manifest-path native/gsm-native/Cargo.toml -- -D warnings

.venv/Scripts/python.exe scripts/benchmark_overlay_processing.py --reference-ref 90eb145b5b8dd1a91ba4c0eca99ec20984b46b64 --output .agent_scripts/overlay-processing.json
node scripts/benchmark-overlay-blocks.cjs 90eb145b5b8dd1a91ba4c0eca99ec20984b46b64
node GSM_Overlay/tests/run-overlay-render-electron.cjs 90eb145b5b8dd1a91ba4c0eca99ec20984b46b64
```

`npm run test:render-electron --prefix GSM_Overlay` also runs the renderer harness. Its default reference is `HEAD`; use the explicit revision above to reproduce this comparison after committing the changes. The harness asserts at most three layout passes per dense frame regardless of elapsed timing.

The extension configuration now sets `debug = false`, so editable installations also use optimized Rust. Without that setting, setuptools-rust normally chooses debug builds for in-place installs. [setuptools-rust build configuration](https://setuptools-rust.readthedocs.io/en/latest/reference.html)

For diagnosis, set `GSM_NATIVE_OVERLAY_MODE=python` to use the reference kernels, or `GSM_NATIVE_OVERLAY_MODE=shadow` to compare results while returning the Python result. Shadow mode is deliberately slower. `GSM_NATIVE_MODE` remains the global override; the existing OCR-specific mode controls the older OCR kernels separately. Restart GSM and the overlay to load the rebuilt native extension and renderer.
