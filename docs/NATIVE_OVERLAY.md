# Native overlay backend

Tauri launches the backend with `GSM_NATIVE_OVERLAY=1`. In this mode, overlay
capture, OCR, filtering, reading order, paragraph grouping, coordinate projection,
retry scheduling and periodic scanning run in Rust. Python's overlay entry points
forward application context and scan requests; they do not call Python OCR or
capture functions. Standalone Python launches retain the existing implementation.

## Ownership

- `src-tauri/src/overlay.rs` owns one native worker, a single pending scan, pause
  state, periodic deadlines, mouse gating, background capture and result delivery.
  New requests and configuration changes invalidate in-flight results. Stopping
  the overlay or losing its data connection invalidates pending work.
- `native/gsm-overlay` runs OneOCR, MeikiOCR, ScreenAI, VOCR and Lens directly.
  VOCR + Lens detects regions locally before sending those crops to Lens. VOCR's
  existing bundled models run through ONNX Runtime without Python. Model choices
  continue to use the existing profile installation files.
  The host points Rust at `GameSentenceMiner/assets/vocr` under the application
  resource directory. Rust and Python share those files; the executable does
  not embed another model copy. Every loaded graph is checked against its pinned
  SHA-256 and model metadata before inference. No download is needed for VOCR.
- Windows scans use a persistent Windows Graphics Capture (WGC) session and
  crop to the physical client rectangle. The latest frame stays on the GPU
  until OCR requests a CPU readback. Sessions follow window resizing, replace
  themselves on target changes, and close on pause/stop/unavailability or after
  30 seconds without a scan. One-off desktop backgrounds use xcap's WGC path.
  Projection accounts for scaling, window offsets and negative monitor origins.
  OBS screenshots are used when selected or when direct window capture fails.
- Include/exclude rectangles, minimum character size, language filtering,
  precomputed `gsm_overlay_coords_v1` coordinates, forced engine-hook bypass and
  supplemental OCR are handled before native grouping. The renderer consumes
  `native_layout` geometry while shared JavaScript grouping retains history and
  nameplate inference.
- Configured include areas now restrict the actual OCR input to their clipped
  union; exclusions stay masked. OCR coordinates, including individual words,
  are translated back into the original capture before desktop projection.
- Last-sent monitoring runs on the native worker at 500 ms intervals. It compares
  contrast signatures of individual text regions, requires two visual misses,
  then uses local OCR to confirm disappearance or relocate the existing text.
  The existing remove-notation / invalidate-lookups options remain independent;
  returning text restores its saved payload and latest coordinates. Monitoring
  does not make cloud OCR calls or inject lines into the log/statistics.
- Adaptive retries accelerate while text grows, back off on uncertain reads,
  allow ongoing hook progress to extend the scan, and stop at a 30-second hard
  limit. Agreement uses capture timestamps, so slow OCR does not manufacture a
  quiet period. Known sentences finish immediately when fully present.
- With adaptive retries enabled, automatic local scans learn a padded dialogue
  crop, refresh the full frame at least every three seconds, and reacquire on
  the same captured frame if a crop is blank, mismatched, fails, or clips text
  at an interior edge. Explicit area selections take priority; manual scans do
  not use a learned crop. Geometry/settings/target changes clear crop history.
- Hook-only initial delays learn from completed scans, never extra OCR calls:
  repeated confirmed late reveals add 50 ms, up to 150 ms; successful first
  passes gradually reduce it. Game/window/language/hook changes reset learning.
  Typewriter growth and unconfirmed/cancelled scans do not teach a delay. Skip
  recovery uses up to eight cheap, cancellable pixel stability probes before OCR.
- `src-tauri/src/overlay_host.rs` forwards commands from the backend socket to
  one worker, preventing duplicate scans. OCR results go directly to the Tauri
  webview, followed by a lightweight completion message for Python mining and
  recycled-line feedback.

Tauri owns the overlay windows, settings, dictionary orchestration and workers.
The runtime does not launch a Node overlay controller. The
shared Python game monitor, OBS integration, profile persistence, translation,
mining and stats services remain application services. A lightweight context
update every 500 ms supplies the current scene, target, availability and settings;
Rust decides when to capture and scan. No new listening port is introduced.

The proof-of-concept reference was `codex/rust-ocr` at
`1bee362c0db01cc911989f0b95f3032b056f282a`. Only its OCR engine implementations,
OCR model/inference support and OCR test fixtures were adapted. No runtime,
overlay-controller, application-core or configuration code was imported from that
branch. Layout, language filtering and comparison reuse pure Rust modules already
on the current branch.

## Parity and capture behavior

Native scans report completed text to the Python context so mining, recycled-line indicators and optional overlay-only ingestion use the displayed frame. Shared renderer grouping retains history and nameplate inference; native correction uses recent hook text while preserving glyph geometry. VOCR + Lens packs detected crops into bounded composites and maps recognized words back to their source positions.

