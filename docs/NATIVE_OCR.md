# Native OCR tab

The Tauri desktop runs the OCR tab in Rust, including advanced configurations.
The existing tab, saved settings, text feed, preview boxes, start/stop buttons,
and keyboard shortcuts control that worker. On macOS and Linux, the optional
portable OneOCR engine uses its own local Python runtime for inference.

## Ownership and lifecycle

- `src-tauri/src/ocr.rs` owns a dedicated blocking worker in Tauri managed state.
  OCR models, capture, pixel processing and inference stay on that thread.
  Commands update a bounded mailbox and return; they never run inference on the
  event loop. The mailbox retains at most one manual request and one candidate
  frame awaiting stable text. Inference does not create an unbounded task queue.
- Generation and session identifiers invalidate results after stop, pause,
  reconfiguration, or a newer manual request. A one-second context heartbeat
  renews a four-second lease; losing the service releases capture and cancels
  selection. Native inference already inside a DLL cannot be forcibly aborted,
  but its obsolete result is discarded. Stop acknowledges worker cleanup; a
  30-second timeout reports failure instead of claiming the worker stopped.
- `native/gsm-capture` owns acquisition for the OCR worker, reading overlay,
  preview images, source-picker thumbnails and native screen picker. On Windows,
  continuous capture uses a process-wide weak registry sharing one WGC session
  per HWND/monitor. The session keeps the latest
  GPU frame and one decoded `Arc<RgbaImage>`; consumers of the same frame reuse
  the CPU readback. Mutable image processing gets its own copy. There is no
  frame streaming over IPC, extra capture process, or unbounded frame queue.
  D3D context access is serialized. Each consumer registers its cadence; the
  fastest active consumer determines capture pacing. Stopping one consumer
  leaves the others alive; the final consumer releases capture. Closed targets,
  changed geometry and capture errors cannot return a stale cached image.
  The one-shot screen picker calls the same library's `desktop_snapshot` API:
  one GDI read of the virtual desktop, without creating streaming sessions or
  stitching separate monitor images. Snapshot resources are released immediately.
  macOS/Linux acquisition uses the same library with xcap; WGC session sharing
  and the measurements here are Windows-specific.
- The same library owns authenticated OBS v5 connections and screenshot
  acquisition for scenes without a window target. Connections are shared by
  endpoint/credentials and decoded frames are reused briefly for the same
  source. Window capture never goes through OBS screenshot encoding. Python
  provides scene identity only. This does not move the separate Python mining
  and recording screenshot workflows into Rust.
- The OCR worker sleeps between scans and while paused or unavailable; slow
  inference never causes catch-up bursts. Priority applies to the worker
  thread, not the whole Tauri process.
- `native/gsm-overlay/src/ocr.rs` handles area masking/cropping, preprocessing,
  Unicode normalization, stability, duplicate checks, source coordinates,
  language/furigana filtering, compact area packing, exclusive/black-hole areas
  and ordered literal/regex replacements. Packed boxes and words are mapped
  back to source coordinates. Regex supports lookarounds and Python-style
  replacement groups with a bounded backtracking budget; invalid expressions
  produce an error rather than silently changing text. Two-pass OCR
  uses the configured first engine/scale, then full-resolution recognition of
  the candidate area. Unchanged settled pixels skip inference; changing pixels
  resume recognition. Text detection includes image content in its stability
  identity so changing dialogue in the same box is not permanently skipped.
- The Node adapter in `electron-src/main/services/native_ocr.ts` transports
  settings/events; keyboard observation stays in Rust. It serializes lifecycle
  changes, bounds pending text deliveries, and awaits backend acknowledgement.
  Capture/model objects stay in Rust. Preview requests return only a bounded
  JPEG thumbnail; full capture frames are not sent to Node.
- Python supplies cached OBS/window identity through `ocr.native.context` and
  accepts text through `ocr.native.result`. The latter rejects a capture from
  an obsolete scene before calling the existing text-ingress pipeline. History,
  exclusions, clipboard behavior, observation IDs and downstream mining continue
  to use that shared pipeline. Capture-preview images and OCR boxes come from
  Rust; preview requests reject obsolete scenes.
- A dedicated Rust input worker subscribes to the existing controller server.
  Chords are device-local and edge-triggered; snapshots do not fire shortcuts.
  Clipboard-image OCR uses the Windows clipboard sequence before reading an
  image, sleeps between checks, and retains at most one pending image. The
  listener sleeps when neither feature is active; clipboard input pauses with
  OCR while controller shortcuts remain usable to resume/manual-scan.

