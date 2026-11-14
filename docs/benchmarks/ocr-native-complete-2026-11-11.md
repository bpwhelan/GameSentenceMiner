# Rust OCR and shared capture: 2026-11-11

The expanded OCR path runs in Rust without the earlier feature-based Python
fallbacks. The shared capture test created **one WGC session for two consumers**,
and all **100/100 paired reads** reused the same decoded image.
All 180 warm OCR samples agreed with the corresponding normalized Japanese
baseline. CPU results vary by engine: this is not a blanket Rust CPU reduction.

## Environment and equal-work comparison

Hardware: AMD Ryzen 7 5800X, 8 cores / 16 logical processors;
Windows 10.0.26300. A real Final Fantasy XVI frame from
`tests/assets/Replay_2025-12-19_22-24-52.mov` at 5 seconds was displayed in a
separate 1920 x 1080 window and captured through real Windows Graphics Capture.
Area tests used 530 x 300 pixels at (480, 340). Both runtimes used the same
installed models, language, input geometry and a 500 ms sleep after each scan.

ScreenAI and OneOCR had one cold scan plus 20 warm scans per runtime/input.
Live Bing had one cold scan plus five warm scans per runtime/input. Cold work
is excluded below. This deliberately performs recognition on every scan in both
runtimes, independently of the production worker's unchanged-frame optimization.
Median averages the middle samples; p95 uses nearest rank. Capture, image
preparation, inference/upload and response parsing are included in scan latency.

| Engine / input | Python median / p95 | Rust median / p95 | Python CPU | Rust CPU |
| --- | ---: | ---: | ---: | ---: |
| screenai / full | 297.2 / 319.2 ms | 296.2 / 321.2 ms | 2.85% | 2.80% |
| screenai / area | 226.2 / 237.2 ms | 220.7 / 243.2 ms | 2.61% | 2.52% |
| oneocr / full | 234.1 / 276.9 ms | 220.9 / 237.1 ms | 8.62% | 9.15% |
| oneocr / area | 151.8 / 169.9 ms | 145.0 / 151.6 ms | 5.65% | 5.74% |
| bing / full | 663.3 / 873.5 ms | 587.5 / 653.9 ms | 0.13% | 0.49% |
| bing / area | 553.1 / 884.2 ms | 405.1 / 530.2 ms | 0.06% | 0.08% |

CPU is process user + kernel time divided by elapsed wall time and by all
16 logical processors. The interval includes inter-scan sleeps, including
the sleep after warmup. OneOCR full-frame CPU was slightly higher in Rust in
this run despite lower median latency. Bing timings include variable network
and service latency; five samples are a small observation, not a service SLA.
Rust capture medians for the local-engine runs were 1.35-1.53 ms, compared with
3.80-4.09 ms for Python. This includes obtaining an owned capture buffer.

Every warm sample's Japanese text was compared after removing paragraph
markers, non-Japanese UI lines, punctuation and whitespace and applying NFKC.
All six engine/input pairs matched. Raw output and all timing samples are
preserved; this agreement on one game image is not a general accuracy benchmark.

## Shared session under changing frames

The fixture alternated original and inverted pixels every 50 ms. This forces
new WGC frames; it is a capture stress fixture, not a gameplay simulation.
A single consumer ran 100 reads with 50 ms sleeps, then two consumers ran 100
paired reads. Both used the process-wide capture registry.

| Measurement | Result |
| --- | ---: |
| Sessions created for both consumers | 1 |
| Paired reads sharing the exact CPU buffer | 100 / 100 |
| Actual GPU-to-CPU readbacks in paired phase | 97 |
| Cached reads in paired phase | 103 |
| First consumer median read | 5.097 ms |
| Second consumer median / p95 shared read | 0.0121 / 0.0180 ms |
| Single-consumer CPU / measured duration | 0.604% / 5.497 s |
| Two-consumer CPU / measured duration | 0.670% / 5.536 s |

The second read returns an `Arc` to the existing decoded image. Consumers that
need to mutate pixels still pay for their own copy and preprocessing; the
0.012 ms result is not the cost of a full OCR or preview operation. The capture
loop used about 0.07 additional percentage points of machine CPU in the paired
phase. These are sequential short intervals with independently arriving GPU
frames, so that difference is not a precise isolated sharing cost.

