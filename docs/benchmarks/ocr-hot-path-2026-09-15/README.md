**OCR performance measurements — September 15, 2026**

The optimized OCR paths preserve every tested output while reducing image copies, repeated image analysis, result serialization, and repeated text comparisons. The baseline is commit `143603cc671bd24cf4b1523be51976003b1c8bf5`. Measurements ran locally on an AMD Ryzen 7 5800X (8 cores, 16 logical processors), Windows 11, Python 3.13.2, NumPy 2.2.6, Pillow 12.3.0, OpenCV 4.13.0.92, and OneOCR 1.0.12.

The full aggregate measurements, individual timing rounds, dependency versions, and corpus fingerprint are in [results.json](results.json). Captured images and recognized text remain in the local ignored `.cache/ocr-perf/` directory.

| Operation | Before, ms | After, ms | Speedup |
| --- | ---: | ---: | ---: |
| OCR result conversion, per captured response | 0.3948 | 0.3418 | 1.16× |
| Text comparison over the full corpus | 0.0149 | 0.0113 | 1.32× |
| Repeated recent text comparisons | 0.0258 | 0.0054 | 4.79× |
| Updating an unchanged stability reference | 4.0365 | 0.2134 | 18.92× |
| Comparing a stable frame | 5.2277 | 1.2233 | 4.27× |
| Comparing and rebasing changing frames | 9.7943 | 2.3377 | 4.19× |
| Blank-frame check, 1080p | 0.3657 | 0.1763 | 2.07× |
| Grayscale to writable RGB array, 1080p | 7.1046 | 1.2597 | 5.64× |
| RGBA to writable RGB array, 1080p | 6.6670 | 4.6885 | 1.42× |
| PNG encoding from RGB, 1080p | 10.2207 | 7.0316 | 1.45× |
| PNG encoding from RGBA, 1080p | 9.5639 | 7.9688 | 1.20× |
| OneOCR pixel preparation from RGB, 1080p | 10.1686 | 2.5998 | 3.91× |
| OneOCR pixel preparation from RGBA, 1080p | 6.5774 | 1.7913 | 3.67× |

These are separate component measurements. They do not imply the same speedup for a complete recognition pass. On 128 captured images spread across the corpus, paired real OneOCR calls had a median of **67.58 ms before and 66.19 ms after**, about a 2.1% reduction. Native inference dominates these relatively small captured images. A final profile over 16 representative images spent about 98% of the OneOCR call inside the native recognition operation. Larger frames benefit more from the image-copy reductions.

Each component measurement uses a warm-up, nine alternating before/after rounds, and three loops per round. Result conversion replays the same raw engine responses. Pixel preparation exercises the installed OneOCR encoder with native inference replaced by a byte sink. Stability component timings use fixed 640×240 images. Live inference timing includes ordinary model and system variability.

The retained changes are:

- Encode RGB/RGBA directly into the same RGBA bytes consumed by OneOCR and fast PNG encoding. Preserve transparent-color metadata and unusual-mode conversion. OneOCR retains ownership of its native buffer and inference call.
- Convert grayscale/RGBA into owned, writable RGB arrays without an intermediate PIL RGB image. Preserve empty-image behavior and the fallback when OpenCV is unavailable.
- Cache OCR dataclass field names while creating fresh output containers and retaining standard serialization for unusual values. Use scalar arithmetic for compatible unrotated boxes; retain NumPy arithmetic for rotations and mixed precision.
- Calculate the same image percentiles from exact 8-bit histograms, count binary-mask intersections in OpenCV, avoid discarded signatures, reuse the signature produced while comparing changed frames, and skip edge detection when it cannot improve a perfect score.
- Cache recent Unicode normalization and matching-block statistics with bounded entry counts and text lengths. Matching algorithms and comparison settings retain their original behavior.
- Read sampled capture pixels through one PIL pixel accessor instead of repeatedly loading the image accessor.

Validation completed:

- **24,580 exact OCR-result comparisons**: all 2,458 captured images, five furigana sensitivities, and both spatial-spacing modes. The entire six-field result is compared, including text, every coordinate, crop geometry, and serialized metadata.
- **896 exact stability observations** on 128 real captures, including repeated, shifted, blank, and returning frames. Scores, scan decisions, counters, and reference-update outcomes match.
- **128 paired real OneOCR recognitions** with identical complete outputs.
- Byte-identical OneOCR and PNG inputs, identical PNG outputs, and pixel-identical writable RGB arrays.
- **72 new regression cases**, including mixed numeric precision near integer boundaries, transparency metadata, empty images, mutable-container ownership, extended dataclasses, cache settings, large-text cache bounds, and exact percentiles and masks.
- Full `.venv` pytest suite: **2,781 passed, 47 skipped**, with existing deprecation warnings.
- Required Ruff formatting completed. New files and the stability module pass Ruff lint. The three older touched OCR files retain their existing lint diagnostics; no new diagnostic was introduced. `git diff --check` passes for the production changes.

To replay the existing local corpus from the repository root:

```powershell
.venv/Scripts/python.exe scripts/benchmark_ocr_hot_path.py --records .cache/ocr-perf/full-corpus.json --reference-ref 143603cc671bd24cf4b1523be51976003b1c8bf5 --repeats 9 --loops 3 --verify-inference 128 --output .cache/ocr-perf/recheck.json
```

To capture a new corpus first, add `--input-dir <directory-of-captured-PNGs> --max-samples 2458`. The benchmark requires the captured files for stability and live-recognition checks, plus a locally installed OneOCR runtime. It makes no remote OCR requests. It fails on an output mismatch rather than reporting performance for a changed result.

The final review found no additional measured improvement that could be retained with the same output guarantees. Remaining substantial work is native recognition, compression, required edge analysis, and rotated-coordinate calculations. These measurements establish observed parity and local speedups, not a claim of a universal performance optimum.