This follows Tauri's guidance to keep blocking work out of synchronous commands.
The long-lived loop uses a dedicated thread because Tokio explicitly recommends
one for persistent blocking work; finite stop and preview operations use
`spawn_blocking`. See [Tauri commands](https://v2.tauri.app/develop/calling-rust/)
and [Tokio blocking work](https://docs.rs/tokio/latest/tokio/task/fn.spawn_blocking.html).

## OCR keyboard shortcut scope

All keyboard bindings use the existing passive Rust input service, including
Ctrl/Alt/Command/Windows combinations and F1–F24. OCR never reserves these keys
with the operating system; input continues to reach the app the user is using.
Shortcuts trigger while the captured game window is shown and not minimized,
regardless of which app has focus. On Windows, DWM-cloaked windows are also
excluded. A window covered by another app remains eligible; this uses window
visibility, not pixel occlusion tracking. No foreground-window check remains.
Exact modifier matching and press/release tracking prevent Ctrl+A from also
triggering plain A and suppress repeats, including a key held during restore.
The Windows visibility checks follow
[IsWindowVisible](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-iswindowvisible)
and [DWMWA_CLOAKED](https://learn.microsoft.com/en-us/windows/win32/api/dwmapi/ne-dwmapi-dwmwindowattribute).

Each client owns a separate keyboard allowlist and optional keyboard-feature
lease; OCR configuration/reconnection does not replace the overlay's bindings.
Stopping OCR or disconnecting releases that subscription. No additional keyboard
polling loop or capture session is created. Visibility is checked when keyboard
events arrive, without capture or periodic window enumeration on Windows. The
UI records Space explicitly and supports Command and F13–F24 combinations.

The Windows integration check uses real SendInput transitions into isolated test
windows and tests delivery to text fields, visible background/minimized/hidden
targets, plain/Shift/Ctrl F13–F24 bindings and release on stop. It also samples the
Rust desktop and input
service CPU separately: `node scripts/test-ocr-hotkeys.mjs`. It requires the
current desktop/main builds and `cargo build --manifest-path
GSM_Overlay/input_server/Cargo.toml`. This check does not claim equivalent runtime
validation on macOS/Linux or alternative keyboard layouts.
See the [visibility and passthrough measurements](benchmarks/ocr-hotkeys-visible-2026-11-11.md)
for live coverage, occupied-key exclusions, latency and CPU results.

## Native screen crop picker

`src-tauri/src/ocr_selector.rs` provides the one-shot area-select OCR window using
Win32/GDI and a frozen desktop pixel buffer. Selection, dimming, mouse capture,
Escape/right-click cancellation and cropping run in Rust. There is no webview,
HTML or JavaScript selection surface. The existing command/hotkey transport
simply opens it, and the chosen crop goes directly to the native OCR engine.

The design follows the frozen-screen approach in
[OneShotOCR](https://github.com/bpwhelan/OneShotOCR/blob/c87f413ce502e2ff2e0c1b0fb5eb41b33abefa42/src/overlay.rs).
This implementation uses a Win32 window on the OCR worker's own message loop,
with physical pixels, per-monitor DPI awareness and negative desktop origins.
A timer closes it when its request is cancelled. The native test creates a real
window, paints it, selects exact pixels, cancels, reopens and verifies stop.
Physical mixed-DPI dragging has not yet been manually verified.

Desktop acquisition is in `native/gsm-capture/src/desktop.rs`. It reads current
physical virtual-desktop bounds on each invocation, captures into a top-down
32-bit DIB, flushes GDI before CPU reads, converts BGRA to opaque RGBA and
restores/releases all GDI objects through RAII. There is no snapshot cache,
background capture timer or new capture thread. The streaming WGC registry is
unchanged. The regression check verifies changing fixture pixels, alpha,
selection/cancellation, zero added WGC sessions and stable GDI handle counts.
See the [selector latency and CPU measurements](benchmarks/ocr-selector-2026-11-12.md).

The persistent area configuration editor and its Add Area action remain Python.
They continue to save the same per-scene area files.

## Engines and compatibility

Tauri manages engine selection, controller bindings, clipboard screenshots,
area processing, regex replacements, Bing menu OCR and OBS capture in Rust.
It reports model or service failures for the selected engine.
The legacy Electron desktop retains its existing Python OCR implementation.

Local engines include ScreenAI, OneOCR, MeikiOCR and its detector, VitaOCR/VOCR
and its detector, MIDA + VOCR6-L, the MIDA detector, and Apple Live Text on macOS.
Remote OCR uses Rust HTTP clients for Google Lens, Bing, and Google Vision.
For Google Vision, enable Vision API in your Google Cloud project and save the
downloaded service account key as `~/.config/google_vision.json` or as
`google_vision.json` in your GSM data or portable profile folder.
`GOOGLE_APPLICATION_CREDENTIALS` can point to a key saved elsewhere. Saved
recognition or stability passes that referenced a retired engine use ScreenAI.

Real-engine comparisons cover ScreenAI, OneOCR and live Bing on Windows.
Local socket tests cover OBS authentication and sharing. Portable OneOCR has also been exercised
with a native Linux build under Ubuntu on WSL. A physical macOS run is outstanding.
The native one-shot picker is currently Windows-specific; the saved-area
configuration editor remains Python as allowed in the rewrite scope.

### Reading presets

In **OCR → Advanced → Recognition Pipeline → Reading preset**, every preset
enables two-pass automatic OCR. A local engine checks for stable text. Once it
settles, the main engine reads the detected area at full resolution.

| Reading preset | Stability pass | Main pass |
|---|---|---|
| Google Lens (default) | ScreenAI | Google Lens, online |
| Horizontal Japanese dialogue | MIDA detector | MIDA + VOCR6-L, local |
| Multilingual and vertical text | Meiki detector | ScreenAI, local |
| Wait for horizontal dialogue | MIDA detector | ScreenAI, local |

The default applies to a fresh Advanced configuration. Existing profiles open
with their saved settings. Changing either engine, disabling two-pass OCR, or
disabling the second-pass crop can produce a Custom configuration. Basic mode
has a separate online-scans switch. MIDA downloads its detector on first use
and GSM bundles the fast large VOCR6-L recognizer. [CPU benchmark](benchmarks/ocr-mida-cpu-2026-11-17.md)

### Portable OneOCR setup

On Windows GSM uses the native OneOCR DLL. On Linux and macOS, install the
portable runtime in a dedicated environment and import the models from your own
copy of Snipping Tool. The following commands use Python 3.13 and the versions
tested under Ubuntu. The importer accepts a Snipping Tool folder or an MSIX bundle.

```sh
uv venv --python 3.13 "$HOME/.config/oneocr/venv"
uv pip install --python "$HOME/.config/oneocr/venv/bin/python" \
  'https://github.com/AuroraWright/oneocr_reimpl/archive/f3698522a341bcbe5e61394f61e8ab3ef11efbe6.zip' \
  'onnxruntime==1.32.0' 'numpy==2.2.6' 'opencv-python-headless==4.13.0.92'
"$HOME/.config/oneocr/venv/bin/oneocr-extract-models" "/path/to/SnippingTool"
```

Select **OneOCR** under Main OCR or in the reading overlay. The runtime reads
models from `~/.config/oneocr/models`. To use existing installations elsewhere,
set `GSM_ONEOCR_PYTHON` to the environment's Python executable and
`ONEOCR_MODELS` to the extracted model directory before starting GSM. For Thai
and right-to-left scripts, install the runtime's optional PyICU dependency.
The local worker stays warm between scans and releases its models when GSM
releases the engine. [OneOCR runtime and importer](https://github.com/AuroraWright/oneocr_reimpl/tree/f3698522a341bcbe5e61394f61e8ab3ef11efbe6)

## Verification and measurements

The [measurement report](benchmarks/ocr-native-complete-2026-11-11.md) includes matching
Python/Rust real WGC scans, raw timing/CPU samples, quality checks, and actual
worker lifecycle measurements. The unchanged-image result is not an estimate
of continuous gameplay CPU or of the entire GSM process tree.

Relevant checks:

```powershell
cargo test --locked --manifest-path native/gsm-capture/Cargo.toml
cargo test --locked --manifest-path native/gsm-overlay/Cargo.toml
cargo test --locked --manifest-path src-tauri/Cargo.toml --target-dir src-tauri/target/native-dev -- --test-threads=1
.venv/Scripts/python.exe -m pytest tests/ocr/test_native_context.py tests/util/communication/test_ocr_ipc.py -q
npm run test:ts -- electron-src/main/services/native_ocr.test.ts electron-src/main/ui/ocr.test.ts electron-src/main/ui/ocr-preview.test.ts electron-src/renderer/src/components/tabs/OCRTab.test.tsx electron-src/renderer/src/components/tabs/OCRTextFeed.test.tsx
npm run build:tauri
node scripts/benchmark-native-ocr.mjs .tmp-ocr-benchmark/full-rewrite-final
```

The benchmark needs installed local ScreenAI/OneOCR assets, network access to
Bing, and `ffmpeg` on PATH.
It opens an isolated fixture window and isolated test desktop, then closes them.
It does not change the user's OCR profile or start OCR in their running app.
Ordinary Rust tests skip benchmarks that require local models/live capture.

After building, `node scripts/test-native-services.mjs ocr-flow` verifies the
desktop coordinator end to end on Windows with installed OneOCR assets. It
captures a Japanese test window, runs both manual and automatic OCR using saved
scene areas, and checks delivery to an isolated backend connection. The desktop
runs with Node removed from PATH; the user's text history and settings are not
modified. The ordinary `ocr` service smoke only checks service availability.
