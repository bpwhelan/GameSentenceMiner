# Incremental Rust migration

## Current ownership catalogue (2026-11-19)

The desktop shell runs as pure Rust (`src-tauri`, zero Node runtime) and already
owns windowing, capture, OCR, text hooking, Agent supervision, OBS management,
packaging/updates, dictionaries, AnkiConnect transport/sync, cron scheduling,
Sudachi word indexing, and most read/write SQLite analytics. Mining itself still
launches `GameSentenceMiner.gsm`. See [AI_AGENT_MAP.md](AI_AGENT_MAP.md) for the
full cross-component map across Rust crates, PyO3 `_native`, standalone native
helpers, Python, and WebView UIs.

| Subsystem | Owned by Rust (Tauri / `native/*`) | Owned by PyO3 (`_native`) | Still owned by Python (`GameSentenceMiner/`) |
| --- | --- | --- | --- |
| **Desktop shell, settings, packages, bus** | Full runtime: Tauri windows/trays/updates, `gsm-settings`, `gsm-packages`, `gsm-runtime` bus & 256-item text outbox, `gsm-downloads`. | Verified asset/file downloads (`gsm-downloads`). | Mining profile schema (`config.json`), profile switching, standalone/non-Tauri fallbacks. |
| **Capture, OBS, hooks & Agent** | `gsm-capture` (WGC/xcap/OBS), `obs/*` (install, v5 client, scenes, switcher, game session/profile selection, recording/longplay outputs), `gsm-texthook`, `gsm-agent` + `gsm-agent-host`, `gsm-text-preview` Hook Finder. | — | Low-latency Anki replay saves, replay-only toggles, OBS event listeners, profile reconfiguration, mining screenshots, standalone OBS launch. |
| **OCR & overlay** | Native OCR tab (`ocr.rs`), overlay OCR (`overlay.rs`), `gsm-overlay` engines (OneOCR/portable, Meiki, ScreenAI, VOCR, MIDA, Lens, LiveText, Bing, Google Vision, composite), Win32 crop picker, `OverlayHost`, `DictionaryManager`. | OCR text/layout/spatial/overlay filters, coordinate projection, `SequenceMatcher` metrics (for Python/standalone paths). | Scene/window context & result ingestion, overlay translation/focus/pause callbacks, macOS/Linux portable OneOCR runtime, standalone `gsm_ocr.py`/`owocr`/`get_overlay_coords.py` fallbacks. |
| **Live dialogue & TextFeed** | Fallback `text.classify` (`text_correlation.rs`); in-process preview (`gsm-text-preview`); speech settings/relay (`mining_workspace.rs`). | `classify_dialogue`, `compact_dialogue`, `DialogueSkipDetector`, `DialogueJournal`, repeated-char/line cleanup. | `AuthoritativeTextRuntime` (`TextCoordinatorActor`/`TextProjectionActor`), `TextRecord`/`IngressAck` creation, speech freeze timers, clipboard & external WS intake, live text processing, live stats, TextFeed v2/plaintext/overlay WS servers, Windows speech helper supervision. |
| **SQLite history, search & analytics** | `gsm-history` serialized writer + read pool: dialogue capture, mined-line updates, game linking, daily/per-game rollups, Sudachi word/kanji index & backfill (`word_index.rs`), sentence & duplicate search, `games_list`, text deletion & deduplication preview/execute, dashboard/game/overview/today/heatmap/kanji/maturity/Anki-game/retention/earliest/note-kanji reports, all tokenization & word-novelty queries. | Batched `count_kanji` (Python fallback paths). | Flask HTTP server (`:7275`) & HTML templates; SQLite schema migrations & backups; **Goals & projections** (`goals_api.py`, `goals_projection_api.py`); **Game metadata CRUD & Jiten/IGDB linking** (`web/routes/*`); remaining DB mutations (`delete-sentence-lines`, `delete-games`, `merge_games`, `migrate-lines`, `delete-regex-in-game-lines`, archiving); imports/exports (`import_api.py`, `third_party_stats_api.py`, `stats_export_api.py`); Yomitan/frequency dict ZIP generation; custom advanced-regex rollup fallback. |
| **Anki & card mining** | `anki_connect.rs`, `anki_poll.rs`, `anki_monitor.rs`, `anki_cards.rs`, `anki_edit.rs`, `anki_group.rs`, `anki_media.rs`, `anki_sync.rs`. | `rank_card_lines` (fuzzy card-to-line matcher). | High-level mining orchestration (`anki.py`), card object/field policy, media prefetch, Anki Beacon HTTP ingress (`/api/anki/events`), session review (`session_review.py`), standalone AnkiConnect fallback. |
| **Replay, media, VAD, clips & longplay** | Recording/longplay start/stop (`obs/outputs.rs`). | — | **Almost entirely Python**: replay folder watchdog (`replay_handler.py`), FFmpeg audio/screenshot/WebP/AVIF extraction (`util/media/*`), Silero ONNX / faster-whisper VAD (`vad.py`), pause-gap handling, clip cards/API (`clip_cards.py`), longplay SRT (`longplay_handler.py`). |
| **Cron scheduler** | `cron.rs` + `gsm-history::schedule` scheduler loop; executes `populate_games`, `tokenize_backfill`, and retired `anki_word_sync` directly in Rust. | — | Leased runners for `jiten_sync`, `jiten_upgrader`, `daily_goals_completion`, `tadoku_sync`, `kechimochi_sync`, `database_maintenance`, plus thin wrappers invoking native `daily_stats_rollup` and `anki_card_sync`. |
| **AI, Cloud Sync & external APIs** | — | — | **Entirely Python**: AI providers & prompts (`ai/`), Encrypted Cloud Sync (`util/cloud_sync/`), Kechimochi & Tadoku sync, Jiten/VNDB/AniList/IGDB clients, Discord RPC. |
| **Qt6 dialogs** | `gui_dialog.rs` typed `open_python_dialog` & one-shot host supervision. | — | All 14 PyQt6 windows (`ui/*_qt.py`: Settings, Anki confirmation, Field grouping, Screenshot selector, Session review, Sync, Prompt help, Anki setup, Furigana preview, OCR selectors, Text/Scene pickers). |

## Mining, reading history, and Qt compatibility

The Tauri desktop now writes accepted dialogue, resolves scene-to-game links,
imports batches of lines, and attaches Anki media and note IDs to existing
lines. The database schema stays compatible with existing profiles. A capture
retry preserves the original creation time, vocabulary, and card fields. A
changed line invalidates the vocabulary derived from its old text. An import
that fails rolls back the entire batch, including any new games.

The built-in game population job also runs in Rust. It repairs missing game
links after imports and syncs, preserves existing links, and uses the first
matching stored title or OBS alias when names overlap. It links all matching
lines in one transaction. This job uses the desktop's writer directly from
the scheduler, avoiding a separate Python worker process.

The native history service lends the running backend a serialized SQLite
writer. Legacy write jobs, backups, and shutdown use the same Python queue
to order operations. The desktop releases its file handle on database close
or broker disconnect. Reports use separate read transactions. The mining
heatmap includes archived lines, today's session report accounts for reading
breaks, and kanji grids preserve the displayed order when counts tie. The
desktop serves these calculations behind the existing HTTP routes.

| Existing route | Work performed in Rust |
| --- | --- |
| `/api/mining_heatmap` | Counts mined lines by local calendar date |
| `/api/daily-activity` | Builds the daily character, time, and speed series |
| `/api/today-stats` | Groups sessions, estimates active reading time, and resolves game aliases |
| `/api/stats/all-lines-data` | Merges historical, imported and live reading totals for the overview and streaks |
| `/api/stats/game-milestones` | Finds the oldest and newest releases before loading their covers and first-played dates |
| `/api/stats/kanji-grid` | Combines historical rollups, today's lines, and archived frequencies |
| `/api/game/<game_id>/kanji-grid` | Counts raw game text and archived kanji, ranks counts, and computes colours |
| `/api/kanji-frequency` | Looks up a character across daily rollups |

The default cleaning rules use the native session, reading overview and dashboard-grid paths.
Profiles with custom punctuation or repetition rules use the original Python
calculations for those three reports. Flask still adds game metadata to sessions.
Separate imported databases, nested Python transactions, and payloads larger
than the desktop transport permits use the local history path. Only the backend
process owning the broker connection delegates work. A spawned tokenizer or
cron worker can inherit the environment without owning that connection.

The desktop queries AnkiConnect for recently added notes and retains the
baseline for the mining session. Polling returns new IDs, and the next poll
acknowledges cards handled by the miner. A disconnected reply can be retried.
Push notifications and note deletions update the same baseline. Uploads send a
path, size, and modification time across the desktop broker. Rust opens
the file, verifies its metadata, and streams
base64 in 48 KiB input blocks to AnkiConnect.

Prepared notes use one desktop request to update Anki fields, add mining
tags, and remove the overlay tag in order. If Anki reports a busy collection,
the miner waits and resumes at the rejected action. A lost
reply surfaces an error. Replaying the whole edit could repeat a mutation
that Anki had already accepted. The desktop uses the configured Anki URL and
reports per-action durations when card timing is enabled.

### Anki duplicate selection and grouped writes

