CREATE TABLE IF NOT EXISTS words (id INTEGER PRIMARY KEY AUTOINCREMENT, word TEXT, reading TEXT, pos TEXT, in_anki TEXT, last_seen TEXT, first_seen TEXT, first_seen_line_id TEXT);

CREATE TABLE IF NOT EXISTS kanji (id INTEGER PRIMARY KEY AUTOINCREMENT, character TEXT);

CREATE TABLE IF NOT EXISTS word_occurrences (id INTEGER PRIMARY KEY AUTOINCREMENT, word_id TEXT, line_id TEXT);

CREATE TABLE IF NOT EXISTS kanji_occurrences (id INTEGER PRIMARY KEY AUTOINCREMENT, kanji_id TEXT, line_id TEXT);

CREATE TABLE IF NOT EXISTS word_stats_cache (
            word_id INTEGER PRIMARY KEY,
            occurrence_count INTEGER NOT NULL DEFAULT 0,
            active_global_rank INTEGER DEFAULT NULL
        );

CREATE TABLE IF NOT EXISTS global_frequency_sources (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            version TEXT NOT NULL,
            source_url TEXT DEFAULT '',
            is_default INTEGER NOT NULL DEFAULT 0,
            max_rank INTEGER NOT NULL DEFAULT 0,
            entry_count INTEGER NOT NULL DEFAULT 0,
            synced_at REAL NOT NULL DEFAULT 0
        );

CREATE TABLE IF NOT EXISTS word_global_frequencies (
            source_id TEXT NOT NULL,
            word TEXT NOT NULL,
            rank INTEGER NOT NULL,
            PRIMARY KEY (source_id, word)
        );

CREATE TABLE IF NOT EXISTS anki_notes (note_id TEXT PRIMARY KEY, model_name TEXT, fields_json TEXT, tags TEXT, mod TEXT, synced_at TEXT);

CREATE TABLE IF NOT EXISTS anki_cards (card_id TEXT PRIMARY KEY, note_id TEXT, deck_name TEXT, queue TEXT, type TEXT, due TEXT, interval TEXT, factor TEXT, reps TEXT, lapses TEXT, synced_at TEXT);

CREATE TABLE IF NOT EXISTS anki_reviews (review_id TEXT PRIMARY KEY, card_id TEXT, note_id TEXT, review_time TEXT, ease TEXT, interval TEXT, last_interval TEXT, time_taken TEXT, synced_at TEXT);

CREATE TABLE IF NOT EXISTS word_anki_links (id INTEGER PRIMARY KEY AUTOINCREMENT, word_id TEXT, note_id TEXT);

CREATE TABLE IF NOT EXISTS card_kanji_links (id INTEGER PRIMARY KEY AUTOINCREMENT, card_id TEXT, kanji_id TEXT);
