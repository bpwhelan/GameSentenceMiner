# Hoshidicts pronunciation-audio simplification handoff

## Scope and status

This is the test-first audit for reducing Hoshidicts pronunciation audio to a generic Yomitan-compatible feature. It intentionally changes only tests and this handoff. Production implementation belongs to the dependent implementation tasks.

The target behavior is authoritative:

- Audio availability is derived from `sources.length > 0`; there is no persisted or rendered enable control.
- Playback uses the browser/speech default volume of `1`; there is no persisted or rendered volume control.
- Non-TTS sources are generic direct-URL or Yomitan custom-JSON sources.
- Named JapanesePod101, LanguagePod101, and Jisho audio providers do not exist in production schema, defaults, labels, parsers, or branches.
- Ordered autoplay, manual play, source testing, local TTS, source movement, custom JSON, and Anki media attachment remain.
- Download byte caps, candidate/attempt caps, MIME rejection, and audio-signature inspection are removed rather than replaced.
- The Audio view links this exact English guidance near the top:
  [You can install yomitan-fast-audio to set up instant high quality Japanese audio.](https://github.com/bee-san/yomitan-audio-fast)

Do not edit `GSM_Overlay/yomitan/**`. It is the built upstream Yomitan copy and contains its own provider taxonomy. Unrelated Hoshidicts popup custom links named “Jisho” are also outside this audio reduction.

## Root cause and current architecture

The feature copied Yomitan’s named-provider taxonomy into a second implementation instead of treating Yomitan custom audio as the compatibility boundary. The duplication now spans seven owners:

1. `electron-src/shared/features/hoshidicts.ts` defines the persisted TypeScript profile, source enum, defaults, cloning, and desktop snapshot contract.
2. `electron-src/main/features/hoshidicts/audio_profile.ts` normalizes and persists the same profile.
3. `electron-src/renderer/src/features/hoshidicts/HoshidictsAudioPanel.tsx` renders enable, autoplay, volume, provider choices, ordering, source tests, URL fields, and TTS voices.
4. `GSM_Overlay/features/hoshidicts/{constants.js,desktop_bridge.js,audio.js}` repeats the profile shape and owns availability, autoplay/manual playback, candidate menus, TTS, source order, candidate limits, fallback limits, and volume assignment.
5. `GameSentenceMiner/hoshidicts_audio_profile.py` repeats defaults and normalizes the profile consumed by the API and mining path.
6. `GameSentenceMiner/hoshidicts_audio.py` implements named-provider discovery, custom URL/JSON discovery, candidate identity, downloads, media validation, caching, and mining fallback.
7. `electron-src/main/features/hoshidicts/audio_source_test.ts` implements a second candidate/media download path for the settings test button, including its own size and MIME validation.

The generic seam already works: a `custom-json` source substitutes `{term}` and `{reading}`, accepts the Yomitan `audioSourceList` envelope, exposes ordered candidates through the local GSM API, and downloads the chosen URL. The new contract tests use the public `yomitan-audio-fast` root query shape and an Opus media URL.

## Canonical retained profile

The persisted, IPC, overlay, and Python profile must converge on one shape:

| Field | Contract |
| --- | --- |
| `version` | Remains `1` unless the implementation has a concrete migration reason to bump it. |
| `autoPlay` | Boolean. When true, schedule playback for the first result of a completed lookup. |
| `sources` | Ordered list. An empty list means audio is unavailable; any non-empty list makes audio controls available. |

Every source remains `{id, type, url, voice}` so existing ordering, source-test, TTS, selection, and mining interfaces do not need a parallel transport.

Allowed source types are exactly:

- `custom`: direct URL template.
- `custom-json`: Yomitan `audioSourceList` endpoint.
- `text-to-speech`: local speech synthesis of the expression.
- `text-to-speech-reading`: local speech synthesis of the reading, falling back to the expression.

Default profile: `{version: 1, autoPlay: false, sources: []}`.

Legacy handling is generic, not provider-specific:

- Ignore/drop top-level `enabled` and `volume` keys.
- Keep valid generic/TTS sources in their original order.
- Drop sources whose `type` is not in the allowed generic/TTS set. This safely removes old named-provider rows without keeping brand-aware migration branches.
- Preserve existing generic URLs and TTS voice IDs.
- A malformed profile may still fall back to the default through the existing owner boundary.

## Capability and deletion map

| Capability | Current owner/path | Retain | Delete or simplify |
| --- | --- | --- | --- |
| Shared schema/defaults | `electron-src/shared/features/hoshidicts.ts` | Version, autoplay, ordered sources, generic/TTS source guards and clone | `enabled`, `volume`, named source types/default rows, named i18n suffixes |
| Main-process normalization | `electron-src/main/features/hoshidicts/audio_profile.ts` | Atomic read/write, trimming, unique IDs, allowed-type validation | Required enable/volume fields; reject-all behavior for obsolete source rows |
| Settings draft/save | `HoshidictsSettingsWindow.tsx`, `hoshidictsSettingsModel.ts`, `ipc.ts`, `manager.ts` | Copy-on-edit, debounced atomic save, progress snapshot, restore defaults | Enable and volume state/controls; named provider rows |
| Audio view | `HoshidictsAudioPanel.tsx`, `i18n/{en,ja,ukr}.json` | Autoplay, add/remove/move, URL/voice fields, per-row test button | Enable toggle, range input, named provider labels/help; add linked guidance in all locales |
| Live profile transport | `manager.ts`, `index.ts`, local control channel, `desktop_bridge.js` | Profile publication and update without overlay restart | Duplicate enable/volume validation; named type acceptance |
| Availability | `GSM_Overlay/features/hoshidicts/audio.js`, `GameSentenceMiner/hoshidicts_audio.py`, `hoshidicts_mining.py` | Source-derived availability | Every `profile.enabled` gate and disabled-specific error |
| Manual playback | `audio.js` | Button, ordered source traversal, exact candidate menu, cancellation, candidate selection | Volume assignment and fallback-attempt count |
| Autoplay | `audio.js` | First rendered result only, deferred start, no restart on rerender | Enable dependency and volume assignment |
| TTS | `HoshidictsAudioPanel.tsx`, `audio.js` | Expression/reading modes, voice choice, Japanese language hint, local-only source test | Persisted volume; utterance always stays at `1` |
| Direct URL | `hoshidicts_audio.py` | `{term}`/`{reading}` substitution, ordering, candidate identity | Named-provider special cases |
| Custom JSON | `hoshidicts_audio.py` | Yomitan `type: audioSourceList` envelope and ordered `{url,name?}` entries | Response-byte cap and candidate truncation |
| Local API | `GameSentenceMiner/web/hoshidicts_api.py`, overlay client in `audio.js` | Candidate/media endpoints, request identity, loopback direct-stream optimization | Candidate slicing in the overlay client; empty-blob validation |
| Settings source test | `audio_source_test.ts` and panel test action | Test term `聞く（きく）`, ordered candidate attempts, returned bytes, browser playback | Candidate cap, total test budget as a fallback cap, MIME/declared-size/body-size rejection |
| Media download | `hoshidicts_audio.py` | Provider response bytes, response content type, extension inference, cache if still useful | `MAX_*_BYTES`, `_read_limited_response`, signature sniffers, MIME allowlist |
| Mining/Anki | `hoshidicts_mining.py`, `hoshidicts_audio.py` | Exact selected candidate when supplied; otherwise source order; `storeMediaFile`; `[sound:...]` field attachment | Enable gate, fallback-attempt cap, media validation |
| Tests/fixtures | Audio tests across Electron, overlay, and Python | Generic/TTS behavior and legacy-removal fixtures | Tests that require named providers, enable/volume, caps, or media rejection |

### What “remove limits and validation” means here

Remove existing content/quantity controls from the pronunciation media pipeline:

- `MAX_DISCOVERY_BYTES`, `MAX_CUSTOM_JSON_BYTES`, and `MAX_AUDIO_BYTES` response caps.
- Custom-JSON and local-API candidate slicing.
- Overlay and mining fallback-attempt caps.
- Settings source-test candidate/media byte caps.
- MIME-type rejection and audio container/signature sniffing.
- Empty-blob/media rejection where the browser or Anki storage path can report the natural failure.

Do not replace these with streams that count bytes, alternate allowlists, codecs, magic-number packages, validation classes, or renamed caps.

The following are not media validation and can remain if they stay simple:

- Loopback API request shape and candidate identity checks.
- URL-template substitution and URL parsing.
- Profile/request text-length boundaries unrelated to downloaded media.
- Abort/cancellation and a per-request transport timeout so lookup cancellation cannot leave a hung UI.
- The settings source-count UX bound, unless removing it is necessary to eliminate a shared candidate cap.

Without byte inspection, media extension inference should trust the response `Content-Type`, then the response/candidate URL suffix, with a small neutral fallback. `audio/mpeg` must continue to produce an `mp3` attachment; this is mapping, not media validation.

## Executable contract matrix

These tests are intentionally RED on the audited implementation. A production simplification is complete only when each becomes GREEN for the asserted behavior rather than by deleting or weakening it.

| ID | Contract | Test |
| --- | --- | --- |
| C01 | Exact generic/TTS source enum and empty generic default | `electron-src/main/features/hoshidicts/audio_contract.test.ts` — `uses only generic URL/JSON and local TTS source types` |
| C02 | Legacy enable/volume keys are dropped | Same file — `ignores retired enable and volume keys in saved profiles` |
| C03 | Legacy named rows are dropped while generic rows survive | Same file and `tests/test_hoshidicts_audio_contract.py` — named-provider migration tests |
| C04 | No named-provider production branches or audio locale labels; no retired enable/volume references or locale keys | Same TypeScript contract file — source/locale scans; migration tests are intentionally excluded |
| C05 | Exact linked setup guidance appears in the first Audio section | `HoshidictsSettingsWindow.test.tsx` — `links the exact yomitan-audio-fast setup guidance near the top of Audio` |
| C06 | Audio UI has no enable/volume controls and only generic/TTS options | Same renderer test file — `shows only generic audio sources without enable or volume controls` |
| C07 | Python default and loaded profile match the canonical shape | `tests/test_hoshidicts_audio_contract.py` — default and legacy profile tests |
| C08 | `yomitan-audio-fast` custom JSON discovers, plays, and mines in configured order | Same Python contract file — `test_yomitan_audio_fast_custom_json_plays_and_mines_in_source_order` |
| C09 | Custom JSON has neither declared-size nor streamed-body caps | Same file — declared-size and streamed custom-JSON tests |
| C10 | Media has neither declared-size nor streamed-body caps | Same file — declared-size and streamed media tests |
| C11 | Provider bytes, MIME type, and empty body are not validated | Same file — provider bytes/content-type/empty-byte tests |
| C12 | Every returned custom-JSON/API candidate survives in order and the overlay client does not reject an empty media blob | Python `test_custom_json_preserves_every_returned_candidate` plus overlay candidate/empty-media tests |
| C13 | Mining tries ordered candidates beyond the former attempt cap | Python `test_mining_has_no_audio_download_attempt_cap` |
| C14 | Source presence alone enables manual play and playback stays at `1` | `overlay-hoshidicts-audio.test.ts` — `derives availability from ordered sources and plays at full volume` |
| C15 | Overlay fallback reaches a playable thirteenth source | Same file — `tries ordered fallback candidates without an attempt cap` |
| C16 | Reading TTS remains local and always uses volume `1` | Same file — `uses term and reading TTS locally at full volume without a mining selection` |
| C17 | Settings source test returns empty/non-audio bytes and reaches a 33rd candidate without MIME/size/attempt rejection | `audio_source_test.test.ts` — validation-removal and no-attempt-cap tests |

Run the RED matrix:

```bash
npx vitest run --config vitest.config.ts \
  electron-src/main/features/hoshidicts/audio_contract.test.ts \
  electron-src/main/features/hoshidicts/audio_source_test.test.ts \
  electron-src/main/ui/overlay-hoshidicts-audio.test.ts \
  electron-src/renderer/src/features/hoshidicts/HoshidictsSettingsWindow.test.tsx \
  --testNamePattern='generic Hoshidicts|without MIME|source-test attempt cap|preserves every candidate|empty media responses|derives availability|without an attempt cap|TTS locally at full volume|links the exact|shows only generic'

.venv/bin/python -m pytest tests/test_hoshidicts_audio_contract.py -q
```

Observed against the audited production code:

- TypeScript/renderer matrix: 14 expected failures across 4 files. The failures isolate the named source enum/branches, retired profile references, retained legacy fields, missing guidance, existing controls, candidate slicing, empty-blob rejection, fallback caps, configured volume, and source-test MIME/size/empty/attempt rejection.
- Python matrix: 13 expected failures. The failures isolate profile shape/migration, the enable gate, declared and streamed JSON/media byte caps, signature/MIME/empty validation, candidate truncation, and the mining attempt cap.
- The commands were wrapped only when collecting evidence so an intentional RED exit did not abort the audit worker; the underlying test processes both returned status `1` as expected.

## Retained behavior already covered

Do not duplicate these tests; keep them green while making the RED matrix green:

| Behavior | Existing coverage |
| --- | --- |
| First-result autoplay and rerender idempotence | `overlay-hoshidicts-audio.test.ts` — `starts autoplay on the next task and does not restart it during rerenders` |
| Manual exact-variant menu and mining selection | Same file — `opens an accessible source menu on Shift-click and plays that exact variant` |
| Source-order editing and atomic save | `HoshidictsSettingsWindow.test.tsx` — `edits and auto-saves ordered pronunciation audio sources` |
| Downloadable source test button and playback | Same file — `tests every downloadable audio row with the current draft and plays the returned bytes` |
| Local expression/reading TTS source tests | Same file — `uses the same per-row test control to speak expression and reading TTS` |
| Candidate ID rejects reordered dynamic lists | `tests/test_hoshidicts_audio.py` — `test_candidate_id_rejects_a_reordered_dynamic_list` |
| Custom JSON exact envelope and URL substitution | Same file — `test_custom_url_substitution_encodes_values_and_custom_json_is_exact` |
| Selected pronunciation is stored only after successful note creation | `tests/test_hoshidicts_mining.py` — `test_mining_stores_selected_pronunciation_after_note_creation` |
| Automatic mining audio skips TTS and follows downloadable source order | `tests/test_hoshidicts_audio.py` — `test_mining_skips_tts_and_falls_through_downloadable_sources` |
| Duplicate-note updates apply the configured audio overwrite mode | `tests/test_hoshidicts_mining.py` — `test_duplicate_overwrite_applies_the_audio_overwrite_mode` |
| Failed/disabled mining audio does not block note creation | Same file — existing skipped-audio and failure-path tests; update “disabled” fixtures to empty sources |

Focused retained-behavior evidence on the audited code: 6 Vitest tests passed across the source-test, overlay, and settings owners; 6 pytest tests passed across custom JSON, local Opus playback, candidate identity, source order/TTS skipping, and Anki storage/template attachment. Pytest also reported the repository's existing `mss.mss` deprecation warning.

Broad host evidence:

- `npm run build` passed (`tsc` main build and Vite renderer build); Vite emitted its existing large-chunk advisory.
- Full pytest excluding only the intentional RED contract file passed: 2,533 passed, 62 skipped, 83 warnings.
- Full Vitest excluding intentional RED test names ran 1,387 tests: 1,359 passed, 19 skipped, and 9 failed in three unrelated Windows-path test owners (`obs.test.ts`, `anki_beacon.test.ts`, and `tray_icons.test.ts`). Those files are untouched by this handoff; failures are Linux-host path separator/executable-fixture mismatches. All exercised Hoshidicts owners passed.

## Obsolete owner tests and fixtures to update with production

The contract files are not the only affected tests. The implementation must update or delete obsolete assertions in these owners rather than adding compatibility shims:

- `electron-src/main/features/hoshidicts/audio_profile.test.ts`: named defaults, required `enabled`/`volume`, provider-specific fixtures.
- `electron-src/shared/features/hoshidicts.test.ts`: shared profile clone/default expectations.
- `electron-src/main/features/hoshidicts/{manager,index,ipc,runtime_state,hoshidicts-backup}.test.ts`: serialized audio-profile fixtures.
- `GSM_Overlay/features/hoshidicts/desktop_bridge.test.ts`: bridge validation of enable/volume and named types.
- `electron-src/main/ui/overlay-hoshidicts-reader.test.ts`: reader update fixtures carrying enable/volume and named sources.
- `electron-src/main/ui/overlay-hoshidicts-audio.test.ts`: remaining named source IDs/types and options for deleted fallback caps.
- `electron-src/renderer/src/features/hoshidicts/HoshidictsSettingsWindow.test.tsx`: volume edits, enable toggles, named labels/defaults, and snapshots.
- `electron-src/renderer/src/features/hoshidicts/test_helpers.ts`: default snapshot/profile factory.
- `tests/test_hoshidicts_audio.py`: named-provider discovery tests, old enabled/volume profile expectations, cap/rejection tests superseded by the contract file.
- `tests/test_hoshidicts_mining.py` and `tests/test_hoshidicts_factories.py`: default audio profile and disabled-audio fixtures.

Jisho custom-link tests outside an audio profile remain valid and must not be removed.

## Suggested vertical implementation order

1. Make C01–C04 and C07 green by changing the shared/main/Python/bridge profile contract together. Update persistence fixtures before moving on.
2. Make C05–C06 green by simplifying `HoshidictsAudioPanel.tsx` and all three locale files. Keep source move/test/autosave tests green.
3. Make C12 and C14–C16 green in overlay constants/bridge/audio. Preserve autoplay, manual menu selection, local TTS, cancellation, and source order.
4. Remove named discovery branches and download/media validation in Python; make C08–C13 green. Keep custom URL/JSON identity and Anki tests green.
5. Simplify `audio_source_test.ts`; make C17 green while preserving the per-row test button.
6. Run the focused owners, then `npm run build`, full Vitest, and full `.venv/bin/python -m pytest`.
7. Search the active audio owners and audio locale subtrees for retired fields/brands/cap/validator symbols. Historical migration tests may retain the old strings; production and active fixtures may not.

## Completion gates for the implementation task

- Contract matrix is green.
- Retained behavior table is green.
- No `enabled` or `volume` field remains in the active audio profile, bridge, UI, overlay, Python loader, or mining path.
- No named-provider type/default/label/parser remains in active Hoshidicts audio code.
- No downloaded-media byte counter, candidate slice, fallback-attempt cap, MIME allowlist, or signature detector remains.
- The exact guidance link is visible near the top of Audio and localized through the existing i18n mechanism.
- Custom JSON works with the documented `yomitan-audio-fast` envelope and all candidates preserve order.
- Audio mining still stores the chosen bytes through AnkiConnect and inserts the resulting `[sound:...]` reference.
- No files under `GSM_Overlay/yomitan/**` are modified.
