# Tokenise Words in Game Lines DB — Design Document

**Ticket:** [#181 — Tokenise words in game lines DB](https://github.com/...)
**Status:** Ready for implementation

---

## 1. Motivation

GSM stores every game line a user reads in the `game_lines` SQLite table. Today, the only character-level analysis is a kanji frequency calculation that runs on-the-fly over raw text (`web/stats.py:73-184`). There is no word-level indexing.

This means:
- **Search is limited.** Searching for a word only matches the exact conjugated form in the line. Searching for `食べる` won't find lines containing `食べた`, `食べない`, `食べられる`.
- **Frequency queries are slow.** Computing "most common words in the last 7 days" requires scanning every line and tokenising on the fly — O(n) per query, and it gets worse as the DB grows.
- **No vocabulary tracking.** There's no way to answer "what words has the user seen that aren't in their Anki deck?" or "what words appeared most often this week?"
- **Kanji frequency is scuffed.** The current implementation (`calculate_kanji_frequency`) re-scans all lines every time, with no caching beyond the daily rollup JSON blob.

By tokenising lines and storing the results in normalised tables with proper indexes, we unlock:
- Instant word/kanji frequency queries (indexed JOINs instead of full-table scans)
- Search by dictionary/base form (all conjugations of a word map to one entry)
- "Words not in Anki" queries
- Personal frequency lists for external apps/Anki addons
- Foundation for i+1 sentence lookup, vocabulary heatmaps, etc.

---

## 2. Configuration

### 2.1 New Config Fields

Two new boolean fields on the `Features` dataclass in `configuration.py`:

```python
@dataclass_json
@dataclass
class Features:
    # ... existing fields ...
    enable_tokenisation: bool = False
    tokenise_low_performance: bool = False
```

| Field | Default | Description |
|-------|---------|-------------|
| `enable_tokenisation` | `False` | Master toggle. When `True`, tokenisation tables are created, the cron is active, and on-insert tokenisation fires. When `False`, tokenisation tables are dropped and all tokenisation work is skipped. |
| `tokenise_low_performance` | `False` | Throttle mode. When `True`, the cron inserts a `time.sleep()` between each line to reduce CPU/IO pressure. Intended for users on weak hardware who notice lag during backfill. |

**Why `Features`?** It's the existing home for user-facing toggles (`full_auto`, `generate_longplay`, etc.) and lives on the per-profile `ProfileConfig`, which is the right scope — tokenisation is a per-profile decision.

**Why off by default?** Tokenisation adds ~80-100 MB of DB overhead per 100k lines (Section 12). Users who don't care about vocabulary tracking shouldn't pay for it. Once a user opts in, the cron runs immediately and backfills historical data.

### 2.2 Enable Lifecycle

When the user toggles `enable_tokenisation` from `False` → `True`:

1. **Create tables.** `words`, `kanji`, `word_occurrences`, `kanji_occurrences` are created (all use `CREATE TABLE IF NOT EXISTS`).
2. **Add column.** `ALTER TABLE game_lines ADD COLUMN tokenised INTEGER DEFAULT 0` (idempotent — wrapped in `try/except OperationalError`).
3. **Create indexes.** `create_tokenisation_indexes()` runs.
4. **Register cron.** `migrate_tokenise_backfill_cron_job()` inserts the cron row with `next_run` in the past.
5. **Force immediate run.** `CronScheduler.force_tokenise_backfill()` is called so the user doesn't wait up to 15 minutes for the scheduler to notice.

Steps 1-4 happen in a `setup_tokenisation()` helper called during DB migration. Step 5 happens when the config change is detected at runtime.

### 2.3 Disable Lifecycle

When the user toggles `enable_tokenisation` from `True` → `False`:

1. **Drop tables.** `WordOccurrencesTable.drop()`, `KanjiOccurrencesTable.drop()`, `WordsTable.drop()`, `KanjiTable.drop()` — uses the existing `SQLiteDBTable.drop()` method which issues `DROP TABLE IF EXISTS`.
2. **Disable cron.** `CronTable` row for `tokenise_backfill` is set to `enabled = False` (or deleted).
3. **Remove cleanup trigger.** The `trg_game_lines_tokenisation_cleanup` trigger is dropped (`DROP TRIGGER IF EXISTS`).

The `tokenised` column on `game_lines` is **not removed**. Removing columns requires `ALTER TABLE ... DROP COLUMN` which is only supported in SQLite 3.35.0+ (2021). Leaving it as a harmless integer column is safer. If re-enabled later, all lines will have `tokenised = 0` because the occurrence tables were dropped, but the column values are stale — a `UPDATE game_lines SET tokenised = 0` is run as part of re-enable to ensure correctness.

### 2.4 Config Guards

All tokenisation code paths check the config before doing work:

```python
# On-insert path (in GameLinesTable.add_line)
if get_config().features.enable_tokenisation:
    run_new_thread(tokenise_line, line.id, line.line_text)

# Cron entry point (in run_tokenise_backfill)
def run_tokenise_backfill():
    if not get_config().features.enable_tokenisation:
        return {"skipped": True, "reason": "tokenisation disabled"}
    ...

# Rollup integration (in analyze_kanji_data_from_tokens)
def analyze_kanji_data_from_tokens(date_start, date_end):
    if not get_config().features.enable_tokenisation:
        # Fall back to legacy raw-text scan
        lines = GameLinesTable.get_lines_filtered_by_timestamp(...)
        return analyze_kanji_data(lines)
    ...
```

### 2.5 Low-Performance / Throttle Mode

When `tokenise_low_performance` is `True`, the cron loop inserts a sleep between each line:

```python
THROTTLE_SLEEP_SECONDS = 0.05  # 50ms pause between lines

def run_tokenise_backfill():
    throttle = get_config().features.tokenise_low_performance
    for line in untokenised_lines:
        tokenise_line(line.id, line.line_text)
        if throttle:
            time.sleep(THROTTLE_SLEEP_SECONDS)
```

**Why 50ms?** Without throttle, the cron processes ~50-100 lines/second and pegs one CPU core. With a 50ms sleep, throughput drops to ~15-18 lines/second — still fast enough to backfill 100k lines in ~90 minutes, but spreads IO over time so the user doesn't notice disk or CPU spikes.

**Only affects the cron.** The on-insert path (real-time, one line at a time) does NOT throttle — it's already negligible overhead.

**Runtime-responsive.** The config is checked via `get_config()` on each iteration, not cached at cron start. If the user toggles throttle mode mid-backfill, it takes effect on the next line.

---

## 3. Tokeniser Choice: MeCab

### 3.1 Why MeCab

GSM already bundles MeCab as a first-class dependency:

- **`GameSentenceMiner/mecab/`** — A vendored package (from Ajatt-Tools/Ren Tatsumoto) wrapping the MeCab binary with ipadic-neologd dictionary.
- **`GameSentenceMiner/mecab/__init__.py:mecab`** — A pre-instantiated singleton `MecabController` with LRU cache (1024 entries).
- **`MecabController.translate(text) -> Sequence[MecabParsedToken]`** — The primary API. Returns tokens with:
  - `word` — surface form (e.g. `食べた`)
  - `headword` — dictionary/base form (e.g. `食べる`)
  - `katakana_reading` — reading in katakana (e.g. `タベタ`), `None` if word is all-kana
  - `part_of_speech` — `PartOfSpeech` enum (noun, verb, particle, symbol, etc.)
  - `inflection_type` — `Inflection` enum (dictionary form, continuative, etc.)
- The LRU cache means repeated lines (e.g. from the backfill cron hitting similar text) are near-free.
- MeCab binary is resolved via `mecab_exe_finder.py` — checks system PATH first, then bundled binaries in `support/` for Mac/Win/Linux.

### 3.2 Alternatives Considered

| Tokeniser | Pros | Cons |
|-----------|------|------|
| **MeCab** (chosen) | Already bundled; fast (~1-5ms/line); mature ipadic dictionary; returns headword + POS + reading | Occasional misparsings (mitigated by `replace_mistakes.py` with ~20 corrections) |
| **Yomitan API** (`/tokenize` endpoint) | Same tokeniser users use for Anki lookups, so tokens would match Anki cards exactly | Requires Yomitan running; HTTP overhead; not always available; Yomitan disables MeCab by default in GSM overlay config |
| **Yomitan Bridge** (window.postMessage) | Same as above | Only works in overlay context (browser); not available from Python backend |
| **Jiten API / JPDB API** | Dictionary-backed tokenisation | External dependency; network latency; rate limits; not always available |
| **sudachipy / fugashi** | Pure Python MeCab alternatives | Extra dependency; GSM already has MeCab; no clear advantage |

**Decision:** MeCab. It's already there, it's fast, it runs in Python where the DB lives, and it gives us headwords which are the key to making search and frequency useful.

### 3.3 MeCab Output Example

Input: `彼女は毎日図書館で本を読んでいる。`

```
MecabParsedToken(word='彼女',   headword='彼女',   katakana_reading='カノジョ', part_of_speech=noun,       inflection_type=unknown)
MecabParsedToken(word='は',     headword='は',     katakana_reading=None,       part_of_speech=particle,   inflection_type=unknown)
MecabParsedToken(word='毎日',   headword='毎日',   katakana_reading='マイニチ', part_of_speech=noun,       inflection_type=unknown)
MecabParsedToken(word='図書館', headword='図書館', katakana_reading='トショカン', part_of_speech=noun,       inflection_type=unknown)
MecabParsedToken(word='で',     headword='で',     katakana_reading=None,       part_of_speech=particle,   inflection_type=unknown)
MecabParsedToken(word='本',     headword='本',     katakana_reading='ホン',     part_of_speech=noun,       inflection_type=unknown)
MecabParsedToken(word='を',     headword='を',     katakana_reading=None,       part_of_speech=particle,   inflection_type=unknown)
MecabParsedToken(word='読ん',   headword='読む',   katakana_reading='ヨン',     part_of_speech=verb,       inflection_type=continuative_ta)
MecabParsedToken(word='で',     headword='で',     katakana_reading=None,       part_of_speech=particle,   inflection_type=unknown)
MecabParsedToken(word='いる',   headword='いる',   katakana_reading='イル',     part_of_speech=verb,       inflection_type=dictionary_form)
MecabParsedToken(word='。',     headword='。',     katakana_reading=None,       part_of_speech=symbol,     inflection_type=unknown)
```

Key point: `読んでいる` (conjugated) → headword `読む` (dictionary form). This is what makes word-level search powerful.

---

## 4. Database Schema

### 4.1 Existing Table Change: `game_lines`

**Add column:** `tokenised INTEGER DEFAULT 0`

This is the single source of truth for whether a line has been tokenised. The backfill cron queries `WHERE tokenised = 0` to find work. On successful tokenisation, we set `tokenised = 1`.

**Why a column on game_lines instead of a separate progress table:**
- Simpler — one query to find un-tokenised lines
- Naturally resumable — if GSM crashes mid-backfill, un-tokenised lines still have `tokenised = 0`
- No separate bookkeeping to maintain
- Easy to "re-tokenise" a line by setting back to 0 (e.g. if MeCab dictionary is updated)

### 4.2 New Table: `words`

```sql
CREATE TABLE IF NOT EXISTS words (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    word TEXT UNIQUE NOT NULL,       -- headword/base form from MeCab
    reading TEXT,                     -- katakana reading (nullable, None for all-kana words)
    pos TEXT                          -- part of speech string (e.g. '名詞', '動詞')
);

CREATE INDEX IF NOT EXISTS idx_words_word ON words(word);
```

**Design notes:**
- `word` is the MeCab **headword** (dictionary form), not the surface form. This means all conjugations of `食べる` map to one row.
- `UNIQUE` constraint on `word` — we deduplicate at insert time with `INSERT OR IGNORE`.
- `reading` and `pos` are stored for future use (furigana display, POS-based filtering) but aren't part of the unique constraint. If MeCab returns different readings for the same headword on different occasions, we keep whichever was inserted first. This is a pragmatic trade-off — the alternative (composite unique on word+reading+pos) would create duplicate entries for the same logical word.
- We store ALL tokens including particles (は, を, て, etc.). Filtering happens at query time, not at insert time. This avoids data loss and allows future features like particle usage statistics.

**What gets filtered OUT at insert time:**
- `PartOfSpeech.symbol` — punctuation like `。`, `！`, `（`, `■`
- `PartOfSpeech.other` — miscellaneous non-word tokens like `ァ`, `よ` (when classified as other)

### 4.3 New Table: `kanji`

```sql
CREATE TABLE IF NOT EXISTS kanji (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    character TEXT UNIQUE NOT NULL    -- single CJK character
);

CREATE INDEX IF NOT EXISTS idx_kanji_character ON kanji(character);
```

**Design notes:**
- Despite the name `kanji`, this stores all CJK Unified Ideographs (U+4E00–U+9FFF). The ticket discussed naming it `han` for universality, but `kanji` is more familiar to the user base and matches existing code (`is_kanji()` in `stats.py`).
- One row per unique character, deduplicated with `INSERT OR IGNORE`.

### 4.4 New Table: `word_occurrences`

```sql
CREATE TABLE IF NOT EXISTS word_occurrences (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    word_id INTEGER NOT NULL,
    line_id TEXT NOT NULL,
    FOREIGN KEY (word_id) REFERENCES words(id),
    FOREIGN KEY (line_id) REFERENCES game_lines(id),
    UNIQUE(word_id, line_id)
);

CREATE INDEX IF NOT EXISTS idx_word_occ_word_id ON word_occurrences(word_id);
CREATE INDEX IF NOT EXISTS idx_word_occ_line_id ON word_occurrences(line_id);
```

**Design notes:**
- This is a many-to-many join table: one word appears in many lines, one line contains many words.
- `UNIQUE(word_id, line_id)` prevents duplicate mappings. If the same word appears 3 times in one line, there's still only one occurrence row. This is a deliberate choice — we track **presence**, not **count per line**. Count-per-line can be derived by re-tokenising the line text if ever needed, and keeping it simple dramatically reduces table size.
- **Trade-off:** We lose per-line word count. For frequency analysis, we count the number of *lines* a word appears in, not the number of *times* it appears across all lines. For vocabulary tracking ("have I encountered this word?") this is actually more useful. For precise frequency, the daily rollup could compute and cache exact counts.
- Indexes on both `word_id` and `line_id` for fast lookups in both directions (word→lines and line→words).

### 4.5 New Table: `kanji_occurrences`

```sql
CREATE TABLE IF NOT EXISTS kanji_occurrences (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kanji_id INTEGER NOT NULL,
    line_id TEXT NOT NULL,
    FOREIGN KEY (kanji_id) REFERENCES kanji(id),
    FOREIGN KEY (line_id) REFERENCES game_lines(id),
    UNIQUE(kanji_id, line_id)
);

CREATE INDEX IF NOT EXISTS idx_kanji_occ_kanji_id ON kanji_occurrences(kanji_id);
CREATE INDEX IF NOT EXISTS idx_kanji_occ_line_id ON kanji_occurrences(line_id);
```

Same design as `word_occurrences` but for individual kanji characters.

### 4.6 Entity-Relationship Summary

```
game_lines  1──────M  word_occurrences  M──────1  words
game_lines  1──────M  kanji_occurrences M──────1  kanji
```

Both are classic many-to-many relationships resolved through join/mapping tables.

---

## 5. Tokenisation Logic

### 5.1 Core Function: `tokenise_line(line_id, line_text)`

```python
def tokenise_line(line_id: str, line_text: str) -> bool:
    """
    Tokenise a single game line and insert word/kanji occurrences.
    Returns True on success, False on failure.
    """
    from GameSentenceMiner.mecab import mecab
    from GameSentenceMiner.mecab.basic_types import PartOfSpeech

    tokens = mecab.translate(line_text)

    for token in tokens:
        # Skip punctuation and non-word tokens
        if token.part_of_speech in (PartOfSpeech.symbol, PartOfSpeech.other):
            continue

        # Skip empty headwords (shouldn't happen, but defensive)
        if not token.headword or not token.headword.strip():
            continue

        # Upsert word: INSERT OR IGNORE on unique headword
        word_id = WordsTable.get_or_create(
            word=token.headword,
            reading=token.katakana_reading,
            pos=token.part_of_speech.value if token.part_of_speech else None,
        )

        # Insert occurrence: INSERT OR IGNORE on unique (word_id, line_id)
        WordOccurrencesTable.insert_occurrence(word_id, line_id)

    # Extract kanji characters directly from the line text
    for char in line_text:
        if is_kanji(char):
            kanji_id = KanjiTable.get_or_create(character=char)
            KanjiOccurrencesTable.insert_occurrence(kanji_id, line_id)

    # Mark line as tokenised
    GameLinesTable.mark_tokenised(line_id)

    return True
```

**Key design choices:**

1. **Headword as the stored word.** `token.headword` gives us the dictionary form. All conjugations collapse to one entry. This is the single most important decision for search quality.

2. **Reading comes from the first encounter.** Because `word` is `UNIQUE`, subsequent `INSERT OR IGNORE` calls for the same headword with a potentially different reading are silently ignored. In practice, MeCab returns consistent readings for the same headword, so this is a non-issue.

3. **Kanji extraction is separate from MeCab.** We iterate the raw `line_text` characters directly rather than extracting kanji from MeCab tokens. This is simpler and guarantees we catch every kanji in the line regardless of tokenisation quirks.

4. **`mark_tokenised()` is called last.** If the function crashes partway through, the line remains `tokenised = 0` and will be retried by the cron. The `INSERT OR IGNORE` / `UNIQUE` constraints mean re-processing a partially-tokenised line is idempotent — no duplicate occurrences.

### 5.2 Filtering Rules

| POS | Stored? | Rationale |
|-----|---------|-----------|
| `noun` (名詞) | Yes | Core vocabulary |
| `verb` (動詞) | Yes | Core vocabulary |
| `i_adjective` (形容詞) | Yes | Core vocabulary |
| `adverb` (副詞) | Yes | Useful vocabulary |
| `particle` (助詞) | Yes | Store everything, filter at query time |
| `bound_auxiliary` (助動詞) | Yes | Store everything, filter at query time |
| `conjunction` (接続詞) | Yes | Useful vocabulary |
| `interjection` (感動詞) | Yes | Useful for tracking colloquial vocabulary |
| `prefix` (接頭詞) | Yes | Useful vocabulary |
| `adnominal_adjective` (連体詞) | Yes | Useful vocabulary |
| `filler` (フィラー) | Yes | Store, filter at query time |
| `symbol` (記号) | **No** | Punctuation, not a word |
| `other` (その他) | **No** | Miscellaneous non-word tokens |

**Trade-off:** Storing particles and auxiliaries makes the `word_occurrences` table larger (~30-40% more rows) but avoids irreversible data loss. Query-time filtering with `WHERE w.pos NOT IN ('助詞', '助動詞')` is trivial and indexed.

---

## 6. Tokenisation Paths

### 6.1 Path A: On-Insert (Real-Time)

**When:** Every time `GameLinesTable.add_line()` successfully inserts a new line, **if `enable_tokenisation` is `True`**.

**How:** After `new_line.add()`, call `tokenise_line(gameline.id, gameline.text)` on a background thread using `run_new_thread()`.

**Why background thread:** The insert into `game_lines` should not be blocked by tokenisation. MeCab is fast (~1-10ms per line) but the DB writes (multiple `INSERT OR IGNORE` statements) add latency. Running on a background thread keeps the text pipeline responsive.

**Recovery:** If the background thread fails or GSM crashes before tokenisation completes, the line's `tokenised` column remains `0`. The weekly cron will pick it up on its next run.

**Code location:** `GameSentenceMiner/util/database/db.py`, in `GameLinesTable.add_line()` and `GameLinesTable.add_lines()`.

### 6.2 Path B: Weekly Cron

**When:** Runs as a `weekly` cron job. On each run it performs three phases:

1. **Orphan cleanup.** Delete `word_occurrences` and `kanji_occurrences` rows whose `line_id` no longer exists in `game_lines`. This handles lines the user deleted since the last cron run (see Section 13 for details). Cleanup uses a single `DELETE ... WHERE line_id NOT IN (SELECT id FROM game_lines)` per table — fast with the existing `line_id` index.

2. **Tokenise new lines.** Query `game_lines WHERE tokenised = 0` and process each line through `tokenise_line()`. This catches:
   - Historical data that was never tokenised (initial backfill after enabling)
   - New lines where the on-insert path failed or was skipped (crash, race condition)
   - Lines that were manually reset to `tokenised = 0` (e.g. after a MeCab dictionary update)

3. **Throttle (optional).** If `tokenise_low_performance` is `True`, insert `time.sleep(THROTTLE_SLEEP_SECONDS)` between each line (see Section 2.5).

**Schedule:** `weekly` — `CronTable.just_ran()` schedules the next run at `03:00` one week later (same pattern as other weekly crons). This is much less aggressive than the previous `hourly` schedule because:
- The on-insert path handles new lines in real time.
- Orphan cleanup from deleted lines is not time-sensitive.
- Weekly keeps the overhead invisible for typical use.

**First run on enable:** When the user enables tokenisation, `force_tokenise_backfill()` triggers an immediate run (Section 2.2). This means the initial backfill doesn't wait a week.

**Why no batching:** The cron dispatcher is single-threaded. The cron simply loops through all un-tokenised lines. If it takes 2 hours for 100k lines, that's fine — the async lock prevents overlap with the next scheduled check.

**Estimated backfill time:**

| Lines | Normal mode | Low-performance mode (50ms sleep) |
|-------|-------------|-----------------------------------|
| 10,000 | ~2-3 min | ~10-12 min |
| 100,000 | ~20-30 min | ~90-120 min |
| 1,000,000 | ~3-5 hours | ~14-18 hours |

**Code location:** `GameSentenceMiner/util/cron/tokenise_lines.py`

### 6.3 Path C: Data Consistency (SQLite Trigger)

**When:** Any time a row is deleted from `game_lines`, a SQLite `AFTER DELETE` trigger fires to clean up the corresponding occurrence rows immediately.

```sql
CREATE TRIGGER IF NOT EXISTS trg_game_lines_tokenisation_cleanup
AFTER DELETE ON game_lines
BEGIN
    DELETE FROM word_occurrences WHERE line_id = OLD.id;
    DELETE FROM kanji_occurrences WHERE line_id = OLD.id;
END;
```

**Why a trigger in addition to the weekly cleanup?** The weekly cron handles bulk orphan cleanup, but the trigger provides immediate consistency for individual and batch deletions via the UI/API. Both are needed:

| Scenario | Trigger handles it? | Weekly cron handles it? |
|----------|---------------------|------------------------|
| User deletes one line via UI | Yes (immediate) | Yes (next week) |
| User bulk-deletes 500 lines | Yes (immediate, per row) | Yes (next week) |
| Direct SQL `DELETE` outside GSM | Yes | Yes |
| Tokenisation tables didn't exist when line was deleted (feature was disabled) | No (trigger doesn't exist) | N/A |

