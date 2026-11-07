# VOCR native AVX2: independent GSM comparison, 2026-11-02

The native build is worth restoring. On this Ryzen 7 5800X, the fork's
single-threaded AVX2 kernels read complete images **1.54–1.71× faster than
GSM's bundled faithful ONNX**, using **34–43% less CPU time per image** and
**36–40% less resident memory in the isolated Python benchmark process**.
They are **3.17–4.79× faster than GSM's previously distributed C runtime**.
Recognition alone improves more than the complete pipeline.

This supports a local native trial and restoring the native build pipeline.
It does not justify replacing the portable ONNX default on untested machines.
No weights were trained or changed.

## What actually changed upstream

The fork's `main` was not the optimization branch. The inspected sources are:

- GSM's original model/runtime pin: `205f47ec4e56ca87c00e7dba0a61c9aaec726707`.
- [Mansive desktop-avx2](https://github.com/Mansive/vita-vn-ocr/tree/b02e81205fa4bba87726a34f9c7a8cd1469a06ce),
  the production candidate, at `b02e81205fa4bba87726a34f9c7a8cd1469a06ce`.
- [Mansive bench-avx2](https://github.com/Mansive/vita-vn-ocr/tree/a0b773d579cf7808762ac8b324f43bd242a0e00e),
  the threading experiment, at `a0b773d579cf7808762ac8b324f43bd242a0e00e`.

Between the original pin and the desktop branch, upstream also added official
ONNX exports, newer data manifests, desktop evaluation tooling and ARM NEON
optimizations. Those data/training changes do not change the v0.5.0 weights
used here. GSM imports only its checksum-pinned C runtime dependencies.

The desktop-specific diff against upstream base `673ee5c` changes eight files;
the inference changes are in `runtime/vocr.c` and `runtime/vocr_textspot6.c`.
[The fork's implementation notes](https://github.com/Mansive/vita-vn-ocr/blob/b02e81205fa4bba87726a34f9c7a8cd1469a06ce/docs/desktop-avx2.md)
describe the arithmetic constraints:

- W8I matrix products compute four positions and eight outputs together using
  AVX2 signed 16-bit multiply-add instructions and exact 32-bit integer sums.
  They retain the original 16-bit activation quantization and 512-term chunks.
- Stem and depthwise convolutions operate across eight channels at a time,
  retaining scalar multiply/add order. Fused multiply-add remains disabled.
- The textspot8 detector vectorizes eight pixels per block, reuses widened
  inputs across four output channels, and vectorizes integer requantization.
- The single-threaded changes retain the ABI, model formats and arena sizes.
  Compilation enables AVX2; the fork itself provides no runtime CPU dispatch.
- The benchmark branch adds process-global fork/join hooks and a Windows
  spinning/sleeping thread pool. It also permits larger recognition tiles and
  output-head batches. These threading hooks are not in the deployed candidate.

The author measured other pipelines on a 5800X3D, without a local ONNX comparison,
and had not tested MSVC. The measurements below use GSM's actual pipeline and
fresh builds made with MSVC on this machine.

## Method

Windows x64, Ryzen 7 5800X (8 physical cores / 16 logical CPUs), Python 3.13.2,
NumPy 2.2.6, ONNX Runtime 1.24.4 CPU provider. Both new native builds use MSVC
19.51.36256.0, `/O2 /fp:strict`, static CRT; the AVX2 build adds `/arch:AVX2`.
The scalar build uses the same fork revision and compiler without AVX2, isolating
the kernels' effect. The shipped-C row is the actual `205f47ec4e56-1` artifact,
not a recompiled approximation of the old installation.

The corpus contains four existing local captures (three Steins;Gate captures
and an Ace Attorney capture), six generated dialogue panels and two empty
images. The original C detector supplies 38 fixed horizontal line crops. A
separate 77-case line check covers three Japanese fonts, three sizes, both
polarities, narrow and clamped widths, and noise. Five additional detector
dimension/noise checks extend through 1921×1081. Images and game text stay local.

Each backend/tier combination runs in **three fresh subprocesses**, with two
warmup passes and three measured passes per stage per process. The 45 jobs run
sequentially in a seeded shuffled order. A cell is the median of the nine pass
means. Detection includes resize and decoding; recognition includes image
preparation, inference, text decoding and character boxes; complete OCR includes
both stages. Loading is measured separately. Capture/OBS latency, downloads,
builds and output validation are outside the timed regions.

CPU figures are process CPU time, summed across threads, rather than elapsed
time. All main-comparison variants use one inference thread; ONNX spinning is
disabled. Memory includes the Python harness and in-memory corpus. The baseline
after common imports and input loading is about 97 MiB. Warm snapshots follow
the measured stages; peak working set is the OS process-lifetime peak at that
point. These are not whole-GSM memory or GPU measurements. The desktop stayed
running, so pass ranges and individual-call p95 values are retained in JSON.

## Complete-image results

Milliseconds per image:

| Size | Shipped C | New scalar C | Bundled faithful ONNX | Research fast ONNX | Native AVX2 | Gain over bundled ONNX |
|---|---:|---:|---:|---:|---:|---:|
| Small | 85.44 | 82.36 | 41.59 | 29.35 | 26.98 | 1.54× |
| Normal | 94.99 | 80.80 | 45.86 | 35.45 | 28.80 | 1.59× |
| Large | 170.79 | 164.93 | 60.84 | 37.53 | 35.62 | 1.71× |

The four real captures alone are a harder subset. Faithful ONNX → native AVX2:
Small **73.52 → 54.27 ms**, Normal **75.10 → 57.87 ms**, Large
**93.41 → 64.36 ms**: **1.30–1.45×**. Full-pipeline speedups must not be
presented as the much larger recognition-only gains. Downscaling and detection
remain substantial costs for large screenshots.

Fast ONNX is an unshipped research mode that changes arithmetic, and all its
rows still use the faithful ONNX detector. It matched this sample, but was not
selected for deployment. Its recognition alone is faster than native for Small
and Large, so native is not faster at every individual operation.

## Recognition and detection

Milliseconds per line, including preprocessing and character geometry:

| Size | Shipped C | Bundled faithful ONNX | Fast ONNX | Native AVX2 |
|---|---:|---:|---:|---:|
| Small | 12.40 | 4.68 | 1.36 | 2.13 |
| Normal | 15.07 | 6.21 | 2.53 | 2.32 |
| Large | 42.23 | 9.90 | 3.74 | 4.76 |

The same detector is measured independently in each tier's process. Native
AVX2 takes **14.93–15.52 ms/image**, versus **22.59–24.22 ms** for bundled ONNX
and **38.36–40.74 ms** for shipped C. Native recognition preserves the gate
and two-level head's ability to skip work; the faithful ONNX graph evaluates
the full head before masking its outputs.

## CPU, memory and loading

| Size | CPU ms/image ONNX → native | Warm RSS MiB ONNX → native | Private MiB ONNX → native | Peak working set MiB ONNX → native | Load ms ONNX → native |
|---|---:|---:|---:|---:|---:|
| Small | 41.67 → 27.34 | 163.3 → 104.0 | 142.2 → 87.6 | 186.5 → 134.6 | 300.5 → 79.8 |
| Normal | 45.57 → 28.65 | 167.5 → 103.1 | 145.1 → 86.4 | 190.0 → 135.7 | 376.1 → 81.3 |
| Large | 61.20 → 35.16 | 177.4 → 106.4 | 155.2 → 89.9 | 200.8 → 137.2 | 344.7 → 86.9 |

Warm RSS increases over the common pre-load baseline are **66.7/70.7/80.0 MiB**
for ONNX and **7.2/6.1/9.2 MiB** for native (Small/Normal/Large). These differences
include runtime libraries, sessions and retained allocator memory, not just
model tensors. Cache-warm OS file loading is included in the load figures;
they are not machine-boot cold-start measurements.

During inference, both single-threaded implementations use about one logical
CPU. Native completes sooner, lowering total CPU cost and the duty cycle at a
fixed scan rate. One-second idle observations recorded zero CPU time for the
native AVX2 workers. This does not measure power consumption or battery life.

A second comparison uses the **actual packaged candidate** and a paced loop:
24 scans at 0.2-second intervals in each of two fresh processes per size/backend,
48 scans per cell. CPU usage below is normalized to this machine's 16 logical
CPUs, as a share of total host CPU capacity:

| Size | ONNX host CPU | Packaged native host CPU | CPU reduction | Missed 200 ms deadlines |
|---|---:|---:|---:|---:|
| Normal | 1.414% | 0.793% | 44% | 0 for either |
| Large | 1.831% | 1.038% | 43% | 0 for either |

In that separate run, unpaced complete-image medians were **44.97 → 25.88 ms**
for Normal and **58.65 → 32.94 ms** for Large. Output and detector-map comparisons
still match. [The packaged comparison](vocr-native-packaged-2026-11-02.json)
contains its independent measurements; it is not pooled into the primary table.

The four original native weights total **4,537,056 bytes**, versus
**16,968,508 bytes** for the bundled ONNX graphs. The Windows DLL pair adds
**384,000 bytes**. The native runtime archive, including complete corresponding
source but excluding model weights, is **372,400 bytes**. ONNX remains bundled
during this trial, so these are format comparisons, not current installer savings.

## Output agreement

All three native sizes match the shipped C reference on:

- **345 line cases**: text, per-frame class predictions and character boxes.
- **36 complete-image outputs** and every line detector box record.
- All **675,280 detector map values** across the 17 detection cases. The detector
  is the same across tiers; this is the unique map-value count, not multiplied
  by three model sizes or repeated processes.

Outputs remained stable across subprocess repeats. Faithful and fast ONNX also
match these cases. Agreement is not a human-labelled accuracy score or proof
of universal bit identity. No claims about better Japanese recognition follow
from these results; the weights and decoding behavior are unchanged.

The first resource run hashed raw detector storage, which is int8 in C and
int64 in the Python decoder. That produced invalid cross-backend hash differences.
All 17 cases were rerun with elementwise equality assertions, which passed; the
corrected comparison canonicalizes signed-int8 storage. Original raw results,
the correction record and unchanged timings remain under `temp/vocr-native/`.
The committed benchmark now rejects lossy canonicalization, with regression tests.

## Additional optimization experiments

Two fresh processes per option, three timed passes per process, Normal model:

| Option | Complete image ms | CPU ms/image | Warm RSS MiB |
|---|---:|---:|---:|
| AVX2, original 4-frame tile / 16-frame head | 30.64 | 29.95 | 104.4 |
| AVX2, tile/head 16 | 27.43 | 27.34 | 105.8 |
| AVX2, tile/head 64 | 27.71 | 27.99 | 105.3 |
| AVX2, tile/head 128 | 30.16 | 29.30 | 107.2 |
| Benchmark branch, 2 threads, tile/head 64 | 28.15 | 38.41 | 106.3 |
| Benchmark branch, 4 threads, tile/head 64 | 25.51 | 50.78 | 105.6 |
| Benchmark branch, 8 threads, tile/head 64 | 26.29 | 88.54 | 106.0 |

All outputs match. Eight threads cost **2.96× the CPU time** for only a **14%**
elapsed-time reduction relative to this experiment's baseline. Four threads
are a better throughput tradeoff, but still cost about 70% more CPU time. The
process-global hooks and benchmark pool also need lifecycle and concurrency
work before use in GSM, where multiple OCR contexts can coexist.

Larger single-threaded batches are worth revisiting, but the small recognition
gains and overlapping/noisy pass ranges do not justify making them a default
from this trial. Different batches cannot improve detector time; part of the
whole-image variation is unrelated to the changed recognizer settings. The
deployed candidate retains the original tile/head settings and uses one thread.

## Integration and reproduction

Existing work was committed first as **`00063070`**. All work from this
investigation is left uncommitted.

`native/vita-ocr/desktop-source-lock.json` pins the new C sources independently
of the original model/ABI pin and ONNX manifest. The maintainer build includes
source, GPL licence, rebuild instructions, CPU requirements and library hashes.
CI is configured for separate portable/AVX2 x64 packages and portable arm64
packages. Cross-platform CI and publication have not been run in this task.

The local installer loads all three sizes in a disposable subprocess before
publishing `native-runtime.json`. Packages are versioned side by side, and
CPU/OS AVX2 support and hashes are checked before loading. Explicit
`GSM_VOCR_BACKEND=onnx` overrides the trial. Removing the trial marker restores
the bundled default without deleting native assets or changing model size.
Automatic mode also falls back to bundled ONNX if the CPU/OS cannot support the
native package's required features, preserving the model size and trial marker.
Explicitly forced `c` remains strict; unrelated validation failures are reported.

The local installation was activated as **`b02e81205fa4-1-avx2`**, preserving
the existing **Large** preference. Fresh production factories select the native
recognizer and detector, and a real screenshot smoke test returns four lines.
The current Main OCR is `vitaocr` and Stability OCR is `vocr_detector`; both use
the new package once the running app restarts. Already loaded instances are not
replaced underneath an active scan.

Validation: the relevant regression run passed **102 tests**, with one optional
real-download test skipped. A subsequent **12-test** native/benchmark run also
passed, including the newly added offline test that switches all three cached
sizes through the real factory and wrapper while retaining the native marker.
It also keeps the same optional download test skipped. Ruff formatting and
lint checks passed, and the four bundled ONNX graph hashes still verify. The
existing GSM Rust extension still loads; no extension replacement was needed.

```powershell
# Fetches only pinned, checksum-verified files. Also accepts --source CHECKOUT.
.venv/Scripts/python.exe scripts/build_vocr_runtime.py --avx2 --install-local

# Restore ONNX locally:
.venv/Scripts/python.exe scripts/build_vocr_runtime.py --restore-onnx

# Prepare the corpus from your screenshots and the original C detector:
.venv/Scripts/python.exe scripts/benchmark_vocr_native.py prepare `
  --models temp/vocr-onnx/models --corpus temp/vocr-native/corpus `
  --images temp/steins-window.png temp/steins-window-restarted.png `
           temp/steins-after-enter.png temp/gpu-validation/example.jpg

# Build AVX2 and scalar candidates before timing; supply their model directories.
.venv/Scripts/python.exe scripts/benchmark_vocr_native.py compare `
  --corpus temp/vocr-native/corpus `
  --native shipped-c=temp/vocr-onnx/models `
  --native fork-scalar=temp/vocr-native/scalar `
  --native fork-avx2=temp/vocr-native/avx2 `
  --fast temp/vocr-onnx/onnx --output temp/vocr-native/independent.json

.venv/Scripts/python.exe scripts/benchmark_vocr_native.py summarize `
  --input temp/vocr-native/independent.json `
  --output temp/vocr-native/summary.json
```

The default comparison uses the actual bundled faithful graphs. `--fast` adds
an optional research baseline; it is not required. `--native-options
NAME=THREADS,TILE,HEAD` enables the isolated tuning experiments; multiple threads
require the research bridge and are not supported by production packages.
`--paced-scans 24 --interval 0.2` additionally measures a five-scans/second loop.
Use GSM's `.venv`; the local synthetic stress set requires Japanese Windows fonts.

The [main record](vocr-native-2026-11-02.json) contains distributions, CPU and
memory measurements, input hashes, agreement counts, source pins and binary
hashes. [The tuning record](vocr-native-tuning-2026-11-02.json) records the
additional experiments. Raw subprocess logs and individual timings are local
under `temp/vocr-native/`.

## Downsides and limits

- This is one Windows/Zen 3 machine and a small corpus from two games. Real
  screenshots improve less than the mixed-corpus headline. Other CPUs,
  compilers, operating systems and sustained gaming loads remain unmeasured.
- AVX2 binaries require AVX2 and OS vector-state support. GSM guards this before
  loading and automatic mode falls back to bundled ONNX when unsupported. Other
  native platforms still need verified builds. ONNX is simpler to distribute
  across platforms.
- Restoring native builds adds compiler, source-pin, ABI and binary-publication
  maintenance. The new fork pin is a branch snapshot, not a published GSM runtime.
- The benchmark's memory figures are for an isolated Python process. Whole-GSM
  savings, power, temperatures and gaming frame rates were not measured.
- Accuracy was checked for agreement, without new human-labelled game ground
  truth. Horizontal Japanese dialogue remains the recognizer's scope.
- Original restrictions remain: runtime source is GPL-3.0-or-later and the
  released model weights carry non-commercial-use notices. Changing the
  execution backend does not remove those restrictions.
- Threading has a substantial CPU cost and was not enabled. Larger batches and
  the faster approximate ONNX recognition mode were also left out of deployment.
