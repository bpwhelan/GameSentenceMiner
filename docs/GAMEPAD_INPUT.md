# Gamepad input and generic controllers

On Windows, the Rust input server uses SDL's game controller and joystick APIs.
SDL's native HID drivers decode Switch and PlayStation controllers, while its
Windows joystick backends support Xbox and generic DirectInput devices. This
avoids the false button presses seen when Windows Gaming Input's generic parser
reads a Switch Pro controller's full HID reports. SDL is bundled and statically
linked: no SDL DLL, controller emulator, or additional runtime installation is
needed. Linux and macOS continue using gilrs' native backends.

The Windows helper initializes SDL without a video window. It disables SDL's
Raw Input and Xbox HID drivers so Xbox controllers use the XInput backend;
Switch and PlayStation HID decoding and generic DirectInput input remain enabled.

## Mapping a device

1. Open Overlay Settings → Gamepad and check the connected device list.
2. Use **Start Test** to inspect its buttons and axes.
3. Click a controller binding, press a button or combo, and release to save it.
4. Configure **Navigate Up/Down/Left/Right** for an unusual directional layout.
   Backspace or Delete clears a binding; Escape cancels capture.

Capture and the input test use the Rust server's state while connected, so their
IDs match navigation even if Chromium assigns different button numbers or cannot
see the device. Browser input remains a fallback when the server is disconnected.
Bindings are shared across devices, as before; use the ignored-device list to
exclude unwanted controllers.

Known controls retain the existing Xbox-style IDs (0–16). Unmapped buttons are
shown as **Button N**. Unmapped axes and hats are also exposed as two numbered
buttons, one for each direction, pressed past the server's trigger threshold
(0.5 by default). These can be assigned to the same settings as physical buttons.
This is a basic fallback, not controller-specific layout calibration: a numbered
input need not match the button number printed on the device, and analog sticks
recognized by the backend still use their standard navigation roles. Known
controllers use Xbox-style button positions, including Nintendo controllers.

## Manual mode and navigation

**Push to Show → Manual Mode** also controls gamepad and keyboard navigation.
With **Hide overlay until activation**, overlay text and navigation highlights
stay hidden until you use the manual hotkey or enter navigation. You do not need
to press the manual hotkey separately before activating navigation. With
**Keep overlay visible, disable interaction**, text stays visible, and activation
enables interaction.

The manual hotkey uses the hold/toggle type in Push to Show. Navigation uses its
own activation mode and bindings in Gamepad settings. Leaving navigation restores
the inactive behavior unless the manual hotkey is still active.

On entry, GSM applies **Starting Position** and, when enabled, **Auto-Confirm
Selection** opens the selected word. These actions wait until the text is visible
and selectable, including when a frozen background or the first OCR result is
still arriving. Releasing navigation before then cancels the pending lookup.

**First new Jiten word** selects the first unknown word in the selected block.
If Jiten is still parsing, navigation starts at the beginning and moves to the
first unknown when results arrive, provided you have not moved or confirmed the
selection. If no unknown word is available, it stays at the beginning. Reopening
unchanged text resumes your last selection; new text uses the starting position
again. Hiding the overlay preserves Jiten results, so the same text does not need
another parse just to re-enter navigation.

## Protocol and implementation

- Existing `button`, `axis`, `gamepad_connected`, `gamepad_disconnected`, and
  `gamepad_state` messages remain compatible.
- Raw controls use a backend-specific code. For code `c`, the raw
  button ID is `32 + 3*c`; negative and positive axis directions use the next two
  IDs. Windows uses the joystick button index, `0x10000 + axis index`, and
  `0x20000 + 2*hat index` (X) or the next code (Y). Other platforms preserve the
  native gilrs code. The complete u32 code fits in a JSON/JavaScript integer.
- Raw analog values are reported under `raw_<code>` axis names. Known controls
  continue through the standard mapping, without duplicate raw events. SDL's
  additional joystick events are ignored for mapped controllers.
- IDs are stable for a given device/backend mapping, not portable between OSes
  or controller drivers. Existing saved bindings may need to be recaptured when
  changing drivers or switching from the older XInput-only server.
- Unplug removes the server state; reconnect creates fresh state. Capture drops
  unfinished combinations when a device or server connection disappears.

Build and validate from the repository root. Windows builds need CMake and the
Visual C++ build tools to compile bundled SDL; `.cargo/config.toml` supplies the
compatibility setting needed by CMake 4. Tests include SDL virtual devices to
check idle connection behavior and button delivery without physical hardware.

```powershell
cargo test --manifest-path GSM_Overlay/input_server/Cargo.toml
cargo build --release --manifest-path GSM_Overlay/input_server/Cargo.toml
node --test GSM_Overlay/tests/gamepad_server_capture.test.cjs GSM_Overlay/tests/gamepad_navigation.test.cjs
npm run test:ts -- electron-src/main/ui/gamepad-bindings.test.ts
```

Restart the development app to pick up the newly built server. Packaged releases
must include the rebuilt server binary as well as the overlay JavaScript.

References: [Rust SDL2 bindings](https://docs.rs/sdl2/latest/sdl2/),
[SDL Switch HID driver](https://github.com/libsdl-org/SDL/blob/SDL2/src/joystick/hidapi/SDL_hidapi_switch.c),
[gilrs backends](https://docs.rs/gilrs/latest/gilrs/).