The trigger is created as part of `setup_tokenisation()` and dropped in `teardown_tokenisation()` (Section 2.3).

### 6.4 Why Three Paths?

| Concern | On-Insert Only | Cron Only | Both + Trigger (chosen) |
|---------|---------------|-----------|-------------------------|
| New lines tokenised immediately | Yes | No (up to 1 week) | Yes |
| Historical data tokenised | No | Yes | Yes |
| Crash recovery | No | Yes | Yes |
| Deleted lines cleaned up | No | Eventually | Immediately + Eventually |
| Complexity | Low | Low | Medium |
| Risk of missed lines | Medium (crash = lost) | None | None |

**Decision:** All three paths. On-insert gives immediacy; the weekly cron gives completeness, orphan cleanup, and crash recovery; the trigger gives immediate consistency on deletion. The `tokenised` column unifies the insert paths — it doesn't matter *who* tokenises a line, only that it gets done.

---

## 7. File Changes

### 7.1 New Files

| File | Purpose |
|------|---------|
| `GameSentenceMiner/util/database/tokenisation_tables.py` | `WordsTable`, `KanjiTable`, `WordOccurrencesTable`, `KanjiOccurrencesTable` — all extending `SQLiteDBTable`. Plus `create_tokenisation_indexes()` helper and `setup_tokenisation()` / `teardown_tokenisation()` lifecycle functions. |
| `GameSentenceMiner/util/cron/tokenise_lines.py` | `tokenise_line()` core function, `run_tokenise_backfill()` cron entry point, `cleanup_orphaned_occurrences()`. |