The desktop searches AnkiConnect for older notes of the configured type and
compares normalized words after removing cloze, HTML, and reading markup.
Manual selection receives the matching notes in ID order. Automatic selection
reads the eight oldest candidates first. If those miss, it tries 64 and then
up to 512 at a time. Manual selection reads up to 512 notes per request. The
Qt chooser still owns the user's selection.

For a confirmed merge, the miner sends the source fields, generated tags, and
chosen order to the desktop. Rust reads the target again, assigns context IDs,
groups text and images, normalizes sentence line breaks and deduplicates tags.
It moves the Anki browser off a selected target using the configured Anki URL.
It updates the target fields and tags before sending any requested source
deletion. A busy collection retries only the rejected action. A lost response
ends the operation. For example, if Anki accepts the field update and rejects
the tags, the updated fields remain on the target and the source note survives.
Backend shutdown cancels pending requests and retry waits.
Grouped writes on the desktop run one at a time so simultaneous merges read
the result of the preceding write.

Standalone launches use the local implementation. A chooser response or source
payload over the desktop transport limit can also use that path. An existing
group attribute outside the native integer representation uses local preparation
before any edit takes place. The desktop accepts numeric note IDs encoded as
strings. A nonstandard historical field value can also use local preparation.

The benchmark uses disposable collections and the production candidate and
merge entry points. The comparison keeps the previously migrated note-edit
service enabled on both sides. The small case automatically selects from eight
older notes, merges the confirmed fields, and deletes the duplicate. The larger
search cases scan 1,024 candidate IDs, including mismatched words and models.
The large merge adds a context to 128 existing groups.

Each run compares the chooser or automatic decision and a digest of the
persisted fields, tags, and ordered mutations. Separate untimed checks cover
overwrite and keep modes, repeated group IDs, unusual fields, a missing target,
the selected Anki browser note, a busy collection, rejected tags, and a response
lost after the target write. Four concurrent desktop merges must retain all four
contexts. An interrupted busy merge must leave the source in the collection.
An additional chooser run compares all HTML5 named character references and
numeric control and invalid references against the Python decoder.

The wall and CPU figures cover a complete operation. CPU adds the calling
process and the desktop. A separate sampler measures their combined peak
private resident memory over three additional operations after warm-up.

Five paired runs on Windows alternated the two implementations. Values below
are medians. The CPU counters have 15.625 ms resolution on this machine.

| Workload | Wall ms, Python → Rust | CPU ms, Python → Rust | Peak MiB, Python → Rust |
| --- | ---: | ---: | ---: |
| Select from 8 and merge | 22.30 → 7.69 | 8.79 → 6.84 | 49.31 → 50.74 |
| Show all 256 exact matches among 1,024 candidates | 26.14 → 17.85 | 17.58 → 11.72 | 60.74 → 52.06 |
| Select the oldest of 1,024, first candidate matches | 26.21 → 2.51 | 17.58 → below timer resolution | 60.58 → 49.63 |
| Select the oldest of 1,024, only the last candidate matches | 24.45 → 16.17 | 17.58 → 7.81 | 59.78 → 51.15 |
| Merge into one note with 128 existing contexts | 14.53 → 7.03 | 7.81 → 2.34 | 50.08 → 51.06 |

The first Rust build used fixed 256-note pages. The chooser took 30.81 ms and
peaked at 51.31 MiB. Automatic selection took 7.91 ms and read 256 notes when
the oldest candidate matched. The final build reads eight notes in that case.
[Initial page sizing comparison](benchmarks/anki-grouping-fixed-pages-2026-11-18.json).
[Five-pair results, mutation checks and executable checksum](benchmarks/anki-grouping-2026-11-18.json).

~~~powershell
.venv\Scripts\python.exe scripts/benchmark_mining_history.py --case group-small group-chooser group-auto group-auto-late group-merge edit sync-small --rounds 5 --output .tmp_test_env/anki-grouping.json
~~~

### Reading Anki notes for mining

For a polled or incomplete Beacon note, the mining backend asks Tauri to read
the requested note IDs from the active AnkiConnect profile. Rust decodes the
note ID, model, tags, card IDs, and field names, values and order. The Python
handler constructs its existing card objects from those values. This keeps
profile field-name repair and Qt confirmation working with the original
ordering, including case-sensitive alternatives. A nonstandard historical row
uses the original decoder individually. A malformed row can fail while its
siblings continue. Batch reads keep per-attempt timing and cancellable busy
retries through the existing mining logger.

Replay and web requests for the latest note now use one desktop request. Rust
reads the last ID returned by Anki's `added:1` query and fetches that note.
If its fields exceed the local transport limit, the mining backend reads the
already selected ID directly. The desktop cancels a pending read when its
owning backend session ends. Standalone Python keeps its direct AnkiConnect
path.

Five paired Windows runs alternated the implementations against the same
loopback AnkiConnect fixture. Each operation includes construction of the
cards delivered to mining. Peak MiB measures the combined private resident
memory of the mining caller and desktop over three additional warm operations.
The fixture checked field values and order, tag order, card IDs and models,
including numeric strings in historical notes and a single field of 7 MiB.
[Raw samples and card digests](benchmarks/anki-card-reads-2026-11-18.json).

| Workload | Wall ms, Python → Rust | CPU ms, Python → Rust | Peak MiB, Python → Rust |
| --- | ---: | ---: | ---: |
| Read one new note | 3.98 → 1.15 | 1.95 → 0.98 | 49.21 → 49.09 |
| Read 32 new notes with formatted definitions | 17.82 → 2.45 | 15.63 → 2.60 | 49.87 → 50.27 |
| Read the latest of 8 recently added notes | 7.22 → 1.89 | 3.58 → 1.63 | 49.04 → 49.11 |
| Read the latest of 16,384 recently added notes | 11.34 → 2.86 | 3.26 → 1.95 | 50.22 → 49.15 |

~~~powershell
.venv\Scripts\python.exe scripts/benchmark_mining_history.py --case cards-single cards-batch cards-latest-small cards-latest --rounds 5 --output .tmp_test_env/anki-card-reads.json
~~~

### Anki polling and connectivity

The Tauri process also owns the Anki monitor's polling interval and failure
backoff. While recording is off it checks AnkiConnect availability. When the
replay buffer starts it seeds the set of recent notes, then polls for additions
at the configured interval. A fresh Beacon heartbeat suspends periodic HTTP.
New Beacon notes, settings edits, replay state changes, shutdown, and backend
disconnects interrupt the current desktop wait. Reconnecting the same mining
process keeps its acknowledged notes. A different AnkiConnect URL gets a new
baseline.

The desktop hands new notes to one Python card handler at a time. Its thread
exits after the batch. The desktop can serve requests while a confirmation
dialog is open, and the backend can shut down even if a card handler stalls.
The status page can read connectivity observed by the desktop monitor. An explicit
status check while periodic HTTP is suspended uses a one-shot native probe.
Standalone Python launches retain their polling loop.

The monitor benchmark runs the previous polling loop and the desktop service
against the same 8,192-note loopback collection. Both use the existing Rust
note-ID tracker. It measures six seconds with the replay buffer off, six more
with it on, 24 status reads, and five individually timed new notes. Timing
starts just before the client asks the fixture to add a note and ends at the
card handler, after the real note lookup and card construction. The fixture
checks the fields, tags, and card IDs. It also exercises ID-only and full-note
Beacon messages, duplicate pushes, Beacon expiry, Anki going offline and
returning, backend reconnection, and a second replay-buffer activation.
Memory and CPU include both the desktop and the Python process. The fixture
server runs in a separate process. A separate 100-call measurement compares
the cost and worker lifetime of a pooled handoff and a thread per batch.

Five paired Windows runs used the optimized executable. The idle and recording
CPU columns give combined process milliseconds per elapsed second. Delivery
is the median of the five run means. Memory is the combined private resident
memory sampled during steady recording. The Windows CPU timer resolves about
2.6 ms/s over each six-second window.

| Poll interval | CPU with recording off, Python → Rust | CPU with recording on, Python → Rust | Delivery (ms), Python → Rust | Recording memory (MiB), Python → Rust |
| --- | ---: | ---: | ---: | ---: |
| 1,000 ms (default) | 5.2 → 5.2 | 5.2 → 2.6 | 516.05 → 522.85 | 49.52 → 49.54 |
| 100 ms | 15.6 → 15.6 | 20.8 → 26.0 | 54.49 → 49.34 | 49.59 → 49.60 |

Both implementations issued a median of five Anki queries per six-second
recording window at the default interval and 55 at 100 ms. Python previously woke and
sent a backend request for each one. The Rust monitor needed zero Python
iterations or additional backend requests in every steady window. The 24 status
checks issued zero additional HTTP requests and averaged 0.002 ms each at both
intervals. Python made 24 requests at 2.35 and 2.99 ms each, respectively.
A pooled card handoff took 0.12–0.13 ms and retained a worker. Creating a
thread per batch took 0.25 ms and released it afterward. After card delivery,
the backend had one fewer thread at both polling intervals.
[Raw samples and optimized executable checksum](benchmarks/anki-monitor-2026-11-18.json)

