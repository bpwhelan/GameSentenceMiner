# VOCR CUDA experiment — 2026-10-31

CUDA runs all eight existing VOCR ONNX exports on this RTX 5070. With TF32
disabled, both recognizer modes and the faithful detector matched C and CPU
ONNX on every tested output. **It did not improve whole-image OCR speed over
CPU ONNX:** CUDA was 14–41% slower in faithful mode and 19–37% slower in fast
mode. This experiment adds no GPU support or configuration changes to GSM.

## Whole-image OCR

Milliseconds per image, including scaling, text detection, recognition of all
horizontal lines, text decoding, character geometry, and GPU transfers. Lower
is better. Both ONNX recognition modes use the faithful detector.

| Model | C | CPU faithful | CUDA faithful | CPU fast | CUDA fast |
| --- | ---: | ---: | ---: | ---: | ---: |
| Small | 81.84 | 38.43 | 54.06 | 30.41 | 37.96 |
| Normal | 83.41 | 42.03 | 55.84 | 31.64 | 43.38 |
| Large | 149.98 | 52.59 | 60.03 | 34.60 | 41.17 |

CUDA still beats C: 1.49–2.50× in faithful mode and 1.92–3.64× in fast mode.
CPU ONNX remains faster for this workload. Detector-only time, including its
CPU preprocessing and decoding, was **39.61 ms C, 23.79 ms CPU ONNX, and
22.42 ms CUDA**. The small detector gain had overlapping timing ranges and did
not offset slower recognition.

## Recognition alone

Milliseconds per cropped line, including preprocessing, inference, text
decoding, and character geometry.

| Model | C | CPU faithful | CUDA faithful | CPU fast | CUDA fast |
| --- | ---: | ---: | ---: | ---: | ---: |
| Small | 12.27 | 4.20 | 9.16 | 1.62 | 4.68 |
| Normal | 13.81 | 5.83 | 10.60 | 2.46 | 6.20 |
| Large | 32.71 | 8.46 | 10.85 | 3.59 | 5.65 |

## Output agreement

- **690 recognition comparisons:** 115 inputs × three model sizes × two modes.
  CUDA with `use_tf32=0` matched C and CPU ONNX text, every character box, and
  every per-frame class prediction: **24,384 frame predictions, zero changes**.
  The 115 inputs comprise 38 detected crops and 77 font, polarity, size, and
  noise stress cases. The CPU ONNX baselines also matched C.
- **72 complete OCR comparisons:** 12 images × three sizes × two modes.
  Every complete CUDA result matched C, including line and character geometry.
- **Faithful detector:** 17 images, including five odd/small/noisy dimension
  cases through 1921×1081. All **675,280 map values** and all final box records
  matched both C and CPU ONNX, including confidence, polarity, tag, and
  orientation.
- **Default CUDA precision:** with `use_tf32=1`, Small/fast changed two frame
  predictions and two cases' character geometry. Text stayed the same. The
  affected cases were the light and dark 26-pixel synthetic panels. The other
  five recognition configurations and the faithful detector had no observed
  changes. These settings are excluded from the primary timing tables.
- **Approximate fast detector:** CUDA matched CPU ONNX exactly on all 12
  benchmark images, but both differed from C on 12,320 of 539,744 map values
  and one image's boxes. This is the existing fast export's approximation,
  also found in the CPU trial. It is not used by GSM or the pipeline tables.

ONNX Runtime enables TF32 by default; it permits reduced-precision float32
matrix multiplication and convolution. Disabling it is appropriate when
testing matching-output behavior. See the official
[CUDA provider documentation](https://onnxruntime.ai/docs/execution-providers/CUDA-ExecutionProvider.html#use_tf32).

These are agreement checks against existing implementations, not a human-labelled
OCR accuracy evaluation. A small corpus cannot establish universal bit equality.

## Execution and method

- AMD Ryzen 7 5800X, NVIDIA RTX 5070, driver 617.14, Windows 11, Python 3.13.2,
  NumPy 2.2.6, ONNX Runtime GPU 1.24.4, system CUDA 12.9 and cuDNN 9.27.
- All CPU and CUDA ONNX timings use the same isolated ONNX Runtime GPU build,
  with the CPU provider explicitly selected for CPU measurements. One CPU
  inference thread, one inter-op thread, and no busy spinning. GSM's installed
  CPU-only ONNX Runtime package was not replaced.
- C baseline: GSM's shipped `205f47ec4e56-1` native libraries, built with MSVC
  `/O2 /fp:strict`. Model revision
  `205f47ec4e56ca87c00e7dba0a61c9aaec726707`, unchanged ONNX model hashes.
- CUDA options: `use_tf32=0`, `cudnn_conv_algo_search=EXHAUSTIVE`, a 2 GiB arena
  limit per session, otherwise defaults. No FP16 conversion, TensorRT, batching,
  CUDA Graph capture, or I/O-binding optimization. Each inference returns CPU
  arrays synchronously; transfer time is included.
- Two complete warmup passes and nine timed passes per stage, backend order
  shuffled with seed 130. Tables report the median of each pass's mean time per
  input. Loading, convolution algorithm search, and profiling are excluded.
  Initial CUDA warmup took several seconds in the separate smoke test.
- Timing corpus: four local game captures, six synthetic dialogue panels, and
  two empty images; 38 horizontal recognition crops. Same corpus as the CPU
  trial, with C and CPU ONNX remeasured alongside CUDA.
- All eight graphs were profiled separately. **All recorded computation nodes
  ran on CUDA, with no CPU graph-node fallback.** Python preprocessing and
  decoding still run on CPU. Recognition graphs execute 72–498 graph nodes per
  line depending on size and mode; launch overhead is a plausible contributor
  to these results, not a measured allocation of total time.
- The desktop remained running. Before the main test, GPU memory use was about
  5.24 GiB and reported utilization was 7%; this was not an idle-machine lab
  benchmark. Raw pass ranges are retained to show variability.

## Artifacts and reproduction

The [compact measurement record](vocr-onnx-gpu-2026-10-31.json) contains timing
ranges, agreement counts, model/input hashes, CUDA kernel counts, and local
artifact hashes. Local detailed results and profiles are under
`temp/vocr-onnx-gpu/`; game captures and recognized text remain local.

The isolated harness uses the existing GPU wheel under
`temp/gpu-validation/onnxruntime/`, local model exports under
`temp/vocr-onnx/onnx/`, and C assets under `temp/vocr-onnx/models/`:

```powershell
.venv/Scripts/python.exe temp/vocr-onnx-gpu/benchmark.py --stage benchmark
.venv/Scripts/python.exe temp/vocr-onnx-gpu/benchmark.py --stage inspect
```

Both runs verified unchanged hashes for OCR source files, installed VOCR
assets/model selection, GPU preferences, dependency declarations, and the
installed ONNX Runtime extension. Ruff passed. GSM still selects CPU ONNX and
defaults to faithful recognition; no app restart was requested.