### 7.2 Modified Files

| File | Change |
|------|--------|
| `GameSentenceMiner/util/config/configuration.py` | 1. Add `enable_tokenisation: bool = False` and `tokenise_low_performance: bool = False` to `Features` dataclass. |
| `GameSentenceMiner/util/database/db.py` | 1. Import new table classes and call `set_db()` for each (conditional on config). 2. Add `migrate_tokenised_column()` — adds `tokenised` column to `game_lines`. 3. Add `migrate_tokenise_backfill_cron_job()` — registers the cron. 4. In `GameLinesTable.add_line()` — fire tokenisation on background thread after insert (guarded by config check). 5. In `GameLinesTable.add_lines()` — same for batch inserts. 6. Add `GameLinesTable.mark_tokenised(line_id)` and `GameLinesTable.get_untokenised_lines()` methods. 7. Create `trg_game_lines_tokenisation_cleanup` SQLite trigger as part of setup. |
| `GameSentenceMiner/util/cron/run_crons.py` | 1. Add `TOKENISE_BACKFILL = 'tokenise_backfill'` to `Crons` enum. 2. Add dispatch branch in `_run_due_crons_sync()` with config guard. 3. Add `force_tokenise_backfill()` method on `CronScheduler`. |
| `GameSentenceMiner/util/cron/__init__.py` | Export `TOKENISE_BACKFILL` and any needed symbols. |
| `GameSentenceMiner/util/database/stats_rollup_table.py` | 1. Add `unique_words_seen` and `word_frequency_data` to `_fields`, `_types`, and `__init__`. 2. Migration function to `ALTER TABLE` add the two new columns. |
| `GameSentenceMiner/util/cron/daily_rollup.py` | 1. Replace `analyze_kanji_data(lines)` call with `analyze_kanji_data_from_tokens(date_start, date_end)` (with legacy fallback when tokenisation disabled). 2. Add `analyze_word_data_from_tokens(date_start, date_end)` call. 3. Include `unique_words_seen` and `word_frequency_data` in the returned stats dict. |
| `GameSentenceMiner/web/rollup_stats.py` | 1. Add `word_frequency_data` merge logic in `aggregate_rollup_data()` (sum frequencies across rollup records). 2. Add `word_frequency_data` merge in `combine_rollup_and_live_stats()`. 3. Add `unique_words_seen` to additive/max fields as appropriate. |