```powershell
.venv\Scripts\python.exe scripts/benchmark_mining_history.py --case anki-monitor anki-monitor-default --rounds 5 --output .tmp_test_env/anki-monitor.json
```

### Anki collection synchronization

Desktop full and incremental syncs now run in the Tauri process. The Python
entry points pass the active profile's Anki URL, word field, and search scope.
The scheduled job shares the existing backend connection. Standalone Python
launches retain their local implementation.

The desktop requests up to 500 notes or cards per page and up to 100 cards' review
histories per request. It selects the configured note field, discards rendered
card HTML, and commits each page through the active database writer. Targeted
syncs intersect the requested note IDs with the scope inside Anki. Full syncs
prune stale records after the remote fetch completes. A failed page can leave
earlier pages refreshed. Deleting stale rows and their dependents is atomic.
A profile close invalidates previously issued writer generations. Concurrent
collection syncs run in order, and other mining operations can use the database
while AnkiConnect is busy. Backend shutdown interrupts a pending network request
or busy retry before Python drains its worker pool.

The benchmark calls the production full and incremental sync entry points with
disposable profiles and a loopback AnkiConnect fixture. The timings exclude
scheduler startup.
It compares the sync summaries, notes, cards, reviews, vocabulary flags, and
word and kanji relationships after a full sync and a repeat operation. It also
checks a changed word field, verifies that an incomplete full fetch keeps the
previously cached stale review, and interrupts a busy AnkiConnect session.
Windows measurements include both the backend and the desktop. The fixture
server runs in a separate process. Short individual CPU samples are quantized
by the Windows process timer. [Sync and report measurements](benchmarks/anki-sync-2026-11-18.json)

| Repeat operation | Python wall → Rust wall (ms) | Python CPU → Rust CPU (ms) | Sampled peak private memory (MiB) |
| --- | ---: | ---: | ---: |
| Full sync, 12 notes and 144 reviews | 34.62 → 8.99 | 11.72 → 7.81 | 58.49 → 58.73 |
| Full sync, 1,200 notes and 14,400 reviews | 400.77 → 192.89 | 265.63 → 140.63 | 76.70 → 70.59 |
| One matching note and one outside the scope, 1,200-note collection | 28.99 → 7.39 | 7.81 → 4.88 | 69.24 → 69.10 |

The first full sync of the larger collection took 416.77 ms in Python and
236.47 ms in Rust. Each note had two cards. The memory probe sampled the sum
of both processes' unique set sizes during separate repeats.

```powershell
.venv\Scripts\python.exe scripts/benchmark_mining_history.py --case sync-small sync-collection sync-incremental anki-earliest anki-note-kanji anki-retention --rounds 5 --output .tmp_test_env/anki-sync.json
```

### Anki maturity and per-game review reports

The desktop history service now builds the daily word and kanji maturity chart,
the weekly maturity series in Reading Impact, and the per-game Anki review
breakdown. Flask serves the existing URLs. Standalone Python, older desktops,
and separate imported databases retain the local calculation.

Each Rust report opens a read-only SQLite snapshot. For maturity, the first
qualifying review takes precedence over a card's sync time. A review can
identify its note directly or through its card. Notes sharing a word contribute
one first-mature date, and old note caches retain their field order when the
configured word field is missing. The weekly view clips dates before grouping
them into Monday-start weeks.

For game statistics, SQLite streams one row per card in storage order. Rust
counts tagged cards, including unreviewed cards, combines reviews for cards
that share a note, and averages retention across reviewed notes. The date
bounds apply independently to note creation and review time.
This lets both the standalone game report and Reading Impact read a short list
of game totals without keeping Python objects for the entire Anki collection.

The benchmark exercises all three Flask handlers with Flask's test client and
the running desktop broker. It verifies which desktop operations answered,
compares the entire JSON response against Python, and alternates execution
order over five fresh pairs of temporary profiles. The large fixture contains
8,192 notes, 8,192 cards, 40,960 reviews, 1,024 linked kanji and 12 game tags.
Every two notes share a word. The small
fixture uses 64 notes and 320 reviews. A third of the notes require card lookup
for review attribution, and some cards mature from their sync state alone.

```powershell
npm run build:tauri:optimized
.venv\Scripts\python.exe scripts/benchmark_mining_history.py --case maturity-small maturity reading-impact anki-game-stats --rounds 5 --output .tmp_test_env/anki-reports.json
```

Windows 11 release-build medians on the Ryzen 7 5800X, November 18, 2026.
Each pair shows Python → Rust. The first request starts with the fixture and
both processes ready. Repeat requests use the same running processes, including
Python's warm Anki object cache where applicable. CPU adds desktop and backend
process time. USS is their combined private resident memory after the timed
loop. [Individual samples and executable hashes](benchmarks/anki-reports-2026-11-18.json)

| Report | First request (ms) | Repeat request (ms) | Repeat CPU (ms) | USS (MiB) |
| --- | ---: | ---: | ---: | ---: |
| Daily maturity, 64 notes | 5.04 → 17.79 | 1.55 → 2.68 | 1.56 → 2.87 | 43.20 → 43.56 |
| Daily maturity, 8,192 notes | 116.33 → 90.49 | 109.56 → 76.86 | 109.38 → 76.17 | 50.30 → 45.65 |
| Reading Impact including game breakdown | 372.91 → 117.76 | 130.28 → 101.66 | 128.91 → 99.61 | 89.73 → 46.03 |
| Per-game reviews | 261.26 → 37.40 | 16.22 → 24.81 | 16.93 → 24.74 | 89.61 → 45.33 |

The earlier Rust query grouped by note and counted distinct cards in SQLite.
It averaged 36.02 ms per repeat request in the median run. Grouping by card
in storage order and combining the note totals in Rust brought that to
24.81 ms. Python's already-materialized collection served repeated per-game
requests in 16.22 ms. The native route used 44.28 MiB less memory in that
workload and served the first request 223.86 ms sooner. Other Anki reports
used to populate the Python collection cache. The desktop now reads the
earliest note date, scoped kanji, and NSFW/SFW retention from SQLite as well.
The earliest-date and kanji queries require a child of the configured parent
tag. Retention preserves the broader parent-prefix rule, classifies the exact
`NSFW` tag, and weights notes equally even when their review counts differ.
For these three reports the desktop retains the last result and its selected
filters. A read-only SQLite connection checks `PRAGMA data_version` before
reuse. Any committed change from another connection invalidates the results.
Closing the profile releases the observer. Concurrent cold reads use separate
snapshots. Standalone launches and unsupported requests can still use the
Python cache. [Measurements before caching the three results](benchmarks/anki-reports-uncached-2026-11-18.json)

| Report on 8,192 notes and 40,960 reviews | First request, Python → Rust (ms) | Repeat, Python → Rust (ms) | Combined private memory, Python → Rust (MiB) |
| --- | ---: | ---: | ---: |
| Earliest tagged note | 264.71 → 21.18 | 3.51 → 0.72 | 90.16 → 45.58 |
| Kanji coverage | 269.58 → 30.64 | 16.37 → 0.91 | 90.05 → 45.54 |
| NSFW/SFW retention | 277.28 → 41.11 | 16.79 → 0.80 | 90.21 → 45.62 |

Reading SQLite afresh on every request took 7.38, 14.04, and 25.72 ms,
respectively, on the same fixture. The repeat figures above include the check
for intervening database writes and the round trip through Flask and Tauri.
This coverage fixture contains two distinct kanji. [Five paired runs](benchmarks/anki-sync-2026-11-18.json)

### Mining vocabulary

On the Tauri desktop, capturing a line or importing a batch can now send the
selected vocabulary dictionary with the existing history write. After commit,
the desktop queues the line IDs and returns. A single worker uses the same
Sudachi dictionary as the overlay, including its user dictionaries. It reads
the stored line and analyzes it outside the SQLite writer lock. Before it
commits word and kanji occurrences, it verifies the line's text, timestamp and
completion flag. Edited, archived and already indexed lines can therefore
share the queue safely. The cache triggers run inside the same transaction.

Indexing preserves the existing distinction between words and kanji. Sudachi
receives the cleaned text. Kanji occurrences come from the original line,
including characters inside removed markup. Existing vocabulary keeps its
word ID, reading, part of speech, Anki links and first-seen line.

Scheduled backfill uses the same worker. Rust pages pending lines in timestamp
and ID order, removes orphan occurrences, preserves archived and Anki-linked
IDs, repairs first-seen metadata and rebuilds counts when cleanup removes rows.
At startup, schema setup schedules missing first-seen repairs after the
backend connects to the desktop. Earlier profiles store occurrence word IDs as
text. The repair converts each outer word ID to text so SQLite can seek its
occurrences by index.
When the desktop dispatches backfill, Python requests the pages and applies
the configured low-performance delay between them. Standalone Python, older
desktops and work inside an existing Python transaction retain their local implementation.

Capture and import share a bounded queue of IDs. If the queue fills or a
dictionary is missing, the saved lines stay eligible for backfill. Database
close waits for earlier indexing work before releasing the writer. A missing
dictionary can still complete a line whose markup leaves no words to analyze.

The SQLite batch benchmark indexed 1,024 prepared lines with seven words each.
Each column shows the median of five release runs.

