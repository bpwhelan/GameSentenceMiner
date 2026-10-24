# Magpie compatibility

This implementation was checked against Magpie **v0.12.1**, the version installed
when this rewrite began. It does not modify Magpie, inject into the game, change
cursor clipping, or synthesize mouse input.

## Evidence and contracts

- [Magpie's integration API](https://github.com/Blinue/Magpie/blob/v0.12.1/docs/Interact%20with%20Magpie%20programally.md)
  defines `MagpieScalingChanged`, the scaling window class, and the `Magpie.*`
  properties. Properties are valid only on a visible scaling window, and their
  coordinates are physical desktop pixels.
- [MagpieWatcher](https://github.com/Blinue/MagpieWatcher/blob/204ed5b0bec51eb49f4ff7f99c7949e9ff02ec2a/MainWindow.cpp)
  demonstrates startup discovery, the UIPI message filter, and raising an overlay
  after Magpie's foreground notification. Notifications distinguish background
  scaling (`0,1`) from stopping (`0,0`), and windowed movement (`3` then `2`).
- [CursorManager.cpp](https://github.com/Blinue/Magpie/blob/v0.12.1/src/Magpie.Core/CursorManager.cpp)
  explains the cursor bridge. While passing input to the source, Magpie sets
  `WS_EX_TRANSPARENT` on its scaling window. On relinquishing capture, it clears
  that style and moves the hardware cursor to the scaled position. Its native
  hit test ignores fully transparent pixels. Cursor projection maps the first
  and last pixel centers; image geometry maps rectangle edges.
- [Electron's window APIs](https://www.electronjs.org/docs/latest/api/browser-window)
  provide `hookWindowMessage`, `getNativeWindowHandle`, `showInactive`, and mouse
  pass-through. Native bindings use the existing Koffi dependency.
- [GetPhysicalCursorPos](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getphysicalcursorpos)
  supplies physical cursor coordinates without relying on thread DPI virtualization.

The cursor style is an **implementation detail verified in v0.12.1**, not a
documented Magpie property. Recheck it when upgrading Magpie. The broadcast and
geometry protocol is the documented integration surface.

## Ownership

`magpie_native.js` is the read-only Windows adapter plus registered-message
listener. It validates visibility and `Magpie.SrcHWND` against the backend's
selected game before using any properties. It decodes property coordinates as
signed 32-bit values and keeps window handles pointer-sized.

`magpie_session.js` owns the native session. A foreground broadcast raises GSM
once without activation, after Magpie has finished its own z-order work. A
background notification preserves geometry and lowers GSM unless an explicit
overlay interaction owns focus. Ordinary text arrival never reasserts topmost.

Notifications wake the existing Python monitor through its owning event loop;
they do not run a second concurrent monitor. The normal polling path remains a
recovery mechanism for startup and missed notifications. Explicit refreshes
publish a new generation even if the observed state is unchanged, allowing a
deferred obscured state to be reconsidered after focus restoration completes.

The backend remains the authority for coordinate payloads and monitor selection.
`magpie.js` holds the shared physical-pixel transforms used by text and the stats
widget. Native pointer samples include a geometry signature; the renderer rejects
samples for geometry it has not received yet. This prevents hits against text
rendered with an older transform.

## Mouse interaction

While automatic interaction is available, the session samples the real cursor
and Magpie's capture style every 16 ms. This is input sampling, not a periodic
mouse release. At most one renderer hit test is in flight; a stalled reply can
expire without changing input ownership. During a windowed drag, the same timer
refreshes native geometry until Magpie broadcasts the end of movement.

Captured cursor coordinates are projected to the displayed image. Chromium
then hit-tests the actual laid-out elements, respecting font fitting, offsets,
visibility, and the occlusion mask. Monitor origins and physical/CSS dimensions
are applied at this boundary. There are no padded source-coordinate hit boxes.

On a hit, the renderer gives the lookup surface one alpha unit so Magpie's native
hit test can detect it, keeping OCR text transparent over the game. Enabling input
allows Magpie itself to hand off the cursor. A change in capture style skips one
sample because Magpie updates the style before moving the cursor. Samples outside
the source rectangle are not projected across letterbox/monitor gaps.

Mouse capture changes only in response to a current hit result. Main-process
ownership guards preserve dictionaries, manual activation, controller navigation,
resizing, and custom pages. Late pointer replies cannot override these owners.
Relative-input/3D games still use GSM's existing manual interaction path; this
bridge does not alter a game's cursor lock.

## Focus handoff

Returning to a scaled game requests backend activation without first blurring
GSM. The request carries its ID and expected game HWND. The backend acknowledges
the result after its activation attempts. Only a confirmed failure allows one
blur-and-retry fallback. A three-second RPC expiry cancels work without forcing
focus. New manual/controller/dictionary/resize interactions cancel pending
backend retries, and stale acknowledgements are ignored.

Removed behavior includes the one-second forced release loop, the 250 ms guessed
focus fallback, the 500 ms obscured-state grace period, the controller release
retries, periodic text-triggered topmost recovery, and the unused undocumented
`Magpie.ToolWindow` property setter.

## Validation and rollback

Run from the repository root:

```powershell
node --test GSM_Overlay/tests/*.test.cjs
node GSM_Overlay/tests/run-magpie-native-electron.cjs
node GSM_Overlay/tests/run-overlay-render-electron.cjs 5ab505c3
npx vitest run --config vitest.config.ts electron-src/main/magpie.test.ts electron-src/main/ui/live-stats-widget.test.ts --maxWorkers=1
.venv/Scripts/python.exe -m pytest tests/util/platform tests/util/overlay tests/web/test_overlay_handler.py -q
```

The native smoke test uses an invisible, non-focusable fixture and sends its test
message only to that fixture. It does not broadcast to or change the user's game.
The renderer comparison checks all painted text and bounds against the baseline;
the intentionally removed invisible hit areas are excluded and asserted absent.

The rewrite is isolated from baseline commit `5ab505c3` on `main`. Revert the
rewrite commit to restore that implementation. Gameplay checks after restart
should cover hover/lookup/close, controller and manual activation, Alt-Tab,
scaling start/stop, and windowed scaling across monitors. Automated native/DOM
checks do not substitute for those checks in the user's games.