### 7.3 Files NOT Changed (but could be in future work)

| File | Why not now |
|------|-------------|
| `GameSentenceMiner/web/stats.py` | The existing `calculate_kanji_frequency()` is kept as the legacy fallback. Could be fully removed once tokenisation is stable and widely adopted. |
| `GameSentenceMiner/web/stats_api.py` | New API endpoints for word frequency queries are out of scope for this ticket. |

---

## 8. Table Class Design

The new tables follow the existing `SQLiteDBTable` pattern used by `GameLinesTable`, `GamesTable`, `CronTable`, etc.

### `WordsTable`

```python
class WordsTable(SQLiteDBTable):
    _table = "words"
    _fields = ["word", "reading", "pos"]
    _types = [int, str, str, str]  # id (int PK), word, reading, pos
    _pk = "id"
    _auto_increment = True

    @classmethod
    def get_or_create(cls, word: str, reading: str | None, pos: str | None) -> int:
        """Return the id of the word, creating it if it doesn't exist."""
        # INSERT OR IGNORE, then SELECT to get the id
        ...

    @classmethod
    def get_by_word(cls, word: str) -> 'WordsTable | None':
        """Look up a word by its headword text."""
        ...
```

### `KanjiTable`

```python
class KanjiTable(SQLiteDBTable):
    _table = "kanji"
    _fields = ["character"]
    _types = [int, str]  # id (int PK), character
    _pk = "id"
    _auto_increment = True

    @classmethod
    def get_or_create(cls, character: str) -> int:
        """Return the id of the kanji, creating it if it doesn't exist."""
        ...
```

### `WordOccurrencesTable` and `KanjiOccurrencesTable`

These don't use the standard `SQLiteDBTable` pattern cleanly because they have composite unique constraints and foreign keys. They'll use raw SQL for table creation (in `create_tokenisation_indexes()`) and thin class methods for inserts/queries.

```python
class WordOccurrencesTable(SQLiteDBTable):
    _table = "word_occurrences"
    _fields = ["word_id", "line_id"]
    _types = [int, int, str]  # id, word_id, line_id
    _pk = "id"
    _auto_increment = True

    @classmethod
    def insert_occurrence(cls, word_id: int, line_id: str):
        """INSERT OR IGNORE a word-line mapping."""
        ...

    @classmethod
    def get_lines_for_word(cls, word_id: int) -> list:
        """Get all line_ids containing a given word."""
        ...

    @classmethod
    def get_words_for_line(cls, line_id: str) -> list:
        """Get all word_ids in a given line."""
        ...
```

### Index Creation

Indexes are created via a `create_tokenisation_indexes()` function called during migration:

```python
def create_tokenisation_indexes(db: SQLiteDB):
    db.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_words_word ON words(word)", commit=True)
    db.execute("CREATE INDEX IF NOT EXISTS idx_kanji_character ON kanji(character)", commit=True)
    db.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_word_occ_unique ON word_occurrences(word_id, line_id)", commit=True)
    db.execute("CREATE INDEX IF NOT EXISTS idx_word_occ_word_id ON word_occurrences(word_id)", commit=True)
    db.execute("CREATE INDEX IF NOT EXISTS idx_word_occ_line_id ON word_occurrences(line_id)", commit=True)
    db.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_kanji_occ_unique ON kanji_occurrences(kanji_id, line_id)", commit=True)
    db.execute("CREATE INDEX IF NOT EXISTS idx_kanji_occ_kanji_id ON kanji_occurrences(kanji_id)", commit=True)
    db.execute("CREATE INDEX IF NOT EXISTS idx_kanji_occ_line_id ON kanji_occurrences(line_id)", commit=True)
    # Index on game_lines.tokenised for the backfill query
    db.execute("CREATE INDEX IF NOT EXISTS idx_game_lines_tokenised ON game_lines(tokenised)", commit=True)
```

---

## 9. Cron Integration

### 9.1 Registration

Following the existing pattern (see `migrate_daily_rollup_cron_job()` in `db.py:1858-1882`). The cron is registered as part of `setup_tokenisation()` (Section 2.2), which only runs when `enable_tokenisation` is `True`:

```python
def migrate_tokenise_backfill_cron_job():
    existing_cron = CronTable.get_by_name("tokenise_backfill")
    if not existing_cron:
        now = datetime.now()
        one_minute_ago = now - timedelta(minutes=1)
        CronTable.create_cron_entry(
            name="tokenise_backfill",
            description="Tokenise game lines and clean up orphaned occurrences",
            next_run=one_minute_ago.timestamp(),  # Run ASAP on first enable
            schedule="weekly",
        )
    else:
        # Re-enabling after disable: ensure cron is active
        if not existing_cron.enabled:
            existing_cron.enabled = True
            existing_cron.next_run = (datetime.now() - timedelta(minutes=1)).timestamp()
            existing_cron.save()
```

### 9.2 Dispatch

In `_run_due_crons_sync()` in `run_crons.py`. The config guard ensures the cron is a no-op if tokenisation has been disabled since the cron was last scheduled:

```python
elif cron.name == Crons.TOKENISE_BACKFILL.value:
    from GameSentenceMiner.util.cron.tokenise_lines import run_tokenise_backfill
    result = run_tokenise_backfill()  # returns early if config disabled
    if cron.id != -1: CronTable.just_ran(cron.id)
    # ...
```

### 9.3 Force Method

```python
def force_tokenise_backfill(self):
    self.add_external_task(Crons.TOKENISE_BACKFILL)
```

Called in two scenarios:
1. **User enables tokenisation.** `setup_tokenisation()` calls this after creating tables/indexes so the initial backfill starts immediately.
2. **Manual trigger.** Exposed via a web API endpoint or future UI button for users who want to force a re-sync.

### 9.4 Cron Entry Point

```python
def run_tokenise_backfill() -> dict:
    """Weekly cron: clean orphans, then tokenise new lines."""
    if not get_config().features.enable_tokenisation:
        return {"skipped": True, "reason": "tokenisation disabled"}

    throttle = get_config().features.tokenise_low_performance

    # Phase 1: Orphan cleanup
    orphans_cleaned = cleanup_orphaned_occurrences()

    # Phase 2: Tokenise untokenised lines
    untokenised = GameLinesTable.get_untokenised_lines()
    processed = 0
    errors = 0

    for line in untokenised:
        try:
            tokenise_line(line.id, line.line_text)
            processed += 1
        except Exception as e:
            logger.error(f"Failed to tokenise line {line.id}: {e}")
            errors += 1

        if throttle:
            time.sleep(THROTTLE_SLEEP_SECONDS)

    return {
        "orphans_cleaned": orphans_cleaned,
        "processed": processed,
        "errors": errors,
    }
```

