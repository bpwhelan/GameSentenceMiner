# Local vocabulary parsing

GSM can parse Japanese OCR text with its existing Rust Sudachi service and match
the results against a persistent word list. The overlay can highlight words and
navigate new / i+1 words without sending the OCR text to Jiten.

## Enable it

1. Rebuild the Rust server (`cargo build --manifest-path GSM_Overlay/input_server/Cargo.toml`)
   and restart GSM. Development GSM prefers the binary under `target/debug`.
   Packaged releases must ship the updated server too; an older server produces
   an explicit update error.
2. Open **Overlay Settings → Reading → Local vocabulary** and enable
   **Parse highlighting locally**.
3. Select **Jiten**, **Anki**, or **Jiten and Anki**, then click **Sync now**.
   For Jiten, enter the existing Jiten API key above these controls. For Anki,
   run Anki with AnkiConnect; GSM uses the current profile's AnkiConnect URL
   and configured word field. An optional Anki search selects cards. Specify
   a reading field if available, especially for words with multiple readings.
4. Enable **Show Jiten Style Text Highlighting** below the local settings.
   Jiten Reader does not need to be enabled for local highlighting.

The first parse uses GSM's existing verified Sudachi dictionary download if the
dictionary is not installed. Once the dictionary and word list are present,
highlighting works offline. The word list refreshes on enable and every 15 minutes
while the overlay runs. **Sync now** reports counts, refresh time, and errors.
Changing accounts or source settings immediately switches the selected snapshot.

This setting controls word-state highlighting. Choose **Sudachi** for the
existing tokenizer/furigana setting to keep those features local too. Jiten
Reader's own popup/website parsing and explicit Jiten grading still use its API.

## Storage and synchronization

- The Rust service owns `local-vocabulary.sqlite3` in GSM's normal configuration
  directory (on Windows, `%APPDATA%/GameSentenceMiner`). A separate SQLite file
  avoids coupling Rust migrations to the Python statistics database. It uses WAL
  and a busy timeout. `GSM_VOCABULARY_DB_PATH` can override the file, including
  for isolated tests.
- Each source snapshot is replaced in one transaction. A malformed export,
  incomplete Anki batch, network error, or failed transaction preserves the
  previous snapshot. An empty *successful* import removes stale entries.
- Jiten scopes hash the API base and key. Anki scopes hash its URL, GSM profile,
  search, and field mapping. Credentials and captured text are not stored in the
  database. Jiten has precedence when both sources match a word.
- Jiten imports `/api/user/vocabulary/export?includeWordText=true`, retaining
  real `(wordId, readingIndex)` identities, spelling, reading, state, and due date.
  The export's review history is discarded. Due flags advance locally with time.
  The response is bounded to 64 MiB; an oversized export fails without replacing
  the saved words.
- Acknowledged Jiten grades/state changes through GSM's existing request broker
  refresh the matching local states. New cards enter on the following full
  refresh, coalesced to at most one automatic export per minute after grading.
  An in-flight older export cannot overwrite a later acknowledged state change.
  SRS reviews are not queued or replayed offline.
- Anki imports use `findCards` and `cardsInfo` in batches of 500. New cards remain
  new; learning/relearning and review intervals under 21 days are young; review
  intervals of at least 21 days are mature. Suspended cards retain their tier.
  Due status comes from `is:due` and refreshes on the next Anki sync. Among cards
  for the same spelling/reading, the strongest learned tier wins.
- Anki imports stay local. They are not automatically uploaded to Jiten or used
  to overwrite Jiten's SRS scheduling. Jiten remains authoritative for its cards.

## Matching boundaries

The parser uses Sudachi B mode, dictionary and normalized forms, NFKC
normalization, and kana-normalized readings. It derives a dictionary-form reading
for inflected tokens, so `食べた` can match `食べる`. Supplied readings distinguish
homographs; an omitted Anki reading matches by spelling. Ambiguous imported Jiten
identities never produce a guessed remote ID.

GSM also runs Jiten's declarative token corrections locally, before vocabulary
matching. The complete 133-rule table is pinned to upstream commit
`a2fd4a6ccbbcc55c975694627e3b54f3f4e23f11`; 128 rules are enabled and five
JMdict-dependent rules stay inactive. This handles corrections such as
clause-initial `いい` + `か` + `！` → `いいか` + `！`, or `主人` + `格` → `主` + `人格`.
Context guards preserve ordinary questions and other valid readings. Rewrites
preserve the original source text, whitespace, and UTF-16 ranges. Tokenization
does not depend on the user's known-word list.

