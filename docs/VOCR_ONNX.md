# Bundled VOCR ONNX

Unconfigured GSM uses the bundled **FP32 faithful ONNX** versions of all three VOCR 6.2
recognizers and the textspot8 detector by default, on CPU with one inference
thread. A fresh installation works offline without either VOCR native library.
An explicitly installed, verified local native trial takes precedence in `auto`
mode when its CPU requirements are supported. Otherwise `auto` uses this bundled
ONNX fallback, preserving the selected model size. `GSM_VOCR_BACKEND=onnx` always
selects this bundle; explicitly forced `c` still refuses unsupported CPUs. See
[the native benchmark and build notes](benchmarks/vocr-native-2026-11-02.md).
The recognizer's blank-frame
gate and two-level output head are included in the exported graphs. Textspot
decoding, reading order, polarity, the structural GRAD fallback, and calibrated
CTC character cells run in Python/NumPy, adapted from the pinned upstream twins.
There is no language model in GSM's existing VOCR pipeline or this conversion.

The upstream pin remains `205f47ec4e56ca87c00e7dba0a61c9aaec726707`, release
`v0.5.0`. No model was retrained. The C backend remains available through the
explicit developer override `GSM_VOCR_BACKEND=c`; a missing or corrupt bundle
reports an error instead of downloading or silently switching to C.

## Packaging and selection

`GameSentenceMiner/assets/vocr/` contains the four verified faithful graphs,
their SHA-256 manifest, and the upstream licence and attribution files. The graphs
are unchanged from the benchmarked exports below, totalling **16,968,508 bytes**
(about 17 MB before compression). Fast, FP16, and native INT8 experiments are not
included. ONNX Runtime is already a GSM dependency; the `onnx` export library is
not needed at runtime.

Python's `package-data` includes the directory in wheels and source distributions.
Electron's existing `extraFiles` copies the same package into
`resources/GameSentenceMiner`, outside `app.asar`. The `afterPack` hook verifies
the actual copied graphs and attribution before signing or creating installers,
on every platform. Missing, extra, or corrupt graphs fail the build.

The runtime resolves these files relative to its own Python package, independent
of the working directory. It never writes into the bundle. Only the selected
Small/Normal/Large preference is stored in the user's VOCR data directory. A fresh
install uses Normal; existing selections, including older C revisions, are
preserved. Main OCR and overlay OCR use the same selection on their next scan.

Older trial exports in the user's `onnx/` directory and `GSM_VOCR_ONNX_MODE` are
no longer used by GSM. Production recognition and detection are always faithful.
`GSM_VOCR_BACKEND=auto` selects the bundle unless a local native trial was
explicitly activated; `onnx` always selects the bundled implementation.

```powershell
npm run verify:vocr-package
# The same validator can inspect an unpacked Electron build:
npm run verify:vocr-package -- dist/win-unpacked/resources/GameSentenceMiner/assets/vocr
.venv/Scripts/python.exe -m pytest tests/ocr/test_vocr_bundle.py -q
```

The offline integration tests exercise a completely empty user data directory,
both OCR wrappers, all size changes, migration, CPU provider selection, corrupt
bundles, and preservation of the old selection after failed validation.

## Measurements on 2026-10-31

AMD Ryzen 7 5800X, Windows x64, Python 3.13.2, NumPy 2.2.6, ONNX Runtime 1.24.4,
CPU provider, **one inference thread**. The baseline is the actual GSM distributed
C runtime (`205f47ec4e56-1`, MSVC `/O2 /fp:strict`), including its enabled gate and
two-level head. This is not a comparison against an unoptimized C build.

Two warmup passes precede nine timed passes, with backend order shuffled using a
fixed seed. Values below are the median of each pass's mean time per input.
Model loading, downloads, and export are excluded. The line stage includes image
preprocessing, inference, text decoding, and character geometry. Whole-image OCR
also includes desktop scaling, detection, and every detected horizontal line.

| Recognition, ms/line | C | ONNX faithful | Speedup | ONNX fast | Speedup |
| --- | ---: | ---: | ---: | ---: | ---: |
| Small | 11.34 | 3.47 | 3.26× | 1.37 | 8.28× |
| Normal | 12.83 | 5.18 | 2.48× | 2.21 | 5.80× |
| Large | 32.64 | 8.58 | 3.80× | 3.28 | 9.94× |

| Whole-image OCR, ms/image | C | ONNX faithful | Speedup | ONNX fast recognition | Speedup |
| --- | ---: | ---: | ---: | ---: | ---: |
| Small | 76.03 | 34.17 | 2.23× | 27.27 | 2.79× |
| Normal | 82.07 | 40.89 | 2.01× | 32.62 | 2.52× |
| Large | 145.45 | 51.38 | 2.83× | 35.70 | 4.07× |

Both whole-image ONNX columns use the **faithful detector**. Detection alone,
including scaling and decoding: C **37.61 ms/image**, faithful ONNX **23.90 ms**
(**1.57×**). Thus recognition reproduces or exceeds the reported 3–6× gain in fast
mode on this machine; the complete pipeline gains less because of detection.

The sample is 12 images: four local game captures (three from Steins;Gate and one
from Ace Attorney), six generated dialogue panels, and two empty images. C's
detector produced 38 horizontal line crops. This is a small local comparison,
not a representative OCR accuracy benchmark or a measurement of capture latency.

- Both recognizer modes matched C text, frame predictions, and character boxes
  on all 38 crops for each of the three models; all 12 complete outputs matched.
- Faithful detection matched all **539,744 output-map values**, every box, tag,
  orientation, confidence, and polarity in that sample.
