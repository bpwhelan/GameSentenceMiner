# VOCR FP16 and native INT8 on CPU — 2026-10-31

The useful candidate was native 8-bit integer matrix multiplication that retains
VOCR's original 16-bit activation precision. It matched all tested outputs and
reduced whole-image OCR latency by **3–7% versus faithful FP32 ONNX**. Existing
FP32 fast mode remained faster. Ordinary 8-bit activation quantization changed
text; FP16 variants changed character geometry and did not provide a compelling
speed improvement.

This report uses CPU-only runs on the Ryzen 7 5800X, with GSM's installed ONNX
Runtime 1.24.4 CPU package. No experimental models were installed, dependencies
or defaults replaced, or precision features integrated into GSM. All recorded
graph operations used the CPU provider.

## Main comparison

Whole-image OCR, milliseconds per image. The ONNX columns all retain the
**existing faithful FP32 CPU detector**; only recognition is replaced.

| Model | C runtime | FP32 faithful | Native INT8, original activation precision | FP32 fast |
| --- | ---: | ---: | ---: | ---: |
| Small | 78.62 | 34.84 | 33.70 | 28.72 |
| Normal | 84.36 | 41.24 | 38.45 | 31.73 |
| Large | 148.17 | 51.05 | 47.83 | 34.68 |

Recognition alone, milliseconds per cropped line, including preprocessing and
text/character decoding:

| Model | C runtime | FP32 faithful | Native INT8, original activation precision | FP32 fast |
| --- | ---: | ---: | ---: | ---: |
| Small | 12.30 | 3.82 | 3.27 | 1.47 |
| Normal | 13.77 | 5.61 | 5.06 | 2.31 |
| Large | 34.05 | 8.99 | 7.43 | 3.58 |

The native variant reduced recognition time by approximately 10–17%. Detection
and decoding limit the whole-image gain. Some pass ranges overlap, particularly
for Small and Normal; raw ranges are retained in the measurement record.

## Precision variants

| Variant | What changes | Text changes / 345 lines | Character-geometry changes / 345 | Per-frame class changes / 12,192 |
| --- | --- | ---: | ---: | ---: |
| Native INT8 with original activation precision | Exact replacement of faithful matrix operations | 0 | 0 | 0 |
| Dynamic W8A8 | Main matrix activations reduced to 8 bits | 93 | 194 | 782 |
| Calibrated INT8 QDQ | Main convolutions and matrix layers quantized to 8 bits | 50 | 108 | 269 |
| Full FP16 export | Convert the fast graph's floating-point values to FP16 | 0 | 2 | 4 |
| Mixed FP16 export | Fast graph's main convolutions/matrices converted; sensitive operations retain FP32 | 0 | 2 | 2 |
| FP16 convolutions | Faithful graph's convolution layers converted; matrix arithmetic retained | 0 | 2 | 2 |

Both original FP32 baselines matched C throughout. The exact native INT8
recognizer also matched all **36 complete OCR outputs**, including line and
character geometry. Each FP16 recognition variant changed two complete outputs
through character geometry, with unchanged text. The affected inputs were the
Small model's light/dark 26-pixel synthetic panels. Dynamic W8A8 and calibrated
INT8 changed 29 and 24 complete output records respectively.

The equality criterion is stricter than matching text: CTC frame predictions and
character positions matter for GSM's overlay. These comparisons establish
agreement on this corpus, not OCR correctness against human-labelled text or
universal bit equality.

## FP16 CPU execution and timing

Profiling showed **FP32 inputs to the executed Conv, MatMul, and Gemm kernels**
for all FP16 variants. ONNX Runtime inserted conversions to run the FP16 graphs
with available CPU kernels. These were FP16 model exports, not native FP16
compute benchmarks on this processor.

Whole-image OCR, still using the unchanged FP32 detector:

| Model | FP32 fast | Full FP16 | Mixed FP16 | FP16 convolutions in faithful model |
| --- | ---: | ---: | ---: | ---: |
| Small | 28.72 | 40.46 | 28.25 | 35.46 |
| Normal | 31.73 | 48.64 | 30.94 | 41.91 |
| Large | 34.68 | 60.64 | 34.14 | 50.74 |

Mixed FP16 was only about 1.6–2.5% faster than FP32 fast in these whole-image
measurements, with overlapping pass ranges and the character-position changes
above. Full FP16 was substantially slower. The convolution-only variant should
be compared with the faithful baseline, not fast mode.