The rules and engine are adapted from **Jiten by Sirush and contributors** under
Apache-2.0, with its license and original source included. See
[credits, scope, and update instructions](../GSM_Overlay/third_party/jiten-parser/README.md)
and [upstream source](https://github.com/Sirush/Jiten/blob/a2fd4a6ccbbcc55c975694627e3b54f3f4e23f11/Jiten.Parser/Stages/MorphologicalAnalyser.RewriteRules.cs).
No .NET service or additional download is needed for these corrections.

This is a port of Jiten's declarative rewrite component, not its full parser.
Its other split/combine/repair stages, deconjugation engine, custom user dictionary,
and JMdict/frequency-based candidate selection are not included. Boundaries and
coverage can therefore differ from Jiten. GSM imports explicit SRS cards, not Jiten's
derived word-set/related-form knowledge, frequency ranks, definitions, or pitch
accents. Words with no matching import remain new and have no Jiten ID. Existing
dictionary popups still supply definitions; explicit Jiten grading resolves a
real Jiten identity through the existing API path.

Protocol references: [Jiten API](https://api.jiten.moe/index.html),
[export schema](https://github.com/Sirush/Jiten/blob/master/Jiten.Core/Data/FSRS/FsrsCardExportDto.cs),
[FSRS states](https://github.com/Sirush/Jiten/blob/master/Jiten.Core/Data/FSRS/FsrsState.cs),
[reader states](https://github.com/Sirush/Jiten/blob/master/Jiten.Core/Data/User/KnownState.cs),
[state calculation](https://github.com/Sirush/Jiten/blob/master/Jiten.Api/Services/CurrentUserService.cs).

## Rust WebSocket API

The normal service handshake advertises `vocabularyProtocol: 1`. A local desktop
client sends `configure_features` with `features: ["sudachi"]` before parsing.
Vocabulary operations require a loopback connection without a browser Origin.

```json
{"type":"local_vocabulary","requestId":"1","request":{"action":"replace","source":"manual:my-list","words":[{"spelling":"猫","reading":"ねこ","knownState":[5]}]}}
{"type":"local_vocabulary","requestId":"2","request":{"action":"parse","sources":["manual:my-list"],"texts":["猫がいる。"]}}
{"type":"local_vocabulary","requestId":"3","request":{"action":"status","sources":["manual:my-list"]}}
```

Replies retain `type` and `requestId` and contain either `result` or `error`.
`parse` returns one token array per input text, with UTF-16 `start`/`end` offsets,
surface `word`, `headword`, `normalizedForm`, `reading`, `pos`, `knownState`, and
nullable `wordId`/`readingIndex`. It does not manufacture Jiten IDs.
`appliedRules` on each token identifies corrections that fired. The top-level
`rules` object reports the upstream commit, imported/enabled rule counts, and
the names of inactive dictionary-dependent rules. `tokenSource` remains
`local-sudachi`; the additions do not change vocabulary protocol version 1.
Rule pins can match a saved Jiten ID even if its spelling differs from Sudachi's
lemma, but a confirmed reading index is required before returning that identity.

States use Jiten Reader's numbering: `0` new, `1` young, `2` mature,
`3` blacklisted, `4` due, `5` mastered, `6` redundant, `7` suspended.
`replace` takes optional `wordId`, `readingIndex`, and Unix-seconds `dueAt`.
`update_states` takes `source` and `words` with real `wordId`, `readingIndex`,
and `knownState`; it patches existing imported identities after a remote write
and discards their old due dates. It does not write to Jiten.

Limits: eight selected sources, 128 paragraphs / 256 KB per parse, 250,000 words
per snapshot, and 1,000 identities per state update. The Electron connection
additionally limits messages to 32 MiB and pending requests to 32.

## Verification

```powershell
node --test GSM_Overlay/tests/*.test.cjs
cargo test --manifest-path GSM_Overlay/input_server/Cargo.toml

# Exercise the real tokenizer using an already installed dictionary:
$env:GSM_TEST_SUDACHI_DICTIONARY = "$env:APPDATA/GameSentenceMiner/sudachi/v20260116-core/system_core.dic"
cargo test --manifest-path GSM_Overlay/input_server/Cargo.toml vocabulary::tests -- --include-ignored

# Exercise the actual server protocol and SQLite store in a temporary directory:
$env:GSM_VOCABULARY_TEST_BINARY = (Resolve-Path GSM_Overlay/input_server/target/debug/gsm_overlay_server.exe).Path
node --test GSM_Overlay/tests/local_vocabulary_native.test.cjs
```

The native smoke test expects an installed core dictionary and uses fake Jiten
responses. It does not access or change the user's Jiten or Anki account.