The test also called both production OCR and overlay acquisition wrappers and
verified they did not create another session. Dropping the first consumer left
the second functional. Acquisition is shared by the OCR worker, reading overlay,
preview images, source-picker thumbnails and native screen picker. The fastest
active consumer controls pacing; the last consumer releases the session.

## Actual Tauri OCR worker

The worker used ScreenAI, two passes, 0.75 first-pass scale and a 500 ms sleep
between scans. Only the Rust desktop process is sampled; Node, Python backend,
OBS, fixture rendering, cloud compute and GPU work are excluded.

| Phase | Duration | CPU seconds | Machine CPU | Resident memory |
| --- | ---: | ---: | ---: | ---: |
| Stopped before use | 5.0 s | 0.00000 | 0.000% | 19.4 MiB |
| Unchanged dialogue | 10.0 s | 0.06250 | 0.039% | 321.2 MiB |
| Paused | 5.0 s | 0.01562 | 0.020% | 301.0 MiB |
| Advanced options, unchanged dialogue | 10.0 s | 0.20312 | 0.127% | 330.1 MiB |
| Stopped after use | 5.0 s | 0.00000 | 0.000% | 312.6 MiB |

The advanced phase enabled controller shortcuts, clipboard-image monitoring,
compact area packing, an exclusive area, a black-hole area and a lookbehind
replacement rule. Synthetic controller events were delivered over an actual
local WebSocket and triggered a real manual WGC/ScreenAI scan while paused.
The test did not replace the user's clipboard or use a physical controller.

The test verified changed pixels resume inference, unchanged pixels skip it,
preview geometry and a native JPEG capture preview, rejection of an obsolete
preview scene, explicit manual OCR while paused, stop acknowledgement and no
late output after stop. The final steady-state checkpoint recorded
21 captures,
3 inference calls and
19 unchanged frames skipped.
Models may remain resident after stop; capture and scheduling are released.
Zero CPU means no increment at the process counter's resolution, not zero
activity throughout GSM. A prior expanded run measured 0.029% for the advanced
phase versus 0.127% here; both are preserved to show short-run variability.

## A regression found and corrected by measurement

The first expanded run exposed excessive Rust Bing encoding CPU: five warm
full-frame scans used 9.78125 CPU seconds. A redundant full-frame encode was
removed and PNG/deflate dependencies were optimized in the development build.
The rerun used 0.46875 CPU seconds, approximately 95% less. Its CPU remains
higher than Python's 0.140625 seconds on this small sample. Both the initial
results and final raw results are retained rather than hiding the regression.

## Validation and limits

Relevant checks passed: 75 Rust tests (desktop, shared capture and OCR library),
74 TypeScript tests, 10 Python tests using `.venv`, main/renderer/native builds,
and Ruff formatting/checks. Native selection tests create a real Win32 window
and exercise paint, selection, cancellation and reopening. Real socket tests
cover OBS authentication, connection/frame reuse and independent consumer
release; MLKit encoded uploads; and OpenAI-compatible parameter retries.

Live engines exercised here are ScreenAI, OneOCR and Bing. Other remote OCR
accounts/services, a real OBS-only source, physical clipboard-image input,
physical mixed-DPI dragging, macOS/Linux runtime behavior and extended live
gameplay were not validated on this Windows machine. The saved-area editor and
separate Python mining/recording workflows remain outside this OCR rewrite.
The native one-shot picker is Windows-specific. See [native OCR design](../NATIVE_OCR.md).

## Evidence and reproduction

[Raw measurements](ocr-native-complete-2026-11-11.json) include all 180 warm
samples, worker events, shared-capture samples, initial expanded-run results,
source hashes and the measured desktop binary identifier
`c85754172983e7ee0190`. The initial narrower rewrite is preserved in the
[earlier report](ocr-native-2026-11-11.md).

```powershell
npm run build:tauri
node scripts/benchmark-native-ocr.mjs .tmp-ocr-benchmark/full-rewrite-final
```

Requires installed ScreenAI/OneOCR assets, `ffmpeg`, and network access to Bing.
Profiles are isolated; installed model assets are read without modifying the
user's OCR settings. The fixture windows close after the run.
