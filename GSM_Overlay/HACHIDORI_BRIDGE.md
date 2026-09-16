# Dictionary navigation and the Hachidori bridge

Hachidori uses the same `GamepadHandler` as Yomitan. Controller/keyboard bindings, OS input, character and token navigation, virtual cursor movement, repeats, and lookup targeting are shared. The configured dictionary reader selects a small popup adapter. Tokenization remains a separate service choice (Sudachi, MeCab, Jiten, JPDB, or Yomitan); Hachidori does not provide a tokenizer.

## Ownership

| File | Responsibility |
| --- | --- |
| `gamepad.js` | Shared input and text navigation |
| `dictionary_navigation.js` | Reader registration, control dispatch, popup subscriptions, target attributes |
| `extension_bridge.js` | Shared request IDs, response correlation, timeouts, errors, teardown |
| `yomitan_bridge.js`, `hachidori_bridge.js` | Public reader API facades |
| `popup_navigation.js` | Reader-neutral action selection, scrolling, entry/grade-row movement |
| `jiten_grading_bar.js` | Reader-neutral grading bar using GSM's existing Jiten host service |
| `integrations/hachidori/bridge.js` | Hachidori API registry, lookup cancellation, lifecycle and navigation ownership |
| `integrations/hachidori/popup.js` | Hachidori view/entry/button mapping into the shared popup controller |
| `../scripts/hachidori-integration.mjs` | All upstream hooks and generated asset registration |
| `hachidori/` | Generated vendor output, including copies of GSM modules in `gsm/` |

The existing Yomitan extension protocol stays compatible. Hachidori does not impersonate its iframe or consume its messages. A reader adapter implements `control`, `mine`, `canConfirm`, `setNavigationActive`, `subscribe`, and `targetAttribute`. Additional readers can register a factory with `GsmDictionaryNavigation.registerReader(name, factory)`.

## Hachidori controls

The configured GSM buttons and keyboard equivalents work for both readers:

- Character/token navigation looks up the selected DOM text directly, including ruby base text.
- Next/previous entry operates on the deepest visible popup.
- The right stick scrolls vertically and selects entry actions horizontally. Confirm activates the selected action, with disabled/busy controls blocking repeated submissions.
- Mine, audio, history, and entry commands use Hachidori's native controllers.
- Moving above the first entry selects the Jiten grading row when enabled. Moving down returns to the first entry. GSM owns all Jiten credentials and API calls.
- Cancel closes the popup and cancels pending lookups. The navigation mode remains active.

The bridge reports actual visible popups through `gsm-hachidori-popup-shown` and `gsm-hachidori-popup-hidden`, with `{popupId, depth}`. These are separate from upstream Hachidori's host-attention events, which can also represent a text-selection drag. GSM's usual `gsm-anki-note-added` event fires on a confirmed native add/update.

During controller navigation, Hachidori's hover, hide timers, blur dismissal, and overlapping keyboard handlers yield to GSM. Native mouse behavior resumes when navigation ends.

## Public API

The overlay exposes `window.gsmHachidoriBridge`. The bridge runs only on GSM's local overlay page or its fixed development origin, and accepts messages from that page's own window. It forwards explicitly registered actions; callers cannot choose arbitrary extension targets, runtime message types, or JavaScript to execute.

```js
const hd = window.gsmHachidoriBridge;
const supported = await hd.capabilities(); // {reader, version: 1, actions, controls, commands}
const state = await hd.state();
const terms = await hd.termEntries('食べた'); // native Hachidori results; does not open a popup
const kanji = await hd.kanjiEntries('食');
await hd.control('command', {command: 'playAudio'});
await hd.closePopups();
```

All actions are also available through `invoke(action, body, {timeoutMs})`. Commands first wait for a shared capability handshake (up to five seconds at startup). The request timeout defaults to 2.5 seconds and can be extended up to 120 seconds. Only the startup handshake is retried. A timeout does not establish whether a mutating operation completed; do not automatically retry an Anki submission.

| Action | Input and result |
| --- | --- |
| `capabilities` | Version and supported action/control/command names |
| `state` | Navigation state, visible popup IDs/count, dictionaries, selection |
| `selection` | Current depth/index, view kind, sentence, match offset, native term result |
| `options` | Stored options including their revision |
| `status` | Native dictionary engine status |
| `terms` | `{text, scanLength?, maxResults?, options?}`; defaults to current reader settings |
| `termsInDictionary` | Term arguments plus `{dictionary}` |
| `kanji` | `{character}` |
| `styles`, `media` | Native dictionary styles; media uses `{dictionary, generation, path}` |
| `dictionaries` | Native state with its revision |
| `updateDictionaries` | Native `{baseRevision, dictionaries, groups?}` with conflict checking |
| `updateOptions` | Native `{baseRevision, options}` patch with conflict checking |
| `customDictionary` | Native custom dictionary document |
| `saveCustomDictionary`, `appendCustomEntry` | Native `hd_custom_save` / `hd_custom_append` payloads |
| `reload` | Reload the dictionary engine |
| `lookupStats` | Native `{term, reading}` lookup statistics |
| `ankiStatus` | Native Anki availability/configuration identity |
| `ankiPreflight`, `ankiSubmit`, `ankiBrowse` | Native `{request}` payloads; normal gamepad mining uses the native popup controller to prepare these |
| `control` | `{action, ...arguments}`; see the capability list |

Control actions include `lookup-point` (`targetId` or finite `x,y`), `navigation-active` (`active`), `hide-popup`, `mine`, `scroll` (`direction, step`), `select-action` (`direction`), `reset-action-selection`, `clear-action-selection`, `confirm-action`, `next-entry`, `previous-entry`, and `command` (`command, argument?`). Native command names are listed by capability discovery.

Responses preserve native Hachidori data instead of attempting to convert it to Yomitan's schema. The public facade is intentionally small; add a named action to the registry for another native capability and test its routing. No worker/offscreen implementation is forked. Hachidori's own validation and revision checks remain in effect.

## Updating and validating

Edit GSM source modules, then regenerate:

```powershell
node scripts/hachidori-integration.mjs
```

For upstream updates, use the existing clean-checkout sync:

```powershell
node scripts/sync-hachidori.mjs C:\path\to\hachidori
```

The script validates every expected upstream hook before replacing the vendor copy, inserts small lifecycle hooks, registers the GSM scripts before `content.js`, and copies the source modules into `hachidori/gsm/`. Regeneration is idempotent. `SOURCE.json` records both the upstream commit and an integration SHA-256 fingerprint; Electron includes both in its extension cache identity. Upstream hook drift produces an actionable failure in the release-update workflow.

From the GSM repository root:

```powershell
node --test scripts/sync-hachidori.test.mjs scripts/hachidori-integration.test.mjs
node --test GSM_Overlay/tests/*.test.cjs
npm run test:ts -- electron-src/main/ui/gamepad-bindings.test.ts
node GSM_Overlay/tests/run-hachidori-electron-smoke.cjs
node GSM_Overlay/tests/run-gamepad-electron-smoke.cjs
node GSM_Overlay/tests/run-jiten-electron-smoke.cjs
```

The Hachidori smoke test loads its actual content scripts and renderer in Chromium's extension isolation, with fixture dictionary/audio/Anki services in a temporary profile. Its gamepad configuration comes from the production main-process reader selection, settings payload builder, and renderer configuration functions. It checks navigation of a mouse-opened popup, ruby targeting, mining once, nested entry routing, parent restoration, grading, audio, scrolling, hover ownership, and cancellation of late lookups. It makes no real Anki submissions or Jiten requests. Physical controller hardware remains a manual check.