---

## 10. Daily Rollup Integration

### 10.1 Current State

The `daily_stats_rollup` table already stores per-day kanji frequency as a JSON blob (`kanji_frequency_data`) and a scalar count (`unique_kanji_seen`). Today these are computed by `analyze_kanji_data()` in `daily_rollup.py`, which calls `calculate_kanji_frequency()` in `stats.py` — a function that iterates every character of every line's raw text looking for CJK codepoints. This is O(total_chars) per day and duplicates work that the tokenisation tables will have already done.

There is no word frequency data in the rollup at all. The rollup stores kanji only.

### 10.2 Changes to StatsRollupTable

**Add two new columns:**

| Column | Type | Description |
|--------|------|-------------|
| `unique_words_seen` | `INTEGER DEFAULT 0` | Count of distinct headwords seen that day (excluding symbols/other) |
| `word_frequency_data` | `TEXT DEFAULT '{}'` | JSON blob: `{"食べる": 12, "本": 8, ...}` — headword → line count for the day |

These mirror the existing `unique_kanji_seen` / `kanji_frequency_data` pair.

**Migration:** `ALTER TABLE daily_stats_rollup ADD COLUMN unique_words_seen INTEGER DEFAULT 0` and `ALTER TABLE daily_stats_rollup ADD COLUMN word_frequency_data TEXT DEFAULT '{}'`. Follows the same `try/except OperationalError` pattern used for other column additions.

### 10.3 Replacing `analyze_kanji_data()`

The current `analyze_kanji_data(lines)` scans raw text. After tokenisation, we replace it with a query against the tokenisation tables:

```python
def analyze_kanji_data_from_tokens(date_start: float, date_end: float) -> Dict:
    """
    Compute kanji frequency for a date range using kanji_occurrences.

    Falls back to the legacy raw-text scan if tokenisation data is incomplete
    (i.e. there are un-tokenised lines in the range).
    """
    # Check if all lines in range are tokenised
    untokenised_count = db.fetchone(
        "SELECT COUNT(*) FROM game_lines "
        "WHERE timestamp >= ? AND timestamp < ? AND tokenised = 0",
        (date_start, date_end),
    )[0]

    if untokenised_count > 0:
        # Fallback: some lines not yet tokenised, use legacy path
        lines = GameLinesTable.get_lines_filtered_by_timestamp(
            date_start, date_end, for_stats=True
        )
        return analyze_kanji_data(lines)  # existing function

    # All lines tokenised — query the indexed tables
    rows = db.fetchall(
        """SELECT k.character, COUNT(*) AS freq
           FROM kanji_occurrences ko
           JOIN kanji k ON k.id = ko.kanji_id
           JOIN game_lines gl ON gl.id = ko.line_id
           WHERE gl.timestamp >= ? AND gl.timestamp < ?
           GROUP BY k.character
           ORDER BY freq DESC""",
        (date_start, date_end),
    )

    frequencies = {row[0]: row[1] for row in rows}
    return {
        "unique_count": len(frequencies),
        "frequencies": frequencies,
    }
```

**Key point: graceful fallback.** During the backfill period (the first run after upgrade), not all lines will be tokenised yet. The function checks for un-tokenised lines in the date range and falls back to the legacy raw-text scan if any exist. Once the backfill cron finishes, all queries go through the fast indexed path.

### 10.4 New: `analyze_word_data_from_tokens()`

```python
def analyze_word_data_from_tokens(date_start: float, date_end: float) -> Dict:
    """
    Compute word frequency for a date range using word_occurrences.

    Returns empty data if tokenisation is incomplete for the range.
    """
    untokenised_count = db.fetchone(
        "SELECT COUNT(*) FROM game_lines "
        "WHERE timestamp >= ? AND timestamp < ? AND tokenised = 0",
        (date_start, date_end),
    )[0]

    if untokenised_count > 0:
        # Can't compute accurate word frequency without full tokenisation
        return {"unique_count": 0, "frequencies": {}}

    rows = db.fetchall(
        """SELECT w.word, COUNT(*) AS freq
           FROM word_occurrences wo
           JOIN words w ON w.id = wo.word_id
           JOIN game_lines gl ON gl.id = wo.line_id
           WHERE gl.timestamp >= ? AND gl.timestamp < ?
             AND w.pos NOT IN ('記号', 'その他')
           GROUP BY w.word
           ORDER BY freq DESC""",
        (date_start, date_end),
    )

    frequencies = {row[0]: row[1] for row in rows}
    return {
        "unique_count": len(frequencies),
        "frequencies": frequencies,
    }
```

**Design note:** Unlike kanji, there is no legacy fallback for word frequency — there was never a raw-text word frequency calculation. If tokenisation is incomplete for a date range, word frequency returns empty. This is fine: the data appears progressively as the backfill cron processes lines.

### 10.5 Changes to `calculate_daily_stats()`

In `daily_rollup.py:calculate_daily_stats()`, the kanji and word sections become:

```python
# Analyze kanji (use tokenisation tables if available, else legacy)
kanji_data = analyze_kanji_data_from_tokens(date_start, date_end)

# Analyze words (only available after tokenisation)
word_data = analyze_word_data_from_tokens(date_start, date_end)
```

The returned dict gains two new keys:
```python
return {
    ...
    "unique_kanji_seen": kanji_data["unique_count"],
    "kanji_frequency_data": json.dumps(kanji_data["frequencies"], ensure_ascii=False),
    "unique_words_seen": word_data["unique_count"],
    "word_frequency_data": json.dumps(word_data["frequencies"], ensure_ascii=False),
    ...
}
```

### 10.6 Changes to Rollup Aggregation

In `rollup_stats.py`, the `aggregate_rollup_data()` and `combine_rollup_and_live_stats()` functions need to merge `word_frequency_data` the same way they already merge `kanji_frequency_data` — sum frequencies across rollup records:

```python
# MERGE - Combine word frequency data (sum frequencies)
combined_word_frequency = {}
for rollup in rollups:
    if rollup.word_frequency_data:
        word_data = json.loads(rollup.word_frequency_data) if isinstance(rollup.word_frequency_data, str) else rollup.word_frequency_data
        for word, count in word_data.items():
            combined_word_frequency[word] = combined_word_frequency.get(word, 0) + count
```

### 10.7 Semantics Note: Count vs Presence

The existing `kanji_frequency_data` in the rollup stores **raw character occurrence counts** (how many times a kanji appears across all text in a day). The new `kanji_occurrences` table stores **line presence** (whether a kanji appeared in a line, not how many times).

When using the tokenisation tables for rollup kanji frequency, the count becomes "number of lines containing this kanji" rather than "total character occurrences." This is a minor semantic change. For most practical purposes (frequency ranking, "have I seen this kanji enough?") the two measures are highly correlated. The line-presence count is arguably more useful — seeing 漢 five times in one copy-pasted line shouldn't count as five encounters.

The same applies to `word_frequency_data`: it counts lines containing the word, not total occurrences across all lines.

---

## 11. Example Queries (What This Enables)

### Most frequent words in the last 2 days

```sql
SELECT w.word, w.reading, w.pos, COUNT(*) AS freq
FROM word_occurrences wo
JOIN words w ON w.id = wo.word_id
JOIN game_lines gl ON gl.id = wo.line_id
WHERE gl.timestamp >= strftime('%s', 'now', '-2 days')
  AND w.pos NOT IN ('記号', 'その他')  -- exclude symbols
GROUP BY w.word
ORDER BY freq DESC
LIMIT 50;
```

### All game lines containing a specific word (by base form)

```sql
SELECT gl.id, gl.line_text, gl.timestamp, gl.game_name
FROM game_lines gl
JOIN word_occurrences wo ON gl.id = wo.line_id
JOIN words w ON w.id = wo.word_id
WHERE w.word = '食べる'
ORDER BY gl.timestamp DESC;
```

### Words not in a known-words list (future: from Anki)

```sql
SELECT w.word, w.reading, COUNT(*) AS freq
FROM word_occurrences wo
JOIN words w ON w.id = wo.word_id
JOIN game_lines gl ON gl.id = wo.line_id
WHERE gl.timestamp >= strftime('%s', 'now', '-7 days')
  AND w.pos IN ('名詞', '動詞', '形容詞', '副詞')  -- content words only
  AND w.word NOT IN (SELECT word FROM known_words)   -- future table
GROUP BY w.word
ORDER BY freq DESC;
```

### Kanji frequency (replaces current on-the-fly calculation)

