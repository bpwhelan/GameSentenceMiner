# CPU OCR on Anki game stills

On a Ryzen 7 5800X, GSM's MIDA + VOCR6-L took **27 ms** for a fresh still and
**17 ms** for a repeat with unchanged dialogue. It read 9 of 11 visually
transcribed passages exactly. ScreenAI read 10, and standalone VOCR read 7.
With the MIDA → ScreenAI preset, MIDA located the dialogue and ScreenAI read the
resulting crop. That recovered **11 of 11** passages and took **105 ms** median
on fresh images, excluding the configured wait for dialogue to settle.

## Timings

Each cell gives median / 95th percentile in milliseconds. “Fresh” is the first
reading of the next distinct image. “Repeat” changes a corner pixel on the same
image while keeping the dialogue in place. Detection runs on both. The Windows
baseline was recorded before changing the engines. Linux compares the integrated
portable engine with and without the new line cache.

| Local CPU engine | Fresh before | Fresh after | Repeat before | Repeat after |
|---|---:|---:|---:|---:|
| VOCR, Large | 17 / 51 | 17 / 51 | 15 / 44 | **9 / 11** |
| MeikiOCR | 64 / 177 | 74 / 190 | 66 / 180 | **45 / 48** |
| MIDA + VOCR6-L | — | **27 / 53** | — | **17 / 21** |
| MIDA detector only | — | 16 / 21 | — | 16 / 21 |
| MIDA detector then MIDA + VOCR6-L | — | **37 / 73** | — | **27 / 40** |
| MIDA detector then ScreenAI on the detected area | — | 105 / 340 | — | 103 / 298 |
| Meiki detector then ScreenAI on the detected area | — | 164 / 362 | — | 147 / 349 |
| ScreenAI, Windows | 107 / 316 | 127 / 313 | 106 / 279 | 123 / 304 |
| OneOCR, Windows DLL | 115 / 202 | 123 / 223 | 114 / 202 | 120 / 221 |
| OneOCR, Ubuntu on WSL | 211 / 594 | 232 / 701 | 206 / 582 | **173 / 400** |

The cache benefited repeated dialogue most. Fresh MeikiOCR was about 10 ms
slower and fresh portable OneOCR about 21 ms slower in these runs. Windows
ScreenAI and OneOCR retain their full-image inference calls, and their timings
also varied across runs. These are single sweeps on a shared desktop. Text,
reading order and all returned boxes matched before and after on **184/184**
readings for each of VOCR, MeikiOCR and portable OneOCR.

## Reading quality

One short passage was transcribed by looking at the pixels on each of 11
different games. The passages contain 179 normalized characters. The second
comparison uses all 92 unmodified Anki sentence fields as references. A poster
can show a cutscene, menu, partial subtitle, or a different dialogue line from
the mined audio. This makes the card measure useful for mining and a poor
estimate of overall OCR accuracy.

| Engine | Visible passages exact / 11 | Visible character edits | Anki sentences exact / 92 | Anki character edits |
|---|---:|---:|---:|---:|
| ScreenAI | 10 | 0.56% | 18 | 67.33% |
| MIDA detector then ScreenAI on the detected area | 11 | 0.00% | 20 | 67.33% |
| Meiki detector then ScreenAI on the detected area | 11 | 0.00% | 19 | 67.33% |
| MIDA detector then MIDA + VOCR6-L | 10 | 1.68% | 13 | 68.44% |
| MIDA + VOCR6-L | 9 | 3.91% | 13 | 70.80% |
| MeikiOCR | 8 | 2.79% | 13 | 68.00% |
| OneOCR, Windows DLL | 8 | 2.79% | 16 | 66.86% |
| OneOCR, Ubuntu | 8 | 2.79% | 16 | 67.13% |
| VOCR, Large | 7 | 19.55% | 11 | 77.65% |
| Experimental ScreenAI detector + VOCR6-L | 5 | 34.08% | 0 | 86.11% |

Both scores compare a reference to the closest substring of the recognized
page, after Unicode NFKC normalization and removing punctuation and whitespace.
The edit percentage divides total edits by total reference characters.
Unrelated UI text outside the closest match has no penalty. Geometry parity
compares the original, unnormalized results. These stills measure individual
readings. They do not measure dialogue tracking over time, false boxes on a
changing background, end-to-end capture latency, or vertical manga accuracy.
All three local two-pass presets were measured at 100% stability-pass scale.
The default ScreenAI → Google Lens preset calls an online service whose
inference hardware and latency are outside the CPU benchmark.

## What transferred from MacPopup