| Lines per transaction | Total write time | 95th percentile transaction |
| ---: | ---: | ---: |
| 1 | 870.46 ms | 1.16 ms |
| 8 | 189.41 ms | 2.15 ms |
| 32 | 98.95 ms | 4.17 ms |
| 128 | 67.54 ms | 10.36 ms |

The desktop uses 32 lines per transaction. The larger batch saved 31 ms over
the full import and held the shared writer for about 2.5 times as long at the
95th percentile. Dialogue capture and note updates also need that writer.

The end-to-end benchmark ran on Windows 11 with an eight-core Ryzen 7 5800X,
using the same optimized desktop and Sudachi small dictionary for both paths.
Five pairs ran in fresh profiles, alternating which implementation ran first.
Capture time ends when all saved
lines are indexed. The warm result is per line across 32 sequential captures.
CPU is cumulative process time. Memory is the sum of unique resident memory
after each operation for the desktop, input helper, Python backend and any
additional indexing worker. It excludes WebView processes. Both backfill runs
invoke the scheduler function directly, excluding legacy cron process startup.
The harness compares all vocabulary, occurrence and cached rank rows, including
IDs, and verifies that all lines completed.

| Workload | Python / Rust elapsed (ms) | Python / Rust CPU (ms) | Python / Rust memory (MiB) |
| --- | ---: | ---: | ---: |
| First captured line | 843.07 / 57.36 | 781.25 / 62.50 | 228.36 / 182.40 |
| Warm captured line | 4.11 / 3.01 | 3.42 / 2.93 | 228.59 / 182.95 |
| Import 256 lines | 453.69 / 44.56 | 390.63 / 46.88 | 229.45 / 183.37 |
| Import 4,352 lines | 9,083.11 / 901.10 | 8,437.50 / 828.13 | 238.23 / 189.82 |
| Backfill 512 lines and clean orphans | 944.77 / 149.27 | 765.63 / 125.00 | 183.66 / 183.65 |
| Repair first-seen history for 4,096 words | 65.27 / 45.82 | 78.13 / 46.88 | 64.57 / 55.73 |

The repair fixture contains 32,768 live occurrences and 1,024 archived words.
The first native implementation took 6,386 ms on this fixture. SQLite's query
plan showed a full scan of the occurrence table per word on legacy schemas.
Converting the outer word ID to text restored indexed lookup and brought
the median to 46 ms. All five pairs produced identical stored results in
each workload. [Raw samples and executable and dictionary checksums](benchmarks/word-index-2026-11-18.json)

To reproduce the database and end-to-end measurements on Windows, use an
installed v20260116 small dictionary. The harness copies it into a fresh
temporary profile for each sample.

~~~powershell
npm run build:tauri:optimized
cargo test --locked --release --manifest-path native/gsm-history/Cargo.toml --test word_index benchmark_word_index_batches -- --ignored --nocapture *> .tmp_test_env/word-index-batches.log
.venv\Scripts\python.exe scripts/benchmark_word_index.py --dictionary "$env:APPDATA/GameSentenceMiner/sudachi/v20260116-small/system_small.dic" --rounds 5 --batch-log .tmp_test_env/word-index-batches.log --output .tmp_test_env/word-index.json
~~~

### Daily statistics rebuild

The desktop rebuilds historical daily and per-game statistics from the active
profile. The scheduled job, manual rebuild and cloud-sync caller all use the
same entry point. Rust discovers the local dates with data and commits both
summary tables in one transaction per date. It releases the writer between
days so live captures can use it. Database close invalidates the running job
before a later day can reopen a restored profile.

The rollup reads each live line's text and media fields once. It retains
timestamps and character counts for reading-time calculations, which need
separate median paces for sessions, hours and games. Each game's result also
contributes to its genre and media totals. Text-free archive events contribute
their saved character, card and media counts. A partially indexed day uses the
historical raw-kanji rules, while a fully indexed day uses the occurrence
tables. Old and new archive token flags are both supported.

The native cleaner supports GSM's repetition setting, literal punctuation
expressions, explicit character classes and their alternatives. More advanced
user-supplied Python regexes use the original implementation. If the native
repetition matcher exceeds its backtracking limit, only that day's transaction
is retried using Python. Archive or restore operations that already hold a
Python transaction also rebuild inside that transaction.

The Windows benchmark runs the scheduled job function against fresh profiles,
using the same optimized desktop for both routes. The harness verifies the
desktop handled the native job and compares persisted daily and per-game
fields, including tied kanji display order. It excludes maintenance timestamps
and normalizes the order of the set of played game IDs. CPU adds desktop and
backend process time. A separate process samples their combined private
resident memory during three additional rebuilds outside the timed loop.
Python's isolated cron process startup is excluded from these measurements.

The one-day fixture contains 16 live lines and eight archived events. Each
ten-day fixture contains 4,608 live lines and 80 archived events, with one
archived-only day. The mixed fixture alternates fully and partially indexed
dates. The cleaning fixture removes a configured character range and a literal
term, then reduces repeated phrases. The 365-day fixture contains 8,744 live
and archived reading events and crosses both local daylight-saving transitions.

Windows 11 release-build medians on a Ryzen 7 5800X. Each cell shows Python
followed by Rust across five pairs, alternating which implementation ran first.
The first invocation creates the rollups. Repeat invocations rebuild existing
rows. Peak memory comes from the separate warm sampling runs.

| Workload | First invocation (ms) | Repeat elapsed (ms) | Repeat CPU (ms) | Peak private memory (MiB) |
| --- | ---: | ---: | ---: | ---: |
| One day, 24 events | 10.89 → 24.86 | 4.06 → 3.09 | 1.95 → 3.91 | 49.65 → 50.15 |
| Ten days, partial vocabulary index | 238.27 → 48.78 | 231.58 → 28.10 | 234.38 → 26.04 | 52.68 → 52.52 |
| Ten days, complete vocabulary index | 169.44 → 58.47 | 192.01 → 38.01 | 187.50 → 31.25 | 52.60 → 52.85 |
| Ten days, custom cleaning and repetition removal | 179.48 → 54.75 | 170.43 → 31.52 | 166.67 → 31.25 | 52.62 → 53.01 |
| 365 days, 8,744 events | 1,682.89 → 476.11 | 2,078.46 → 411.88 | 1,875.00 → 234.38 | 53.70 → 55.16 |

As a separate comparison, Python dispatched the same 365 native transactions
one date at a time against the warm database. That took 820.31 ms elapsed and
703.13 ms CPU. Keeping the calendar loop in Rust reduced those figures to
411.88 ms and 234.38 ms. All implementations produced matching daily and
per-game results and preserved existing daily row IDs and creation timestamps.
[Raw samples, result digests and optimized executable checksum](benchmarks/daily-rollups-2026-11-18.json)

```powershell
npm run build:tauri:optimized
.venv\Scripts\python.exe scripts/benchmark_mining_history.py --case rollup-small rollup-mixed rollup-indexed rollup-repeat rollup-year --rounds 5 --output .tmp_test_env/daily-rollup.json
```

### Scheduled backend work

The desktop reads enabled jobs from the active profile, orders the startup
batch by priority and deadline, and accepts manual triggers in arrival order.
It sleeps until the next deadline, a settings change, a manual trigger or the
15-minute database refresh. A manual run leaves the saved schedule intact.
Game linking and completion of the retired Anki word-sync entry run entirely
in Rust. Game linking commits the repaired lines and the schedule update in
one transaction. Completion checks the saved deadline and schedule so a
concurrent settings change wins.

Jobs with Python dependencies receive one lease at a time over the existing
backend connection. A reconnect can recover the lease and retry its receipt.
The desktop advances the row after the receipt arrives. A runner exception
leaves the row due for retry. Tadoku and Kechimochi still supply their
service-specific next run times. Python-only launches retain the existing
scheduler.

The Windows benchmark alternates five pairs of disposable profiles using one
optimized desktop. Both paths use the native game linker and daily rollup.
Each scheduling sample checks startup order, measures four idle seconds, then
times 24 manual links through the usual trigger and verifies their saved rows.
The retired word-sync timing includes the following job as a completion
signal. A second workload runs the real scheduled rollup and compares a digest
of both summary tables across ten days of mixed live and archived history.
CPU time and settled unique memory cover the desktop and backend processes.
The harness also disconnects the backend and requests shutdown during separate
active jobs to verify each completion is recorded once.

| Median on Windows | Python scheduler | Rust scheduler |
|---|---:|---:|
| Mixed startup batch, elapsed | 26.05 ms | 21.60 ms |
| Python scheduler timeouts in four idle seconds | 7 | 0 |
| Dedicated idle Python cron threads | 1 | 0 |
| Combined CPU in four idle seconds | 46.88 ms | below clock resolution |
| Manual game link, elapsed / CPU | 2.31 / 1.95 ms | 2.26 / 1.30 ms |
| Settled unique memory after manual links | 48.31 MiB | 48.16 MiB |
| Retired word-sync trigger and following job, elapsed | 860.52 ms | 2.72 ms |
| Python children launched for the retired trigger | 1 | 0 |
| Scheduled ten-day rollup, elapsed / CPU | 42.03 / 15.63 ms | 41.61 / 31.25 ms |
| Settled unique memory after the rollup | 51.73 MiB | 52.84 MiB |