The native worker honors the configured OBS capture backend and selected source, and falls back to OBS when direct window capture fails. Direct window capture remains the fast path in automatic mode. Monitor-only/manual background capture remains independent of OBS. OBS frames use the same window-client or monitor projection contract as the legacy path; transformed/composite scenes and Magpie still require live setup-specific validation.

See [the repair status](TAURI_PARITY_REPAIR_STATUS.md) for the current test results and remaining platform acceptance checks. Built-in engine hooks are deferred by user instruction.

## Validation and development

```powershell
cargo test --manifest-path native/gsm-overlay/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml --target-dir src-tauri/target/native-dev --bin gsm-desktop overlay::tests
node --test GSM_Overlay/tests/native_overlay.test.cjs
.venv/Scripts/python.exe -m pytest tests/util/overlay/test_native_runtime.py tests/util/overlay/test_periodic_scanning.py -q
npm run build
node scripts/build-native-dev.mjs
node scripts/test-native-desktop.mjs overlay
```

The Windows overlay smoke uses temporary profiles and controlled backend events
to check real settings visibility, keyboard delivery, Jiten extension requests,
monitor geometry, profiles and two complete start/stop cycles. Dictionary smoke
separately imports a fixture dictionary and verifies hover lookups after reopening.
The capture benchmark launches a native test window, runs MeikiOCR, and checks
freshness, resizing, reopening, target switching and closure:

```powershell
node scripts/benchmark-native-overlay.mjs --python
node scripts/test-native-desktop.mjs ocr-flow
```

The OCR-flow check exercises the main OCR coordinator and OneOCR with an isolated
backend. A separate OneOCR screenshot check is available:

```powershell
cargo run --manifest-path native/gsm-overlay/Cargo.toml --example recognize -- oneocr native/gsm-overlay/tests/fixtures/dialogue.png
```

Linux/macOS capture and the external ScreenAI/Lens services require their own
platform/model/network integration checks; Windows capture, Meiki, VOCR and
installed OneOCR are the locally exercised paths. The Python facade tests verify
that native mode does not enter the Python capture/OCR paths.

## Performance investigation

The first development build had two significant repeat-scan costs: xcap started
and stopped a WGC frame pool/session for every screenshot, and Cargo's default
unoptimized development build ran pixel loops without optimization. Grouping
was not a significant contributor. Capture was already WGC, not OBS.

On this Windows workstation, a 1000×500 fixture with two text lines, Meiki's large
CPU detector and scale 1.0 produced these approximate warm medians (nine samples,
excluding the initial capture/model load):

| Stage | Original Rust development build | Fixed Rust development build | Python baseline |
| --- | ---: | ---: | ---: |
| Capture, including geometry and client crop | 99 ms | 7 ms | 1–2 ms |
| Meiki OCR, including input preparation | 167 ms | 81 ms | 77–82 ms |
| Rust grouping | <1 ms | <1 ms | — |

The November 13 parity-repair rerun used the native fixture launcher (no Electron
capture helper). Nine warm samples measured native capture **3.89 ms**, Meiki OCR
**72.81 ms**, and capture + OCR **76.68 ms** median; Python measured **1.21 ms**,
**79.47 ms**, and **80.49 ms** respectively. Capture freshness, resize, reopen,
target-switch and closure checks passed. These are workstation fixture results,
excluding model initialization, rather than an application-wide latency promise.

Meiki input preparation alone fell from roughly 80 ms to 5 ms. The desktop,
overlay, image and xcap packages now use optimized code even in development
builds, while retaining debug symbols and checks. Release builds already use
optimization. These are stage measurements on a controlled fixture, not a
claim about first-launch latency or end-to-end hook-to-render timing in every game.

Reproduce the comparison after building the native desktop:

```powershell
node scripts/benchmark-native-overlay.mjs --python
```

The optional Python comparison uses `.venv`, WGC and the same selected Meiki
detector on CPU. The Rust benchmark exercises the actual capture/OCR/grouping
functions and also verifies fresh pixels, resizing, session reopening, monitor /
window target changes and closed-target invalidation. It is an ignored test so
normal unit tests do not capture the desktop or launch windows.

Set `GSM_OVERLAY_PROFILE=1` before starting GSM to log native stage timings
(`[overlay-perf]`): capture geometry/WGC/crop/resize, masking, OCR, grouping and
dispatch, with separate Meiki preprocessing and inference timings. This is
disabled by default and does not log screenshot contents or recognized text.
Crop/full/reacquisition stages also report the actual OCR input dimensions;
presence checks report capture, visual comparison and confirmation OCR separately.

Presence monitoring cancels when a newer scan, pause, target change or shutdown
supersedes it. If capture geometry changes and confirmation cannot find the old
text, it invalidates the old targets and waits for a new scan instead of restoring
obsolete coordinates or repeatedly running background OCR. Learning and monitoring
state live in memory; existing user preferences are preserved.