- MIDA finds horizontal lines. The recognizer reads the padded crops and supplies
  character geometry. GSM's CPU detector matched the reference CPU provider's
  complete box sequence on **92/92** stills, including images with no detections.
  In a separate 32-still comparison using the same MIDA detector in Python, the
  faithful large and fast large VOCR graphs produced identical text and character
  geometry. Median full-reading time fell from **50.6 to 29.6 ms**. GSM uses the
  fast large graph for this pairing. Standalone VOCR retains its selected tier.
  [MacPopup's MIDA engine](https://github.com/AuroraWright/MacPopup/blob/a7441ef660a636ad355286d69991c6f0c0a93ece/Sources/OCREngines/MidaVOCR6.swift) · [Reference CPU provider](https://github.com/rtr46/meikipop/tree/0bb61ca117667faccb485f034e5e6b1d489569c0/src/meikipop/ocr/providers/mida_vocr6) · [Pinned MIDA model](https://huggingface.co/rtr46/mida/tree/8503f1ccf4bc214b9c4710b5d19cba5ce422df83)
- MacPopup reuses recent line results. GSM now hashes every contributing pixel
  for VOCR, MIDA and native MeikiOCR. Source-coordinate results also include
  geometry and polarity where applicable. The portable OneOCR worker reuses
  script, layout and recognizer inference for identical normalized lines, and
  includes the voted language/model in its recognition key. Page voting, box
  projection, reading order and duplicate handling still run on each frame.
  [MacPopup's line cache](https://github.com/AuroraWright/MacPopup/blob/a7441ef660a636ad355286d69991c6f0c0a93ece/Sources/OCRLineCache/LineCache.swift) · [Portable OneOCR pipeline](https://github.com/AuroraWright/oneocr_reimpl/blob/f3698522a341bcbe5e61394f61e8ab3ef11efbe6/oneocr_native/pipeline.py)
- A separate local prototype paired the CPU ScreenAI detector and its line
  grouping with fast VOCR6-L. At **79 ms median / 106 ms p95** it read fewer
  visible passages than the MIDA pairing. Its grouping differs from MacPopup's
  Core ML implementation, and this prototype used no confidence post-filter.
  The published presets therefore use MIDA + VOCR6-L for speed and ScreenAI
  for accuracy. The **MIDA then ScreenAI** preset is a stability pass followed
  by full ScreenAI recognition of a crop. The benchmark used the desktop's
  second-pass crop with 20 pixels of padding and a first-pass scale of 100%.
  MIDA found candidates in 65 of the 92 stills. The other 27 only incurred
  detection. The reported time includes both passes when recognition ran.

## Reproduce

The collection's poster cache contained 1,623 stills. The sampler joined poster
filenames to Anki's Picture and Sentence fields, used seed 1711 and drew four
distinct posters per eligible title, for 92 images from 23 titles. Source sizes
were preserved. Each local release-build engine received one warm-up image,
then the same ordered PNGs decoded to RGBA before timing. Model downloads,
startup, image decoding, capture, UI and waiting for stability are excluded.
Portable OneOCR timing includes the local worker round trip. All inference used
CPU. MIDA used four detector threads and VOCR one recognizer thread.

GSM's native Linux reader ran under Ubuntu on WSL, using the upstream OneOCR
runtime, ONNX Runtime 1.32.0 and models imported locally from Snipping Tool
11.2608.41.0. The Python adapter also reproduced its result after a worker
restart. A physical Mac has yet to be tested. The local desktop build passed,
as did the targeted Python, renderer, native engine and desktop OCR tests.
The Windows screen-selector checks shared the desktop and passed when run
serially. Rerunning the sampler reproduced all 92 saved poster/reference pairs.

Use a fresh output directory and your own GSM profile. The preparation command
reads a temporary snapshot of the Anki database and its journal. The JSONL files contain your locally recognized
text and boxes. The commands below use PowerShell 7.

```powershell
$corpus = ".tmp-ocr-benchmark/anki-sample"
$profileDir = "C:/path/to/GSM-profile"
.venv/Scripts/python.exe scripts/benchmark_anki_ocr.py prepare "C:/path/to/Anki-profile" $corpus
cargo build --release --locked --manifest-path native/gsm-overlay/Cargo.toml --example ocr_corpus --target-dir src-tauri/target/native-dev
$reader = "src-tauri/target/native-dev/release/examples/ocr_corpus.exe"
foreach ($engine in "vitaocr", "mida_detector", "mida_vocr", "mida_mida_vocr", "mida_screenai", "meiki_screenai", "meikiocr", "screenai", "oneocr") {
    & $reader $engine $profileDir $corpus 2 | Out-File -Encoding utf8 "$corpus/$engine.jsonl"
    if ($LASTEXITCODE -ne 0) { throw "OCR failed for $engine" }
}
.venv/Scripts/python.exe scripts/benchmark_anki_ocr.py score $corpus (Get-ChildItem "$corpus/*.jsonl").FullName
```

To score human transcriptions, pass `--visible path/to/visible.json` to
`score`. The JSON object maps filenames such as `044.png` to the visible
passage. [Portable OneOCR setup](../NATIVE_OCR.md#portable-oneocr-setup)