The Windows process CPU counters advanced in 15.625 ms increments. The
rollup timings include scheduler startup and one complete rebuild. Both routes
produced the same daily and per-game content in every sample.
[Measurements and optimized executable checksum](benchmarks/cron-scheduler-2026-11-18.json)

```powershell
npm run build:tauri:optimized
.venv\Scripts\python.exe scripts/benchmark_mining_history.py --case cron-scheduler cron-rollup --rounds 5 --output .tmp_test_env/cron-scheduler.json
```

### Qt entry points

Rust callers use `gui_dialog::open` with a typed `Dialog` request. The
authorized desktop webview can call `open_python_dialog`. Settings and session
review use the existing backend entry points when a mining session is running.
Other requests run on its Qt thread and return the selection through the broker.
With the backend stopped, the desktop prepares the configured interpreter and
supervises a single window host until the window closes. It skips the session
tracker and uses files for screenshots and cropped images.
Crop results include both the PNG path and the screen coordinates of the
selection. Closing the screenshot picker cancels its video decoder and waits
for it to release the recording before the one-shot host exits.
Area selectors notify the desktop after a successful save so active OCR can
pick up edits while the window remains open.

The supported windows are settings, session review, sync settings, prompt
help, recommended Anki setup, card confirmation, duplicate-field grouping,
screenshot selection, text input, scene selection, screen cropping, OCR area
and monitor selection, minimum character size, and furigana preview. The last
two accept an optional image path so Rust can supply a captured frame.

### Live dialogue correlation and fast-forward detection

Rust decides whether processed hook, OCR, speech, clipboard and manual observations
append a line, revise open speech, or duplicate a previous observation. The
classifier checks source, scene, relay status, timestamps, speech finalization
and source-specific prefixes. Fuzzy comparisons use Unicode scalar values and
the same normalized Indel similarity threshold as the Python reference. A
decision returns a new string only when GSM actually trims a prefix.

The Tauri-managed miner calls the packaged Rust extension in process. With an
older extension, the desktop serves the same classifier through the authenticated
`text.classify` request. Classification is read-only, so an unsupported string,
oversized request, or missing reply can use the reference safely. The desktop
receives the newest line, the open speech line and relevant source context.
OCR images and the rest of the reading history stay out of that request.

The extension also owns the per-source evidence used to distinguish
fast-forwarding from normal reading. It counts newly revealed characters, tracks
up to 256 samples per source and calculates when scanning can resume. It checks
up to 512 Unicode characters for a sliding-window overlap in linear time.
Inputs containing only separators leave the source history intact. Common
Japanese and ASCII text is normalized in Rust. Other forms use the installed
Python Unicode tables before the Rust detector consumes them. A source checkout
with an older extension retains the Python detector. Setting
`GSM_NATIVE_TEXT_MODE=python` selects the reference paths.

The parity suite covers speech revisions interrupted by a manual line,
prefixes, expiration boundaries, malformed desktop replies, and unpaired
surrogates. It checks the native normalization fast path against Python across
the entire Unicode code-point range. Timed workloads check the acknowledgments
and ordered record events, including stats classifications. The live actor case
also waits for delivery after every observation.

In the initial three-pair comparison, a mixed observation took 23.48 µs in the
extension and 416.06 µs through the desktop broker. Both still used the Python
fast-forward detector. This comparison informed the choice to keep the normal
mining call in process. [Initial classifier measurements](benchmarks/dialogue-classifier-2026-11-19.json).

Nine fresh interpreters timed creation of the coordinator and detector. Loading
the Python fuzzy matcher, Unicode tables and median implementation on demand
reduced median initialization from 53.83 to 28.90 ms. Additional private memory
fell from 2.95 to 1.69 MiB. These measurements exclude interpreter startup.
[Cold initialization samples](benchmarks/dialogue-startup-2026-11-19.json).

Five paired runs on Windows alternated the retained Python path and staged Rust
build. Each workload contains 216 observations. CPU combines the caller and
desktop processes. Peak MiB is their combined private resident memory sampled
over three additional batches after warm-up. The live actor workload includes
startup, ordered projection after every line, and shutdown of each batch.
[Individual runs, event digests and binary checksums](benchmarks/dialogue-intake-2026-11-19.json).

| Workload | Wall µs/observation, Python → Rust | CPU µs/observation, Python → Rust | Peak MiB, Python → Rust |
| --- | ---: | ---: | ---: |
| Short mixed hook, OCR, speech and manual dialogue | 20.26 → 20.41 | 20.09 → 20.09 | 36.13 → 35.52 |
| Long mixed dialogue | 106.72 → 51.76 | 100.47 → 52.24 | 37.44 → 37.15 |
| Sliding 500-character hook buffers during fast-forward | 86.18 → 28.42 | 88.41 → 28.13 | 36.03 → 36.16 |
| Live actor, manual lines with projection acknowledged | 203.29 → 217.09 | 126.59 → 126.59 | 37.02 → 36.93 |
| Short mixed dialogue with an older wheel using the desktop broker | 21.32 → 417.32 | 18.08 → 506.37 | 36.16 → 35.88 |

~~~powershell
.venv\Scripts\python.exe scripts/benchmark_mining_history.py --case dialogue-mixed dialogue-long dialogue-burst dialogue-live dialogue-mixed-broker --rounds 5 --output .tmp_test_env/dialogue-intake.json
.venv\Scripts\python.exe -m scripts.benchmark_dialogue_correlation
~~~

### Live dialogue retention and TextFeed snapshots

The Tauri-managed miner's Rust extension now owns the live record index,
stream sequence, retry window, source-prefix history, and pending statistics
queue. A speech revision updates the line in its original position. A retried
observation keeps its original FIFO position. Each successful source write
renews its prefix entry, including when the previous line has already expired.
The default windows retain 20,000 observation IDs and 512 source prefixes.
Generated 36-byte IDs fit directly in the Rust index, and longer caller-supplied
IDs retain their full contents.

Expiration removes an eligible prefix in order and stops at the first live,
provisional, or statistics-pending line. The extension holds the immutable
record objects that subscribers already consume, including opaque OCR metadata.
It compares their original UTC timestamps at expiration. Existing snapshots
therefore retain the original object and microsecond precision across revisions.
The extension participates in Python's cycle collector. Source installations
with an older extension, Python mode, and shadow mode use the reference journal.

TextFeed v2 passes its requested window through the mining actor to the journal.
The Rust journal walks backward from the newest line and returns that tail in
stream order. The server encodes only the requested records. Unbounded snapshot
readers reuse an immutable tuple until a record changes. The stream sequence
continues across both expiration and partial snapshots.

Five pairs of fresh workers on Windows exercised the Python and Rust journals
with the same native classifier and skip detector. Each pair checked matching
results, including ordered events and snapshot payloads. Table entries give
the median Python and Rust values respectively. Memory is peak private memory
of the worker and its isolated desktop combined.

| Operation | Wall time | CPU time | Peak private MiB |
| --- | ---: | ---: | ---: |
| TextFeed asks for 100 of 4,096 retained lines, including JSON encoding | 17.91 → 0.70 ms | 17.58 → 0.73 ms | 58.24 → 54.76 |
| Same long session with a bounded read in both implementations | 0.645 → 0.629 ms | 0.610 → 0.610 ms | 54.77 → 54.57 |
| TextFeed asks for 100 lines in a 64-line session | 0.439 → 0.436 ms | 0.407 → 0.407 ms | 51.81 → 51.96 |
| Check a retry ID, with a 20,000-ID FIFO | 0.287 → 0.218 µs | 0.286 → 0.223 µs | 40.30 → 39.93 |
| Expire one line, append one and look up the oldest among 16,384 retained | 2.81 → 0.69 µs | 2.68 → 0.72 µs | 56.47 → 56.60 |
| Short mixed hook, OCR, speech and manual observation | 20.27 → 20.00 µs | 19.59 → 19.59 µs | 35.43 → 35.49 |
| Manual observation through live actor and confirmed projection | 297.89 → 244.23 µs | 162.76 → 180.85 µs | 37.41 → 37.57 |

The streamed 20,000-ID cache added 4.01 MiB in Python and 1.89 MiB in Rust.
With row projections already allocated, the 16,384-line ordered index added
0.71 and 1.82 MiB respectively. Rebuilding a full 16,384-line snapshot after
a revision took 34.29 and 107.71 µs. Repeated reads between changes took 31.80
and 0.067 µs. These snapshot microbenchmarks exclude wire encoding. CPU times
near zero are below the resolution of the Windows process timer.

The prior TextFeed request serialized all 4,096 records and discarded 3,996.
The new request selects its 100 records before serialization. The reconnect
fixture uses the production actor, response builder and JSON encoder and
excludes socket transport. [Samples, result digests and binary checksums](benchmarks/dialogue-journal-2026-11-19.json).

```powershell
.venv\Scripts\python.exe scripts/benchmark_mining_history.py --case dialogue-journal-feed dialogue-journal-feed-bounded dialogue-journal-feed-short dialogue-journal-receipts dialogue-journal-retention dialogue-journal-mixed dialogue-journal-live --rounds 5 --output .tmp_test_env/dialogue-journal.json
```

