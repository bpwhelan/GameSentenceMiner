# Native area-selector latency — 2026-11-12

The delay came primarily from starting a fresh Windows Graphics Capture session
for every display on each invocation. The picker now uses a one-shot GDI
virtual-desktop snapshot in the shared Rust capture library. Continuous game
capture, thumbnails and previews retain their shared WGC sessions.

## Measurements

Twelve openings per implementation on this machine's 4480 × 1440 virtual desktop,
AMD Ryzen 7 5800X, 16 logical processors. Both GSM runs used the optimized
native-dev packages used by `npm start`. Each selector painted its frozen pixels,
waited for DWM, then cancelled itself through its own HWND; no user mouse/key
injection was required. Samples include the first invocation.

| Median per opening | Previous WGC snapshot | New GDI snapshot |
| --- | ---: | ---: |
| Desktop capture | 464.94 ms | 67.71 ms |
| Separate monitor composition | 9.98 ms | None |
| First paint complete | 546.19 ms | 143.11 ms |
| Including compositor synchronization | 556.84 ms | 156.09 ms |
| Process CPU time through presentation | 453.13 ms | 93.75 ms |

Presentation latency fell **72.0%**, and median CPU time per opening fell
**79.3%**. The 95th-percentile presentation latency (nearest-rank, 12 samples)
was 615.27 ms before and 176.47 ms after.

The complete burst, including 150 ms between openings and window cleanup, used
5.703 CPU-seconds in 9.077 seconds before, and 1.203 CPU-seconds in 4.129 seconds
after. That is 3.93% and 1.82% whole-machine CPU during their respective bursts.
Per-opening CPU time is the more comparable measure because the faster
implementation completed the burst sooner. GetProcessTimes has finite resolution;
these are short measurements, not an idle-CPU or GPU-usage estimate. There is no
new idle timer or capture session.

A separate probe compiled OneShotOCR's **unmodified capture function** without
xcap's WGC feature. Its median capture-plus-stitch time was **97.82 ms**, versus
**67.71 ms** for GSM's new combined snapshot. This compares acquisition only,
not OneShotOCR's complete selector/UI or Python's UI. The source hash and exact
probe scope are in the raw data.

## Correctness and scope

- 21 Tauri tests passed. The selector tests cover fresh fixture colors across
  repeated snapshots, opaque RGBA channels, no added WGC sessions, unchanged GDI
  handle counts, exact selected pixels, cancel/reopen and stop cancellation.
- The one-shot API reads physical virtual-desktop geometry each time, preserving
  negative origins and handling changed layouts without stale cached buffers.
  This run exercised the current two-display layout; it did not manually verify
  mixed-DPI dragging or every multi-GPU/HDR/exclusive-fullscreen arrangement.
- The measurements start inside the selector worker and end at first paint/DWM
  synchronization. Hotkey transport, time queued behind existing OCR inference,
  selection time, OCR inference and backend delivery are excluded.
- Windows GDI resources are scope-owned and released on success and error. GDI
  drawing is flushed before reading DIB memory, following
  [CreateDIBSection](https://learn.microsoft.com/en-us/windows/win32/api/wingdi/nf-wingdi-createdibsection).
  Layered windows are included via
  [BitBlt CAPTUREBLT](https://learn.microsoft.com/en-us/windows/win32/api/wingdi/nf-wingdi-bitblt).

[Raw measurements](ocr-selector-2026-11-12.json) include every sample and the
OneShotOCR source hash. No desktop screenshots were saved. Reproduce the current
selector benchmark after creating an output directory:

```powershell
$env:GSM_SELECTOR_BENCH_OUT = Join-Path (Get-Location) '.tmp-ocr-benchmark/selector-current.json'
cargo test --locked --manifest-path src-tauri/Cargo.toml --target-dir src-tauri/target/native-dev selector_activation_benchmark -- --ignored --nocapture --test-threads=1
```

The benchmark briefly opens and closes full-desktop selectors. It is ignored in
normal test runs. `GSM_SELECTOR_BENCH_COUNT` optionally changes the default 12 samples.
