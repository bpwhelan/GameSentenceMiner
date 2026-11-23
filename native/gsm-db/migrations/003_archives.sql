CREATE TABLE IF NOT EXISTS archived_game_days (
            game_id TEXT NOT NULL, date TEXT NOT NULL, game_name TEXT NOT NULL,
            events BLOB NOT NULL, kanji TEXT NOT NULL, raw_kanji TEXT NOT NULL,
            archived_at REAL NOT NULL, line_count INTEGER NOT NULL, character_count INTEGER NOT NULL,
            first_timestamp REAL NOT NULL, last_timestamp REAL NOT NULL,
            tokenized_lines INTEGER NOT NULL, token_kanji TEXT NOT NULL, PRIMARY KEY(game_id, date));

CREATE INDEX IF NOT EXISTS idx_archived_days_date ON archived_game_days(date);

CREATE TABLE IF NOT EXISTS archived_word_stats (
            game_id TEXT NOT NULL, date TEXT NOT NULL, word_id INTEGER NOT NULL,
            word TEXT NOT NULL, reading TEXT NOT NULL, pos TEXT NOT NULL,
            frequency INTEGER NOT NULL, first_seen REAL NOT NULL, last_seen REAL NOT NULL,
            first_line_id TEXT NOT NULL,
            PRIMARY KEY(game_id, date, word_id));

CREATE INDEX IF NOT EXISTS idx_archived_words_word ON archived_word_stats(word_id);

CREATE TRIGGER IF NOT EXISTS trg_delete_game_archive AFTER DELETE ON games BEGIN
            DELETE FROM archived_game_days WHERE game_id=OLD.id;
            DELETE FROM archived_word_stats WHERE game_id=OLD.id;
        END;

CREATE TABLE IF NOT EXISTS database_maintenance (
        id INTEGER PRIMARY KEY CHECK(id=1), vacuum_interval_days INTEGER NOT NULL DEFAULT 0,
        archive_after_days INTEGER NOT NULL DEFAULT 0, last_vacuum REAL);

INSERT OR IGNORE INTO database_maintenance(id) VALUES (1);

CREATE INDEX IF NOT EXISTS idx_third_party_stats_date ON third_party_stats(date);
CREATE INDEX IF NOT EXISTS idx_game_lines_game_id ON game_lines(game_id);

CREATE INDEX IF NOT EXISTS idx_reading_breaks_time ON stats_reading_breaks(CAST(timestamp AS REAL));