```sql
SELECT k.character, COUNT(*) AS freq
FROM kanji_occurrences ko
JOIN kanji k ON k.id = ko.kanji_id
GROUP BY k.character
ORDER BY freq DESC;
```

### Kanji frequency for a specific time window

```sql
SELECT k.character, COUNT(*) AS freq
FROM kanji_occurrences ko
JOIN kanji k ON k.id = ko.kanji_id
JOIN game_lines gl ON gl.id = ko.line_id
WHERE gl.timestamp >= strftime('%s', 'now', '-30 days')
GROUP BY k.character
ORDER BY freq DESC
LIMIT 100;
```

### Word frequency per game

```sql
SELECT w.word, COUNT(*) AS freq
FROM word_occurrences wo
JOIN words w ON w.id = wo.word_id
JOIN game_lines gl ON gl.id = wo.line_id
WHERE gl.game_id = 'some-game-uuid'
GROUP BY w.word
ORDER BY freq DESC
LIMIT 50;
```

---

## 12. Space & Performance Estimates

### Table Sizes (estimated for a user with 100,000 game lines)

| Table | Rows (est.) | Row Size (est.) | Total (est.) |
|-------|-------------|-----------------|--------------|
| `words` | ~15,000-25,000 unique headwords | ~50 bytes | ~1 MB |
| `kanji` | ~2,000-3,000 unique characters | ~20 bytes | ~60 KB |
| `word_occurrences` | ~1,500,000 (100k lines × ~15 words) | ~20 bytes | ~30 MB |
| `kanji_occurrences` | ~500,000 (100k lines × ~5 kanji) | ~20 bytes | ~10 MB |
| Indexes | — | — | ~40-60 MB |
| **Total** | | | **~80-100 MB** |

For 1,000,000 lines (heavy user), expect ~800 MB - 1 GB. This is noted in the ticket as an acceptable trade-off.

### Insert Performance

- **MeCab tokenisation:** ~1-10ms per line (with LRU cache)
- **DB writes per line:** ~5-10 INSERT OR IGNORE statements (words + occurrences + kanji)
- **Total per line:** ~10-20ms
- **Backfill throughput:** ~50-100 lines/second
- **Impact on real-time insert:** Negligible (runs on background thread)

### Query Performance

With proper indexes, all the example queries above should complete in <50ms even for 1M+ game lines. The key is that we're doing indexed JOINs on integer foreign keys instead of full-text scanning.

---

## 13. Error Handling & Edge Cases

### MeCab Not Available

If MeCab binary is not found (shouldn't happen since it's bundled, but defensive):
- `tokenise_line()` catches the exception, logs a warning, returns `False`
- The line's `tokenised` column stays `0`
- The cron retries on next run
- After N consecutive failures, the cron should log an error suggesting MeCab reinstall

### Empty or Whitespace Lines

- Skip lines where `line_text` is empty or whitespace-only
- Still mark as `tokenised = 1` (nothing to tokenise is not an error)

### Very Long Lines