## Detector

All variants include scaling and the same Python detector decoding.

| Detector | ms/image | Map values changed / 675,280 | Images with changed box records / 17 |
| --- | ---: | ---: | ---: |
| C runtime | 38.44 | 0 | 0 |
| Original faithful FP32 | 23.01 | 0 | 0 |
| FP16 convolutions | 23.06 | 330,283 | 11 |
| Exact native INT8 convolutions | 25.53 | 0 | 0 |

The native INT8 detector preserved all map values, box geometry, confidence,
orientation, polarity, and tags, but was about 11% slower than the existing
ONNX detector. Retaining FP32 detection was therefore the faster matching-output
choice for the recognition comparisons above.

## Technical details

- Exact native recognition retains dynamic signed 16-bit activation quantization
  and the original int8 weight codes. Two `MatMulInteger` calls per reduction
  chunk implement each activation's high/low bytes. Zero points preserve signed
  values; results are reconstructed in INT32 and scaled in FP32 using the same
  512-term chunk boundaries. Convolutions remain FP32. This preserves 16-bit
  activation information while using genuine 8-bit integer kernels.
- CPU integer kernels use unsigned byte operands with zero-point offsets
  (U8U8), avoiding the AVX2 U8S8 saturation issue described in the official
  [ONNX Runtime quantization documentation](https://onnxruntime.ai/docs/performance/model-optimizations/quantization.html#when-and-why-do-i-need-to-try-u8u8).
- Dynamic W8A8 uses 8-bit per-position activation quantization in main matrix
  layers; sensitive gate/escape calculations retain their original activation
  precision. Calibrated QDQ quantizes the main convolution and matrix layers,
  leaving the sensitive gate/escape subgraphs unchanged.
- QDQ calibration used MinMax, per-channel weight quantization, and 48 generated
  Japanese line samples (24 distinct tensors after polarity normalization),
  with different text and sizes from validation. No validation screenshots or
  crops were used for calibration. This is a limited
  calibration trial, not an exhaustive search for the best quantization scheme.
- Native detector convolutions use `ConvInteger` with INT32 accumulation and
  biases, preserving the existing FP64 fixed-point rescaling/rounding. Profiles
  confirmed actual `ConvInteger`, `MatMulInteger`, `QLinearConv`, and
  `QLinearMatMul` execution for the relevant variants.
- Six arithmetic tests cover signed extrema, zero/tiny inputs, and reduction
  dimensions 16, 511, 512, 513, 1024, and 1792. Native matrix outputs match the
  original faithful ONNX implementation exactly in those tests.

## Method and reproduction

Windows 11, Ryzen 7 5800X, Python 3.13.2, NumPy 2.2.6, ONNX 1.20.1, installed
ONNX Runtime 1.24.4 CPU wheel. One inference thread and one inter-op thread;
busy spinning disabled. C is GSM's shipped MSVC `/O2 /fp:strict` runtime at
`205f47ec4e56-1`, using the same pinned model weights as the ONNX exports.

Two full warmup passes precede nine timed passes. Backend order is shuffled with
seed 130. Tables report the median of each pass's mean milliseconds per input.
Model loading, conversion, calibration, and profiling are excluded. Profiling
uses separate sessions. The desktop remains running; this is a local comparison.

Timing uses four game captures, six synthetic panels, and two empty images,
producing 38 horizontal crops. Recognition validation adds 77 font, polarity,
size, and noise cases per model. Detector validation adds five dimension/noise
cases through 1921×1081. Images and recognized game text remain local.

The [compact measurement record](vocr-precision-cpu-2026-10-31.json) retains
timing ranges, agreement counts, hashes, and kernel/provider evidence. Local
raw results are under `temp/vocr-precision/`.

```powershell
.venv/Scripts/python.exe temp/vocr-precision/cpu_benchmark.py benchmark
.venv/Scripts/python.exe temp/vocr-precision/cpu_benchmark.py detectors
.venv/Scripts/python.exe -m pytest temp/vocr-precision/test_integer.py -q
```

The CPU entry point asserts that GSM's installed CPU runtime is loaded and
explicitly selects only `CPUExecutionProvider`. Protected source, assets,
preferences, dependency declarations, and runtime extension hashes remained
unchanged. No application restart is needed for these isolated experiments.
