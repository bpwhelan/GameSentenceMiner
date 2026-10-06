# Experimental game background hooks

Windows 10+; x86 and x64 games. On Home, select the game's OBS capture and use
**Game background behavior (experimental)**. Enable **Automatically apply to this
game** to save an opt-in for that executable's full path. The two behaviors can
be toggled independently while playing. Focus the game once after enabling, then
switch to GSM's overlay to try controller navigation.

GSM follows only the active OBS capture. It stops controlling the previous game
when the capture changes, and attaches again when an opted-in game is relaunched.
An ambiguous target is left alone. A failed attachment is latched until Retry,
another explicit settings change, or a different process is selected.

## What the prototype does

- Keeps the selected game window's focus queries active and suppresses its
  `WM_ACTIVATEAPP(FALSE)`, `WM_ACTIVATE(WA_INACTIVE)`, and `WM_KILLFOCUS` messages.
  It does not change the actual foreground window or undo minimization.
- Filters XInput 1.1, 1.2, 1.3, 1.4, 9.1.0 and UAP exports already loaded in that
  game. Successful state reads become neutral in the background, preserving
  connected devices, and packet numbers change when the exposed state changes.
  Keystroke queues are drained while backgrounded. Ordinal 100 (GetStateEx) is
  covered when exported. Late-loaded XInput libraries are discovered too.
- Uses an unmodified foreground query for input filtering. The fake focus used
  for rendering cannot accidentally re-enable the game's background controller.
- Exposes hook counts, intercepted focus messages, controller read counts and
  blocked read counts. These show interception, not proof that every game engine
  continues rendering or that all of its input paths are covered.

This is for offline games without anti-cheat. Native injection can destabilize an
incompatible game. Special K is detected by module name and by proxy DLL version
metadata; GSM refuses to stack this experiment on it. This is a best-effort
conflict check, not an exhaustive detector of other injectors. No elevation,
debug-privilege request, global hook, driver or game-directory file is used.

DirectInput, Raw Input/HID, native Steam Input and GameInput are not implemented.
Steam Input mapped through XInput uses the implemented path; keyboard emulation
does not. Engines that pause through other mechanisms, stop pumping messages,
or suspend an exclusive-fullscreen graphics device may still need Special K or a
game-specific fix. Minimizing the game is outside the continue-rendering scope.

## Lifetime and build

A matching-bitness controller loads `gsm-game-background.dll` into the verified
PID/window/executable and maintains a three-second lease. Configuration uses a
local Windows mapping. Normal shutdown, closed controller pipes, controller
failure or an expired lease restore pass-through behavior. The DLL and hook
trampolines stay resident until game exit to avoid unloading code a game thread
could still be executing. Restart the game to fully remove the DLL or try a new
DLL build. Modified input DLLs are pinned for the same reason.

Build outputs use immutable content-addressed directories selected by
`bin/<architecture>/current.json`. Rebuilding does not overwrite a DLL still
mapped in a game. A controller from a different build refuses to reuse the old
DLL and asks for a game restart. Only the current build is staged for packaging.

The build uses Visual Studio C++ and CMake. MinHook 1.3.4 is vendored, so no extra
download is needed. The regular Windows helper packaging workflow includes both
architectures and dependency notices.

```powershell
npm run build:game-background
npm run test:game-background
npm run test:ts -- electron-src/main/services/game_background.test.ts
```

The native test creates disposable hidden game processes with a deterministic
XInput DLL. It verifies real x86/x64 injection, neutral buttons/axes/triggers,
disconnected-slot preservation, keystroke filtering, packet changes, render
ticks, independent options, clean stop, reconnection, single ownership, crash
recovery and late module loading. Real game animation and foreground controller
behavior must additionally be tried in the game; counters alone cannot prove
those behaviors.

Electron's main-process build, renderer bundle and focused service/UI tests pass.
The standalone full renderer type-check still reports errors in unchanged
`App.tsx` (nullable install-session snapshot), `GameAutomationTab.tsx`
(`details.defaultOpen`) and `lib/theme.ts` (theme category typing).

Initial local trial (October 5, 2026): Akaiito HD Remaster accepted the x64 DLL
with three focus API hooks, one window procedure hook and four XInput state
hooks, with no reported hook errors. The brief unattended run recorded 9,226
filtered controller reads while Windows still reported the game in the
background. The trial was stopped and `--status --pid <pid>` confirmed
`effective: 0`. Animation and controller behavior during real focus changes
remain unverified in Akaiito because the user was away from the computer.
