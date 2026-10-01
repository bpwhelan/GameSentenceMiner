# Overlay gamepad navigation

This audit keeps existing settings, bindings, reader transports, and public
`GamepadHandler` methods. The rewrite consolidates action dispatch, repeat
scheduling, selection transitions, and asynchronous tokenization ownership.

## Ownership

| Layer | Responsibility |
| --- | --- |
| `GSM_Overlay/index.html` | Load settings, lazily load the handler, reconcile its lifetime, publish status and forward Electron IPC. |
| `GSM_Overlay/gamepad.js` | Normalize input, activate navigation, move selections, request tokens, manage repeat timers and render navigation visuals. |
| `GSM_Overlay/dictionary_navigation.js` | Adapt popup discovery, controls and mining to Yomitan or Hachidori. |
| `GSM_Overlay/jiten_highlight.js` | Provide Jiten navigation tokens and notify the handler when that data changes. |
| `GSM_Overlay/main.js` | Own overlay focus, pass-through, manual capture and forwarding approved actions to the target window. |
| `electron-src/main/services/input_server.ts` | Start the shared native input service and distribute its actual endpoint. |
| `GSM_Overlay/input_server/src/` | Capture native input and serve local tokenizer/furigana requests. |

`GSM_Overlay/window.js` is an unrelated window-discovery example, not the
renderer navigation entry point. Dictionary vendor trees remain generated
output; gamepad integration changes belong in GSM-owned adapters.

## Behavior contracts

- The renderer has at most one live handler. A settings snapshot updates it in
  place. Settings changed while the script loads are checked again before
  creation; disabling navigation and furigana cannot be undone by a late load.
- A failed module load is retryable. Hotkeys received while loading wait for the
  handler, and repeated requests with the same ID toggle only once.
- Controller and keyboard input share action dispatch and repeat scheduling.
  Repeat ticks resolve current bindings and held state. Releasing a chord,
  suppressing input, disconnecting or destroying the handler stops repeats.
- Modifier activation records the input that owns the session. Releasing an
  unrelated keyboard modifier or another controller does not end that session.
- Only the current WebSocket may change connection or input state. Retired
  sockets and delayed callbacks cannot revive a destroyed handler.
- Directional movement enters blocks through one transition and finalizes only
  after the selected anchor or block changes. No-op movement does not repeat a
  lookup. Direct and wrapped movement skip unselectable blocks consistently.
- Character selection uses the actual navigation mode, including temporary
  character fallback on a line inside a token. Incomplete line metadata falls
  back to geometry instead of dropping unlabelled characters.
- Applying the current token mode again is a no-op. An actual mode change
  converts the anchor once and clears its temporary character override.
- Each block has one current tokenization request. Only that request may cache
  tokens, change the current selection or begin fallback. A superseded request
  cannot clear a newer request's pending state.
- Native `tokenize` requests and `tokens` responses optionally carry
  `requestId`. The client validates request ID, text and tokenizer backend;
  old requests without IDs remain supported. Replies from old servers lacking
  IDs can only be checked against text/backend, so full same-text correlation
  requires the updated native service.
- Native tokenization waits for completion with a five-second timeout before
  falling back. Disconnection, cancellation and send failure release pending
  requests and timers. Expired furigana responses do not repaint later text.
- Remote tokenizer offsets are converted from UTF-16 to overlay character
  indices once, when accepting tokens. Malformed ranges are discarded and
  character fallback preserves astral characters such as `𠮷`.
- Reader subscriptions discover already-open popups. Hachidori's initial state
  is merged by popup ID with intervening events, so a child opening or closing
  cannot erase its parent's state or resurrect a closed popup.

## Bugs addressed

The regression tests cover duplicate handlers during concurrent initialization,
disabled handlers created by late loads, permanently cached load failures,
navigation resets on repeated settings snapshots and lost startup hotkeys.
Popup tests cover Yomitan popups opened before navigation is enabled and
Hachidori state/event races during subscription.

Input tests cover stale socket callbacks, modifier ownership, duplicate input
edges, repeat cancellation, invalid binding/timing values, and delayed popup
dismissal after re-entry. Selection tests cover horizontal edge traversal,
selectable-block skipping, stable no-op selections, lines inside multi-line
tokens, character overrides and incomplete line metadata. Token tests cover
out-of-order results, request cancellation, fallback, unavailable native
tokenizers, Unicode offsets and expired furigana replies.

## Verification

Validated in this checkout:

- Overlay suite: 326 passed, one native vocabulary test skipped because its
  separate binary/dictionary fixture was not configured.
- Targeted binding, keyboard-settings, hotkey-recovery and source-pause suites:
  68 TypeScript tests passed.
- Native input server: 60 passed, two installed-dictionary tests ignored.
- Electron gamepad and Hachidori smoke tests and native request-ID smoke passed.
- Electron production build and native release build passed.
- Managed restart completed with the app/backend ready and the rebuilt native
  helper running from `input_server/bin/gsm_overlay_server.exe`.

Run the overlay unit suite from the repository root:

```powershell
npm --prefix GSM_Overlay test
npm run test:ts -- electron-src/main/ui/gamepad-bindings.test.ts electron-src/main/ui/overlay-translation-controls.test.ts
cargo test --manifest-path GSM_Overlay/input_server/Cargo.toml --bin gsm_overlay_server
```

The new focused suites are `gamepad_input_lifecycle.test.cjs`,
`gamepad_renderer_lifecycle.test.cjs`, `gamepad_selection.test.cjs`,
`gamepad_tokenization.test.cjs`, and `dictionary_navigation_lifecycle.test.cjs`.
They complement existing navigation, manual activation, focus and reader tests.

Exercise Electron and a built native helper separately:

```powershell
npm --prefix GSM_Overlay run test:gamepad-electron
npm --prefix GSM_Overlay run test:hachidori-electron
node GSM_Overlay/tests/tokenization-server-smoke.cjs <path-to-built-input-server>
```

The native protocol smoke starts its own helper on an OS-assigned port with
isolated settings, checks correlation IDs and legacy requests, and stops only
that helper. Empty text avoids requiring installed tokenizer dictionaries.

Development runtime chooses the newest existing helper among `target/debug`,
`target/release`, and `input_server/bin`. Packaging additionally checks
`input_server/bin/<platform>`. A successful compile must reach the binary the
runtime selects. On Windows, a running executable may prevent Cargo from
copying the linked artifact from `target/release/deps` into `target/release`;
that is a failed build command, even when linking finished. Stage a verified
artifact into a selectable unused path, restart through the managed workflow,
then repeat the build once the old executable is released.

Use the managed restart described in [AGENT_RESTART.md](AGENT_RESTART.md) after
building and checking changes. Never replace a failed restart with broad
process-name termination.

## Manual checks and limits

Automated input tests use synthetic events; they do not establish physical
controller compatibility, latency or target-game focus behavior. Check these
on hardware before a release:

1. Hold and toggle activation with controller and keyboard, including two
   controllers, modifier release, disconnect/reconnect and settings input capture.
2. Rapidly exit/re-enter navigation with a visible reader popup; confirm no
   delayed close, stuck repeat, extra toggle or lingering click interception.
3. Traverse real OCR layouts containing multiple blocks, wrapped dialogue,
   continuation lines, non-Japanese text and astral characters in both modes.
4. Scroll and select popup actions with the right stick; mine from parent and
   nested popups in both readers.
5. Change tokenizer settings and OCR text while requests are pending; confirm
   the selected character stays stable and unavailable services fall back.
6. Verify manual capture/freeze-frame entry, game focus restoration and the
   chosen input service binary after a managed restart.
