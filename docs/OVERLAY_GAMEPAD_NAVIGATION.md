# Trying the navigation experiments

Open **Overlay Settings → Gamepad → Navigation Experiments**. All options use
existing bindings and default to the original behavior. Keyboard navigation uses
the same options. Settings apply immediately and are saved with overlay settings.

## Combinations to demo

| Use case | Options to try | What to compare |
| --- | --- | --- |
| Long dialogue | Hold Direction: **Jump to sentence starts**; edge: **Wrap within the current block** | Hold to skim sentences, then tap to adjust to a word. |
| Scattered menu text | Up/Down: **Nearest block above/below**; start: **Nearest point to previous position**; **Block-Jump Trail** on | Movement follows screen position and enters near the old cursor, instead of traversing every line. |
| Several large text panels | Up/Down: **Whole blocks in reading order**; start: **Middle of block** | Reach a panel directly, starting with less distance to either edge. |
| Vocabulary study | Hold Direction: **Jump to new Jiten words**; start: **First new Jiten word** | Skip known vocabulary while retaining ordinary taps for precision. |
| Existing navigation, faster | Hold Direction: **Accelerating repeat**; **Left-Stick Speed Curve** on | Compare long holds and full-stick travel against rapid tapping. |

Change one option at a time if you want to isolate what helps. Restore the
entries marked **(default)** and turn off both checkboxes to return to the
original scheme.

## Movement details

- **Holding:** the first press makes an ordinary character/word step. After the
  existing repeat delay, left/right uses the selected jump. Release to stop.
  Acceleration instead speeds up all held directions, reaching a 50 ms interval
  after 1.2 seconds of repeating (never slowing an already faster interval).
- **Sentences:** jumps land on the first selectable character after punctuation.
  Japanese sentence marks, question/exclamation marks, ellipses and periods are
  boundaries. Closing quotes and whitespace are skipped; decimal points between
  digits are ignored. This is a punctuation heuristic, so abbreviations can split.
- **Jiten:** choose new words, words highlighted by your current Jiten styles,
  or the next word with a different set of SRS status classes. Requires Jiten
  Reader highlighting. Existing Reader results are reused without new parse
  requests. Missing, outdated, or nonmatching results fall back to ordinary
  movement. Grading a word updates subsequent jumps.
- **Wrapping:** line/block wrapping constrains both ordinary horizontal movement
  and held jumps. Otherwise jumps can cross blocks and wrap around all available
  targets. Up/down remains available to leave the current line or block.
- **Block hopping:** reading order wraps; spatial hopping chooses a nearby block
  above/below, preferring the same column, and stays put if none exists in that
  direction. Left/right still provides access to text in each block.
- **Starting position:** start, middle, and first-new apply on activation and
  ordinary block entry. First-new falls back to the start if no result is ready;
  later parse results do not pull the cursor away. Nearest-point entry uses the
  previous cursor location on block changes and resumes on activation. Explicit
  sentence/Jiten jumps always land on their target.
- **Left stick:** still a free cursor. The optional curve makes gentle tilts
  slower and full tilt twice as fast as before.
- **Trail:** a 220 ms light streak connects positions on block changes. It cannot
  intercept input, is cleared on exit, and respects reduced-motion preferences.

## Jiten grading in the Yomitan popup

- Use **Previous Entry** (LT by default) above the first definition, or scroll up
  with the right stick at the top of the popup, to select the Jiten bar.
- Press **Previous Entry** again while in the Jiten bar to select **Never Forget**.
- Move the right stick left/right to select a grade, Blacklist, or Never Forget.
  **Good** is selected initially when grading is enabled.
- Press your **Confirm** button to apply the highlighted action. While a grade
  is saving, further confirms wait for the buttons to become available again.
- Use **Next Entry** (RT by default), or scroll down with the right stick, to
  return to the definition actions. Normal scrolling and entry navigation still
  work when the Jiten bar is hidden.

## Verification

From the repository root:

```powershell
npm test --prefix GSM_Overlay
npm run test:gamepad-electron --prefix GSM_Overlay
npm run test:ts -- electron-src/main/ui/gamepad-bindings.test.ts electron-src/main/ui/overlay-settings-keyboard-bindings.test.ts
```

The Electron smoke test runs offline in a disposable profile and prints the
temporary directory containing its settings and block-jump screenshots. Physical
controller feel should still be compared in a game with both short and dense text.