### Sentence and duplicate search

The desktop history service now serves `/api/search-sentences` (substring,
regex, match-all, and tokenized modes) and `/api/search-duplicates`
(time-window and full-scan modes) from read-only SQLite snapshots. Standalone
Python launches, older desktops, oversized "ALL" responses beyond the broker
transport limit, and invalid or unsupported regex syntax fall back to Python.

For regex and wildcard-free substring searches, Rust streams only the row ID,
borrowed `line_text` slice, and sort key from SQLite, avoiding row-object
materialization and duplicate full-table scans. Standard regex patterns run on
Rust's linear-time `regex` engine; patterns requiring lookarounds or
backreferences automatically fall back to `fancy-regex`. Page selection uses
linear-time `select_nth_unstable_by` with `rowid` tie-breaking before
hydrating only the requested page by row ID. Duplicate search streams rows
grouped by normalized game name and timestamp, replacing Python's backward
window scan with a per-game `HashMap` of last-seen timestamps (or `HashSet`
for full-scan mode) and hydrating only the detected duplicates.

Five paired Windows runs on the optimized release desktop alternated Python
and Rust across 20,000 dialogue lines in four games, verifying identical HTTP
JSON digests on every round. CPU adds the desktop and backend processes; peak
memory samples their combined private resident memory over three warm
operations. [Raw samples and executable checksum](benchmarks/sentence-search-2026-11-19.json).

| Workload (20,000 lines) | First request (ms), Python → Rust | Repeat wall (ms), Python → Rust | Repeat CPU (ms), Python → Rust | Peak private MiB, Python → Rust |
| --- | ---: | ---: | ---: | ---: |
| Substring (`LIKE`) search | 61.06 → 21.60 | 8.44 → 8.72 | 7.81 → 7.81 | 69.58 → 67.88 |
| Regex search (`regex` fast path) | 184.02 → 20.65 | 134.27 → 9.31 | 127.60 → 7.81 | 86.25 → 67.82 |
| Regex lookahead (`fancy-regex`) | 192.85 → 65.83 | 142.96 → 54.03 | 140.63 → 54.69 | 86.23 → 69.10 |
| Tokenized word search | 56.44 → 17.25 | 2.76 → 5.22 | 2.34 → 5.47 | 69.43 → 68.13 |
| Duplicate search, 5-minute window | 216.87 → 32.85 | 163.61 → 22.10 | 159.38 → 21.88 | 85.78 → 71.13 |
| Duplicate search, all-time | 198.37 → 34.54 | 147.14 → 22.33 | 140.63 → 21.88 | 85.75 → 71.08 |

The initial Rust `LIKE` implementation ran two SQLite scans (`COUNT(*)` and
`SELECT ... ORDER BY`), taking 11.19 ms wall and 11.72 ms CPU per repeat.
Replacing wildcard-free queries with a single zero-copy Rust pass lowered that
to 8.72 ms wall and 7.81 ms CPU. Repeated `search-like` and `search-tokenized`
queries still pay a fresh read-only SQLite connection open per desktop request
compared to Python's warm connection, while cutting first-request latency by
2.8–3.3x and reducing peak memory across every workload.

```powershell
.venv\Scripts\python.exe scripts/benchmark_mining_history.py --case search-like search-regex search-regex-fancy search-tokenized search-duplicates-window search-duplicates-all --rounds 5 --output .tmp_test_env/sentence-search.json
```

### What still requires Python

Ordinary mining still launches `GameSentenceMiner.gsm`. In addition to the
sections above, `gsm-history` now also serves `games_list`, text-deletion and
deduplication previews/writes, dashboard and per-game stats, all tokenization
and word-novelty queries, and pooled read-only SQLite connections; `gsm-downloads`
owns verified asset/file downloads; `obs/session.rs` owns desktop game-session
tracking and profile selection; and `gsm-overlay` includes MIDA, Bing, Google
Vision, macOS LiveText, and portable OneOCR orchestration.

Even with those migrations in place, substantial backend work still lives in
Python:

- **Replay, media extraction, VAD, clips, and longplay**: `replay_handler.py`,
  `vad.py` (Silero ONNX / faster-whisper), `util/media/*` (FFmpeg trimming,
  screenshots, animated WebP/AVIF, pause gaps), `clip_cards.py`, and
  `longplay_handler.py` (SRT generation).
- **Anki mining orchestration and Beacon ingress**: card object construction and
  field-name repair, field policy resolution, media prefetch, incoming Anki
  Beacon HTTP payloads (`/api/anki/events`), `session_review.py`, and direct
  low-latency OBS replay saves / event listeners / profile reconfiguration.
- **Live text runtime and WebSocket servers**: `AuthoritativeTextRuntime`
  (`TextCoordinatorActor`/`TextProjectionActor`), `TextRecord`/`IngressAck`
  construction, speech freeze timers, clipboard and user-configured external
  WebSocket intake, live text-processing execution, live stats tracking,
  TextFeed v2 / plaintext / overlay WebSocket servers (`web/gsm_websocket.py`),
  overlay callbacks (`web/overlay_handler.py`), and Windows speech helper
  supervision (`windows_speech_recognition.py`).
- **Flask HTTP server (`:7275`) and unmigrated routes**: HTML template serving,
  runtime texthooker/media/translation endpoints (`texthooking_page.py`), all
  **Goals** endpoints (`goals_api.py`, `goals_projection_api.py`), **Game
  management & Jiten/IGDB linking** (`web/routes/*`, `jiten_database_api.py`),
  remaining DB mutations (`delete-sentence-lines`, `delete-games`, `merge_games`,
  `migrate-lines`, `delete-regex-in-game-lines`, backups, schema setup, and
  game/vocabulary archiving), imports/exports (`import_api.py`,
  `third_party_stats_api.py`, `stats_export_api.py`), clips/onboarding/OCR-area
  routes, and custom Yomitan/frequency dictionary ZIP generation
  (`yomitan_api.py`, `util/yomitan_dict/*`).
- **AI translation, Cloud Sync, and external integrations**: `ai/` (Gemini,
  OpenAI, Groq, Ollama, DeepL, Zai, prompt builder, character context, cache),
  encrypted Cloud Sync (`util/cloud_sync/`), Kechimochi and Tadoku sync,
  Jiten/VNDB/AniList/IGDB clients, and Discord RPC.
- **Leased cron runners**: `jiten_sync`, `jiten_upgrader`,
  `daily_goals_completion`, `tadoku_sync`, `kechimochi_sync`, and
  `database_maintenance` (plus thin wrappers that pass profile config into
  native `daily_stats_rollup` and `anki_card_sync`).
- **Mining profile configuration and PyQt6 dialogs**: `config.json` schema and
  `profile_switcher.py`, plus the 14 PyQt6 windows (`ui/*_qt.py`) which require
  an interpreter while open.
- **Standalone / fallback paths**: historical statistics with advanced custom
  cleaning regexes or inside a Python-owned transaction, macOS/Linux portable
  OneOCR inference, and non-Tauri standalone OCR/overlay/DB/Anki/cron fallbacks.

The user-script runner is retired: on upgrade GSM removes historical script
schedules and keeps the user's `plugins.py` file on disk. A complete cutover
needs end-to-end mining and stats verification with the interpreter unavailable,
including fresh profiles and existing installations.

### Reproducing the measurements

Run from the checkout on Windows. Both paths use isolated temporary profiles
and deterministic fixtures. The history benchmark checks equivalent HTTP
responses, committed rows, note detections, Anki field and tag order, and
uploaded bytes through the normal entry points. An untimed warm-up verifies
that the selected implementation handled the request. Each measured Anki
field update targets a fresh line. Each measured note poll has one ID to detect.

```powershell
npm run build:tauri
.venv\Scripts\python.exe scripts/benchmark_mining_history.py --rounds 3 --output .tmp_test_env/history-results.json
.venv\Scripts\python.exe scripts/benchmark_qt_dialog.py --rounds 3 --output .tmp_test_env/dialog-results.json
cargo test --locked --manifest-path native/gsm-history/Cargo.toml
```

The Windows comparison uses an eight-core AMD Ryzen 7 5800X and the optimized
desktop build. Each history or Anki result is the median of three paired runs
in fresh processes. Each run warms the operation once and then measures
repeated calls. Wall time includes transport and serialization. CPU time
adds the desktop and the calling Python process. Memory is their combined
unique set size (USS) after the timed calls. The legacy path includes GSM's
existing native extensions. A separate local process serves the AnkiConnect
fixture and verifies the received media digest. Its CPU and memory are
excluded from both columns.

For the Qt comparison a timer accepts the same offscreen text dialog in
both hosts. The cold runs include interpreter startup, window creation,
and process exit with an already prepared environment. CPU and USS are
sampled in the Qt worker while the window is open. The live measurement
starts after the existing host connects.

### Windows release measurements, November 18, 2026

