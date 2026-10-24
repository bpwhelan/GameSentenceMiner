# Magpie compatibility

This implementation was checked against Magpie **v0.12.1**, the version installed
when this rewrite began. It does not modify Magpie, inject into the game, change
cursor clipping, or synthesize OS mouse input. Projected DOM hover events feed
the dictionary scanner; button presses remain real input delivered by the OS.

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
without activation, following Magpie's z-order work. A background notification
preserves geometry and lowers GSM unless an explicit overlay interaction owns
focus. Ordinary text arrival never reasserts topmost.

Cross-thread activation can still finish restacking windows **after** that
broadcast. This was reproduced when leaving controller navigation: the game
regained foreground focus, GSM rose above the scaler, then the scaler rose above
GSM again while GSM remained visible. An out-of-context
[`EVENT_OBJECT_REORDER` listener](https://learn.microsoft.com/en-us/windows/win32/winauto/event-constants)
observes desktop child order on Electron's message loop. It ignores accessibility
changes inside other windows and coalesces each burst outside the native callback
to avoid [WinEvent reentrancy](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwineventhook).
The session revalidates the selected source and scaling window, requires the
game to still own foreground focus, and checks the actual native order. Only a
scaler above a visible, eligible GSM overlay causes a non-activating raise.
Our resulting reorder event does nothing once that order is correct. Hidden
manual overlays and other foreground apps are respected; there is no periodic
topmost retry or extra focus handoff. Disposal cancels queued work and unhooks
the native listener.

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

In automatic mode, **game text remains click-through even while hovered or while
a dictionary popup is open**. Real popup surfaces and toolbar controls still
accept input. Explicit manual/controller/resize interaction and the optional
focus-on-lookup setting retain their existing ownership. Text selection and
click-triggered lookup therefore belong to those explicit interaction modes.

For ordinary windows, Electron's
[`setIgnoreMouseEvents(true, {forward: true})`](https://www.electronjs.org/docs/latest/api/base-window#winsetignoremouseeventsignore-options)
passes real clicks through while forwarding mouse movement to Chromium. Its
forwarded movement is available on Windows and macOS; Linux retains its existing
input behavior.

Magpie's captured cursor is still in source coordinates. The existing sampler
projects it into the displayed image and includes held buttons and modifiers.
`text_hover.js` hit-tests actual laid-out elements, respecting font fitting,
offsets, visibility, clipping and the occlusion mask. It feeds projected pointer
and mouse movement to the dictionary scanner without acquiring native input over
game text. Raw source-coordinate hover is suppressed during that projection.
Stationary samples are deduplicated so they cannot continually reset Yomitan's
scan delay; modifier-only changes still reach the scanner. No mouse-button or
click events are synthesized, and the previous one-alpha text surface is gone.

Only a hit on a popup/control requests native input, allowing Magpie itself to
hand off the cursor. A capture-style transition skips one sample because Magpie
updates the style before moving the cursor. Samples outside the source rectangle
are not projected across letterbox/monitor gaps. Monitor origins and physical/CSS
dimensions are applied once at this boundary.

Mouse ownership changes only after a current hit result. A held button preserves
its current recipient, including a press begun while Chromium was answering.
Main-process guards protect manual activation, controller navigation, focused
dictionary interaction, resizing, and custom pages from late pointer replies.
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

## Visibility and source-window order

The Windows monitor reads Magpie's session **before** checking visibility. With
scaling active, it starts the coverage walk above the scaling HWND and measures
`Magpie.Dest*`, the displayed image rectangle. Windows between the source and
Magpie cannot hide GSM or mask its text. Windows above Magpie mask their actual
desktop positions, without projecting those rectangles through the source
transform. Letterbox borders do not count as uncovered game content. Starting,
stopping, or moving scaling invalidates cached coverage even without a WinEvent.

Fullscreen size follows the scaling window, including its letterbox surface;
it does not imply Direct3D exclusive fullscreen. Capture/OCR coordinates,
keyboard focus, and `target_window_rect` still describe the original game.

When the game **already owns foreground focus**, a window can nevertheless slip
between it and Magpie's topmost image. The monitor detects overlapping windows
in that gap and requests one non-activating `HWND_TOP` reorder of the source.
This follows the operation in Magpie v0.12.1's
[`ScalingWindow::_UpdateFocusState`](https://github.com/Blinue/Magpie/blob/v0.12.1/src/Magpie.Core/ScalingWindow.cpp).
It rechecks the matching session, focus, and geometry before acting, preserves
size/position/topmost status, and uses `SWP_ASYNCWINDOWPOS` to avoid waiting on
another app's input queue. See
[`SetWindowPos`](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowpos)
for the flag and ownership behavior.

The repair respects topmost apps and the game's owned dialogs. It does not run
when another app owns focus, and it does not retry an unchanged obstruction.
There is no new polling loop or focus-stealing fallback. A native regression test
reproduces the gap with off-screen fixture windows and verifies that the source
returns below Magpie, GSM stays above Magpie, and real desktop focus is unchanged.

## Validation and rollback

Run from the repository root:

```powershell
node --test GSM_Overlay/tests/*.test.cjs
node GSM_Overlay/tests/run-magpie-native-electron.cjs
node GSM_Overlay/tests/run-yomitan-startup-electron-smoke.cjs
node GSM_Overlay/tests/run-overlay-render-electron.cjs 5ab505c3
npx vitest run --config vitest.config.ts electron-src/main/magpie.test.ts electron-src/main/ui/live-stats-widget.test.ts --maxWorkers=1
.venv/Scripts/python.exe -m pytest tests/util/platform tests/util/overlay tests/web/test_overlay_handler.py -q
```

The native smoke test uses an invisible, non-focusable fixture and sends its test
message only to that fixture. It does not broadcast to or change the user's game.
The Yomitan smoke test loads the bundled reader and a small dictionary in a
temporary profile. It checks ordinary and projected hover against the actual
frontend, verifies popup hit regions and native click-through, and checks that
hover creates no click events or desktop focus changes.
The renderer comparison checks all painted text and bounds against the baseline;
the intentionally removed invisible hit areas are excluded and asserted absent.

The rewrite is isolated from baseline commit `5ab505c3` on `main`. Revert the
rewrite commit to restore that implementation. Gameplay checks after restart
should cover hover/lookup/close, controller and manual activation, Alt-Tab,
scaling start/stop, and windowed scaling across monitors. Automated native/DOM
checks do not substitute for those checks in the user's games.