- MeCab handles long text fine (it's a streaming parser)
- No special handling needed

### Unicode Edge Cases

- `is_kanji()` check (U+4E00–U+9FFF) covers CJK Unified Ideographs
- Does NOT cover CJK Extension A/B/C/D/E/F (rare characters). Could be extended later.
- Surrogate pairs in Python 3 are handled natively (no UCS-2 issues)

### Re-tokenisation

Re-tokenisation is handled automatically by the weekly cron. To force a full re-tokenise (e.g. after a MeCab dictionary update):

1. `UPDATE game_lines SET tokenised = 0`
2. `DELETE FROM word_occurrences`
3. `DELETE FROM kanji_occurrences`
4. (Optional) `DELETE FROM words` and `DELETE FROM kanji` to clean up orphans
5. Force-run the cron via `CronScheduler.force_tokenise_backfill()`

This can be triggered manually or via a future "re-tokenise" button in the UI.

### Deleted Game Lines

When a game line is deleted from `game_lines`, occurrences are cleaned up by two complementary mechanisms (see Section 6.3):

1. **Immediate:** The `trg_game_lines_tokenisation_cleanup` SQLite trigger deletes matching rows from `word_occurrences` and `kanji_occurrences` on every `DELETE FROM game_lines`.
2. **Weekly sweep:** The cron's orphan cleanup phase (`DELETE ... WHERE line_id NOT IN (SELECT id FROM game_lines)`) catches any stragglers — e.g. if the trigger didn't exist when lines were deleted (feature was disabled at the time).

The `words` and `kanji` dimension tables are **not** cleaned up when lines are deleted. A word/kanji entry with zero occurrences is harmless (a few bytes) and may be needed again if the word appears in a future line. Periodic compaction could be added later if space becomes a concern.

### Tokenisation Disabled

When `enable_tokenisation` is `False`:
- `tokenise_line()` is never called (config guard in `add_line()`).
- The cron returns immediately with `{"skipped": True}`.
- Rollup functions fall back to legacy raw-text scanning for kanji, and return empty for word frequency.
- The tokenisation tables don't exist (dropped on disable), so any stray query against them would fail — but all query paths are guarded by the config check.

---

## 14. Future Work (Out of Scope)

These are explicitly NOT part of this ticket but are enabled by it:

1. **API endpoints** for word/kanji frequency queries (e.g., `/api/word-frequency?days=7&limit=50`)
2. **Web UI** for vocabulary statistics, word clouds, frequency graphs
3. **"Words not in Anki" feature** — requires an Anki-Connect query to build a `known_words` table
4. **External API** for Anki addons / third-party apps to query user's frequency data
5. **i+1 sentence finder** — "show me a sentence containing this word where all other words are in my Anki deck"
6. **Personal frequency list export** — CSV/JSON export of word frequencies for use in other tools
7. **Furigana storage** — store readings alongside occurrences for instant furigana display

---

## 15. Testing Strategy

### 15.1 Unit Tests — `tokenise_line()` Core Logic

These mock MeCab via `monkeypatch` so no binary is needed. Each test creates an in-memory SQLite DB with the tokenisation tables.

| Test | What it verifies |
|------|------------------|
| `test_tokenise_line_basic` | Mock MeCab returns known tokens for `彼女は本を読んだ。`. Verify `words` contains `彼女`, `は`, `本`, `を`, `読む`, `だ` (headwords). Verify `word_occurrences` has one row per word×line. Verify `kanji` contains `彼`, `女`, `本`, `読`. Verify `kanji_occurrences` has one row per kanji×line. Verify `game_lines.tokenised = 1`. |
| `test_tokenise_line_idempotent` | Call `tokenise_line()` twice on the same line_id. Verify row counts in `word_occurrences` and `kanji_occurrences` are unchanged after the second call. |
| `test_tokenise_line_skips_symbols` | MeCab returns tokens including `PartOfSpeech.symbol` (`。`, `！`) and `PartOfSpeech.other`. Verify these are absent from `words`. |
| `test_tokenise_line_stores_all_pos` | MeCab returns particles (`は`), auxiliaries (`だ`), verbs, nouns, adverbs, conjunctions, interjections, fillers, prefixes, adnominal adjectives. Verify all are stored in `words`. |
| `test_tokenise_line_empty_text` | Pass `line_text=""`. Verify `tokenised` is set to `1`, `word_occurrences` and `kanji_occurrences` have zero rows. |
| `test_tokenise_line_whitespace_only` | Pass `line_text="   \n\t"`. Same expectations as empty. |
| `test_tokenise_line_no_kanji` | Line is all-hiragana (`おはようございます`). Verify `kanji_occurrences` has zero rows, but `word_occurrences` is populated. |
| `test_tokenise_line_empty_headword` | MeCab returns a token with `headword=""` or `headword=None`. Verify it is skipped and doesn't create a `words` row. |
| `test_tokenise_line_mecab_failure` | MeCab `translate()` raises an exception. Verify `tokenise_line()` returns `False`, `tokenised` stays `0`, no partial data inserted. |
| `test_conjugations_collapse_to_headword` | Two lines: one containing `食べた`, another containing `食べない`. Both should produce a single row in `words` with `word='食べる'` and two rows in `word_occurrences` pointing to the same `word_id`. |
| `test_same_word_different_lines` | Word `本` appears in 3 different lines. Verify one `words` row, three `word_occurrences` rows. |
| `test_same_kanji_multiple_times_in_line` | Line `漢字漢字` — kanji `漢` appears twice. Verify one `kanji_occurrences` row (presence, not count). |
| `test_mark_tokenised_only_after_success` | Simulate a crash mid-processing (mock `KanjiOccurrencesTable.insert_occurrence` to raise). Verify `tokenised` stays `0`. |

### 15.2 Unit Tests — Table Classes

| Test | What it verifies |
|------|------------------|
| `test_words_table_get_or_create` | First call creates a row and returns its id. Second call with same headword returns the same id without inserting a duplicate. |
| `test_words_table_get_or_create_reading_first_wins` | Insert `食べる` with reading `タベル`. Call again with reading `タベタ`. Verify the stored reading is still `タベル`. |
| `test_words_table_get_by_word` | Insert a word, retrieve it by headword, verify fields match. |
| `test_words_table_get_by_word_not_found` | Query a non-existent headword, verify returns `None`. |
| `test_kanji_table_get_or_create` | Same upsert semantics as `WordsTable`. |
| `test_kanji_table_duplicate_character` | `INSERT OR IGNORE` on same character twice, verify one row. |
| `test_word_occurrences_unique_constraint` | Insert `(word_id=1, line_id='abc')` twice. Verify one row in the table. |
| `test_word_occurrences_get_lines_for_word` | Insert occurrences for word_id=1 across 3 lines. Verify `get_lines_for_word(1)` returns all 3 line_ids. |
| `test_word_occurrences_get_words_for_line` | Insert 5 word occurrences for line_id='abc'. Verify `get_words_for_line('abc')` returns all 5 word_ids. |
| `test_kanji_occurrences_unique_constraint` | Same as word occurrences. |
| `test_mark_tokenised` | Insert a game_line with `tokenised=0`. Call `mark_tokenised()`. Verify column is now `1`. |
| `test_get_untokenised_lines` | Insert 5 lines: 3 with `tokenised=0`, 2 with `tokenised=1`. Verify `get_untokenised_lines()` returns exactly 3. |

### 15.3 Unit Tests — Rollup Functions

These are pure function tests following the existing `test_rollup_stats.py` pattern (no DB, mock data via `SimpleNamespace`).

| Test | What it verifies |
|------|------------------|
| `test_analyze_kanji_data_from_tokens` | All lines in date range are tokenised. Verify the function queries `kanji_occurrences` and returns correct `{character: count}` dict. |
| `test_analyze_kanji_data_fallback` | Mix of tokenised and un-tokenised lines in range. Verify it calls the legacy `calculate_kanji_frequency()` path instead. |
| `test_analyze_kanji_data_all_untokenised` | All lines are `tokenised=0`. Verify legacy fallback is used. |
| `test_analyze_word_data_from_tokens` | All lines tokenised. Verify correct `{headword: count}` dict, with symbols excluded via `pos NOT IN`. |
| `test_analyze_word_data_incomplete` | Un-tokenised lines exist. Verify returns `{"unique_count": 0, "frequencies": {}}`. |
| `test_analyze_word_data_pos_filtering` | Tokenised lines contain particles and symbols. Verify symbols are excluded from frequency, particles are included. |
| `test_rollup_word_frequency_merge` | Two rollup records: `{"食べる": 5, "本": 3}` and `{"食べる": 2, "読む": 1}`. Verify `aggregate_rollup_data()` produces `{"食べる": 7, "本": 3, "読む": 1}`. |
| `test_rollup_word_frequency_empty` | Rollup records with `word_frequency_data="{}"`. Verify merge produces empty dict without error. |
| `test_combine_live_and_rollup_word_frequency` | Rollup has `{"食べる": 10}`, live today has `{"食べる": 3, "新しい": 1}`. Verify `combine_rollup_and_live_stats()` produces `{"食べる": 13, "新しい": 1}`. |
| `test_combine_live_only_word_frequency` | No rollup data, only live stats. Verify word frequency passes through unchanged. |
| `test_combine_rollup_only_word_frequency` | No live data, only rollup. Verify word frequency passes through unchanged. |
| `test_unique_words_seen_matches_frequency_keys` | After merge, verify `unique_words_seen == len(word_frequency_data)`. |
| `test_calculate_daily_stats_includes_word_fields` | Mock `analyze_kanji_data_from_tokens` and `analyze_word_data_from_tokens`. Verify the returned dict contains `unique_words_seen` and `word_frequency_data` keys with correct values. |

### 15.4 Integration Tests — Backfill Cron

| Test | What it verifies |
|------|------------------|
| `test_backfill_processes_all_lines` | Insert N lines with `tokenised=0`. Run `run_tokenise_backfill()`. Verify all are now `tokenised=1`. |
| `test_backfill_populates_occurrence_tables` | Insert 3 known lines, run backfill. Verify `word_occurrences` and `kanji_occurrences` have expected row counts. |
| `test_backfill_skips_already_tokenised` | Insert 5 lines, manually set 3 to `tokenised=1`. Run backfill. Verify only the 2 untokenised lines are processed (check MeCab call count). |
| `test_backfill_returns_summary` | Run backfill on 10 lines. Verify return dict contains `processed` count and `elapsed_time`. |
| `test_backfill_zero_lines` | No un-tokenised lines. Verify backfill returns immediately with `processed=0`, no errors. |
| `test_backfill_partial_failure` | Mock MeCab to fail on 1 out of 5 lines. Verify the other 4 are tokenised, the failed line stays `tokenised=0`, and an error count is returned. |
| `test_backfill_idempotent_after_crash` | Insert 3 lines. Tokenise line 1 fully, then simulate a partial tokenisation of line 2 (insert some `word_occurrences` but don't set `tokenised=1`). Run backfill. Verify line 2 is fully tokenised with no duplicate occurrences. |

### 15.5 Integration Tests — On-Insert Path

| Test | What it verifies |
|------|------------------|
| `test_add_line_triggers_tokenisation` | Call `GameLinesTable.add_line()` with known text. Wait for background thread. Verify `tokenised=1` and `word_occurrences` populated. |
| `test_add_lines_batch_triggers_tokenisation` | Call `GameLinesTable.add_lines()` with 3 lines. Verify all are tokenised after background threads complete. |
| `test_add_line_tokenisation_failure_leaves_flag_zero` | Mock MeCab to raise. Call `add_line()`. Verify line is inserted (`game_lines` row exists) but `tokenised=0`. |

### 15.6 Integration Tests — End-to-End Frequency Queries

| Test | What it verifies |
|------|------------------|
| `test_word_frequency_query` | Insert 3 lines with overlapping vocabulary. Tokenise. Run the "most frequent words" SQL query from Section 11. Verify ordering and counts. |
| `test_word_search_by_base_form` | Insert lines containing `食べた`, `食べない`, `食べられる`. Tokenise. Query for `w.word = '食べる'`. Verify all 3 lines returned. |
| `test_kanji_frequency_query` | Insert 5 lines with known kanji distribution. Tokenise. Run the kanji frequency SQL. Verify top kanji and counts. |
| `test_frequency_with_time_filter` | Insert lines at different timestamps (simulating different days). Tokenise. Query with `WHERE gl.timestamp >= ...`. Verify only lines in the window contribute to counts. |
| `test_word_frequency_per_game` | Insert lines for 2 different games. Tokenise. Query frequency filtered by `gl.game_id`. Verify counts are game-scoped. |
| `test_frequency_excludes_deleted_lines` | Insert 3 lines, tokenise, delete 1 line from `game_lines`. Run frequency query (which JOINs back to `game_lines`). Verify the deleted line's words don't appear in counts. |

### 15.7 Migration Tests

| Test | What it verifies |
|------|------------------|
| `test_migrate_tokenised_column` | Start with a `game_lines` table without the `tokenised` column. Run migration. Verify column exists and defaults to `0` for existing rows. |
| `test_migrate_tokenised_column_idempotent` | Run migration twice. Verify no error on second run. |
| `test_migrate_rollup_word_columns` | Start with a `daily_stats_rollup` table without `unique_words_seen`/`word_frequency_data`. Run migration. Verify columns exist with correct defaults. |
| `test_migrate_rollup_word_columns_idempotent` | Run migration twice. Verify no error. |
| `test_create_tokenisation_indexes` | Run `create_tokenisation_indexes()`. Verify all indexes exist (query `sqlite_master`). |
| `test_create_tokenisation_indexes_idempotent` | Run twice. Verify no error (all use `IF NOT EXISTS`). |
| `test_tokenise_backfill_cron_registration` | Run `migrate_tokenise_backfill_cron_job()`. Verify `CronTable` has a row with `name='tokenise_backfill'`, `schedule='weekly'`, and `next_run` in the past (triggers on first startup). |
| `test_tokenise_backfill_cron_registration_idempotent` | Run registration twice. Verify only one cron row exists. |

### 15.8 Edge Case & Regression Tests

| Test | What it verifies |
|------|------------------|
| `test_cjk_range_boundaries` | Verify `is_kanji()` returns `True` for `U+4E00` (一) and `U+9FFF`, `False` for `U+4DFF` and `U+A000`. |
| `test_non_cjk_characters_not_stored` | Line contains only hiragana, katakana, romaji, and emoji. Verify `kanji_occurrences` is empty. |
| `test_mixed_script_line` | Line `Hello世界！おはよう漢字ABC`. Verify only `世`, `界`, `漢`, `字` end up in `kanji`. Verify MeCab-derived words are stored correctly. |
| `test_very_long_line` | Line with 10,000+ characters. Verify tokenisation completes without error or timeout. |
| `test_line_with_rare_unicode` | Line containing CJK Extension B characters (`𠀀`). Verify `is_kanji()` returns `False` (outside U+4E00–U+9FFF range) — documents current behaviour. |
| `test_duplicate_kanji_in_line` | Line `漢漢漢`. Verify one `kanji` row and one `kanji_occurrences` row. |
| `test_duplicate_word_in_line` | Line `本と本と本`. Verify one `words` row for `本` and one `word_occurrences` row for that line. |
| `test_retokenisation_workflow` | Insert and tokenise 3 lines. Reset: `UPDATE game_lines SET tokenised = 0`, `DELETE FROM word_occurrences`, `DELETE FROM kanji_occurrences`. Run backfill. Verify data is fully restored with same row counts. |
| `test_concurrent_tokenise_and_query` | Tokenise lines on a background thread while simultaneously running a frequency query on the main thread. Verify no `database is locked` errors (SQLite WAL mode). |

### 15.9 Config Toggle & Lifecycle Tests

| Test | What it verifies |
|------|------------------|
| `test_enable_tokenisation_creates_tables` | Set `enable_tokenisation = True`, call `setup_tokenisation()`. Verify `words`, `kanji`, `word_occurrences`, `kanji_occurrences` tables exist (query `sqlite_master`). |
| `test_enable_tokenisation_creates_trigger` | After `setup_tokenisation()`, verify `trg_game_lines_tokenisation_cleanup` trigger exists in `sqlite_master`. |
| `test_enable_tokenisation_creates_indexes` | After `setup_tokenisation()`, verify all expected indexes exist. |
| `test_enable_tokenisation_registers_cron` | After `setup_tokenisation()`, verify `CronTable` has a `tokenise_backfill` row with `enabled=True` and `next_run` in the past. |
| `test_enable_tokenisation_resets_tokenised_column` | Insert 3 lines, manually set `tokenised=1` (stale from a previous enable/disable cycle). Call `setup_tokenisation()`. Verify all lines are now `tokenised=0`. |
| `test_disable_tokenisation_drops_tables` | Enable, insert data, then call `teardown_tokenisation()`. Verify `words`, `kanji`, `word_occurrences`, `kanji_occurrences` tables do not exist. |
| `test_disable_tokenisation_drops_trigger` | After `teardown_tokenisation()`, verify `trg_game_lines_tokenisation_cleanup` trigger does not exist. |
| `test_disable_tokenisation_disables_cron` | After `teardown_tokenisation()`, verify the `tokenise_backfill` cron row has `enabled=False`. |
| `test_disable_preserves_tokenised_column` | Disable tokenisation. Verify the `tokenised` column still exists on `game_lines` (not dropped). |
| `test_disable_preserves_game_lines` | Insert 5 game lines, tokenise, then disable. Verify all 5 game lines still exist in `game_lines`. |
| `test_enable_disable_enable_roundtrip` | Enable → tokenise 3 lines → disable (tables dropped) → re-enable. Verify tables are recreated, all lines have `tokenised=0`, backfill re-processes them correctly. |
| `test_config_guard_add_line` | Set `enable_tokenisation = False`. Call `GameLinesTable.add_line()`. Verify the line is inserted but `tokenise_line()` is never called (mock check). |
| `test_config_guard_cron` | Set `enable_tokenisation = False`. Call `run_tokenise_backfill()`. Verify it returns `{"skipped": True}` without touching any tables. |
| `test_config_guard_rollup_kanji_fallback` | Set `enable_tokenisation = False`. Call `analyze_kanji_data_from_tokens()`. Verify it falls back to legacy `calculate_kanji_frequency()`. |
| `test_config_guard_rollup_word_empty` | Set `enable_tokenisation = False`. Call `analyze_word_data_from_tokens()`. Verify it returns empty frequencies. |

### 15.10 Deletion Cleanup Tests

| Test | What it verifies |
|------|------------------|
| `test_trigger_cleans_word_occurrences_on_delete` | Insert a line, tokenise it (creating `word_occurrences` rows). Delete the line via `GameLinesTable.delete_line()`. Verify `word_occurrences` rows for that `line_id` are gone. |
| `test_trigger_cleans_kanji_occurrences_on_delete` | Same as above but for `kanji_occurrences`. |
| `test_trigger_preserves_other_lines_occurrences` | Insert 2 lines sharing a word. Delete line 1. Verify line 2's occurrences are untouched. |
| `test_trigger_batch_delete` | Insert 5 lines, tokenise all. Batch-delete 3 via `_delete_line_ids_batched()`. Verify occurrences for the 3 deleted lines are gone, occurrences for the remaining 2 are intact. |
| `test_trigger_preserves_word_and_kanji_rows` | Delete a line. Verify the `words` and `kanji` dimension rows are NOT deleted (only occurrences). |
| `test_orphan_cleanup_cron_phase` | Insert 3 lines, tokenise. Directly `DELETE FROM game_lines WHERE id = ...` (bypassing trigger, simulating trigger-not-existing scenario). Run `cleanup_orphaned_occurrences()`. Verify orphaned occurrence rows are removed. |
| `test_orphan_cleanup_no_orphans` | All lines exist. Run `cleanup_orphaned_occurrences()`. Verify it returns 0 cleaned and no data is lost. |
| `test_orphan_cleanup_large_batch` | Insert 100 lines, tokenise, delete 50 directly (no trigger). Run cleanup. Verify exactly the 50 deleted lines' occurrences are removed. |

### 15.11 Throttle Mode Tests

| Test | What it verifies |
|------|------------------|
| `test_throttle_mode_sleeps_between_lines` | Set `tokenise_low_performance = True`. Mock `time.sleep`. Run backfill on 5 lines. Verify `time.sleep(0.05)` was called 5 times. |
| `test_normal_mode_no_sleep` | Set `tokenise_low_performance = False`. Mock `time.sleep`. Run backfill on 5 lines. Verify `time.sleep` was never called. |
| `test_throttle_mode_runtime_toggle` | Start backfill with throttle off. After 2 lines, monkeypatch config to enable throttle. Verify sleep begins on line 3 (config is checked per-iteration, not cached). |
| `test_throttle_does_not_affect_on_insert` | Set `tokenise_low_performance = True`. Call `GameLinesTable.add_line()`. Verify no `time.sleep` in the on-insert code path. |
| `test_throttle_still_completes_all_lines` | Set `tokenise_low_performance = True`. Run backfill on 10 lines. Verify all 10 are `tokenised=1` (throttle slows but doesn't skip). |

### 15.12 Manual Testing

- Enable tokenisation on a real user database and verify backfill starts immediately
- Check DB file size before/after tokenisation (compare against Section 12 estimates)
- Run the example SQL queries from Section 11 against real data and verify sensible results
- Monitor MeCab memory usage during a long backfill (100k+ lines)
- Enable low-performance mode and verify CPU/disk activity is noticeably lower during backfill
- Disable tokenisation and verify tables are dropped (check `.tables` in SQLite CLI)
- Re-enable tokenisation after disabling — verify full re-backfill runs, data is consistent
- Delete a batch of game lines via the web UI, verify occurrence rows are cleaned up immediately (trigger path)
- Verify the rollup cron produces correct `kanji_frequency_data` and `word_frequency_data` after backfill completes
- Verify the web stats page still displays correctly (kanji frequency section) with tokenisation enabled vs disabled
- Kill GSM mid-backfill, restart, verify it resumes cleanly (un-tokenised lines picked up on next cron run)
- Toggle `enable_tokenisation` rapidly on/off/on — verify no crashes or corrupt state