Each pair shows the Python baseline followed by the Rust-backed desktop path.
Times are milliseconds per operation. Short CPU measurements are limited by
the Windows process accounting interval. The individual runs and medians are
available for [mining, stats and Anki](benchmarks/mining-history-2026-11-18.json)
and the [Qt hosts](benchmarks/qt-dialog-2026-11-18.json).

| Operation and fixture | Wall ms | CPU ms | Combined USS MiB |
| --- | ---: | ---: | ---: |
| Mining heatmap, 12,000 lines | 144.15 → 7.97 | 144.53 → 7.81 | 56.84 → 46.03 |
| Daily activity, 183 recorded days in one year | 3.48 → 2.04 | 3.13 → 2.50 | 41.69 → 42.09 |
| Today's report, 1,024 lines across four sessions | 4.51 → 3.37 | 4.17 → 4.17 | 43.13 → 43.18 |
| Reading overview, 365 daily totals, 183 imported entries and 1,024 live lines | 8.91 → 5.10 | 8.33 → 5.21 | 43.78 → 43.25 |
| Oldest and newest releases, 500 games with covers and 2,000 lines | 66.16 → 6.11 | 66.41 → 5.86 | 46.84 → 44.21 |
| Per-game kanji grid, 12,000 lines | 159.31 → 11.22 | 159.38 → 10.94 | 47.05 → 44.71 |
| One character across 365 daily kanji counts | 6.90 → 7.98 | 7.03 → 7.81 | 58.66 → 45.04 |
| Dashboard kanji grid, 302 characters | 14.02 → 19.43 | 13.02 → 18.23 | 59.15 → 46.02 |
| Attach Anki fields to an existing line | 0.68 → 1.05 | 0.23 → 0.78 | 34.78 → 34.97 |
| Persist one new dialogue line | 0.71 → 1.11 | 0.00 → 0.63 | 51.15 → 51.25 |
| Import 256 lines across four games in one transaction | 2.06 → 3.05 | 0.00 → 3.91 | 51.61 → 52.13 |
| Repair 6,400 unlinked lines across 104 scenes | 157.09 → 14.37 | 93.75 → 15.63 | 50.96 → 50.89 |
| Upload an 8 MiB + 1 byte media file | 97.32 → 63.87 | 44.92 → 17.58 | 47.93 → 48.25 |
| Detect a new Anki note among 16,384 known IDs | 7.50 → 2.56 | 2.19 → 2.50 | 50.98 → 48.73 |
| Update fields, add mining tags and remove the overlay tag | 13.50 → 6.92 | 4.91 → 2.68 | 47.78 → 48.03 |

During three additional media uploads per run, a separate sampler measured
combined USS growing from 47.93 to 69.70 MiB on the Python path and from
48.25 to 48.47 MiB with streaming. These are sampled peaks. The fixture also
rejects the first tag update during the warm-up edit and verifies that only
that action is retried.

The serialized writer keeps scene resolution and related database changes in
one transaction. The round trip costs about 0.4 ms on individual writes
and 1.0 ms per 256-line import. The link repair measures the normal population
job after clearing all links and removing four game rows. Both timings include
the two SQL resets and exclude Python worker startup. Both dashboard kanji
queries took longer on repeated requests. Their combined private memory was
about 13 MiB lower with Rust after the Python baseline had warmed its JSON cache.

| Qt text dialog | Elapsed ms | Worker CPU ms | Worker USS MiB |
| --- | ---: | ---: | ---: |
| Cold host with session tracker | 1,035.19 | 812.50 | 53.11 |
| Cold host launched by Rust for one dialog | 545.12 | 375.00 | 29.22 |
| Already running host, requested through Rust | 8.82 | Unmeasured | Unmeasured |

## OBS recording and automatic longplay

