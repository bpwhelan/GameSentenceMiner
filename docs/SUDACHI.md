# Shared Japanese dictionary

All GSM Japanese analysis uses the shared Rust Sudachi service: Python Anki
furigana, Whisper reading comparison, new-line word statistics, overlay readings,
controller word selection, local vocabulary matching, and compiled user dictionaries.
MeCab selections migrate to Sudachi. The statistics feature flag controls recording
statistics; it no longer chooses the tokenizer for other features.

Open the desktop setup guide's Japanese dictionary step or Overlay Settings →
Furigana and Tokenization. Select Small, Core, or Full and choose Download / Retry.
Downloads happen only after this runtime setup action. Ordinary analysis and status
requests never download dictionaries. Failed downloads, invalid dictionaries, or an
unavailable service expose setup/retry errors; they never produce substitute tokens.
The Python backend requires the shared GSM service to be running.

The native desktop hosts Sudachi and its local vocabulary database. The input
helper forwards existing WebSocket requests over its private process pipes.
Standalone overlay builds host the same service in the helper itself.
The desktop releases loaded dictionaries after five minutes without requests,
including when the last client disconnects. The next request loads them on demand.

The service persists the chosen edition under `sudachi/selection.txt` in GSM's data
directory. Existing Python/overlay dictionary preferences seed the first selection.
Small is the default for a fresh profile.
Subsequent clients reuse that choice; only explicit setup changes it. Dictionary
archives have pinned SHA-256 checksums and extraction uses a temporary file. Retry
can replace an unreadable system dictionary without removing user CSVs or vocabulary.
`GSM_SUDACHI_DATA_PATH` and `GSM_SUDACHI_USER_DICTS_PATH` support relocated data roots.

Compatibility is intentionally pinned to sudachi.rs **0.6.10** and SudachiDict
**20260116 (V0)**. The [upstream compatibility documentation](https://github.com/WorksApplications/SudachiDict/blob/develop/README.md)
states that releases from 202610 use V1 and require engine 0.7 or newer. Do not
switch the download to “latest.” Update the engine, release and all three checksums
together. User dictionary compilation caches include the system dictionary identity,
so editions/formats never share a compiled user binary. Original CSVs are retained;
compilation errors are reported instead of silently omitting a user's entries.

No migration resets `game_lines.tokenized`, word IDs, saved readings, occurrences,
Anki links, or vocabulary snapshots. Completed lines bypass analysis entirely.
Unprocessed lines stay pending if the dictionary is unavailable and can be retried
by normal backfill after setup. Historical records are not automatically retokenized.

Desktop staging excludes the MeCab package and bridge. Python package discovery,
package-data exclusions, and the source manifest exclude MeCab binaries/dictionaries
from wheels and source distributions. No Sudachi dictionary is bundled either.
Wheel smoke checks reject either dictionary payload.

Offline validation:

```powershell
node --test scripts/native-package-policy.test.mjs GSM_Overlay/tests/gamepad_tokenization.test.cjs
cargo test --offline --workspace --manifest-path GSM_Overlay/input_server/Cargo.toml
node GSM_Overlay/tests/sudachi-migration-smoke.cjs GSM_Overlay/input_server/target/release/gsm_overlay_server.exe
```

The service smoke test uses an empty temporary cache and does not install a dictionary.
Tests requiring a real dictionary remain opt-in; do not download one for validation.
