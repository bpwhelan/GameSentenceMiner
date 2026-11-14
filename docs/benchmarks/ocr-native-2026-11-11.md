# OCR tab: Windows native measurements, 2026-11-11

Historical first-stage measurements. See the [completed rewrite and shared-capture
measurements](ocr-native-complete-2026-11-11.md) for the current implementation.

The Rust worker performed real Windows Graphics Capture and real ScreenAI and
OneOCR inference. All four matched engine/region comparisons preserved the
normalized Japanese text. Repeated inference was not consistently faster:
full-frame ScreenAI was slower in this run. The largest practical reduction in
work comes from skipping inference once the selected pixels stop changing.

## Matched work

Hardware: AMD Ryzen 7 5800X, 8 cores / 16 logical processors; Windows build
10.0.26300. Both implementations captured the same separate 1920 × 1080 window
showing a real Final Fantasy XVI frame from
`tests/assets/Replay_2025-12-19_22-24-52.mov` at 5 seconds. The area test used
the same 530 × 300 pixel rectangle at (480, 340).

Both used Japanese, the same locally installed engines/models, full scale and
zero furigana threshold. Each run had one cold scan followed by 20 measured
warm scans, with a 500 ms sleep after each scan. This is scan time **plus**
500 ms, not a fixed two-scans-per-second rate. Capture, crop, recognition and
result parsing are included in the elapsed scan time. Rust used the optimized
development profile used by `npm start`. The benchmark deliberately performs
inference every scan in both runtimes to compare equal work.

| Engine / input | Python median / p95 | Rust median / p95 | Python CPU | Rust CPU |
| --- | ---: | ---: | ---: | ---: |
| ScreenAI / full frame | 301.4 / 332.9 ms | 324.9 / 378.9 ms | 2.92% | 2.84% |
| ScreenAI / area | 221.8 / 231.9 ms | 221.5 / 228.8 ms | 2.67% | 2.49% |
| OneOCR / full frame | 215.9 / 228.5 ms | 215.7 / 225.0 ms | 9.70% | 8.47% |
| OneOCR / area | 150.9 / 154.6 ms | 149.1 / 155.0 ms | 5.63% | 5.34% |

CPU is process user + kernel time divided by elapsed wall time and by all 16
logical processors, matching the scale of total-machine CPU utilization. For
example, Rust OneOCR full-frame used 20.125 CPU seconds over its measured run,
or 135.5% of one core / 8.47% of the machine. Python used 23.047 CPU seconds.
The aggregate interval includes inter-scan sleeps, including the sleep after
warmup; cold model loading is excluded. Medians average the two middle samples;
p95 uses nearest rank.

Raw recognized text differs in paragraph separators, whitespace and English UI
lines. The comparison strips those and normalizes Japanese lines; all four
engine/input pairs match. This checks agreement on this fixture, not general
OCR accuracy across fonts, languages or games. The production native path also
applies its language filter before emitting results.

## Actual automatic worker

A separate test used the actual Tauri-owned OCR worker, the real capture window
and ScreenAI, with a 500 ms scan interval, 0.75 first-pass scale and optimized
full-resolution second pass. Measurements below cover the Rust desktop process;
Node, Python backend, OBS, the fixture and GPU work are outside this scope.

| Phase | Measured duration | CPU seconds | Total-machine CPU | Resident memory |
| --- | ---: | ---: | ---: | ---: |
| Stopped before first use | 5.0 s | 0.00000 | 0.00% | 19.0 MiB |
| Watching unchanged dialogue | 10.0 s | 0.09375 | **0.059%** | 312.7 MiB |
| Paused | 5.0 s | 0.00000 | 0.00% | 300.2 MiB |
| Stopped after use | 5.0 s | 0.00000 | 0.00% | 301.6 MiB |

Zero means no CPU increment at the process counter's measurement resolution
during that short interval. It does not mean that every part of GSM uses zero
CPU. Models/DLL caches can remain resident after stop; capture and scheduling
stop without promising to return all model memory to the operating system.

At the steady-state checkpoint the worker had captured 21 frames, made 3
inference calls and skipped 19 unchanged frames. After hiding/restoring the
fixture's content, inference calls rose to 7, confirming that changed pixels
resume recognition. The test also checked preview boxes, no automatic output
while paused, an explicit manual scan while paused, acknowledged stop, and no
late output after stop. The last successful automatic scan took 437.3 ms for
capture and both passes; this excludes the wait between stability observations.

## Evidence and reproduction

[Raw results](ocr-native-2026-11-11.json) contain all 160 warm samples, aggregate
CPU counters, hardware/source metadata, the measured worker binary identifier,
recognized text, preview geometry and lifecycle observations. They preserve the
original measured event format; subsequent source cleanup names that coordinate
space `source_content` and tightens lease cancellation without changing the
measured inference/capture path.

```powershell
npm run build:tauri
node scripts/benchmark-native-ocr.mjs
```

This writes `.tmp-ocr-benchmark/summary.json`, individual run data/logs, and
`worker.json`. The Python baseline runs through `.venv/Scripts/python.exe`.
The fixture and worker use isolated profiles; local model assets are read from
the normal installation. See [native OCR design](../NATIVE_OCR.md) for fallback
scope and test commands.

These are single-machine observations under normal desktop load, not repeated
controlled laboratory trials. They cover a real game's static frame and an
image-change/lifecycle test, not a long live-game session, cloud-engine latency,
mixed-DPI manual dragging or cross-platform performance. They support the low
idle-work claim and comparable inference costs, not a blanket Rust speedup.
