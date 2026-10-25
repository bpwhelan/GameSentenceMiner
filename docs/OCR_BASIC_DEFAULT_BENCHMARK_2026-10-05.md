# Basic OCR default benchmark — October 5, 2026

Use **ScreenAI for both stability and final text in Basic mode**, with Google Lens
available through an explicit online-scan option. ScreenAI had the best agreement
with saved Lens text in this corpus, substantially fewer empty results than Meiki,
and similar median latency to the other local recognition engines. Reusing the
stable result avoids a redundant final scan.

## Measurements

All 2,458 PNG/JSON pairs in the user's `ocr_metrics/pending` directory were tested
(2,456 distinct image hashes). Sources: 2,424 automatic OCR, 33 secondary/menu,
and one screen crop. The run used Windows 11, an eight-core/16-thread AMD CPU,
32 GiB RAM, Python 3.13.2, OneOCR 1.0.12, MeikiOCR 0.3.4, and ONNX Runtime 1.24.4.
Meiki was explicitly run on CPU. These are Windows measurements; macOS/Linux
performance and other languages were not measured.

Each candidate ran in its own process, sequentially, with five warmup images.
Image loading and initialization were excluded from scan timings. GSM remained
open; short development checks also ran during parts of the benchmark, so treat
small timing differences as approximate rather than a controlled hardware ranking.
All four candidates completed every call successfully. Empty output is reported
separately because a successful call can still miss visible text.

| Candidate | Median scan | 95th percentile | Empty outputs | Saved-Lens character disagreement | Exact saved-Lens matches |
| --- | ---: | ---: | ---: | ---: | ---: |
| ScreenAI | 77.7 ms | 154.2 ms | 18 | 8.97% | 1,748 / 2,455 (71.2%) |
| OneOCR | 73.1 ms | 125.7 ms | 10 | 9.62% | 1,128 / 2,455 (45.9%) |
| Meiki full OCR | 70.5 ms | 98.2 ms | 148 | 10.25% | 1,511 / 2,455 (61.5%) |
| Meiki detector → recognition only | 68.7 ms | 108.2 ms | 87 | 10.22% | 1,571 / 2,455 (64.0%) |

Timing and empty counts cover all 2,458 images. Agreement excludes the three
samples whose reference engine was ScreenAI. Character disagreement is total
Levenshtein edits divided by reference characters, after NFKC normalization and
removal of punctuation, whitespace, and the internal `BLANK_LINE` marker. Spelling
and reading order still count. **This is agreement with saved OCR, not a measured
accuracy rate against human transcription.** No fresh online OCR requests were made.

ScreenAI's post-run process memory was about 507 MiB, versus 225 MiB for OneOCR,
725 MiB for full Meiki, and 332 MiB for the recognition-only experiment. These
include the Python runtime and retained engine allocations, and are not model
sizes or peak-memory measurements.

## Meiki detection reuse

The experiment calls GSM's Meiki detector, crops its unpadded line boxes, then
uses Meiki's public `run_recognition` API and restores character coordinates to
the original image. It does not rerun detection in recognition. Median detector
time was **47.2 ms**; median recognition-only time was **19.8 ms** (mean 28.5 ms).
Skipping detection therefore has real value when a previous stability scan has
already found the lines. The total column includes one detection and recognition;
individual medians do not add to the median total.

The detector uses its existing 0.4 confidence threshold; full Meiki uses its
existing 0.5 threshold. The experiment also recognizes line crops individually,
whereas full Meiki batches lines. Its coverage difference cannot be attributed
solely to skipping detection. This is an experimental benchmark adapter, not a
new production Meiki recognition path.

For two stability observations, summing measured mean engine work gives roughly
186 ms for ScreenAI twice, versus 122 ms for Meiki detection twice plus recognition
once. This is an estimate, not measured end-to-end delivery latency: polling,
capture, changing text, and output handling are excluded. The small speed saving
does not outweigh Meiki's weaker text coverage for the default. Meiki remains
available in Advanced mode.

## Stability and visual checks

A separate stratified 128-image run repeated 64 images five times each. ScreenAI
returned identical text on all repeated comparisons. Geometry/empty-state results
were also repeatable; the existing benchmark's lower box-stability score counts
empty boxes as unstable. Its generic detector ranking preferred Meiki on detection
latency, but does not evaluate recognition quality or the saved final scan when
ScreenAI fills both roles. The pending corpus remained unchanged.

Visual inspection confirmed both real differences and limits of the reference:

- `20260709T102238_026058Z`: ScreenAI reads the single dialogue line once; the
  Meiki reuse experiment duplicates it.
- `20260709T223412_444477Z`: ScreenAI preserves the left-to-right menu sequence;
  Meiki reorders the labels.
- `20260709T233857_848702Z`: Meiki preserves the speaker/dialogue order; ScreenAI
  puts the last part of the dialogue first. ScreenAI is not uniformly better.
- `20260709T215551_966090Z`: ScreenAI includes background text `必要費用` that is
  visibly present but absent from the saved Lens reference. Some disagreement
  is extra real text rather than a recognition error; tight OCR areas still help.

This corpus contains isolated Japanese game captures, not labeled animation
sequences. Repeating static images does not establish temporal stability across
every game's text animation.

## Implemented behavior

- Basic mode uses ScreenAI locally for both stages on Windows, macOS, and Linux.
  Initial resource acquisition can require a download; scans use local resources.
- **Use online scans for better accuracy** opts into Google Lens for final OCR.
  Existing Basic profiles do not inherit online opt-in from their old `ocr2` value.
  Advanced engine selections are preserved.
- Stable same-engine text goes directly through final filtering and output,
  without cropping, queuing, or invoking the main OCR engine again. This applies
  to both controller versions. Raw separators and the matching frame's geometry
  are preserved; duplicate handling uses delivered text rather than OCR1 history.
- The online option reloads the running engines and stability state. Newline
  preferences refresh without discarding a pending frame.

Validation: 519 Python tests covering OCR, configuration, and the benchmark
adapter; 29 desktop tests covering defaults, the settings UI, and store behavior;
Electron main/renderer production build; visual inspection of the settings UI.
Ruff formatting passed. The touched existing Python files have pre-existing lint
findings; comparison against HEAD found no new findings, and the new files pass
lint independently.

## Reproduction and outputs

From the repository root, using its virtual environment:

```powershell
.\.venv\Scripts\python.exe scripts/benchmark_basic_ocr.py --input-dir "$env:APPDATA\GameSentenceMiner\ocr_metrics\pending" --output-dir "$env:APPDATA\GameSentenceMiner\ocr_metrics\basic_benchmark_20261005" --max-samples 0
.\.venv\Scripts\python.exe scripts/benchmark_stability_ocr.py --input-dir "$env:APPDATA\GameSentenceMiner\ocr_metrics\pending" --output-dir "$env:APPDATA\GameSentenceMiner\ocr_metrics\basic_benchmark_20261005\repeatability" --engines screenai,meiki_text_detector --max-samples 128 --consistency-samples 64 --repeats 5
```

The output directory contains the input manifest and image hashes, environment
metadata, per-image recognized text and timings in JSONL, per-engine summaries,
logs, and the separate repeatability report. The game images and their text are
kept in the local metrics directory, outside this repository.