The Tauri desktop already launches and supervises OBS, owns a persistent OBS v5
connection, and switches scenes for the foreground window. Mining recording
start/stop now uses that same connection. With **Generate Longplay** enabled,
the backend sends one request per replay transition. Rust changes the replay
buffer and, if that transition succeeded and changed state, starts or stops
recording on the same OBS session. Python receives the recording path for
longplay bookkeeping and subtitles. A failed recording command preserves the
successful replay result. An uncertain command is never replayed on another
connection. OBS reports an already-running start or already-stopped stop in
the command reply, which lets Rust skip the preliminary status request.
[OBS WebSocket v5 request status codes](https://github.com/obsproject/obs-websocket/blob/master/docs/generated/protocol.md#requeststatus).

Python still decides when window focus or captured output warrants a replay
transition. Replay-only operation, manual toggles, Anki replay saves, event
handling, and profile reconfiguration still use the Python OBS service. Routing
a single Anki save through the desktop increased elapsed time from 0.19 to
0.45 ms in the Windows loopback test. Separate replay-only start/stop commands
also increased CPU time. These paths keep their direct connections.

The desktop advertises the recording controller when it launches the mining
backend. Standalone Python and older desktops retain their existing transport.
The build uses the existing Tauri binary, broker, and OBS WebSocket dependency.

Run the output benchmarks against the locally built desktop from the repository
root. Each sample uses a temporary GSM profile and an isolated OBS v5 fixture.
Both sides use the real broker and OBS sockets. The Python baseline loads the
original OBS actions and service from Git revision `7a87ee32`.

```powershell
npm run build:tauri
.venv\Scripts\python.exe scripts/benchmark_obs_outputs.py --case record --cycles 1200 --rounds 5
.venv\Scripts\python.exe scripts/benchmark_obs_outputs.py --case longplay --cycles 1200 --rounds 5
```

Windows release-build medians on November 18, 2026, across five fresh pairs of
processes per case. CPU is total desktop and backend CPU time per cycle.
Memory is their combined unique resident memory after warm-up and measurement.
The fixture acknowledges OBS commands without encoding media.

| Cycle | Elapsed ms, Python → Rust | CPU ms, Python → Rust | Memory MiB, Python → Rust | OBS requests, Python → Rust |
| --- | ---: | ---: | ---: | ---: |
| Start and stop recording | 1.456 → 0.901 | 1.081 → 1.016 | 38.68 → 37.42 | 4 → 2 |
| Start longplay with replay, save a clip, stop both | 2.869 → 1.415 | 2.148 → 1.263 | 38.82 → 37.63 | 9 → 5 |

## Anki card matching for live history and saved clips

Rust selects the original dialogue line for a mined Anki sentence. The same
matcher serves live replay history, overlay mines, and saved clips. It scores
whole sentences and text aligned to the highlighted expression, preserves stream
order on ties, and handles an original line appearing in multiple saved clips.
Returning the original line preserves its media, timestamps, and history links.

Python still reads the card fields, interprets HTML and Unicode punctuation,
and filters the replay window. The existing native extension sends eligible
lines to the Rust matcher eight at a time and releases the GIL while scoring.
The Rust module has no Python or Tauri dependencies in its interface. Tauri's
build command and the Python wheel build both stay the same.

The existing `GSM_NATIVE_TEXT_MODE=python` and `shadow` settings also apply to
card matching. Older wheels use the Python implementation. Python RapidFuzz
loads when a Python caller needs it.

Run these checks on Windows from the repository root.

```powershell
.venv\Scripts\uv.exe pip install --python .venv\Scripts\python.exe --no-deps --reinstall --editable .
cargo test --locked --manifest-path native/gsm-native/Cargo.toml
.venv\Scripts\python.exe -m pytest tests/test_text_log.py tests/test_clip_cards.py
.venv\Scripts\python.exe scripts/benchmark_card_matching.py --reference-ref 7a87ee32 --rounds 5
.venv\Scripts\python.exe scripts/benchmark_card_matching.py --reference-ref 7a87ee32 --rounds 3 --preload-rapidfuzz
```

### Windows measurements, November 18, 2026

Each worker called the normal card-to-line lookup on a deterministic synthetic
history and checked the identity of the selected line on every iteration. The
baseline runs the original Python matcher and its scorers from `7a87ee32`.
Values are medians across five fresh Python worker processes per implementation, with
alternating run order. Wall time and process CPU time are per card. Peak RAM is
the worker's Windows peak working set, including the interpreter and history.

| History | Python / Rust elapsed (ms) | Python / Rust CPU (ms) | Python / Rust peak RAM (MiB) |
| --- | ---: | ---: | ---: |
| Single candidate | 0.041 / 0.031 | 0.040 / 0.031 | 36.84 / 35.64 |
| 64 live lines | 0.481 / 0.176 | 0.469 / 0.167 | 37.05 / 35.61 |
| 256 overlay lines, newest contains the highlighted word | 2.654 / 0.055 | 2.500 / 0.063 | 36.97 / 35.60 |
| 2,048 saved lines | 14.991 / 4.854 | 14.375 / 4.792 | 37.36 / 36.33 |
| 2,048 lines from overlapping clips | 25.718 / 5.159 | 24.609 / 4.688 | 37.72 / 36.25 |
| 10,000 live lines, 11 inside the replay window | 0.472 / 0.428 | 0.469 / 0.417 | 40.81 / 39.57 |

The overlay fixture can finish as soon as it finds the newest qualifying
highlighted line. Saved clips still require checking the full history. These
measurements exclude AnkiConnect, clip directory reads, and media encoding.

Other mining features can already have Python RapidFuzz loaded. In a second
comparison with it resident in both workers, peak working set ranged from 0.14
MiB lower to 0.30 MiB higher with Rust. Compared with each worker's own
pre-lookup baseline, the difference in private resident memory growth ranged
from 16 KiB lower to 4 KiB higher across the six histories. These are medians
of three fresh runs per implementation.

## Desktop Hook Finder

The Tauri desktop ranks hook samples against ScreenAI text blocks in
`gsm-text-preview`. Matching and filter suggestions share the text processors
used by the settings preview. Each discovery session owns its profile and
language filter. It checks for a saved profile change when a frame has text.
Ranking runs on a blocking worker and stops when the discovery session ends.
The native coordinator still checks the active scene before publishing results.

The normal `npm run build:tauri` command includes the ranker. The old
`texthook.rank` Python handler loads on request for compatibility with older
desktops. Other mining features still use the Python backend.

To check results against the captured Python fixtures and repeat the performance
comparison, run the following commands from the repository root.

```powershell
cargo test --locked --manifest-path native/gsm-text-preview/Cargo.toml
cargo build --release --locked --example rank_hooks --manifest-path native/gsm-text-preview/Cargo.toml
.venv\Scripts\python.exe scripts/benchmark_hook_ranking.py
node scripts/test-native-desktop.mjs texthook
```

### Windows measurements, November 18, 2026

The benchmark verified complete recommendation lists before timing five alternating
rounds on synthetic hook samples and OCR blocks. Wall time and process CPU time
are medians per batch. The native worker uses the normal saved-profile path. The
Python timing calls the previous ranking function directly and excludes its
desktop round trip. Capture and OCR inference are outside both measurements.

| Workload | Python wall / CPU (ms) | Rust wall / CPU (ms) | Python / Rust worker peak RAM (MiB) |
| --- | ---: | ---: | ---: |
| 16 exact hooks | 0.202 / 0.196 | 0.084 / 0.080 | 36.97 / 5.13 |
| 24 hooks with mixed markup and noise | 9.874 / 9.448 | 2.196 / 2.188 | 37.46 / 5.57 |
| 12 hooks with game-script tags | 5.670 / 5.722 | 1.445 / 1.431 | 37.32 / 6.11 |
| 12 hooks with a custom regex | 0.463 / 0.458 | 0.190 / 0.187 | 36.92 / 6.30 |
| 64 hooks against 48 OCR blocks | 3.987 / 4.010 | 1.277 / 1.271 | 37.45 / 5.25 |

To measure the transition while Python is still present, the paired benchmark
keeps a native broker, native ranking worker and Python backend alive in both
runs. It sends 50 batches through the selected route and takes the median of
three fresh runs per route. Combined unique resident memory fell by 0.05–0.84
MiB across the five workloads. Combined private committed memory ranged from
0.87 MiB lower to 0.55 MiB higher. These measurements cover the ranking and
transport processes. A live game, WebView, and OCR engine are outside the fixture.

```powershell
cargo build --release --locked --example service --manifest-path native/gsm-runtime/Cargo.toml
.venv\Scripts\python.exe scripts/benchmark_hook_ranking.py --resident-broker src-tauri/target/native-dev/release/examples/service.exe
```

## Python extension

GSM uses one private PyO3 extension, `GameSentenceMiner._native`, for in-process native components.
Application code must call a Python facade under `GameSentenceMiner.native` instead of importing the
extension directly. This keeps Rust ABI details, fallback behavior, and rollout controls at one boundary.

## Layout

```text
native/gsm-native/
  Cargo.toml
  src/
    lib.rs          # Thin PyO3 conversion layer only
    text_filter.rs  # Pure Rust OCR text filtering
    layout.rs       # Pure Rust OCR geometry/layout engine
    text_matching.rs # Exact no-junk sequence matching
    text_cleanup.rs  # Repeated-text cleanup and batched kanji counts
GameSentenceMiner/native/
  runtime.py        # Shared rollout mode
  ocr.py            # Typed Python facade
  text.py           # Text kernels, Python references, and fallback
```

Future components should follow the same split: domain logic remains independent of Python in a Rust
module, `lib.rs` converts a small number of coarse-grained calls, and a typed Python facade owns rollout
and compatibility. Avoid Python callbacks and per-character or per-pixel FFI calls.

The extension exposes a small integer API version. Each facade validates that version before enabling
native calls, so an old binary beside new Python source falls back safely. Bump the version only for a
breaking boundary change; additive Rust-internal changes do not require it.

## Current OCR boundary

Rust owns script-aware character filtering, source-separator preservation, repeated-prefix removal,
spatial line joining, writing-direction detection, paragraph grouping, overlapping-line merging, and
furigana filtering. The overlay's structured line/word language gate is also one batched Rust call;
Python reconstructs the selected dictionaries so bounding boxes and OCR metadata stay unchanged. Python
still owns sentence segmentation, rolling OCR history, configuration, normalization, and reconstruction
of the existing `OcrResult`/`Paragraph`/`Line` objects. Those state owners can move later without changing
current OCR callers.

The native Japanese/Chinese text path uses the same target-script extraction as the legacy filter and
does not run the legacy statistical language classifier once per text block. Python and shadow modes
retain that classifier for rollback and representative parity audits.

## Text computation boundary

Three more CPU-heavy paths use the same extension, with no new Rust dependencies:

- OCR matching-block coverage and stability ratios use the exact string-only
  `SequenceMatcher(None, a, b, autojunk=False)` algorithm, including asymmetric tie breaking and
  Unicode character indexing. The existing bounded OCR result cache remains in Python.
- Text-hook repeated-character and repeated-line cleanup run in Rust. Automatic line repetition
  detection finds the shortest exact period in linear time. Explicit counts, incomplete character
  groups, and the original automatic character-count tie rules retain their existing behavior.
- Statistics count kanji in batches of up to 1,024 lines, releasing the GIL while scanning characters.
  The CJK ranges, first-seen ordering, archive merges, stable frequency ties, and color output are
  unchanged. Batches flush before archived records so their position in the input still matters.

The Python facades check each capability separately, so an older extension can keep serving the
existing OCR/overlay operations while these new paths use Python. Lone surrogates and integers beyond
the native argument range also use Python. `GSM_NATIVE_TEXT_MODE=python` disables all three new paths;
`GSM_NATIVE_TEXT_MODE=shadow` compares results (including dictionary order), reports mismatches, and
returns the Python result. The global `GSM_NATIVE_MODE` remains the default when no text override is set.

Rebuild without changing application dependencies and reproduce the benchmarks:

```powershell
.venv\Scripts\python.exe -m uv pip install --python .venv\Scripts\python.exe --no-deps --reinstall --editable .
.venv\Scripts\python.exe -m pytest tests/native/test_text_native.py
.venv\Scripts\python.exe scripts/benchmark_native_text.py --reference-ref 90eb145b --output .tmp_test_env/native_text_benchmark/results.json
```

The benchmark's statistics baseline comes from `--reference-ref`; use a revision before the text
migration. It verifies exact outputs before timing, alternates execution order, and includes facade and
argument-conversion costs. Inputs are deterministic synthetic Japanese text; these are component
measurements, not overall OCR inference or application speedups. See
[text benchmark results](benchmarks/native-text-2026-09-17/README.md) for the measured revision and timings.

## Development

The root setuptools build uses `setuptools-rust`, so the normal environment sync builds the extension:

```powershell
uv lock --check
uv sync --frozen --extra dev
cargo test --manifest-path native/gsm-native/Cargo.toml
.venv\Scripts\python.exe -m pytest tests/native tests/ocr/test_text_filtering_punctuation.py
```

PyO3 is configured for CPython's `abi3` stable ABI beginning with Python 3.10. A wheel is still required
for each supported operating system and architecture.

Development prerelease CI builds and smoke-tests one platform wheel per Electron target. The wheel and
its SHA-256 digest are bundled with the app through `electron-src/assets/prerelease.json`; the managed
Python environment installs that immutable local artifact rather than compiling a GitHub branch archive
on the user's machine. The same wheels are attached to the matching GitHub prerelease for inspection.

## Rollout and rollback

The default mode is `native`. Set either environment variable before starting GSM:

- `GSM_NATIVE_OCR_MODE=python` uses the retained Python reference implementation.
- `GSM_NATIVE_OCR_MODE=shadow` computes both implementations, logs mismatches, and returns the Python
  result. Shadow mode is diagnostic and intentionally slower.
- `GSM_NATIVE_MODE` applies the same mode to every native component unless a component-specific value
  overrides it.

If the extension cannot be imported or a native call raises, OCR automatically uses the Python reference.
The Python implementation should remain until representative shadow runs and release telemetry establish
parity; it can then be removed in a separate change.

## Adding another component

1. Add pure Rust logic and Rust unit tests under `native/gsm-native/src`.
2. Export one coarse-grained operation from `lib.rs`, releasing the GIL during CPU work.
3. Add a typed facade under `GameSentenceMiner/native`.
4. Extend the native API version only if the Python/Rust boundary is no longer backward compatible.
5. Keep state and Python object reconstruction in the facade until the entire state owner is ready to move.
6. Add Python contract/parity tests, an end-to-end benchmark, and import smoke tests for every release target.
