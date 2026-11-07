# VOCR 6.2 and textspot8: ONNX conversion and CPU precision findings

**Measured:** 2026-10-31

**Upstream:** [bee-san/vita-vn-ocr, revision 205f47ec4e56ca87c00e7dba0a61c9aaec726707](https://github.com/bee-san/vita-vn-ocr/tree/205f47ec4e56ca87c00e7dba0a61c9aaec726707), release `v0.5.0`
**Purpose:** Findings for the VOCR author, including conversion mechanics, performance, output agreement, unsuccessful precision changes, and useful follow-up work. This report covers CPU execution.

## Main findings

The ONNX conversion produced a substantial CPU speedup with the existing weights and no retraining. The conservative, faithful implementation was approximately **2–3× faster for the complete detection-and-recognition pipeline** on this machine. Recognition alone improved by approximately **2.5–3.8×**. The simpler fast recognizer was faster again, while matching every tested recognition output, but it changes the arithmetic and has a weaker preservation argument.

| Approach | Measured outcome | Output agreement with the C baseline |
| --- | --- | --- |
| Faithful FP32 ONNX recognition + faithful detector | About 2–3× faster complete OCR | All tested text, frame predictions, character boxes, and detector maps/box records matched |
| Fast FP32 recognition + faithful detector | About 2.5–4.3× faster complete OCR across the two runs | All tested recognition outputs matched; arithmetic is approximate relative to the C W8I path |
| Native byte-integer recognition preserving the original 16-bit activations | A further 10–17% reduction in recognition time and 3.3–6.8% in complete OCR time relative to faithful FP32 in the precision run | All tested outputs matched |
| Dynamic W8A8 recognition | Faster than faithful FP32, slower than fast FP32 in this run | Changed text on 93/345 model/input pairs |
| Calibrated INT8 QDQ recognition | Timings near fast FP32 | Changed text on 50/345 model/input pairs |
| FP16 recognition exports | No compelling matching-output improvement on this CPU | Text matched, but character geometry changed; executed heavy kernels used FP32 |
| Native INT8 detector | About 11% slower than the faithful FP32 detector | All tested maps and box records matched |
| FP16 detector convolutions | Essentially unchanged latency | Changed 330,283/675,280 map values and box records on 11/17 images |

The strongest upstream candidates are the faithful ONNX conversion and, as a separate optimization, the byte-decomposed native integer recognizer. Straightforward 8-bit activation quantization and FP16 conversion did not satisfy the tested output-preservation requirement.

“Matched” throughout this report means agreement on the stated test corpus. It does not establish universal bit equality or OCR correctness against human-labelled reference text.

## What was converted

The following original weight files were used unchanged:

| Component | Original file | Vocabulary entries | Enabled head features |
| --- | --- | ---: | --- |
| Small recognizer | `VOCR6.2_S_w8.vocr` | 4,987 | Neither gate nor two-level head |
| Normal recognizer | `VOCR6.2_N_w8g2.vocr` | 5,631 | Blank-frame gate and two-level head |
| Large recognizer | `VOCR6.2_L_w8_2l.vocr` | 5,631 | Two-level head |
| Detector | `textspot8_t64n8c16_w8.vtsp` | — | VTSP v4, textspot8 trunk |

Both faithful and fast recognizer graphs include the gate/escape decisions where applicable. The conversion reads the pinned upstream blob formats directly using the upstream readers. It does not reconstruct the models through PyTorch or retrain/recalibrate the baseline exports.

The exports use standard ONNX operators, **opset 18 and IR version 10**. No custom operator library is needed. Vocabulary, source-weight hash, model revision, mode, and decoding parameters are embedded as model metadata. A separate manifest hashes each exported graph.

The conversion is a complete usable OCR pipeline, but it is **not a single ONNX graph from an arbitrary screenshot to text and boxes**. The boundary is:

| Stage | Implementation |
| --- | --- |
| Screenshot scaling, integer grayscale, detector half-scale preprocessing | Python/NumPy/Pillow |
| textspot8 neural network | ONNX |
| Head-to-map rearrangement, line decoding, ordering, polarity, tags, structural GRAD fallback | Python/NumPy, adapted from upstream |
| Recognition resizing, inversion, stride padding, normalization | Python/NumPy/OpenCV |
| Recognition network, gate, two-level head, frame argmax | ONNX |
| CTC collapse, text assembly, calibrated character cells and ink geometry | Python/NumPy, adapted from upstream |

The recognizer accepts float32 NCHW input `[1, 1, 32, width]` with dynamic width, stride 8, and the pinned 1024-pixel width limit. Its exported output is the int64 per-frame best-class sequence. The detector accepts float32 NCHW input with dynamic spatial dimensions and returns its head tensor; host code rearranges and decodes the maps.

There is no language model in the pipeline evaluated here. Vertical detector flags are compared, but complete OCR recognizes horizontal lines; these results are not a vertical-text recognition evaluation.

## What “faithful FP32” actually means

The original weights are already stored in 8-bit form. Calling an export “FP32” describes its main execution path, not the precision of the source weight file. Also, “faithful FP32” is shorthand: the graph deliberately includes integer operations, and the detector uses float64 for one sensitive rescaling step.

### Faithful recognizer: retain W8I behavior using FP32 GEMM

For each activation vector, the conversion preserves the original dynamic signed 16-bit quantization:

```text
m = max(abs(x))
s_x = m / 32767
q = clip(round_half_away_from_zero(x * 32767 / m), -32767, 32767)
```

Zero vectors use a safe denominator while retaining a zero output scale. This is not an ONNX `Round` substitution: the sign/floor construction explicitly preserves half-away-from-zero rounding.

A direct float32 dot product of `q16` and the original signed 8-bit weight codes can exceed float32's exact integer range. The faithful graph instead splits each activation into signed base-256 digits:

```text
h = trunc(q / 256)
l = q - 256*h
q*w = 256*(h*w) + l*w
```

Each reduction is split at the C implementation's **512-term boundaries**. For the larger digit, the absolute-sum bound is:

```text
512 * 255 * 127 = 16,581,120 < 2^24
```

This keeps each partial integer dot product exactly representable in float32, including intermediate reductions. The two partial results are cast to INT32, reconstructed as `256*hi + lo`, and then converted to float32. The graph adds chunk results in order, applies the original activation and per-output weight scales, and adds bias.

The INT32 reconstruction is significant. Leaving the reconstruction as float32 multiply/add allowed an ONNX Runtime matrix/add fusion to change the intended rounding boundary. Explicit integer casts prevent that fusion across the reconstruction and reproduce the integer-to-float conversion point.

The standard float convolutions still use optimized floating-point kernels, so preserving this matrix arithmetic does not prove every internal tensor is universally bit-identical to the C implementation. The demonstrated claim is exact preservation of these bounded integer subcomputations, plus agreement of tested observable outputs.

### Fast recognizer: dequantized FP32 matrix operations

Fast mode dequantizes the stored weight codes with their scales and uses ordinary FP32 matrix multiplication for the main matrix layers. It omits the main W8I activation quantization and byte decomposition.

Sensitive gate and escape subgraphs retain faithful matrix arithmetic. Their small scalar scoring reductions also preserve ordered additions, since threshold decisions can be close. “Fast” therefore does not mean every part of the graph has been replaced by unrestricted floating-point arithmetic.

An implementation limitation remains in both modes: the full classifier head is evaluated before outputs are masked by the gate/two-level logic. The decisions are preserved, but the current ONNX graph does not obtain the C implementation's potential savings from skipping that matrix work. This is an optimization opportunity, not a measured speedup in this report.

### Faithful detector: integer-exact float convolution plus FP64 requantization

textspot8's activations and weight codes are integer-valued. The exporter checks a per-output-channel bound:

```text
128 * sum(abs(weights)) + abs(bias) < 2^24
```

For these pinned weights, this allows float32 convolution to represent the integer sums exactly. Requantization is more sensitive: the result is multiplied by the original fixed-point multiplier divided by a power of two, rounded half away from zero, and clipped to the signed 8-bit or ReLU range.

The faithful export performs this rescaling in float64. The exporter checks the corresponding integer-product-and-rounding bound below `2^53`; the power-of-two fraction is representable exactly. Results are then converted back to float32. This avoids a per-cell broadcast INT64 division while retaining the original fixed-point rounding behavior.

The fast detector uses float32 for the rescaling as well. It changed output maps and a final box record in testing, without a useful latency advantage. There was no reason to pair it with the fast recognizer: all complete-pipeline comparisons use the faithful detector.

## Benchmark setup and interpretation

| Item | Configuration |
| --- | --- |
| CPU | AMD Ryzen 7 5800X |
| OS | Windows 11, build 10.0.26300 |
| Python / NumPy | 3.13.2 / 2.2.6 |
| ONNX export library | 1.20.1 |
| ONNX Runtime | 1.24.4, CPU wheel |
| Execution provider | Explicitly `CPUExecutionProvider` |
| Threads | One intra-op and one inter-op thread; intra-op busy spinning disabled |
| C baseline | Distributed VOCR runtime build `205f47ec4e56-1`, MSVC `/O2 /fp:strict` |
| Warmup / measurement | Two complete warmup passes, then nine timed passes |
| Ordering | Backend order shuffled per pass, seed 130 |
| Statistic | Median across the nine per-pass mean milliseconds per input |

Each backend is timed sequentially on the same inputs. Profiling uses separate sessions and is excluded from timing. Model loading, graph export, downloads, calibration, and application startup are excluded. The desktop remained running; CPU affinity, power-state controls, and an otherwise idle machine were not established as laboratory conditions.

**Timing corpus:** four local game captures, six synthetic Japanese dialogue panels, and two blank images. Three game captures are from Steins;Gate and one from Ace Attorney, so the real-image sample is small and correlated. The C detector supplies **38 horizontal crops** for recognition-only timing, ensuring recognizers receive the same regions.

Recognition timing includes preprocessing, inference, CTC/text decoding, and character geometry. Complete-image timing includes screenshot scaling, detection and its decoding, then recognition of every accepted horizontal line. It is not screenshot-capture latency, application event latency, or neural-kernel-only time. The complete-image average includes the two blank images; it is not the latency of a fixed number of dialogue lines.

The initial conversion and later precision study are **separate runs**. Each has its own freshly measured C and FP32 baselines. Their numbers should not be combined to calculate a cross-run speedup. The min/max ranges below are ranges of per-pass means, not confidence intervals or individual-image latency percentiles.

The motivating third-party claim compared C builds at `-O2` and `-O3 -march=native`. This study uses the actual distributed Windows MSVC build described above. It supports a substantial ONNX speedup on this workload, but does not reproduce that exact compiler comparison or establish a speedup over every possible optimized upstream C build.

## Initial conversion results

**Recognition, milliseconds per line:**

| Model | C | Faithful FP32 | Speedup vs C | Fast FP32 | Speedup vs C |
| --- | ---: | ---: | ---: | ---: | ---: |
| Small | 11.34 | 3.47 | 3.26× | 1.37 | 8.28× |
| Normal | 12.83 | 5.18 | 2.48× | 2.21 | 5.80× |
| Large | 32.64 | 8.58 | 3.80× | 3.28 | 9.94× |

**Complete OCR, milliseconds per image; both ONNX modes use faithful detection:**

| Model | C | Faithful FP32 | Speedup vs C | Fast FP32 | Speedup vs C |
| --- | ---: | ---: | ---: | ---: | ---: |
| Small | 76.03 | 34.17 | 2.23× | 27.27 | 2.79× |
| Normal | 82.07 | 40.89 | 2.01× | 32.62 | 2.52× |
| Large | 145.45 | 51.38 | 2.83× | 35.70 | 4.07× |

Detector-only time, including scaling and decoding, was **37.61 ms C**, **23.90 ms faithful ONNX**, and **24.11 ms fast ONNX**. Faithful detection was **1.57× faster than C**. The much smaller detector gain helps explain why complete-pipeline speedup is lower than recognition speedup; these timings do not separately attribute detector inference and Python decoding costs.

On the 12 benchmark images, faithful detection matched all **539,744 map values** and every final box record. Fast detection changed **12,320 map values**, and one image's final box records differed. Both recognizer modes matched C on all 38 crops for each tier, and on all 36 complete model/image outputs per mode.

## Expanded agreement checks

The later precision study evaluated **115 recognition inputs per tier**: the 38 detector crops plus 77 additional line cases. Across three tiers this is **345 model/input pairs** and **12,192 per-frame predictions for each candidate**.

The 77 additional cases contain:

- Four Japanese strings rendered with MS Gothic, MS Mincho, and Meiryo, at sizes 16, 26, and 40, in both polarities: 72 cases.
- Five random-image edge cases with dimensions 1×1, 7×33, 641×31, 1027×32, and 2049×19, exercising narrow, odd, and width-clamped inputs.

Checks compare text, the complete character records, and every per-frame argmax class. Complete OCR compares line/character output records. Detector checks compare maps and full box records, including geometry, confidence, orientation, polarity, and tags.

Detector validation expands to **17 images and 675,280 map values**, adding random inputs sized 1×1, 17×9, 321×119, 960×544, and 1921×1081. Dimensions refer to the input before desktop scaling. Separate tests also exercise exact C preprocessing, empty images, shared-runtime concurrency, palette-image handling, structural fallback, and invalid capture bounds.

| Recognizer candidate | Text disagreements / 345 | Character-record disagreements / 345 | Frame disagreements / 12,192 | Complete-output disagreements / 36 |
| --- | ---: | ---: | ---: | ---: |
| Faithful FP32 | 0 | 0 | 0 | 0 |
| Fast FP32 | 0 | 0 | 0 | 0 |
| Native INT8, original activation precision | 0 | 0 | 0 | 0 |
| Dynamic W8A8 | 93 | 194 | 782 | 29 |
| Calibrated INT8 QDQ | 50 | 108 | 269 | 24 |
| Full FP16 | 0 | 2 | 4 | 2 |
| Mixed FP16 | 0 | 2 | 2 | 2 |
| FP16 convolutions in faithful recognizer | 0 | 2 | 2 | 2 |

Character-record disagreements are case counts, not counts of individual wrong characters. When text changes, the associated character records can also change. Complete-output disagreements include geometry-only changes. Dynamic W8A8 changed complete-image text in **22/36** cases, and calibrated QDQ in **13/36**.

The FP16 recognition differences occurred on the Small model's light and dark 26-pixel synthetic dialogue panels. CTC text remained the same while frame assignments and character-cell geometry changed. Text-only comparison would have missed those regressions.

## Native INT8 while preserving 16-bit activation information

This experiment does **not** reduce the original W8I activation precision to eight bits. It uses genuine byte-integer kernels to compute the existing q16-by-w8 arithmetic.

For a quantized activation `q` in `[-32767, 32767]`, form unsigned bytes:

```text
u = q + 32768
H = floor(u / 256)      # UINT8
L = u - 256*H           # UINT8
W = w + 128             # UINT8 representation of signed weight codes

q = 256*(H - 128) + L
```

For each original reduction chunk, two ONNX `MatMulInteger` calls compute:

```text
hi = MatMulInteger(H, W, a_zero_point=128, b_zero_point=128)
lo = MatMulInteger(L, W, a_zero_point=0,   b_zero_point=128)
sum_int32 = 256*hi + lo
```

The result is converted to FP32 at the same chunk boundary as the faithful graph, then accumulated/scaled/bias-adjusted in the same order. Recognition convolutions remain FP32. This is a mixed implementation using exact native byte-integer matrix kernels, not an entirely INT8 network.

`MatMulInteger` has 8-bit input types, input zero points, and INT32 output, which supplies the needed primitive. The byte decomposition retains the original activation information. [ONNX operator definition](https://onnx.ai/onnx/operators/onnx__MatMulInteger.html).

The CPU experiment uses **U8U8 with offsets**. This avoids the U8S8 intermediate saturation issue documented for some AVX2/AVX512 kernels; it is not an assertion that a particular mismatch observed here was caused by saturation. [ONNX Runtime quantization guidance](https://onnxruntime.ai/docs/performance/model-optimizations/quantization.html#when-and-why-do-i-need-to-try-u8u8).

Six arithmetic tests cover reduction dimensions **16, 511, 512, 513, 1024, and 1792**, including zero vectors, tiny values, alternating signed activation extrema, and extreme signed weights. The native matrix results were exactly equal to the existing faithful matrix implementation in those tests. Profiles confirmed execution of actual `MatMulInteger` kernels.

In the precision run, recognition latency reductions relative to faithful FP32 were **14.5% Small**, **9.8% Normal**, and **17.4% Large**. Complete-pipeline reductions were **3.3%, 6.8%, and 6.3%**, respectively. Some pass ranges overlap, so these are observed local median improvements rather than confidence-qualified guarantees. Fast FP32 remained faster than this exact native variant for all three tiers.

The equivalent detector experiment replaced convolutions with `ConvInteger`, retaining INT32 sums/biases and the existing faithful rescaling. Its maps and boxes matched, but latency increased. Integer operators therefore did not provide a uniform benefit across components. [ONNX ConvInteger definition](https://onnx.ai/onnx/operators/onnx__ConvInteger.html).

## FP16 and ordinary INT8 experiments

### FP16 policies and what actually executed

Three recognizer policies were tested:

| Policy | Starting graph | Conversion |
| --- | --- | --- |
| Full FP16 | Fast FP32 | Generic float-to-float16 conversion, retaining external input/output types |
| Mixed FP16 | Fast FP32 | Main convolutions and dequantized matrix operations converted; sensitive arithmetic stays FP32 |
| FP16 convolutions | Faithful FP32 | Convolutions converted; faithful matrix arithmetic retained |

The mixed conversion uses explicit boundaries. This avoids unintended half-precision round trips between adjacent nodes that were meant to remain FP32 in the faithful arithmetic.

Profiles showed **FP32 inputs to the executed Conv, MatMul, and Gemm kernels** for these FP16 variants on this CPU/runtime. The models ran through conversions and available FP32 CPU kernels. These results concern FP16 model exports on this platform; they are not a measurement of native FP16 arithmetic throughput. ONNX Runtime's documentation also distinguishes float16 conversion from execution support. [Float16 and mixed-precision documentation](https://onnxruntime.ai/docs/performance/model-optimizations/float16.html).

Full FP16 was substantially slower than fast FP32. Mixed FP16 lowered complete-image medians by roughly 1.6–2.5%, with overlapping ranges and the geometry disagreements above. The convolution-only variant was close to faithful FP32, without consistently better timing or identical geometry.

### Dynamic W8A8

This variant quantizes the main matrix activations to signed eight-bit values using a per-position maximum, while retaining faithful gate/escape calculations. It is a genuine reduction from the original 16-bit activation information. It ran with native integer kernels, but changed text substantially and remained slower than the fast FP32 alternative in this run.

### Calibrated INT8 QDQ

The static experiment quantized the main convolutions and matrices, keeping sensitive gate/escape subgraphs unchanged. Calibration used **MinMax, per-channel weights, and 48 generated Japanese line samples**, representing 24 distinct tensors after polarity normalization. Calibration text and font sizes differed from validation; no validation screenshots or crops were used for calibration.

Profiles showed `QLinearConv` and `QLinearMatMul` execution after runtime optimization. Timing was close to fast FP32, but text and geometry differed from C. This was one limited calibration trial, not a broad search over calibration datasets, quantization methods, layer exclusions, or quantization-aware training. It does not establish that all possible W8A8 models will perform poorly.

## Complete CPU precision timings

Every cell is **median [minimum, maximum]**, in milliseconds, over the nine per-pass means. These are all from the same precision study. All complete-OCR candidates below use the unchanged faithful FP32 detector so recognition changes can be compared directly.

**Recognition per cropped line:**

| Candidate | Small | Normal | Large |
| --- | ---: | ---: | ---: |
| C | 12.30 [11.32, 12.50] | 13.77 [12.95, 14.46] | 34.05 [33.41, 39.44] |
| Faithful FP32 | 3.82 [3.56, 4.16] | 5.61 [5.31, 5.97] | 8.99 [8.52, 9.45] |
| Fast FP32 | 1.47 [1.33, 1.62] | 2.31 [2.14, 2.46] | 3.58 [3.25, 4.05] |
| Native INT8, original activation precision | 3.27 [3.13, 3.66] | 5.06 [4.81, 5.51] | 7.43 [7.05, 8.12] |
| Dynamic W8A8 | 2.63 [2.37, 3.15] | 3.77 [3.55, 3.99] | 5.70 [5.16, 6.69] |
| Calibrated INT8 QDQ | 1.57 [1.45, 1.96] | 2.38 [2.25, 3.01] | 3.22 [3.03, 3.92] |
| Full FP16 | 5.37 [4.92, 5.65] | 8.01 [7.62, 8.66] | 11.52 [10.98, 12.80] |
| Mixed FP16 | 1.43 [1.35, 1.70] | 2.17 [2.10, 2.59] | 3.47 [3.30, 4.30] |
| FP16 convolutions in faithful model | 3.72 [3.50, 3.86] | 5.41 [5.20, 6.15] | 9.09 [8.39, 10.14] |

**Complete OCR per image:**

| Candidate | Small | Normal | Large |
| --- | ---: | ---: | ---: |
| C | 78.62 [77.12, 83.32] | 84.36 [81.66, 85.86] | 148.17 [146.22, 181.35] |
| Faithful FP32 | 34.84 [33.66, 40.86] | 41.24 [40.05, 45.17] | 51.05 [49.69, 53.45] |
| Fast FP32 | 28.72 [26.43, 32.00] | 31.73 [29.78, 32.66] | 34.68 [33.10, 35.86] |
| Native INT8, original activation precision | 33.70 [32.93, 35.56] | 38.45 [38.23, 42.75] | 47.83 [44.13, 48.79] |
| Dynamic W8A8 | 32.09 [29.80, 38.58] | 36.82 [34.51, 38.95] | 41.21 [38.57, 43.25] |
| Calibrated INT8 QDQ | 27.93 [26.58, 28.99] | 31.48 [30.57, 33.90] | 34.24 [32.46, 41.18] |
| Full FP16 | 40.46 [38.33, 45.66] | 48.64 [47.37, 50.84] | 60.64 [58.53, 66.52] |
| Mixed FP16 | 28.25 [27.17, 30.92] | 30.94 [29.65, 32.36] | 34.14 [32.96, 43.20] |
| FP16 convolutions in faithful model | 35.46 [34.14, 38.91] | 41.91 [40.50, 44.20] | 50.74 [48.82, 52.15] |

**Detector variants, including scaling and decoding:**

| Candidate | ms/image, median [min, max] | Map differences / 675,280 | Images with differing box records / 17 |
| --- | ---: | ---: | ---: |
| C | 38.44 [37.51, 39.55] | Reference | Reference |
| Faithful FP32 | 23.01 [21.80, 24.23] | 0 | 0 |
| FP16 convolutions | 23.06 [22.07, 25.15] | 330,283 | 11 |
| Exact native INT8 convolutions | 25.53 [24.84, 27.72] | 0 | 0 |

Detector timing still uses the 12-image timing corpus; the 17-image set is the expanded agreement corpus.

## Export size and deployment observations

| Export | Bytes | Graph nodes before runtime optimization |
| --- | ---: | ---: |
| Small faithful | 2,983,204 | 387 |
| Small fast | 2,936,291 | 79 |
| Normal faithful | 4,391,905 | 558 |
| Normal fast | 4,339,856 | 250 |
| Large faithful | 9,400,009 | 516 |
| Large fast | 9,338,604 | 168 |
| textspot8 faithful | 193,390 | 221 |
| textspot8 fast | 186,466 | 177 |

Node counts describe the serialized graphs, not executed kernel counts or a performance model. Each recognizer has nine Conv nodes; textspot8 has 22. The larger faithful graphs reflect the quantization/decomposition machinery and, for Normal/Large, preserved head decisions.

The four faithful files total **16,968,508 bytes**. In the built Python wheel, their compressed members total **6,419,286 bytes**; that excludes notices, runtime dependencies, and the rest of the application. Disk size is not peak RAM use, and this study did not measure resident memory or cold-load latency.

The runtime needs ONNX Runtime, NumPy, OpenCV, and Pillow, but not the upstream checkout, PyTorch, the `onnx` exporter package, a compiler, or the VOCR C libraries. The upstream readers are export-time dependencies only.

As a deployment check, all three faithful recognizers and textspot8 were bundled as ordinary package data, with SHA-256 verification before load. Both a built Windows Python wheel and the Python resources copied into an unpacked Electron app successfully recognized two Japanese lines with each tier, using only the CPU provider, with network access through the download path forbidden and an empty model-data directory. Fresh-use and model-switching tests also passed. macOS/Linux package destination logic was tested, but inference and timing in this report were measured on Windows only.

The model attribution files and upstream GPL notice were preserved. The original recognizer and detector notices specify non-commercial use restrictions; conversion did not remove or change those notices.

## Limits and recommended upstream follow-up

The current evidence supports a useful implementation option, with several boundaries:

- **Small evaluation set.** Four game captures and synthetic/noise cases cannot represent VOCR's full deployment distribution. Three captures come from one game. The author's held-out evaluation corpus would be a much stronger next test.
- **Agreement rather than recognition accuracy.** C was the reference. No aggregate CER/WER against human reference text was measured; a candidate disagreement is not automatically an OCR accuracy loss, though it violates the preservation requirement.
- **Observable-output comparison.** Recognition checks cover best classes, text, and character geometry. The exported graph does not expose full logits, and this is not a layer-by-layer or all-logits equality proof. Gate decisions are implemented but were not separately reported as a confusion matrix.
- **One CPU/runtime/OS configuration.** Native integer and FP16 behavior can change with CPU architecture and execution-provider kernels. The observed rankings should be rechecked on the author's target CPUs, including lower-power systems and ARM.
- **Warm latency only.** No startup, session creation, cold caches, peak memory, energy, multithread scaling, or batched-throughput conclusions follow from these measurements.
- **Compiler scope.** The C baseline is the specified shipped MSVC build. Re-run the author's best available native build alongside ONNX on the same machine and corpus before attributing the entire speedup to the interchange format.
- **Limited quantization search.** QDQ calibration was small, and no quantization-aware retraining was attempted. The unsuccessful W8A8 result does not rule out a separately trained or more carefully calibrated model.

The most useful next steps would be to run faithful and fast exports over the upstream held-out corpus, add intermediate/logit and gate-decision diagnostics for any disagreements, and evaluate the exact native byte-decomposition on other CPUs. For optimization, measuring the detector's inference-versus-decoding split and investigating a head implementation that actually skips gated work are concrete targets. Keeping the existing C preprocessing/geometry while replacing neural inference is another integration design worth measuring; that hybrid was not benchmarked here.

## Reproduction and evidence map

The report is self-contained for reading. The following companion paths refer to the GameSentenceMiner working tree containing the implementation; they should not be assumed to exist in upstream VOCR or to have been published remotely.

| Artifact | Purpose |
| --- | --- |
| `scripts/export_vocr_onnx.py` | Baseline faithful/fast exports from pinned original blobs |
| `scripts/benchmark_vocr_onnx.py` | C/ONNX timing, preprocessing checks, maps, frames, text and geometry comparison |
| `GameSentenceMiner/ocr/vocr_onnx.py` | ONNX sessions, preprocessing, runtime, metadata/checksum validation |
| `GameSentenceMiner/ocr/vocr_onnx_decode.py` | Detector map decoding and structural fallback |
| `GameSentenceMiner/ocr/vocr_onnx_charbox.py` | CTC character-cell and ink geometry |
| `tests/ocr/test_vocr_onnx.py` | Portable arithmetic/preprocessing and behavior tests |
| `tests/ocr/test_vocr_onnx_native.py` | Opt-in C parity and stress cases |
| `tests/ocr/test_vocr_bundle.py` | Offline package, migration, model-switching and corruption checks |
| `docs/benchmarks/vocr-onnx-2026-10-31.json` | Initial timing/validation summary, model and input hashes |
| `docs/benchmarks/vocr-precision-cpu-2026-10-31.json` | Precision timings/ranges, agreement counts, calibration and executed-kernel evidence |
| `temp/vocr-precision/experiment.py`, `cpu_benchmark.py`, `test_integer.py` | Local experimental conversion/harness/arithmetic tests; not production dependencies |

The local precision harness depends on other local experiment helpers and corpus paths; these three temporary files alone are not a standalone reproducibility package. The measurement JSON records their hashes. Private game captures and recognized game dialogue are not included in this report. Exact reruns of the original numbers therefore require the original local corpus; replacement images provide a new benchmark, not an exact reproduction.

To reproduce the baseline conversion from the GSM tree, use an environment with its runtime dependencies and `onnx==1.20.1`, then check out the pinned upstream source:

```sh
git clone https://github.com/bee-san/vita-vn-ocr ../vita-vn-ocr-onnx
git -C ../vita-vn-ocr-onnx checkout 205f47ec4e56ca87c00e7dba0a61c9aaec726707
python scripts/export_vocr_onnx.py --source ../vita-vn-ocr-onnx --models work/vocr-native --download-models --output work/vocr-onnx
```

The exporter defaults to both modes. Add `--modes faithful` to export only the four faithful graphs. It verifies source revision, relevant tracked source changes, original weight hashes, and attribution hashes. Use a clean output directory so old graph files do not remain beside a newly generated manifest.

Prepare a matching native baseline separately. In the GSM tree, the pinned prebuilt runtime can be prepared without a local C compiler using:

```sh
python -c "from GameSentenceMiner.ocr.vocr_runtime import ensure_installation; [ensure_installation('work/vocr-native', model=t, backend='c') for t in ('small', 'normal', 'large')]"
```

Run the comparison with your own images and Japanese font:

```sh
python scripts/benchmark_vocr_onnx.py --models work/vocr-native --onnx work/vocr-onnx --images capture1.png capture2.png --font /path/to/JapaneseFont.ttf --repeats 9 --warmup 2 --threads 1 --output work/vocr-results.json
```

The native parity pytest module is opt-in through `GSM_VOCR_ONNX_TEST_MODELS` and `GSM_VOCR_ONNX_TEST_ASSETS`. Its current 77-case generator expects the named Windows Japanese fonts; adapting the font set on another platform changes that test corpus. The benchmark itself accepts a font path.

## Pinned hashes

Original input weights:

```text
VOCR6.2_S_w8.vocr
  864bbd196d5bc5d3a7bd7918cf7274b3503dfe65d440017ef0781ea7e7ba37d2
VOCR6.2_N_w8g2.vocr
  107cf084cc0c1a3a61ce4c3f9b9cf6b31d6dff80f0a1bdb94afd3f7ee9ae3bc9
VOCR6.2_L_w8_2l.vocr
  65310013e8f990886e4e8097b2fe55eb98cdf082d7193eea510601fc0ac26c82
textspot8_t64n8c16_w8.vtsp
  e129d41adfa02c658a7d13d6f98064e6ab6ce9a2bc8c7a56da700a21357b5e1c
```

Faithful graph files used for the baseline and subsequently bundled:

```text
small-faithful.onnx
  b8a7207d8323c9468833676fdf09199bf793644b126db9038862d2d7b41ee36e
normal-faithful.onnx
  8e067c0e2ea895813367d84f492a268618ef2885dc01c536e95ef90ede28c9ac
large-faithful.onnx
  b67831a53fef77510d931fb00f4b05bd0b4ee588692cf1f4ca2da695c04eb0a2
textspot8-faithful.onnx
  030c4a7441b5bd92cb0812a86cb00ada19ee0cade8b48af602552fc8fcb9ed28
```

The companion measurement records also contain fast-graph and experimental-graph hashes. The precision experiments did not modify the baseline graphs. The implementation ultimately selected the faithful FP32 recognizers and faithful detector as its default; native integer and FP16 variants remain experiments.