- A separate 77-case line check per tier used three fonts, three font sizes,
  both polarities, narrow/clamped dimensions, and noise. Both recognition modes
  matched C text, frame predictions, and character boxes on all **231 cases**.
- Additional checks cover detector maps at odd dimensions through 1921×1081,
  exact C preprocessing, empty captures, and concurrent use.
- The approximate fast detector changed 12,320 map values and one image's boxes.
  It is exported for research but **GSM always selects the faithful detector**.

Agreement with C does not establish correctness against human reference text.
Faithful recognition preserves W8I activation quantization and integer matrix
sums, but optimized floating-point convolutions can round differently from C.
Neither recognizer mode is claimed to be universally bit-identical to C.

The compact results are in
[`benchmarks/vocr-onnx-2026-10-31.json`](benchmarks/vocr-onnx-2026-10-31.json).
Local raw timing and disagreement records are written under `temp/vocr-onnx/`;
game screenshots and their recognized text are not committed.

## Reproduce the bundled exports

Use GSM's `.venv`. Only the exporter needs the `onnx` package; runtime dependencies
are already provided by GSM. No PyTorch, compiler, or C runtime download is needed
to build or use the ONNX assets.

```powershell
.venv/Scripts/python.exe -m pip install -r scripts/requirements-vocr-onnx.txt
git clone https://github.com/bee-san/vita-vn-ocr ../vita-vn-ocr-onnx
git -C ../vita-vn-ocr-onnx checkout 205f47ec4e56ca87c00e7dba0a61c9aaec726707
.venv/Scripts/python.exe scripts/export_vocr_onnx.py `
  --source ../vita-vn-ocr-onnx `
  --models temp/vocr-onnx/models --download-models `
  --output temp/vocr-onnx/reproduced --modes faithful
```

This produces the four faithful graphs, a checksum manifest, upstream attribution,
and the licence. To update the checked-in bundle, compare the hashes and run the C
parity suite first, then copy those files into `GameSentenceMiner/assets/vocr/`,
retaining/updating GSM's `NOTICE.md`. Run `npm run verify:vocr-package` afterward.
Omit `--modes faithful` to also export fast graphs for research into a separate
directory; those graphs are never loaded by GSM's production factories.
The graphs use standard ONNX operators (opset 18, IR 10), dynamic image dimensions,
and embedded vocabulary/metadata. The exporter checks the upstream revision,
working tree, original model SHA-256 values, and attribution SHA-256 values.

Every graph is checksum-verified before loading. A loaded instance remains valid
while the model selection changes. The C backend and research `ONNXRuntime` /
`ONNXLineFinder` classes remain directly constructible with an explicit asset
directory for benchmarks. The exporter's legacy `--install` option only stages
assets for those external tools; it does not replace GSM's packaged models.

## Reproduce the comparison

For the C baseline, prepare the existing GSM runtime and all three original
weights in the directory supplied to `--models`. The benchmark calls the native
classes directly, bypassing GSM's automatic ONNX selection.

```powershell
.venv/Scripts/python.exe scripts/benchmark_vocr_onnx.py `
  --models temp/vocr-onnx/models --onnx temp/vocr-onnx/onnx `
  --images temp/steins-window.png temp/steins-window-restarted.png `
           temp/steins-after-enter.png temp/gpu-validation/example.jpg `
  --repeats 9 --warmup 2 --threads 1 `
  --output temp/vocr-onnx/benchmark-final.json

$env:GSM_VOCR_ONNX_TEST_MODELS = (Resolve-Path temp/vocr-onnx/models).Path
$env:GSM_VOCR_ONNX_TEST_ASSETS = (Resolve-Path temp/vocr-onnx/onnx).Path
.venv/Scripts/python.exe -m pytest tests/ocr/test_vocr_onnx.py `
  tests/ocr/test_vocr_onnx_native.py -q
```

Supply your own images and, on non-Windows systems, a Japanese font via `--font`.
The benchmark records every input's hash and dimensions, all timing samples,
map disagreements, per-line text/character/frame comparisons, and whole-image
agreement. Unit tests stay offline and skip the native parity suite unless both
asset environment variables are provided.

## Implementation and provenance

`scripts/export_vocr_onnx.py` reads the original blobs using the pinned upstream
readers. Faithful recognition implements the original per-position int16
quantization and 512-term integer accumulations. Splitting each quantized value
into base-256 digits lets float32 GEMM calculate exact integer partial sums;
integer reconstruction prevents ONNX graph fusion from changing the rounding.
Fast recognition dequantizes the stored weights and uses ordinary float32 GEMM.
Both retain the gate and two-level classifier decisions. The full head is
evaluated before masking; the gate and escape preserve behavior but currently
do not save matrix work in the ONNX graph.

Textspot's integer convolution bounds are checked to fit exactly in float32.
The faithful requantizer uses exact power-of-two fractions in float64, with
checked bounds below 2^53, preserving the original half-away-from-zero rounding.
This was faster locally than the int64-division and ConvInteger experiments.

The Python geometry modules are adapted from upstream `synth/common.py`,
`synth/textspot_twin.py`, `synth/textspot6_twin.py`, `synth/textdet_twin.py`, and
`eval/charbox.py` at the same pin. They carry GPL-3.0-or-later attribution.
Original model restrictions, including the recognizers' non-commercial use
notice, remain unchanged; the export includes the original attribution files.

Upstream: [bee-san/vita-vn-ocr](https://github.com/bee-san/vita-vn-ocr/tree/205f47ec4e56ca87c00e7dba0a61c9aaec726707).
