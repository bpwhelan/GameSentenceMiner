# Optional HoshiDicts Backend Implementation Plan

## Document status

- **Status:** Planning complete; implementation has not started.
- **Target repository:** `bee-san/GameSentenceMiner`
- **Planning branch:** `plan/optional-hoshidicts`
- **Upstream base:** `bpwhelan/GameSentenceMiner@ccc7f920`
- **Last source audit:** 2026-08-04
- **Primary user outcome:** A user can choose HoshiDicts as the overlay dictionary
  backend, manage imported Yomitan-format dictionaries, and switch back to the
  existing Yomitan backend without losing either backend's data.
- **Default behavior:** Yomitan remains selected on existing and new installs.
- **Scope of this file:** Design and execution plan only. It intentionally does
  not modify application behavior.

## Source references

- [GameSentenceMiner upstream](https://github.com/bpwhelan/GameSentenceMiner)
- [GameSentenceMiner fork](https://github.com/bee-san/GameSentenceMiner)
- [Chimahon reference integration](https://github.com/sohilsayed/chimahon)
- [GPL HoshiDicts line](https://github.com/sohilsayed/hoshidicts)
- [MIT HoshiDicts candidate](https://github.com/Manhhao/hoshidicts/tree/main-mit)

## `/goals`-ready index

Use these as independently trackable implementation goals. A goal is complete
only when all of its acceptance criteria are met.

- [ ] **Goal 0 - Resolve licensing and dependency provenance**
- [ ] **Goal 1 - Freeze current behavior with characterization tests**
- [ ] **Goal 2 - Build the native HoshiDicts host and versioned protocol**
- [ ] **Goal 3 - Implement safe dictionary storage and import lifecycle**
- [ ] **Goal 4 - Introduce a backend-neutral popup/controller contract**
- [ ] **Goal 5 - Build the HoshiDicts result renderer**
- [ ] **Goal 6 - Add settings, backend switching, and dictionary management**
- [ ] **Goal 7 - Preserve mouse, focus, click-through, manual-mode, and Magpie behavior**
- [ ] **Goal 8 - Preserve keyboard and gamepad behavior**
- [ ] **Goal 9 - Add explicit HoshiDicts mining integration**
- [ ] **Goal 10 - Package and verify native artifacts on all release platforms**
- [ ] **Goal 11 - Add observability, recovery, and security hardening**
- [ ] **Goal 12 - Document, migrate, and beta the feature**
- [ ] **Goal 13 - Qualify and release the stable feature**

## Executive summary

HoshiDicts cannot be added safely as a small replacement for Yomitan's lookup
function. In the current overlay, Yomitan also owns popup lifecycle events,
pointer interception, focus restoration, Magpie compatibility, gamepad popup
commands, entry selection, and Anki note creation. Replacing only the result
data would leave those workflows connected to a popup that no longer exists.

The implementation should therefore proceed in two layers:

1. Introduce a backend-neutral dictionary popup/controller contract and adapt
   the existing Yomitan behavior to it without changing the default path.
2. Add HoshiDicts behind that contract through a long-lived native host process
   and a dedicated renderer.

The native host should be an executable communicating over versioned
line-delimited JSON on stdin/stdout. It should not be a Node native addon:
Electron ABI coupling would make packaging and upgrades unnecessarily fragile,
and a separate process isolates native crashes and untrusted dictionary imports
from the overlay process.

The initial setting should be:

```text
Dictionary backend
  (o) Yomitan
  ( ) HoshiDicts
```

This is the enable/disable switch: selecting HoshiDicts enables it; selecting
Yomitan disables it. Hoshi-specific dictionary controls appear only while
HoshiDicts is selected. The selected backend and enabled dictionary order are
profile-scoped through the overlay's existing profile mechanism. Imported
dictionary files are global to the overlay data directory so the same large
indexes are not duplicated per profile.

There is one blocking issue before implementation: GameSentenceMiner declares
`LGPL-3.0-only`, while `sohilsayed/hoshidicts` at Chimahon's pinned commit
`156f586a5bc67d72e5e6b315e84464719415583c` is GPL-3.0. The MIT branch
`Manhhao/hoshidicts@af99b554cd4ab289aa65e16fd2a4eea0d3870d3b` is a
permissively licensed candidate, but it uses the Jiten-derived deconjugator
rather than the newer Yomitan-derived GPL deinflector. Goal 0 must audit its
transitive dependencies and record the approved dependency choice. The
recommended path is the pinned MIT branch unless an explicit legal and
source-distribution review approves a GPL sidecar strategy.

## What exists today

### GameSentenceMiner overlay

- `GSM_Overlay/main.js` owns overlay windows, settings, profile-scoped setting
  snapshots, Yomitan extension loading, click-through, focus restoration,
  manual mode, Magpie recovery, and child native services.
- `GSM_Overlay/index.html` owns the visible text surface and tracks nested
  Yomitan popups through `yomitan-popup-shown` and
  `yomitan-popup-hidden`. It forwards that state to the main process through
  the `yomitan-event` IPC message.
- `GSM_Overlay/gamepad.js` sends Yomitan-specific popup commands:
  `lookup-point`, `hide-popup`, `scroll`, `select-action`,
  `reset-action-selection`, `confirm-action`, `next-entry`, and
  `previous-entry`.
- A second confirm on an unchanged lookup target can send
  `gsm-trigger-anki-add`, invoking Yomitan's configured Anki template.
- `GSM_Overlay/yomitan_bridge.js` exposes Yomitan API operations over
  `window.postMessage`, including tokenization and popup closing.
- `GSM_Overlay/settings.html` is an overlay-local settings window. Settings
  declared in `DEFAULT_USER_SETTINGS` are profile-scoped unless listed in
  `OVERLAY_NON_PROFILE_SETTING_KEYS`.
- The overlay settings file is
  `<GSM_OVERLAY_DATA_PATH or platform default>/settings.json`.
- The dictionary popup backend and the tokenizer backend are separate concepts.
  Existing MeCab, Sudachi, Yomitan bridge/API, JitenAPI, and JPDB tokenizer
  choices must remain independent from this feature.
- `GSM_Overlay/yomitan/` is generated content. Repository instructions prohibit
  hand-editing it. Any required Yomitan integration change must be made in the
  maintained Yomitan source checkout and rebuilt through the documented
  workflow.

### Packaging and tests

- The overlay is packaged separately with Electron Forge, then staged into the
  desktop package by `scripts/stage-overlay-build.mjs`.
- `scripts/verify-overlay-package.mjs` verifies required overlay resources in
  the final desktop package.
- The Rust input server already demonstrates the desired native artifact model:
  `.github/workflows/build_overlay_server.yml` builds one binary per supported
  platform and publishes a rolling artifact release consumed by app builds.
- Stable and development release workflows build Windows x64, Linux x64, and
  macOS arm64 packages.
- The overlay has no standalone test script, but the root Vitest suite already
  loads legacy overlay modules and HTML through JSDOM. Relevant tests include
  `electron-src/main/ui/gamepad-bindings.test.ts`,
  `electron-src/main/ui/overlay-profile-websocket-sync.test.ts`,
  `electron-src/main/magpie.test.ts`, and
  `electron-src/main/overlay_runtime.test.ts`.

### Chimahon and HoshiDicts

- Chimahon pins `sohilsayed/hoshidicts` at
  `156f586a5bc67d72e5e6b315e84464719415583c`.
- HoshiDicts imports Yomitan ZIP dictionaries into native indexes and supports
  term, frequency, and pitch data. Chimahon also wraps kanji lookup, styles,
  and dictionary media.
- A `DictionaryQuery`, deinflector/deconjugator, and `Lookup` are kept warm and
  reused rather than rebuilt for each lookup.
- Chimahon renders structured results in a dedicated web surface and has its
  own Android/AnkiDroid mining pipeline.
- Chimahon's JNI layer, Android lifecycle, WebView bridges, and AnkiDroid code
  are reference material, not a desktop integration boundary to copy.

## Product requirements

### Required behavior

1. Existing installs continue to use Yomitan after upgrading.
2. New installs continue to use Yomitan by default.
3. A user can explicitly select HoshiDicts in overlay settings.
4. A user can switch back to Yomitan without deleting HoshiDicts indexes.
5. A user can import supported Yomitan-format ZIP dictionaries.
6. A user can see import progress, success, failure, and cancellation state.
7. A user can enable, disable, reorder, reimport, and remove Hoshi dictionaries.
8. Dictionary files are stored once globally; selected backend and dictionary
   enable/order state can vary by overlay profile.
9. Hoshi lookup works with pointer, keyboard, and gamepad workflows.
10. Popup open/close state preserves click-through and focus safety.
11. Yomitan behavior, settings, imported dictionaries, and mining remain
    unchanged while Yomitan is selected.
12. Hoshi failure never breaks OCR, text intake, stats, or the overlay process.
13. Hoshi does not require a network connection after installation and import.
14. Packaged Windows, Linux, and macOS builds contain a matching native host.
15. Mining behavior is explicit. No control may claim to mine a selected Hoshi
    definition until the Hoshi mining contract is implemented and tested.

### Non-functional requirements

- Untrusted dictionary ZIPs and glossary content must not execute code or read
  arbitrary local files.
- Imports and catalog updates must be crash-safe and atomic.
- The overlay UI must stay responsive during imports and lookups.
- Stale responses must never replace a newer popup.
- Native process crashes must be isolated and recoverable.
- Hoshi must consume no long-lived native process or index memory while
  Yomitan is selected, unless an import is actively running.
- Protocol and on-disk schema changes must be versioned.
- Logs must not include looked-up text or sentence contents by default.
- Build inputs must be pinned and reproducible enough to identify the exact
  shipped HoshiDicts source.

## Scope boundaries

### In scope

- Japanese dictionary lookup in the GSM overlay.
- Yomitan-format term, frequency, pitch, media, style, and supported kanji data.
- Dictionary import and lifecycle management.
- Mouse, keyboard, and gamepad popup interaction.
- Recursive lookup within Hoshi results if the renderer can preserve popup
  safety and request generation semantics.
- A deliberate Hoshi-to-Anki mining path in Goal 9.
- Native packaging for GSM's currently released architectures.

### Out of scope for the first stable version

- Replacing GSM's tokenizer backends with HoshiDicts.
- Automatically extracting or migrating dictionaries from Yomitan's extension
  storage. Users reimport their source ZIP files.
- Cloud synchronization of dictionary ZIPs or native indexes.
- Sharing a live index with Chimahon.
- Supporting languages other than Japanese.
- Editing generated files under `GSM_Overlay/yomitan/` by hand.
- A Node-API, Koffi, or Electron native addon binding.
- Running arbitrary dictionary JavaScript, remote CSS, or remote media.
- Reproducing every Yomitan settings page option in the Hoshi renderer.
- Supporting architectures that GSM itself does not release.

## Architecture decisions

These are the recommended decisions. Goal 0 records the final license choice;
the remaining decisions should be treated as the implementation contract unless
a later goal documents a measured reason to change one.

### D1 - Use a separate native host process

Create a small C++23 executable linked to the pinned HoshiDicts library. The
host owns import, warm query state, lookup, styles, and media reads. Electron
owns process lifecycle and all filesystem paths.

Reasons:

- no Electron/Node ABI rebuild requirement;
- native crashes do not terminate the overlay;
- imports cannot block Electron's main thread;
- stdin/stdout avoids a discoverable local TCP service;
- the executable can be built and signed independently per platform;
- protocol fixtures can test the boundary without launching Electron.

### D2 - Use versioned NDJSON RPC

One JSON object per UTF-8 line is written to stdin/stdout. Requests carry an
opaque ID; responses echo it. Unsolicited progress/status messages are events.
Human logs go only to stderr so they cannot corrupt protocol framing.

### D3 - Keep popup and tokenizer selection independent

`dictionaryBackend=hoshidicts` changes dictionary popup lookup and rendering.
It does not alter `gamepadTokenizerBackend`, furigana generation, or the
Yomitan API bridge. If Yomitan remains loaded for tokenization, its text scanner
must be explicitly gated off while Hoshi owns popup lookup.

### D4 - Profile-scope selection, globalize files

- Profile-scoped:
  - `dictionaryBackend`
  - `hoshiDictionaryOrder`
  - `hoshiDictionaryEnabled`
  - Hoshi display preferences that affect lookup/rendering
- Global:
  - imported dictionary indexes and manifest
  - import jobs and storage usage
  - native host version and schema migration state

When overlay profile support is disabled, the same settings naturally behave as
global settings under the existing overlay model.

### D5 - Do not silently fall back

If Hoshi is selected but unavailable, show an actionable Hoshi error state and
an explicit **Use Yomitan** action. Do not silently produce Yomitan results or
mine through Yomitan: backend identity affects result semantics and mining.
OCR and the rest of the overlay continue working.

### D6 - Keep one warm catalog session

The native host loads the active ordered dictionaries into one query session.
Profile/backend changes rebuild that session once. Individual lookups reuse it.
Catalog rebuilds run off the Electron thread and become visible atomically.

### D7 - Stage mining rather than pretending parity

Yomitan owns its templates and current add-note path. Hoshi mining requires a
new field-mapping and note-creation contract. Internal lookup alphas may ship
without Hoshi mining, but a disabled control must state that limitation.
Stable completion requires Goal 9.

## Proposed runtime architecture

```text
                         GameSentenceMiner desktop process
                                      |
                         in-process GSM Overlay host
                                      |
                 +--------------------+--------------------+
                 |                                         |
        Electron overlay main.js                    Python GSM backend
                 |                                  overlay_handler.py
                 |                                         |
       DictionaryBackendManager                    AnkiConnect / existing
        /                    \                      card enhancement pipeline
       /                      \
 YomitanBackend          HoshiDictsBackend
       |                      |
 patched extension      HoshiHostClient
 + existing popup             |
                         stdin/stdout NDJSON
                               |
                    gsm_hoshidicts_host
                               |
                    pinned HoshiDicts library
                               |
                 global imported dictionary indexes
```

## Proposed popup architecture

```text
Pointer / keyboard / gamepad lookup intent
                    |
             PopupController
                    |
       request generation + active anchor
                    |
       +------------+-------------+
       |                          |
 Yomitan adapter             Hoshi adapter
       |                          |
 existing iframe             native lookup
 lifecycle events            normalized result model
       |                          |
       +------------+-------------+
                    |
       backend-neutral popup state
       opened / updated / closed / error
                    |
     click-through, focus, Magpie, manual mode
```

## Backend-neutral controller contract

The exact module syntax may follow existing CommonJS conventions, but the
behavioral contract should be equivalent to:

```js
/**
 * @typedef {Object} DictionaryLookupIntent
 * @property {string} text
 * @property {number} offset
 * @property {{x:number,y:number,width:number,height:number}} anchorRect
 * @property {{x:number,y:number}=} point
 * @property {"pointer"|"keyboard"|"gamepad"|"recursive"} source
 * @property {string=} lineId
 */

class DictionaryPopupBackend {
  async start(context) {}
  async stop(reason) {}
  async lookupAt(intent, requestContext) {}
  async dismiss(reason) {}
  async scroll(direction, amount) {}
  async selectAction(direction) {}
  async confirmAction() {}
  async nextEntry() {}
  async previousEntry() {}
  async mine(selection) {}
  isOpen() {}
  subscribe(listener) {}
}
```

Backend events:

```text
dictionary-popup-opened
dictionary-popup-updated
dictionary-popup-closed
dictionary-popup-error
dictionary-popup-action-selection-changed
dictionary-mine-started
dictionary-mine-finished
```

Every event includes:

- backend ID;
- popup/request generation;
- stable popup ID;
- active anchor key when applicable;
- timestamp;
- reason or error code where applicable.

During migration, the controller may emit compatibility
`yomitan-popup-shown/hidden` events only for the Yomitan adapter. Main process
focus and click-through code must consume generic dictionary events before
Hoshi can be enabled.

## Native protocol

### Framing and limits

- UTF-8, one JSON object per line.
- Maximum request line: 1 MiB.
- Maximum normal response line: 8 MiB.
- Media responses: 16 MiB absolute maximum, with a lower configurable
  renderer limit where possible.
- Unknown fields are ignored within the same major protocol version.
- Unknown methods return `METHOD_NOT_FOUND`.
- Malformed input returns one bounded error and does not crash the host.
- stdout contains protocol only; stderr contains structured logs.
- Electron kills and restarts a host that violates framing or size limits.

### Handshake

```json
{"id":"1","method":"hello","params":{"protocol":{"major":1,"minor":0},"client":"gsm-overlay","clientVersion":"2026.7.4"}}
```

```json
{"id":"1","ok":true,"result":{"protocol":{"major":1,"minor":0},"hostVersion":"0.1.0","hoshidictsCommit":"af99b554cd4ab289aa65e16fd2a4eea0d3870d3b","capabilities":["term","frequency","pitch","styles","media","cancel"]}}
```

The capability list is authoritative. Kanji support may be advertised only
after Goal 0 verifies or implements it on the selected license-compatible pin.

### Catalog configuration

```json
{"id":"2","method":"catalog.configure","params":{"generation":7,"dictionaries":[{"id":"jitendex","path":"/absolute/validated/path","types":["term"],"priority":0},{"id":"frequency","path":"/absolute/validated/path","types":["frequency"],"priority":1}]}}
```

```json
{"id":"2","ok":true,"result":{"generation":7,"loaded":2,"styles":3,"elapsedMs":84}}
```

### Lookup

```json
{"id":"3","method":"lookup.term","params":{"catalogGeneration":7,"requestGeneration":42,"text":"食べました","scanLength":16,"maxResults":16}}
```

```json
{"id":"3","ok":true,"result":{"catalogGeneration":7,"requestGeneration":42,"matchedLength":5,"results":[],"elapsedMs":11}}
```

The renderer accepts a lookup response only when both generations still match.

### Import

```json
{"id":"4","method":"dictionary.import","params":{"jobId":"import-uuid","zipPath":"/validated/source.zip","stagingPath":"/validated/staging/uuid","lowRam":true}}
```

```json
{"event":"import.progress","jobId":"import-uuid","phase":"term-bank","completed":12,"total":80}
```

```json
{"id":"4","ok":true,"result":{"title":"Jitendex","types":["term"],"formatRevision":3,"outputPath":"/validated/staging/uuid/Jitendex"}}
```

### Cancellation and shutdown

```json
{"id":"5","method":"cancel","params":{"requestId":"4"}}
{"id":"6","method":"shutdown","params":{}}
```

Import cancellation must be cooperative. If the pinned library cannot cancel
inside a long operation, Electron may terminate a dedicated import host, remove
the staging directory, and preserve the active lookup host.

### Error shape

```json
{"id":"4","ok":false,"error":{"code":"INVALID_DICTIONARY_ARCHIVE","message":"The ZIP does not contain a supported Yomitan index","retryable":false,"details":{"phase":"inspect"}}}
```

Stable codes include:

```text
PROTOCOL_MISMATCH
METHOD_NOT_FOUND
INVALID_REQUEST
REQUEST_TOO_LARGE
INVALID_DICTIONARY_ARCHIVE
UNSUPPORTED_DICTIONARY_REVISION
UNSUPPORTED_DICTIONARY_TYPE
IMPORT_CANCELLED
IMPORT_OUT_OF_SPACE
CATALOG_GENERATION_MISMATCH
CATALOG_LOAD_FAILED
LOOKUP_FAILED
MEDIA_NOT_FOUND
MEDIA_TOO_LARGE
PATH_OUTSIDE_STORE
INTERNAL_ERROR
```

## On-disk layout

All paths are rooted under `path.join(dataPath, "hoshidicts")`, where
`dataPath` is the existing overlay data path.

```text
hoshidicts/
  manifest.json
  manifest.json.backup
  dictionaries/
    <stable-dictionary-id>/
      current/
        ... HoshiDicts index files ...
      source.json
  staging/
    <import-job-id>/
  quarantine/
    <failed-import-id>/
  logs/
    host.log
```

`staging/` is never queried. An import is published by validating the complete
index, writing metadata, and atomically renaming the staged directory into
place. Reimport builds a sibling replacement and swaps it only after success.
The prior `current/` remains usable until publication finishes.

### Manifest example

```json
{
  "schemaVersion": 1,
  "revision": 12,
  "dictionaries": [
    {
      "id": "a8fcd4aa-70a4-42a7-af5a-0d465b61fd75",
      "title": "Jitendex",
      "types": ["term"],
      "formatRevision": 3,
      "sourceSha256": "sha256-hex",
      "importedAt": "2026-08-04T00:00:00.000Z",
      "hostVersion": "0.1.0",
      "hoshidictsCommit": "af99b554cd4ab289aa65e16fd2a4eea0d3870d3b",
      "relativePath": "dictionaries/a8fcd4aa-70a4-42a7-af5a-0d465b61fd75/current",
      "sizeBytes": 123456789,
      "health": "ready"
    }
  ]
}
```

Dictionary IDs are generated once and survive reimport. Titles are display
metadata and are not unique identifiers. All paths in the manifest are
relative, normalized, and verified to stay inside the Hoshi store.

## Settings schema

Add defaults in `GSM_Overlay/main.js`:

```js
{
  dictionaryBackend: "yomitan",
  hoshiDictionaryOrder: [],
  hoshiDictionaryEnabled: {},
  hoshiScanLength: 16,
  hoshiMaxResults: 16,
  hoshiRecursiveLookupEnabled: true,
  hoshiLowRamImport: true
}
```

Normalization rules:

- backend is exactly `yomitan` or `hoshidicts`; otherwise use `yomitan`;
- dictionary order is a de-duplicated array of known string IDs;
- enabled state is an object of known ID to boolean;
- newly imported term dictionaries are enabled only for the active profile
  that initiated the import, after explicit confirmation;
- missing dictionary IDs are ignored in runtime configuration but retained for
  one migration cycle so a temporarily unavailable store can recover;
- numeric values are clamped to documented bounds;
- no dictionary absolute paths are stored in profile settings.

## Performance budgets

Goal 2 records representative baselines on all release platforms. These are
initial targets, not permission to hide regressions by widening thresholds:

| Operation | Target |
| --- | --- |
| Yomitan selected | No running Hoshi host and no loaded Hoshi indexes |
| Host handshake | p95 <= 500 ms after process spawn |
| Warm catalog activation | p95 <= 2 s for the release fixture set |
| Warm lookup native time | p50 <= 30 ms, p95 <= 100 ms |
| Lookup-to-painted popup | p95 <= 200 ms |
| Stale request cancellation | superseded within 50 ms at the JS boundary |
| Popup scroll/action input | visible response within one rendered frame |
| Import progress | first progress or phase event within 500 ms |
| Import cancellation | UI acknowledges immediately; worker exits within 2 s where cooperative |
| Host restart after crash | one retry visible within 1 s |
| Memory regression | <= 20% over the recorded fixture baseline |
| Absolute warm-host memory guard | <= 1.5 GiB for the release fixture set |

If real dictionary fixtures make an absolute target invalid, the implementing
PR must attach benchmark evidence, update the target deliberately, and retain a
regression budget.

## Threat model

| Threat | Required control |
| --- | --- |
| ZIP path traversal | reject absolute paths, `..`, drive prefixes, UNC paths, and symlink escapes |
| ZIP bomb | cap entry count, per-entry size, total expanded size, and compression ratio |
| Malformed Hoshi/Yomitan data | parse in native host, return bounded errors, never crash Electron |
| Native memory corruption | isolate host process; bounded restart; preserve active indexes |
| Arbitrary glossary HTML/script | structured allowlist renderer; no script/event attributes/raw web navigation |
| Malicious dictionary CSS | parse/scope or allowlist properties; never inject unrestricted global CSS |
| Media path escape | resolve by dictionary ID plus relative media path inside the indexed dictionary |
| Oversized media | MIME allowlist and byte limit before reading into renderer memory |
| Stale lookup response | catalog and request generations checked before render |
| Protocol spoofing | private stdio child, executable path under packaged resources, handshake pin |
| Host stdout log corruption | protocol-only stdout; stderr-only logs; framing violation kills host |
| Mining field injection | typed backend payload, server-side field allowlist, sanitized HTML |
| Duplicate mining requests | request idempotency key and Anki duplicate policy |
| Sensitive text in logs | log hashes/lengths and request IDs, not lookup text or full sentences |
| Corrupt manifest | schema validation, last-known-good backup, quarantine, explicit recovery UI |
| Executable replacement | packaged hash/version verification; code signing where supported |

---

# Goal 0 - Resolve licensing and dependency provenance

## Objective

Choose and document a legally and technically acceptable HoshiDicts source pin
before any linked binary is distributed.

## Rationale

GameSentenceMiner is `LGPL-3.0-only`. Chimahon's HoshiDicts pin and
`sohilsayed/hoshidicts` current `main` are GPL-3.0 because the newer
deinflection implementation derives from Yomitan. Linking that library into a
distributed host cannot be treated as an incidental implementation detail.

The MIT `main-mit` branch is the recommended starting point, but it has a
different Jiten-derived deconjugator and may lack features added later on GPL
`main`. Behavior and capability differences must be measured.

## Candidate paths

### Path A - Pinned MIT HoshiDicts (recommended)

- Pin `Manhhao/hoshidicts` branch `main-mit` at
  `af99b554cd4ab289aa65e16fd2a4eea0d3870d3b`.
- Preserve its MIT license and all transitive notices.
- If desktop fixes are required, maintain a minimal `bee-san/hoshidicts` fork
  based on that commit and keep provenance explicit.
- Port only features whose source and dependencies remain compatible.

### Path B - GPL host sidecar

- Treat the host as a separately distributed GPL program.
- Obtain explicit legal/project-owner approval for aggregate/communication
  boundaries and installer distribution.
- Publish complete corresponding source, build scripts, license notices, and
  exact source offer for every released host.
- Confirm that the chosen IPC and packaging do not create an unacceptable
  licensing obligation for the rest of GSM.

Path B is blocked until that review is written. This plan does not assert that
process separation alone resolves licensing.

## Files/modules

- root `package.json`
- `GSM_Overlay/package.json`
- proposed `.gitmodules`
- proposed `GSM_Overlay/hoshidicts_host/vendor/hoshidicts`
- proposed `docs/third-party/hoshidicts-provenance.md`
- proposed `THIRD_PARTY_NOTICES.md` or the repository's eventual notice file
- proposed `scripts/verify-hoshidicts-provenance.mjs`

## Detailed tasks

1. Record the licenses and exact commits of both candidate HoshiDicts lines.
2. Inventory every recursive dependency and its pinned commit/license.
3. Compare MIT and GPL APIs and behavior for:
   - term import;
   - term lookup and matched length;
   - deconjugation/deinflection;
   - frequency and pitch;
   - structured glossary;
   - styles and media;
   - kanji dictionaries;
   - cancellation support;
   - Windows, Linux, and macOS builds.
4. Run identical fixture dictionaries and golden lookups through Chimahon's pin
   and the MIT candidate. Record differences rather than masking them.
5. Decide whether missing MIT capabilities are:
   - acceptable first-version limitations;
   - clean-room/compatible ports;
   - blockers;
   - reasons to pursue Path B.
6. Select a source owner and update policy. Dependency updates must be deliberate,
   not branch-head pulls.
7. Add a submodule or equivalent immutable pin. Do not use unpinned CMake
   `FetchContent` against a moving branch.
8. Add license and provenance text to packaged notices.
9. Add a CI check that verifies:
   - expected HoshiDicts commit;
   - expected license file hash;
   - recursive submodules initialized;
   - no generated host binary was built from another source pin.
10. Record whether the native host is LGPL-compatible MIT aggregation or a
    separately distributed GPL work, including release obligations.

## Tests and evidence

- Provenance verification script unit tests.
- CI runs the script from a clean recursive checkout.
- Golden capability report comparing both candidate pins.
- Build proof on Windows x64, Linux x64, and macOS arm64.
- Packaged notice inspection.
- Dependency license inventory reviewed by a human owner.

## Acceptance criteria

- [ ] One candidate path is explicitly approved in the provenance document.
- [ ] The exact source commit and recursive dependencies are pinned.
- [ ] The packaged license obligations are documented and testable.
- [ ] The selected pin builds on every current release architecture.
- [ ] Required and unavailable capabilities are listed without ambiguity.
- [ ] No GPL HoshiDicts code is silently linked into an LGPL-labeled package.
- [ ] Goals 2 and 10 may proceed without unresolved legal assumptions.

## Dependencies

None. This blocks every implementation goal that links or distributes
HoshiDicts.

## Failure and rollback behavior

If no acceptable path is approved, stop the feature. The backend setting must
not be exposed and no native binary should ship.

## Out of scope

This goal records project decisions and evidence; it is not legal advice.

---

# Goal 1 - Freeze current behavior with characterization tests

## Objective

Capture Yomitan popup, settings, pointer, focus, and controller behavior before
introducing abstractions.

## Rationale

The highest-risk code is not lookup itself. It is the implicit behavior spread
across `main.js`, `index.html`, and `gamepad.js`. Refactoring without tests can
make an overlay click through a visible popup, steal focus from a game, or mine
the wrong entry while unit lookup tests remain green.

## Files/modules

- `GSM_Overlay/main.js`
- `GSM_Overlay/index.html`
- `GSM_Overlay/gamepad.js`
- `GSM_Overlay/yomitan_bridge.js`
- `GSM_Overlay/magpie.js`
- `GSM_Overlay/settings.html`
- `electron-src/main/ui/gamepad-bindings.test.ts`
- `electron-src/main/magpie.test.ts`
- `electron-src/main/ui/overlay-profile-websocket-sync.test.ts`
- proposed `electron-src/main/ui/dictionary-popup-lifecycle.test.ts`
- proposed `electron-src/main/ui/dictionary-settings.test.ts`

## Detailed tasks

1. Extract only the minimum pure helpers needed to test popup state transitions.
2. Characterize single and nested Yomitan popup open/close counts.
3. Characterize DOM fallback detection and stale-popup recovery.
4. Characterize `yomitan-event` effects on:
   - mouse pass-through;
   - focus-on-lookup;
   - manual hold and toggle mode;
   - active gamepad navigation;
   - Linux focus restoration;
   - Magpie close recovery.
5. Characterize gamepad/keyboard commands and frame targeting.
6. Pin first-confirm lookup, second-confirm mining, cancel, scrolling, action
   selection, and next/previous entry behavior.
7. Pin the rule that a moved cursor or closed popup invalidates pending mining.
8. Pin settings defaults, normalization, profile snapshot behavior, and unknown
   value fallback.
9. Pin independent tokenizer backend behavior.
10. Add a minimal JSDOM popup fixture rather than loading the generated Yomitan
    bundle into every unit test.
11. Add a packaged smoke harness that can assert popup lifecycle IPC without a
    real game.
12. Record a manual baseline video or checklist for Windows click-through,
    focus restoration, Magpie, and controller interaction.

## Tests

- Vitest unit tests for popup state transitions.
- JSDOM tests for frame visibility and event routing.
- Existing gamepad suite expanded with nested-popup and stale-target cases.
- Main-process tests with mocked `BrowserWindow.setIgnoreMouseEvents`,
  `focus`, `blur`, `showInactive`, and topmost recovery.
- Profile tests proving new settings will default to Yomitan.

## Acceptance criteria

- [ ] Every current popup control action has a characterization test.
- [ ] Focus/click-through state transitions are covered for open and close.
- [ ] Nested popups do not release click-through until the final close.
- [ ] Pending mining is invalidated by target change or popup close.
- [ ] Existing profile migration/default behavior is pinned.
- [ ] Tests fail when representative Yomitan coupling is intentionally broken.
- [ ] The existing Yomitan path is behaviorally unchanged.

## Dependencies

Goal 0 may run in parallel because this goal does not link HoshiDicts.

## Failure and rollback behavior

If a current behavior cannot be deterministically tested, document the manual
gate and add diagnostic events before refactoring it.

## Out of scope

No backend abstraction or Hoshi feature is introduced here.

---

# Goal 2 - Build the native HoshiDicts host and versioned protocol

## Objective

Create a long-lived, testable native executable that wraps the approved
HoshiDicts pin behind the protocol defined above.

## Rationale

The host is the isolation and performance boundary. It must be independently
correct before Electron settings or rendering depend on it.

## Files/modules

- proposed `GSM_Overlay/hoshidicts_host/CMakeLists.txt`
- proposed `GSM_Overlay/hoshidicts_host/src/main.cpp`
- proposed `GSM_Overlay/hoshidicts_host/src/protocol.*`
- proposed `GSM_Overlay/hoshidicts_host/src/session.*`
- proposed `GSM_Overlay/hoshidicts_host/tests/`
- proposed `GSM_Overlay/hoshidicts_host/vendor/hoshidicts`
- proposed `GSM_Overlay/hoshidicts_client.js`
- proposed `electron-src/main/ui/hoshidicts-client.test.ts`

## Detailed tasks

1. Add the approved immutable dependency pin and initialize recursive
   dependencies in local/CI instructions.
2. Build a C++23 host executable linked statically where license and platform
   constraints allow.
3. Implement strict NDJSON framing and typed request validation.
4. Implement `hello`, `health`, `catalog.configure`, `lookup.term`,
   supported kanji lookup, `styles.list`, `media.get`, `cancel`, and `shutdown`.
5. Keep a single warmed `DictionaryQuery` and lookup object per active catalog
   generation.
6. Build a replacement catalog off to the side; swap only after all requested
   dictionaries load successfully.
7. Put all human diagnostics on stderr.
8. Return stable error codes and bounded messages.
9. Add request cancellation checks between controllable phases.
10. Add `--version`, `--protocol-version`, and `--self-test` commands.
11. Add an Electron-side client with:
    - executable resolution;
    - spawn/handshake timeout;
    - request IDs;
    - per-method timeouts;
    - maximum line sizes;
    - cancellation;
    - stderr capture;
    - graceful shutdown then forced kill;
    - child-exit notification;
    - no shell invocation.
12. Separate active lookup hosting from import workers if imports cannot be
    cancelled without terminating the process.
13. Capture capability differences from Goal 0 in the handshake rather than
    assuming Chimahon's API surface.
14. Add golden fixtures containing:
    - plain term entries;
    - inflected terms;
    - multiple dictionaries;
    - frequency and pitch;
    - structured glossary;
    - media;
    - malformed data;
    - non-Japanese text.

## Tests

- Native unit tests for protocol parsing and session management.
- Native integration tests against small committed/generated fixture ZIPs.
- Golden lookup comparisons against the selected Hoshi pin.
- Node/Vitest tests using a fake host process.
- End-to-end spawn tests using the real host on each CI platform.
- Protocol fuzz tests for malformed JSON, huge lines, missing fields, and
  duplicate request IDs.
- Crash tests proving Electron rejects all pending requests and stays alive.
- Benchmarks for handshake, catalog warmup, lookup latency, and memory.

## Acceptance criteria

- [ ] Host builds and self-tests on all supported release platforms.
- [ ] Protocol major/minor negotiation is enforced.
- [ ] stdout remains valid protocol under success and failure.
- [ ] A catalog remains usable after a replacement catalog fails to load.
- [ ] Stale catalog generations are rejected.
- [ ] Real host crash does not terminate Electron or corrupt indexes.
- [ ] Performance baselines and budgets are recorded.
- [ ] Selected Hoshi source commit is reported by the host and verified by CI.

## Dependencies

Goal 0 is blocking. Goal 1 should be complete before Electron integration.

## Failure and rollback behavior

The host is not started when Hoshi is disabled. A failed handshake marks Hoshi
unavailable, closes any Hoshi popup, and offers an explicit switch to Yomitan.

## Out of scope

No dictionary management UI or production popup is added here.

---

# Goal 3 - Implement safe dictionary storage and import lifecycle

## Objective

Provide atomic, recoverable import and catalog management for Yomitan-format
dictionary ZIPs.

## Rationale

Dictionary archives are large and untrusted. An interrupted import must not
destroy the active catalog, and a dictionary title must not be used as a
filesystem identity.

## Files/modules

- proposed `GSM_Overlay/hoshidicts_store.js`
- proposed `GSM_Overlay/hoshidicts_import_manager.js`
- proposed `GSM_Overlay/hoshidicts_manifest.js`
- `GSM_Overlay/main.js`
- proposed `electron-src/main/ui/hoshidicts-store.test.ts`
- proposed `electron-src/main/ui/hoshidicts-import.test.ts`

## Detailed tasks

1. Implement schema-validated manifest read/write with a monotonic revision.
2. Keep a last-known-good manifest backup and recover only after validation.
3. Generate stable opaque dictionary IDs; never derive directory names directly
   from archive titles.
4. Inspect archives before import and report supported entry types.
5. Enforce ZIP defenses from the threat model.
6. Check free space using a conservative expanded-size estimate plus reserve.
7. Copy the file selected by Electron's file picker into the job's staging
   directory using no-follow/canonical-path checks, hash it during the copy, and
   let the native import worker read only that store-local copy.
8. Import into a unique staging directory.
9. Surface structured phases and progress in Electron.
10. Validate the staged output by loading it in a temporary native session and
   running probe lookups.
11. Write `source.json` and manifest metadata before publication.
12. Atomically publish a new dictionary or reimported replacement.
13. Preserve the prior index when import, validation, cancellation, or
    publication fails.
14. Clean abandoned staging directories on startup only after confirming they
    are not referenced by an active import process.
15. Quarantine diagnostically useful corrupt outputs without loading them.
16. Implement remove:
    - show profiles that reference the dictionary;
    - require confirmation;
    - remove profile references transactionally;
    - rebuild the active catalog;
    - move to trash/quarantine before final deletion.
17. Implement enable/disable and ordering through stable IDs.
18. Handle duplicate source hashes and title collisions explicitly:
    - same hash: offer reuse or reimport;
    - same title/different hash: allow distinct IDs with disambiguated labels.
19. Add storage usage calculation without scanning on every settings render.
20. Define index migration behavior when host/index schema changes:
    - mark reindex required;
    - retain source metadata;
    - never attempt to interpret incompatible files silently.
21. Decide whether original ZIPs are retained. Recommended default: do not
    retain them after successful import; record hash and source filename only.

## Tests

- Manifest property tests and corrupt-manifest fixtures.
- Import success, duplicate, replacement, cancellation, out-of-space, and
  process-crash tests.
- Path traversal, symlink, compression-ratio, entry-count, and giant-file tests.
- Atomic publication fault injection before and after each rename/write.
- Startup cleanup tests.
- Profile reference cleanup tests.
- Real host validation against imported fixture dictionaries.

## Acceptance criteria

- [ ] No failed import changes the active dictionary.
- [ ] No staged or manifest path can escape the Hoshi store.
- [ ] Reimport preserves stable ID and old data until success.
- [ ] Title collisions do not overwrite each other.
- [ ] Manifest corruption has a deterministic recovery path.
- [ ] Import progress and cancellation are observable.
- [ ] Active catalog rebuild is atomic from the renderer's perspective.
- [ ] Store behavior is covered by fault-injection tests.

## Dependencies

Goals 0 and 2.

## Failure and rollback behavior

On failure, remove or quarantine only the job's staging area, preserve the
current manifest/catalog, and return a specific actionable error. A user can
continue using Yomitan or already imported Hoshi dictionaries.

## Out of scope

No automatic download catalog or cloud sync.

---

# Goal 4 - Introduce a backend-neutral popup/controller contract

## Objective

Move popup lifecycle and commands behind a generic controller while preserving
the current Yomitan implementation.

## Rationale

Both backends must drive the same focus, click-through, and controller state.
Duplicating those rules in a second Hoshi path would guarantee drift.

## Files/modules

- proposed `GSM_Overlay/dictionary_popup_controller.js`
- proposed `GSM_Overlay/dictionary_backend_manager.js`
- proposed `GSM_Overlay/yomitan_dictionary_backend.js`
- proposed `GSM_Overlay/hoshidicts_dictionary_backend.js`
- `GSM_Overlay/index.html`
- `GSM_Overlay/gamepad.js`
- `GSM_Overlay/main.js`
- `GSM_Overlay/yomitan_bridge.js`
- maintained external Yomitan source, only if a scanner gate is required
- tests introduced by Goal 1

## Detailed tasks

1. Define backend IDs, lifecycle states, event shapes, and command results.
2. Add one `DictionaryPopupController` instance to the overlay renderer.
3. Wrap current Yomitan event tracking and command dispatch in a
   `YomitanDictionaryBackend`.
4. Keep compatibility method names temporarily, but route all new controller
   calls through generic names.
5. Replace `yomitanShowing` as the owner of click-through state with generic
   active-popup state. Keep Yomitan-specific state only inside its adapter.
6. Replace main-process `yomitan-event` handling with a generic
   `dictionary-popup-event`, retaining a compatibility bridge during migration.
7. Attach a monotonically increasing request generation to every lookup.
8. Cancel or ignore all older work when:
   - the anchor changes;
   - backend changes;
   - profile changes;
   - popup is dismissed;
   - text DOM is rebuilt;
   - active dictionary catalog changes.
9. Define backend switching as a transaction:
   - block new lookup intents;
   - dismiss current popup;
   - increment generation;
   - stop old backend scanner;
   - start/configure new backend;
   - publish ready/error state;
   - unblock lookup intents.
10. Add a Yomitan scanner gate that does not disable the tokenizer bridge.
    Preferred mechanism: an explicit bridge/source-level runtime scan-enabled
    command in the maintained GSM Yomitan source. Rebuild generated assets
    through the documented workflow; never patch generated files by hand.
11. Prove that Hoshi selection cannot produce a duplicate Yomitan popup.
12. Prove that returning to Yomitan re-enables scanning and all current
    Yomitan controls.
13. Keep Yomitan extension settings and dictionaries untouched when disabled.
14. Make backend readiness observable to settings and diagnostics.

## Tests

- Run every Goal 1 characterization test through the Yomitan adapter.
- Contract tests shared by fake Yomitan and Hoshi adapters.
- Backend switch tests with in-flight lookup and open nested popup.
- Profile switch tests.
- Stale response tests.
- Scanner-gate tests proving no duplicate popup and preserved tokenization.
- Main-process tests proving generic popup events drive existing focus logic.

## Acceptance criteria

- [ ] Yomitan remains the default and passes all baseline tests.
- [ ] Main focus/click-through code no longer requires Yomitan-specific events.
- [ ] Controller commands have backend-neutral names and results.
- [ ] Switching backend cannot leave two scanners active.
- [ ] Stale responses cannot reopen or replace a popup.
- [ ] Yomitan tokenizer bridge can remain usable while its popup scanner is off.
- [ ] No generated Yomitan file was hand-edited.

## Dependencies

Goal 1. A fake Hoshi adapter can be used before Goals 2 and 3 finish.

## Failure and rollback behavior

Keep the Hoshi setting hidden until the Yomitan adapter passes all existing
behavioral gates. Reverting this goal returns to the original direct path
without changing user dictionary data.

## Out of scope

No production Hoshi rendering yet.

---

# Goal 5 - Build the HoshiDicts result renderer

## Objective

Render Hoshi term results, dictionaries, frequencies, pitch, styles, media, and
actions in a safe popup integrated with the overlay.

## Rationale

HoshiDicts returns data, not Yomitan's popup UI. A dedicated renderer must be
keyboard/gamepad addressable, correctly positioned, theme-compatible, and safe
for untrusted dictionary content.

## Files/modules

- proposed `GSM_Overlay/hoshidicts_popup.js`
- proposed `GSM_Overlay/hoshidicts_popup.css`
- proposed `GSM_Overlay/hoshidicts_result_model.js`
- proposed `GSM_Overlay/hoshidicts_glossary_renderer.js`
- proposed `GSM_Overlay/hoshidicts_media.js`
- `GSM_Overlay/index.html`
- `GSM_Overlay/shared.css`
- Chimahon dictionary payload/renderer code as behavior reference only
- proposed renderer Vitest and Playwright/Electron harness tests

## Detailed tasks

1. Define a normalized immutable result view model with stable result,
   dictionary, glossary, and action IDs.
2. Preserve native ranking and matched-length information.
3. Group/display:
   - expression and reading;
   - deconjugation reason;
   - part-of-speech/term tags;
   - ordered glossaries by dictionary;
   - frequency values;
   - pitch data supported by the selected Hoshi pin;
   - dictionary attribution.
4. Render structured glossary content through an explicit node/property
   allowlist. Plain text must use `textContent`.
5. Scope allowed dictionary styles to the popup root. Reject global selectors,
   scriptable URLs, imports, behavior properties, and unsupported constructs.
6. Resolve media by dictionary ID and relative path through validated main/host
   APIs. Do not expose arbitrary `file://` access.
7. Restrict media MIME types and sizes; show a placeholder for rejected media.
8. Position the popup near the lookup anchor while clamping it to the active
   display/work area.
9. Reposition on overlay/display changes without moving the lookup anchor.
10. Define responsive maximum width/height and internal scrolling.
11. Implement explicit states:
    - loading;
    - results;
    - no result;
    - host unavailable;
    - no enabled term dictionaries;
    - catalog rebuilding;
    - recoverable error.
12. Implement action selection with a stable selected action.
13. Implement entry next/previous behavior over top-level results.
14. Implement recursive lookup from selected glossary text with:
    - a bounded history stack;
    - new request generations;
    - back navigation;
    - no execution of dictionary content;
    - preserved original source sentence for mining.
15. Use the overlay's visual language without copying Chimahon's Android UI.
16. Expose screen-reader labels, focus order, and reduced-motion behavior.
17. Keep popup dimensions stable enough that hover/action selection does not
    shift the overlay unexpectedly.
18. Do not place explanatory feature marketing inside the popup.

## Tests

- Result-model unit tests with golden native responses.
- Structured content allowlist and injection tests.
- CSS scoping tests.
- Media path/MIME/size tests.
- JSDOM action and recursive-history tests.
- Playwright or Electron screenshot tests for:
  - short and long entries;
  - multiple dictionaries;
  - media;
  - no results;
  - error states;
  - high DPI;
  - constrained screen edges;
  - light/dark overlay backgrounds.
- Pixel/DOM assertions proving popup is nonblank and on-screen.
- Lookup-to-paint performance measurement.

## Acceptance criteria

- [ ] Representative Hoshi results are readable and ordered correctly.
- [ ] No dictionary-provided content can execute script or escape popup styles.
- [ ] Popup remains within the active display.
- [ ] Loading, empty, and error states are distinct.
- [ ] Action selection and entry navigation use stable IDs.
- [ ] Recursive lookup cannot render a stale result.
- [ ] Media is served only from the owning dictionary and within size limits.
- [ ] Visual tests cover desktop scaling and edge placement.

## Dependencies

Goals 2, 3, and 4.

## Failure and rollback behavior

Renderer failure closes only the Hoshi popup, records a bounded error, and
keeps the overlay interactive. The user can retry or explicitly choose
Yomitan.

## Out of scope

Full visual identity with Yomitan and arbitrary dictionary web content.

---

# Goal 6 - Add settings, backend switching, and dictionary management

## Objective

Expose a clear optional backend selector and complete Hoshi dictionary controls
in overlay settings.

## Rationale

The feature must be opt-in, reversible, and operable without editing files.
Settings must also explain readiness and failures through state, not through
silent console errors.

## Files/modules

- `GSM_Overlay/settings.html`
- `GSM_Overlay/main.js`
- proposed store/import/backend manager modules
- proposed `electron-src/main/ui/dictionary-settings.test.ts`
- proposed `electron-src/main/ui/hoshidicts-settings.test.ts`

## Detailed tasks

1. Add a **Dictionary** section to the existing Reading tab.
2. Add a backend selector:
   - `Yomitan (default)`
   - `HoshiDicts`
3. Keep the existing **Yomitan Settings** affordance visible when Yomitan is
   selected and available from an advanced/link area when Hoshi is selected.
4. Show Hoshi controls only when Hoshi is selected:
   - host/status line;
   - **Import dictionary ZIP**;
   - installed dictionary list;
   - type badges;
   - enable checkbox;
   - ordering controls;
   - reimport;
   - remove;
   - per-dictionary health/size;
   - total storage usage;
   - repair/reindex when required.
5. Disable Hoshi selection with an actionable packaged-host error if the binary
   is missing or incompatible.
6. If no term dictionary is enabled, keep Hoshi selected but show a clear empty
   state and import action.
7. Use the existing generic setting binding system rather than one-off event
   handlers where possible.
8. Normalize and persist the proposed settings schema.
9. Let existing profile settings machinery scope backend and enabled order.
10. Label global dictionary operations explicitly so users understand that
    removing a dictionary affects all profiles.
11. Before remove, list profile references and require confirmation.
12. On backend selection:
    - persist only after the manager validates the transition;
    - show switching progress;
    - rollback the value if startup/configuration fails;
    - keep the previous backend usable.
13. Do not couple this selector to the tokenizer/furigana selector.
14. Rename Yomitan-specific gamepad labels that now apply to both backends:
    `Next Dictionary Entry`, `Previous Dictionary Entry`, and
    `Mine Selected Dictionary Entry`.
15. Add reset behavior that returns only the backend/display values to defaults;
    it must not delete imported dictionaries.
16. Show import errors with a concise message and expandable diagnostic code.
17. Make import progress survive settings-window close/reopen.
18. Ensure settings search indexes the new labels and controls.

## Tests

- Settings DOM and binding tests.
- Default/malformed/profile migration tests.
- Conditional panel visibility tests.
- Backend transition success/failure tests.
- Import progress window lifecycle tests.
- Remove/reimport confirmation tests.
- Keyboard accessibility tests.
- Settings search tests.

## Acceptance criteria

- [ ] Upgrades and fresh installs show Yomitan selected.
- [ ] Hoshi can be enabled and disabled from settings.
- [ ] Switching does not delete either backend's dictionaries.
- [ ] Backend selection and enabled order follow overlay profiles.
- [ ] Imported files are shared globally.
- [ ] Dictionary management is complete without filesystem edits.
- [ ] Tokenizer settings remain unchanged when popup backend changes.
- [ ] A failed transition leaves the prior backend selected and usable.

## Dependencies

Goals 2 through 5.

## Failure and rollback behavior

If Hoshi startup fails during selection, restore the previous setting and show
the host error. Removing the feature code later leaves an ignored settings key
and dictionary directory; Yomitan remains the default.

## Out of scope

Automatic online dictionary discovery/download.

---

# Goal 7 - Preserve mouse, focus, click-through, manual-mode, and Magpie behavior

## Objective

Make Hoshi popups obey the same interaction safety rules as current Yomitan
popups on every supported platform and overlay mode.

## Rationale

An always-on-top transparent overlay can swallow game input or leak clicks into
the game. Popup correctness includes window behavior, not only visible results.

## Files/modules

- `GSM_Overlay/main.js`
- `GSM_Overlay/index.html`
- `GSM_Overlay/preload.js`
- `GSM_Overlay/magpie.js`
- `GSM_Overlay/manual_hotkey_controller.js`
- generic controller modules
- Goal 1 lifecycle tests

## Detailed tasks

1. Route generic popup opened/closed events into the existing main-process
   interaction state machine.
2. Preserve nested popup/reference counting for recursive Hoshi lookup.
3. Ensure a visible Hoshi popup disables click-through on Windows/macOS.
4. Preserve Linux's existing hide/focus workaround.
5. Respect `focusOverlayOnYomitanLookup` behavior under a generic label and
   setting migration. Consider renaming the setting only with backward-compatible
   read/write support; otherwise preserve the key and update display text.
6. Keep focus while manual hold/toggle or controller navigation owns it.
7. Restore prior pass-through only after the final popup closes.
8. Prevent stale close events from closing a newer popup generation.
9. Reuse Magpie coordinate mapping and close-recovery behavior.
10. Verify popup anchor mapping in scaled/upscaled Magpie coordinates.
11. Preserve manual inactive modes:
    - hide overlay;
    - disable interaction;
    - optional focus behavior.
12. Close Hoshi lookup when manual hold releases under the same rules as
    Yomitan.
13. Ensure clicks inside the Hoshi popup are recognized as popup clicks and do
    not immediately restore pass-through.
14. Ensure outside clicks dismiss the popup and then restore the correct state.
15. Handle game window minimized, closed, obscured, display disconnected, and
    profile switched while a popup is open.
16. Add diagnostic state snapshots for popup owner, focus owner, click-through,
    manual mode, Magpie, and generation.

## Tests

- Main-process state-machine unit tests.
- JSDOM composed-path tests for inside/outside popup clicks.
- Nested Hoshi recursive popup tests.
- Stale event and backend-switch races.
- Manual hold/toggle tests.
- Magpie coordinate and pass-through tests.
- Windows manual qualification with a normal, borderless, and exclusive
  fullscreen game.
- Linux and macOS packaged smoke checks.

## Acceptance criteria

- [ ] No click passes through a visible actionable Hoshi popup.
- [ ] Closing the final popup restores the same state as Yomitan.
- [ ] Manual and controller focus ownership is preserved.
- [ ] Magpie anchor and recovery behavior pass the manual matrix.
- [ ] Stale events cannot release a newer popup's interaction lock.
- [ ] Hoshi host/renderer failure cannot leave the overlay permanently
  interactive or permanently click-through.

## Dependencies

Goals 1, 4, and 5.

## Failure and rollback behavior

On ambiguous state, close the Hoshi popup and restore the conservative
mode-specific state. Never guess that a visible popup is safe to click through.

## Out of scope

Changing the overlay's general focus policy.

---

# Goal 8 - Preserve keyboard and gamepad behavior

## Objective

Route all popup controls through the backend-neutral contract and achieve
equivalent Hoshi interaction without regressing Yomitan.

## Rationale

Controller operation is a first-class overlay workflow. The current code sends
commands directly to Yomitan frames and uses popup visibility to gate second
confirm mining.

## Files/modules

- `GSM_Overlay/gamepad.js`
- `GSM_Overlay/index.html`
- `GSM_Overlay/settings.html`
- generic popup/controller modules
- `electron-src/main/ui/gamepad-bindings.test.ts`
- proposed `electron-src/main/ui/dictionary-controller-parity.test.ts`

## Detailed tasks

1. Replace direct `sendYomitanControlMessage` use with generic controller
   commands.
2. Keep a Yomitan adapter that emits the existing postMessage commands.
3. Implement Hoshi commands:
   - lookup current point/token;
   - dismiss;
   - scroll up/down;
   - select previous/next action;
   - confirm selected action;
   - next/previous entry;
   - mine;
   - recursive back when a binding is defined or cancel semantics allow it.
4. Preserve first-confirm lookup and target anchoring.
5. Preserve pending-mine invalidation on movement, popup close, text rebuild,
   profile switch, backend switch, and catalog change.
6. Define second-confirm behavior unambiguously:
   - if an explicit popup action is selected, confirm it;
   - otherwise, if the same target remains open and mining is supported, invoke
     the backend's default mine action;
   - if mining is unavailable, show a non-destructive status and keep popup open.
7. Keep right-stick vertical scrolling and horizontal action selection.
8. Preserve repeat-rate and thumbstick latch behavior.
9. Ensure auto-confirm lookup cancels older Hoshi native requests.
10. Rename user-facing labels from Yomitan-specific to dictionary-generic while
    preserving stored binding keys.
11. Keep keyboard and physical controller paths behaviorally aligned.
12. Preserve controller navigation active state and focus ownership.
13. Make backend capabilities available to the controller so unsupported
    actions are disabled rather than dropped.
14. Prevent one physical input from reaching both Yomitan and Hoshi adapters.
15. Add visible but compact success/failure feedback for mining.

## Tests

- Shared contract tests run against fake Yomitan and Hoshi backends.
- Existing gamepad binding suite remains green.
- First/second confirm tests for open, moved, stale, and unsupported mining.
- Stick scroll/action selection tests.
- Next/previous entry boundaries.
- Cancel and recursive history tests.
- Backend/profile switch while buttons are held.
- Duplicate event suppression tests.
- Manual controller qualification on Windows with overlay unfocused.

## Acceptance criteria

- [ ] Every current popup command routes through the generic controller.
- [ ] Yomitan controller behavior remains unchanged.
- [ ] Hoshi lookup, scroll, action, entry, dismiss, and mining-capability
  behavior work from keyboard and gamepad.
- [ ] One input cannot trigger both backends.
- [ ] Stale target/generation cannot mine.
- [ ] Existing stored bindings require no migration.

## Dependencies

Goals 4, 5, and 7. Goal 9 supplies stable Hoshi mining behavior.

## Failure and rollback behavior

If a Hoshi action is unsupported or fails, keep navigation active, preserve the
popup where safe, and show bounded feedback. Never forward the action to
Yomitan as an implicit fallback.

## Out of scope

Redesigning the broader gamepad navigation system.

---

# Goal 9 - Add explicit HoshiDicts mining integration

## Objective

Create Anki notes from a selected Hoshi result through a typed GSM-owned
contract while preserving Yomitan's current template path.

## Rationale

Current Yomitan mining calls Yomitan's Anki integration and templates.
Chimahon's Hoshi mining targets AnkiDroid through Android-specific code.
Neither is a reusable backend-neutral desktop path. GSM's Python side already
monitors and enhances newly created cards, but Hoshi still needs a deliberate
base-note creation and field-mapping contract.

## Release phases

### Internal alpha

- Hoshi lookup is available.
- Hoshi mine controls are hidden or disabled with an explicit
  `Hoshi mining is not available in this build` status.
- Yomitan mining remains fully operational when Yomitan is selected.
- This phase is not the stable definition of done.

### Beta/stable

- Hoshi can create a base note with selected term/reading/glossary and source
  sentence.
- GSM's existing card enhancement pipeline observes/enriches the created note.
- Duplicate handling, media, field validation, and result feedback are explicit.

## Files/modules

- `GSM_Overlay/gamepad.js`
- Hoshi popup/backend modules
- `GSM_Overlay/backend_connector.js`
- `GameSentenceMiner/web/overlay_handler.py`
- `GameSentenceMiner/anki.py`
- `GameSentenceMiner/util/models/model.py`
- existing Anki configuration models/UI
- proposed Hoshi mining request/result models and tests

## Proposed request

```json
{
  "type": "dictionary-mine-request",
  "request_id": "uuid",
  "backend": "hoshidicts",
  "line_id": "optional-gsm-line-id",
  "source_sentence": "食べました。",
  "lookup": {
    "expression": "食べる",
    "reading": "たべる",
    "matched_text": "食べました",
    "dictionary_id": "stable-id",
    "dictionary_title": "Jitendex",
    "glossary_id": "stable-result-id",
    "glossary_text": "to eat",
    "glossary_html": "<sanitized optional fragment>",
    "frequency": [],
    "pitch": []
  },
  "idempotency_key": "uuid"
}
```

Response:

```json
{
  "type": "dictionary-mine-result",
  "request_id": "uuid",
  "status": "created",
  "note_id": 123,
  "warnings": []
}
```

Status is one of:

```text
created
duplicate
opened-existing
cancelled
invalid-config
anki-unavailable
failed
```

## Detailed tasks

1. Audit the current GSM Anki configuration and decide where Hoshi's required
   deck/model/field mapping lives.
2. Prefer reusing existing GSM Anki deck/model and field settings when their
   semantics match. Add Hoshi-specific mapping only for missing fields such as
   selected definition/reading.
3. Query and validate model field names before enabling mining.
4. Define mappings for:
   - expression;
   - reading;
   - selected glossary;
   - source sentence;
   - dictionary name;
   - optional frequency/pitch;
   - optional dictionary media;
   - tags.
5. Add a typed overlay message handler in
   `GameSentenceMiner/web/overlay_handler.py`.
6. Resolve the authoritative active profile on the Python side. Validate
   request size, backend, field names, and sanitized content server-side; when
   `line_id` resolves, use the server-owned line text and treat the renderer's
   sentence only as a bounded fallback.
7. Add a focused Anki note-creation service instead of overloading the
   post-creation enhancement code.
8. Call AnkiConnect through the existing `anki.invoke` transport.
9. Use a deterministic duplicate query/policy and expose outcomes.
10. Add `overlay` and a documented Hoshi source tag so the existing
    `_is_overlay_mine` path can associate the correct recent line.
11. Preserve `line_id` when available to avoid ambiguous sentence matching.
12. Make request IDs idempotent for the lifetime of a backend session so button
    bounce/retry cannot create two notes.
13. Do not report success until Anki confirms note creation.
14. Trigger existing stats/enhancement through the authoritative note-created
    path; do not optimistically increment `cards_mined`.
15. Keep popup open on validation/network failure and show a retryable result.
16. On success, honor the existing hide-after-mine preference through generic
    popup behavior.
17. Handle dictionary media with strict type/size limits and unique Anki media
    names. A media failure may warn but must not silently corrupt fields.
18. Add settings/readiness status for missing Anki, deck, model, or fields.
19. Preserve Yomitan mining exactly as-is in the Yomitan adapter.
20. Document that Yomitan templates and Hoshi field mapping are separate
    configuration surfaces.

## Tests

- Python unit tests for request validation and field mapping.
- Fake AnkiConnect tests for create, duplicate, unavailable, malformed model,
  missing field, media warning, and retry.
- Idempotency/concurrent request tests.
- Overlay websocket request/result tests.
- Correct line association tests.
- Existing Yomitan mining tests unchanged.
- Keyboard/gamepad selected-glossary tests.
- End-to-end manual test with real Anki and the GSM enhancement pipeline.

## Acceptance criteria

- [ ] Stable release exposes Hoshi mine controls only when configuration is
  valid.
- [ ] The selected Hoshi result, not merely the first result, is mapped.
- [ ] One user action creates at most one note.
- [ ] Duplicate behavior is deterministic and visible.
- [ ] Created notes enter the existing GSM enhancement/stats path.
- [ ] Failed mining does not close the popup or claim success.
- [ ] Yomitan mining and templates are unchanged.
- [ ] Gamepad second-confirm cannot mine a stale or different result.

## Dependencies

Goals 4, 5, 6, and 8. Python integration can be developed against a typed
fixture before the native renderer is complete.

## Failure and rollback behavior

Disable only Hoshi mining, not lookup. Preserve the request and user-visible
error for retry. Switching to Yomitan restores the existing mining path.

## Out of scope

Cloning Chimahon's AnkiDroid profile/permission model or promising byte-for-byte
Yomitan template parity.

---

# Goal 10 - Package and verify native artifacts on all release platforms

## Objective

Build, sign, publish, stage, and verify the matching Hoshi host in Windows,
Linux, and macOS GSM packages.

## Rationale

Local success is insufficient for a native feature. The host must be present,
executable, architecture-correct, protocol-compatible, and covered by release
artifact checks.

## Files/modules

- proposed `.github/workflows/build_hoshidicts_host.yml`
- `.github/workflows/release_exe.yml`
- `.github/workflows/dev_release_exe.yml`
- other supported release workflows
- `GSM_Overlay/forge.config.js`
- `scripts/stage-overlay-build.mjs`
- `scripts/verify-overlay-package.mjs`
- proposed host provenance verifier

## Detailed tasks

1. Create a native host workflow modeled on
   `.github/workflows/build_overlay_server.yml`.
2. Build:
   - Windows x64: `gsm_hoshidicts_host.exe`;
   - Linux x64: `gsm_hoshidicts_host`;
   - macOS arm64: `gsm_hoshidicts_host`.
3. Use pinned compiler/CMake versions where practical and cache only safe build
   outputs.
4. Initialize recursive submodules in every native build.
5. Run native unit/integration tests and `--self-test` before upload.
6. Publish artifacts with platform/architecture and source commit metadata.
7. Prefer a separate rolling prerelease/tag from `overlay-server` so changes to
   one native service do not replace the other accidentally.
8. Download the exact expected artifact in stable/dev app builds.
9. Verify checksum/provenance metadata before packaging.
10. Add the host as an overlay extra resource and stage it beside the existing
    input server.
11. Preserve executable permission on Unix.
12. Extend package verification to require:
    - host presence;
    - expected architecture;
    - executable permission;
    - `--protocol-version` success;
    - expected Hoshi source pin;
    - required notices.
13. Confirm Windows SignPath signs or accepts the nested host. If it does not,
    add a dedicated host signing step and verify Authenticode.
14. Include the host in macOS signing/notarization and verify Gatekeeper behavior.
15. Keep Linux dependencies self-contained or explicitly packaged; test on the
    minimum supported distro baseline.
16. Add an artifact smoke test that launches the packaged app, selects Hoshi,
    imports a tiny fixture, and performs a lookup.
17. Ensure the `bee-san` fork workflows reference `${{ github.repository }}`
    for rolling artifacts rather than hardcoding upstream.
18. Document how a fork without signing secrets can produce unsigned
    development artifacts without weakening stable release gates.

## Tests

- Three-platform native CI.
- Three-platform packaged verification.
- Binary architecture inspection.
- Signature/notarization checks.
- Packaged spawn/handshake/self-test.
- Tiny fixture import/lookup smoke.
- Missing/wrong-version artifact negative tests.
- Upgrade test from a package without the host.

## Acceptance criteria

- [ ] Every released architecture contains the correct host.
- [ ] Package verification fails for missing, wrong-arch, wrong-pin, or
  incompatible host artifacts.
- [ ] Host executes under installed-package paths with spaces/non-ASCII names.
- [ ] Windows and macOS trust/signing behavior is verified.
- [ ] Linux executable/dependency behavior is verified on the support baseline.
- [ ] Stable and development workflows consume provenance-checked artifacts.

## Dependencies

Goals 0, 2, and 3. Final smoke tests need Goals 5 and 6.

## Failure and rollback behavior

Release jobs fail closed when the host is missing or invalid. Existing packages
without Hoshi remain valid because Yomitan is the default.

## Out of scope

Adding new GSM release architectures solely for Hoshi.

---

# Goal 11 - Add observability, recovery, and security hardening

## Objective

Make failures diagnosable and bounded without logging user content or weakening
the overlay.

## Rationale

Native parsing, large archives, profile changes, and transparent-window state
create failure modes that ordinary console logging will not explain.

## Files/modules

- host logging/protocol modules
- `GSM_Overlay/hoshidicts_client.js`
- store/import/backend manager modules
- `GSM_Overlay/main.js`
- `docs/LOGGING.md`
- proposed diagnostics exporter integration

## Detailed tasks

1. Define structured host log fields:
   - timestamp;
   - severity;
   - host/protocol/source version;
   - process ID;
   - request ID;
   - operation;
   - catalog generation;
   - dictionary IDs;
   - duration;
   - stable error code.
2. Redact lookup text, glossary content, source sentences, API keys, and full
   local paths by default.
3. Add bounded rotating host logs consistent with GSM process log policy.
4. Add Electron lifecycle logs for spawn, handshake, configure, crash, restart,
   and shutdown.
5. Add import audit events without archive contents.
6. Add an in-settings status snapshot:
   - host version/status;
   - protocol version;
   - selected backend;
   - active catalog generation;
   - loaded dictionary count;
   - last error code;
   - restart count.
7. Add a **Copy diagnostics** action that excludes dictionary/query content.
8. Implement restart backoff:
   - immediate first retry;
   - exponential delay;
   - bounded attempts/window;
   - manual retry after circuit open.
9. Reject pending requests on child exit.
10. Detect and stop crash loops without restarting the overlay.
11. On corrupt active index, quarantine that dictionary, rebuild from remaining
    enabled dictionaries, and report the excluded ID.
12. Run import in low-privilege/bounded mode where platform support makes this
    practical.
13. Enforce all threat-model limits in both Electron and native layers.
14. Add static analysis/sanitizers for the native host:
    - compiler warnings as errors for owned code;
    - ASan/UBSan CI lane where supported;
    - dependency vulnerability/license scanning;
    - fuzz targets for protocol and archive metadata.
15. Add fault-injection switches in development builds for crash, timeout,
    malformed response, slow lookup, failed catalog, and out-of-space.
16. Update `docs/LOGGING.md` with exact log locations and redaction guarantees.

## Tests

- Crash-loop and restart-backoff tests.
- Timeout/cancellation tests.
- Log redaction assertions using sensitive fixture strings.
- Corrupt-index quarantine tests.
- Native sanitizer/fuzz CI.
- Diagnostics payload snapshot tests.
- All threat-model negative tests.
- Resource exhaustion tests with bounded fixture sizes.

## Acceptance criteria

- [ ] A host/import failure can be diagnosed by stable code and request ID.
- [ ] Default logs contain no lookup text or full source sentence.
- [ ] Crash loops cannot consume unbounded CPU/processes.
- [ ] One bad dictionary does not prevent recovery of healthy dictionaries.
- [ ] Protocol/archive/rendering limits are enforced in tests.
- [ ] Diagnostics can be shared without dictionary content.
- [ ] Native sanitizer/fuzz lanes have no known owned-code findings.

## Dependencies

Goals 2 through 7. Security controls should be implemented alongside each goal,
then closed here as a release gate.

## Failure and rollback behavior

Open the Hoshi circuit, close its popup, stop the host, and preserve Yomitan and
all non-dictionary overlay behavior. Never delete active indexes as an automatic
response to an unexplained crash.

## Out of scope

Remote telemetry or uploading dictionaries/logs.

---

# Goal 12 - Document, migrate, and beta the feature

## Objective

Provide accurate user/developer documentation, deterministic upgrade behavior,
and a staged beta before stable release.

## Rationale

Users already have Yomitan dictionaries and workflows. The feature must explain
that Hoshi has separate imports and mining configuration, and beta limitations
must not be inferred from hidden behavior.

## Files/modules

- `GSM_Overlay/README.md`
- root `README.md` or docs site source as appropriate
- `docs/LOGGING.md`
- proposed `docs/features/hoshidicts.md`
- proposed `docs/development/hoshidicts-host.md`
- changelog/release notes
- settings migration code/tests

## Detailed tasks

1. Document:
   - what the backend selector changes;
   - what remains controlled by tokenizer settings;
   - supported dictionary ZIP types/revisions;
   - import/reimport/remove;
   - global files versus profile selection/order;
   - storage location/usage;
   - mining behavior and differences from Yomitan;
   - diagnostics and recovery;
   - how to switch back to Yomitan.
2. State that Yomitan extension dictionaries are not automatically migrated.
3. Add a one-time, non-blocking notice only when a user first selects Hoshi.
4. Do not prompt existing users merely because the feature was installed.
5. Add settings migration:
   - missing/invalid backend -> Yomitan;
   - no deletion of unknown future settings;
   - no eager host start;
   - no import directory creation until needed, unless package verification
     requires it.
6. Define backup behavior. Recommended:
   - include manifest/profile settings in normal settings backup;
   - exclude regenerable large indexes by default;
   - document that ZIP reimport may be required after restore;
   - never create a manifest that points to absent indexes without marking them
     unavailable.
7. Add developer build instructions and dependency pin update procedure.
8. Add native protocol/index schema migration documentation.
9. Add third-party notices and source links to About/notice surfaces.
10. Roll out in stages:
    - developer-only fake backend;
    - internal native alpha;
    - opt-in fork prerelease with mining clearly gated;
    - beta with Goal 9;
    - stable after Goal 13.
11. Collect structured issue templates asking for diagnostic codes, platform,
    backend/host version, dictionary type, and reproduction without requesting
    copyrighted dictionary files.
12. Record known capability differences between the chosen MIT pin and
    Chimahon's GPL pin.
13. Ensure any Electron React UI strings added outside the legacy overlay use
    the repository's `t("key")` localization rules and all locale files.

## Tests

- Upgrade tests from representative old `settings.json` files.
- Backup/restore tests with present and absent indexes.
- Documentation command verification.
- Notice/source-link package inspection.
- Beta checklist completed on clean and existing user data.

## Acceptance criteria

- [ ] Existing users see no behavior change until opting in.
- [ ] Documentation distinguishes popup backend, tokenizer, and mining.
- [ ] Restore/missing-index behavior is deterministic.
- [ ] License/source notices ship in packaged builds.
- [ ] Beta limitations are visible in UI and release notes.
- [ ] Switching back to Yomitan is documented and tested.

## Dependencies

All prior goals as documentation becomes authoritative. Early drafts may land
alongside implementation.

## Failure and rollback behavior

Withdraw or hide the Hoshi selector in a release while preserving imported data
and Yomitan settings. Document the rollback; do not delete indexes on downgrade.

## Out of scope

Bundling third-party commercial/copyrighted dictionaries.

---

# Goal 13 - Qualify and release the stable feature

## Objective

Prove the complete feature on real packaged builds and publish it with a tested
rollback path.

## Rationale

Unit tests cannot prove transparent-window focus behavior, native packaging,
real dictionary compatibility, or Anki integration.

## Files/modules

- all files changed by Goals 0 through 12
- `.github/workflows/`
- `scripts/verify-overlay-package.mjs`
- root and overlay package manifests
- native host artifacts and provenance metadata
- release notes/changelog
- proposed release qualification evidence document

## Tests

### Required automated gates

1. Root TypeScript/Vitest suite.
2. Relevant Python test suite through the repository `.venv`.
3. Scoped Ruff formatting/checks for changed Python.
4. Native host unit/integration tests.
5. Native protocol/archive fuzz and sanitizer lanes.
6. Three-platform host builds.
7. Three-platform overlay/app packages.
8. Extended `verify-overlay-package`.
9. Packaged host self-test and fixture lookup.
10. Provenance/license verification.
11. Renderer security and screenshot tests.
12. Settings upgrade/backup tests.
13. Fake and real Anki mining tests.

### Manual qualification matrix

Run at least:

| Dimension | Values |
| --- | --- |
| Platform | Windows x64, Linux x64, macOS arm64 |
| Backend | Yomitan, HoshiDicts |
| Input | mouse, keyboard, gamepad |
| Overlay mode | automatic, manual hold, manual toggle |
| Window mode | windowed, borderless, exclusive fullscreen where supported |
| Upscaling | Magpie off/on on Windows |
| Profile mode | overlay profiles disabled/enabled; switch while popup open |
| Dictionary | term only, term+frequency+pitch, structured/media, malformed |
| Lookup | plain, inflected, no result, recursive, rapid movement |
| Mining | create, duplicate, failure, selected glossary, second confirm |
| Upgrade | old settings, beta settings, missing/corrupt host/index |

## Detailed tasks

1. Build a clean prerelease from the fork.
2. Install it on clean machines/VMs for all supported platforms.
3. Upgrade an existing package with populated Yomitan settings/dictionaries.
4. Confirm Yomitan baseline before enabling Hoshi.
5. Import representative legally redistributable fixtures and user-owned local
   test dictionaries.
6. Exercise rapid lookup/cancel/profile/backend switch races.
7. Verify focus and click-through with real games.
8. Verify Magpie and display scaling.
9. Verify controller interaction while the overlay is not initially focused.
10. Verify real Anki create/enhance/duplicate/failure paths.
11. Measure performance budgets and attach results.
12. Inspect installed files, signatures, notices, and source links.
13. Simulate host deletion, wrong version, crash, corrupt index, and no space.
14. Test rollback:
    - select Yomitan;
    - install prior release if supported;
    - preserve Yomitan settings;
    - preserve Hoshi indexes for later re-upgrade;
    - document any index downgrade incompatibility.
15. Publish beta first and hold stable promotion until blocker issues are zero.
16. Produce release notes with exact supported/unsupported behavior.

## Acceptance criteria

- [ ] Every automated gate is green at the release commit.
- [ ] Manual matrix evidence is attached for all three platforms.
- [ ] Yomitan regression count is zero.
- [ ] No P0/P1 security, data-loss, focus, click-through, or mining issue remains.
- [ ] Performance budgets pass or have an explicitly approved evidence-backed
  revision.
- [ ] Packaged provenance and notices match the approved Goal 0 path.
- [ ] Rollback to Yomitan is immediate and data-preserving.
- [ ] Stable release notes state mining and dictionary compatibility precisely.

## Dependencies

Goals 0 through 12.

## Failure and rollback behavior

Do not promote the beta. Keep Yomitan as default and either hide Hoshi behind a
development flag or ship a corrective prerelease. Never "fix" a release blocker
by silently falling back to another backend.

## Out of scope

Declaring broader platform/language support based only on compilation.

---

## Cross-goal test fixture strategy

Use only redistributable, generated, or explicitly licensed fixtures in the
repository and CI:

1. A tiny generated term dictionary with plain glossaries.
2. A dictionary with duplicate expressions/readings.
3. A frequency-only dictionary.
4. A pitch-only dictionary.
5. A structured-content dictionary containing every allowed node.
6. A media dictionary with safe image/audio plus rejected types.
7. A kanji dictionary if supported by the approved pin.
8. An inflection corpus with expected MIT/GPL behavior differences documented.
9. A malformed archive corpus:
   - missing index;
   - bad revision;
   - invalid JSON;
   - path traversal;
   - duplicate paths;
   - giant entry declarations;
   - extreme compression;
   - truncated ZIP.
10. Golden normalized result JSON independent of renderer markup.

Do not commit real user dictionaries or copied copyrighted archives.

## Full test matrix

| Layer | Test type | Primary proof |
| --- | --- | --- |
| Hoshi library pin | golden differential | chosen capability/behavior is known |
| Native host | unit/integration/fuzz | protocol and lookup are bounded |
| Store/import | unit/fault injection | publication is atomic |
| Host client | Vitest fake/real child | lifecycle and timeouts |
| Backend controller | shared contract tests | adapter parity |
| Renderer | unit/security/visual | content is correct and safe |
| Settings | JSDOM/profile migration | opt-in and reversible |
| Interaction | mocked main + packaged manual | click-through/focus safety |
| Controller | Vitest + hardware manual | command parity |
| Mining | Python fake Anki + real Anki | selected note is created once |
| Packaging | workflow + installed smoke | host is shippable |
| Upgrade/rollback | package matrix | existing users are protected |

## Suggested pull request sequence

Keep reviewable boundaries and do not combine native, UI, and mining into one
unreviewable change:

1. **Provenance and characterization**
   - Goal 0 documents/pins the dependency.
   - Goal 1 adds baseline tests.
2. **Native host**
   - Goal 2 host, protocol, fixtures, benchmarks.
3. **Storage/import core**
   - Goal 3 without user-visible backend selection.
4. **Controller refactor**
   - Goal 4 with Yomitan still the only production backend.
5. **Hoshi renderer**
   - Goal 5 behind a development flag.
6. **Settings and import UI**
   - Goal 6; opt-in fork alpha.
7. **Interaction and controller parity**
   - Goals 7 and 8.
8. **Mining**
   - Goal 9 with a separate Python/API review.
9. **Packaging/security**
   - Goals 10 and 11, including signing and fault injection.
10. **Docs/beta/release**
    - Goals 12 and 13.

Each PR should state:

- what already existed;
- what new behavior is added;
- which goal acceptance criteria it closes;
- exact tests run;
- source/provenance impact;
- rollback behavior;
- whether it is safe to ship while the Hoshi selector remains hidden.

## Risk register

| Risk | Likelihood | Impact | Mitigation / stop rule |
| --- | --- | --- | --- |
| GPL/LGPL incompatibility | High until Goal 0 | Release blocker | use pinned MIT path or explicit legal review; do not ship unresolved |
| MIT branch lookup differs from Chimahon | High | Medium/High | differential corpus; document or port only compatible behavior |
| Duplicate Yomitan and Hoshi popups | Medium | High | explicit scanner gate and switch transaction tests |
| Click-through/focus regression | Medium | High | generic lifecycle tests plus real-game matrix |
| Native crash on malformed dictionary | Medium | High | process isolation, fuzzing, quarantine, restart circuit |
| Import corrupts active index | Low after design | High | stage, validate, atomic publish, fault injection |
| Packaged host missing/wrong arch | Medium | High | strict package verification and installed smoke |
| Hoshi mining creates wrong/duplicate note | Medium | High | typed mapping, selected IDs, idempotency, fake/real Anki tests |
| Untrusted glossary executes content | Medium | High | structured allowlist renderer and CSP |
| Large indexes exhaust memory | Medium | Medium/High | low-RAM import, baselines, caps, process isolation |
| Settings/profile references drift | Medium | Medium | stable IDs, schema normalization, profile tests |
| Generated Yomitan source cannot be rebuilt | Medium | High for scanner gate | prove source workflow before exposing selector |
| Fork CI lacks signing secrets | High | Medium | unsigned fork beta; upstream/stable signing remains a release gate |

## Open decisions with recommendations

1. **License path**
   - Recommendation: MIT `main-mit` pin, with a minimal fork only if needed.
2. **Stable mining scope**
   - Recommendation: require Goal 9 before calling the feature stable; alpha may
     clearly disable Hoshi mining.
3. **Kanji dictionary support**
   - Recommendation: advertise only if the approved MIT pin passes capability
     tests or receives a license-compatible implementation.
4. **Original ZIP retention**
   - Recommendation: delete after successful import; retain filename/hash only.
5. **Backup indexes**
   - Recommendation: exclude large regenerable indexes by default and make
     missing indexes explicit after restore.
6. **Yomitan scanner gate**
   - Recommendation: add an explicit runtime gate in maintained source while
     preserving bridge tokenization; do not unload the entire extension unless
     tests prove no dependent feature needs it.
7. **Host build ownership**
   - Recommendation: separate rolling host artifact release with immutable
     commit metadata.
8. **Dictionary styles**
   - Recommendation: scope and allowlist; never inject raw CSS globally.
9. **Silent fallback**
   - Recommendation: no. Offer one-click explicit switch to Yomitan.

## Definition of done

The overall feature is complete only when all of the following are true:

- [ ] Goals 0 through 13 meet every acceptance criterion.
- [ ] Yomitan is still the default on fresh and upgraded installs.
- [ ] Hoshi can be enabled/disabled from settings.
- [ ] Backend and dictionary order are profile-aware; files are global.
- [ ] Imports, reimports, removals, crashes, and manifest changes are atomic and
  recoverable.
- [ ] Hoshi lookup and rendering support the approved term/frequency/pitch/media/
  style capability set.
- [ ] Mouse, keyboard, and gamepad workflows pass parity gates.
- [ ] Click-through, focus, manual mode, and Magpie pass real packaged tests.
- [ ] Hoshi mining creates the selected note at most once and enters GSM's
  existing enhancement/stats pipeline.
- [ ] Yomitan mining remains unchanged.
- [ ] Windows x64, Linux x64, and macOS arm64 packages contain verified native
  hosts.
- [ ] No generated Yomitan file was hand-edited.
- [ ] Threat-model controls and log redaction are tested.
- [ ] Exact dependency source and license notices ship in the package.
- [ ] Performance budgets pass.
- [ ] A user can immediately return to Yomitan without data loss.
- [ ] Documentation and release notes state limitations and differences
  accurately.

## First implementation checkpoint

Before writing feature code:

1. Complete Goal 0 and commit the approved dependency/provenance decision.
2. Complete Goal 1 and prove current Yomitan behavior is characterized.
3. Build a host prototype that imports one tiny fixture and returns one golden
   lookup over the proposed protocol.
4. Measure the MIT branch against Chimahon's pinned GPL branch.
5. Reconfirm the architecture and capability list from evidence.

Do not add the visible Hoshi setting before those five steps pass.
