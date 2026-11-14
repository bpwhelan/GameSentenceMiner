# OCR hotkey regression verification — 2026-11-11

Historical focus-policy results. Superseded by the
[visibility and passthrough policy](ocr-hotkeys-visible-2026-11-11.md).

Plain keys were incorrectly registered with the operating system as global
shortcuts. The running older app reproduced the failure: backtick never reached
the test text field. Its OCR session was stopped to release that registration.

The replacement reserves only combinations containing Ctrl, Alt, Command,
Windows or their aliases globally. Plain and Shift-only combinations use the
existing passive Rust listener and require the captured game to be foreground.
They do not consume the game's input. Consumers hold independent key allowlists
and release them on disconnect, without replacing the overlay's bindings.

The real Windows integration check passed:

- Backtick reached another application's test field without triggering OCR.
- Backtick both reached the game field and triggered its OCR pause action.
- Ctrl+backtick did not also trigger the plain binding.
- Shift+tilde triggered only in the captured game and remained typeable elsewhere.
- Ctrl+F8 triggered globally, including from the other test window.
- Stopping OCR released subscriptions and left normal typing available.

The test uses actual Windows SendInput transitions, the current Rust input
service, the production Node shortcut adapter, and the Tauri OCR actor. It uses
isolated profiles and two temporary windows; it does not change saved bindings.

| Ten-second interval | Tauri CPU | Input service CPU | Combined CPU |
| --- | ---: | ---: | ---: |
| Passive shortcut enabled, idle | 0.342% | 0.117% | 0.459% |
| OCR stopped | 0.176% | 0.098% | 0.273% |

Percentages are process user + kernel CPU time divided by wall time and all 16
logical processors on a Ryzen 7 5800X. The desktop includes the two visible test
windows; the input service had a connected controller. These short sequential
samples show an observed combined difference of about 0.19 percentage points,
not a precise isolated keyboard-listener cost. They exclude WebView processes
and do not measure inference. No additional polling thread or capture session
was added for keyboard input.

Relevant automated checks: 67 TypeScript tests, 61 input-service tests, and
19 Tauri tests passed, plus main/renderer/native builds. Platform-specific and
optional dictionary/benchmark tests remain separately gated.

[Raw CPU measurements](ocr-hotkeys-2026-11-11.json) include binary identifiers.
See [OCR design and shortcut scope](../NATIVE_OCR.md). Reproduce after building:

```powershell
cargo build --locked --manifest-path GSM_Overlay/input_server/Cargo.toml
npm run build:tauri
node scripts/test-ocr-hotkeys.mjs
```

The test refuses to inject input unless its own window is foreground. An older
GSM process still reserving backtick must first stop OCR. Windows was verified;
other platforms and alternative keyboard layouts were not exercised here.
