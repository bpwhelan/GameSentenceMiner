# OCR keyboard passthrough and window visibility — 2026-11-11

This supersedes the focus-based policy in the earlier hotkey report. Every OCR
keyboard binding now uses the existing passive Rust listener. OCR does not call
RegisterHotKey, consume the key, or require foreground focus. The captured game
must be shown and not minimized; Windows DWM-cloaked windows are excluded too.
Windows behind other apps remain eligible. This does not calculate pixel occlusion.

## Verification

- 33 actual Windows key combinations passed: F13–F24, plain/Shift/Ctrl,
  excluding F17, Shift+F17, F18 because they were already reserved
  by existing system registrations (Win32 error 1409). Those reservations were
  left unchanged. All twelve function keys have at least one verified variant.
- For each tested combination: OCR triggered with another test app focused,
  the same key reached that app's WebView, and hiding/minimizing the game
  suppressed the action. Restoring the game re-enabled subsequent input.
- Backtick and tilde remained typeable. Exact modifiers prevented accidental
  matches. Stopping OCR released the subscription.
- 38 accepted key presses each emitted exactly one action. Median key-to-event
  latency was **2.71 ms**, p95 **4.57 ms**, maximum **15.18 ms**.
  These timings include input-service processing, the OCR actor and bridge delivery;
  they are not OCR inference timings.
- 69 TypeScript and 20 Tauri tests passed, including all 36 plain/Shift/Ctrl
  F13–F24 cases in Rust and the shortcut recorder. Three existing native
  inference/capture benchmarks remain separately gated. Main, renderer and
  native development builds completed.

The live test uses an isolated profile and two temporary windows. It refuses to
send input unless its own test window is foreground. Earlier attempts stopped on
focus changes and existing external shortcut interference; the completed run is
hotkeys-8NV0Fd. Occupied combinations are now skipped explicitly before injection.

## CPU measurements

| Ten-second interval | Tauri CPU | Input-service CPU | Combined CPU |
| --- | ---: | ---: | ---: |
| visible-background-keyboard-idle | 0.000% | 0.029% | 0.029% |
| hidden-game-keyboard-idle | 0.020% | 0.020% | 0.039% |
| stopped | 0.000% | 0.117% | 0.117% |

CPU is user + kernel process time divided by elapsed time and all
16 logical processors (AMD Ryzen 7 5800X 8-Core Processor). These are short sequential
observations, not a precise isolated keyboard-listener overhead measurement.
The fixture's Tauri host is included; WebView, Node, Python and OCR inference
are excluded. The input service had an attached controller. Window state changes
also affect the fixture host, so the visible-versus-stopped difference must not
be attributed entirely to hotkey processing. No capture session or polling
thread was added; Windows visibility checks run only on keyboard events.

[Raw measurements and binary identifiers](ocr-hotkeys-visible-2026-11-11.json).
Reproduce with current main/renderer/native builds and the debug input service:

```powershell
node scripts/test-ocr-hotkeys.mjs
```

Windows was exercised; macOS/Linux and alternative keyboard layouts were not
runtime-tested in this run. See [OCR architecture](../NATIVE_OCR.md).
