# Yomitan popup baseline checklist

Use this checklist before replacing direct Yomitan popup ownership with the
backend-neutral dictionary controller. Record the package commit, operating
system, game, display scale, and capture mode with the results.

## Windows

- [ ] Windowed game: pointer lookup opens a popup and blocks click-through.
- [ ] Borderless game: closing the final popup restores game interaction.
- [ ] Exclusive fullscreen game: lookup does not strand overlay focus.
- [ ] Nested glossary popup: closing the child keeps the parent interactive.
- [ ] Manual hold: releasing the hotkey closes lookup and restores the configured inactive state.
- [ ] Manual toggle: popup close does not exit active manual mode.
- [ ] Magpie: popup anchor follows the scaled text and close recovery restores topmost state.
- [ ] Controller: first confirm looks up; second unchanged confirm mines.
- [ ] Controller: moving the target, rebuilding text, or closing the popup prevents stale mining.
- [ ] Right stick scroll/action selection and next/previous entry reach only the topmost popup.

## Linux

- [ ] Pointer lookup preserves the existing hide/focus workaround.
- [ ] Closing the final popup restores game focus without hiding a newer popup.
- [ ] Manual hold/toggle and controller focus ownership match the Windows behavior.

## macOS

- [ ] Pointer lookup disables click-through while the popup is actionable.
- [ ] Closing the final popup restores pass-through and prior focus state.
- [ ] Manual hold/toggle and controller focus ownership match the Windows behavior.

## Profile And Settings

- [ ] Fresh settings retain current defaults, including focus-on-lookup disabled.
- [ ] Switching overlay profiles restores that profile's interaction and tokenizer settings.
- [ ] Popup behavior does not change the selected tokenizer backend.
- [ ] Existing Yomitan settings, dictionaries, and mining templates remain intact.

The automated companion coverage lives in
`dictionary-popup-lifecycle.test.ts`, `dictionary-settings.test.ts`, and
`gamepad-bindings.test.ts`. Packaged manual results belong in release
qualification evidence rather than this reusable checklist.
