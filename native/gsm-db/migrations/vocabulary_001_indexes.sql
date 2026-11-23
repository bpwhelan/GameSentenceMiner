CREATE UNIQUE INDEX IF NOT EXISTS idx_words_word ON words(word);

CREATE INDEX IF NOT EXISTS idx_words_in_anki ON words(in_anki);

CREATE INDEX IF NOT EXISTS idx_words_pos ON words(pos);

CREATE INDEX IF NOT EXISTS idx_words_first_seen ON words(first_seen);

CREATE INDEX IF NOT EXISTS idx_words_first_seen_line_id ON words(first_seen_line_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_kanji_character ON kanji(character);

CREATE UNIQUE INDEX IF NOT EXISTS idx_word_occ_unique ON word_occurrences(word_id, line_id);

CREATE INDEX IF NOT EXISTS idx_word_occ_word_id ON word_occurrences(word_id);

CREATE INDEX IF NOT EXISTS idx_word_occ_line_id ON word_occurrences(line_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_kanji_occ_unique ON kanji_occurrences(kanji_id, line_id);

CREATE INDEX IF NOT EXISTS idx_kanji_occ_kanji_id ON kanji_occurrences(kanji_id);

CREATE INDEX IF NOT EXISTS idx_kanji_occ_line_id ON kanji_occurrences(line_id);

CREATE INDEX IF NOT EXISTS idx_game_lines_tokenized ON game_lines(tokenized);

CREATE INDEX IF NOT EXISTS idx_game_lines_timestamp ON game_lines(timestamp);

CREATE INDEX IF NOT EXISTS idx_game_lines_game_id ON game_lines(game_id);

CREATE INDEX IF NOT EXISTS idx_word_stats_cache_occurrence_count
        ON word_stats_cache(occurrence_count DESC, word_id);

CREATE INDEX IF NOT EXISTS idx_word_stats_cache_active_global_rank
        ON word_stats_cache(active_global_rank, word_id);

CREATE INDEX IF NOT EXISTS idx_anki_cards_note_id ON anki_cards(note_id);

CREATE INDEX IF NOT EXISTS idx_anki_reviews_card_id ON anki_reviews(card_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_word_anki_links_unique ON word_anki_links(word_id, note_id);

CREATE INDEX IF NOT EXISTS idx_word_anki_links_word_id ON word_anki_links(word_id);

CREATE INDEX IF NOT EXISTS idx_word_anki_links_note_id ON word_anki_links(note_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_card_kanji_links_unique ON card_kanji_links(card_id, kanji_id);

CREATE INDEX IF NOT EXISTS idx_card_kanji_links_card_id ON card_kanji_links(card_id);

CREATE INDEX IF NOT EXISTS idx_card_kanji_links_kanji_id ON card_kanji_links(kanji_id);

CREATE TRIGGER IF NOT EXISTS trg_game_lines_tokenization_cleanup
        AFTER DELETE ON game_lines
        BEGIN
            DELETE FROM word_occurrences WHERE line_id = OLD.id;
            DELETE FROM kanji_occurrences WHERE line_id = OLD.id;
        END;

CREATE TRIGGER IF NOT EXISTS trg_word_occurrences_stats_cache_insert
        AFTER INSERT ON word_occurrences
        BEGIN
            INSERT OR IGNORE INTO word_stats_cache (word_id, occurrence_count, active_global_rank)
            SELECT NEW.word_id, 0, wgf.rank
            FROM words w
            LEFT JOIN global_frequency_sources gfs ON gfs.is_default = 1
            LEFT JOIN word_global_frequencies wgf
                ON wgf.source_id = gfs.id AND wgf.word = w.word
            WHERE w.id = NEW.word_id
            LIMIT 1;

            UPDATE word_stats_cache
            SET occurrence_count = occurrence_count + 1
            WHERE word_id = NEW.word_id;
        END;

CREATE TRIGGER IF NOT EXISTS trg_word_occurrences_stats_cache_delete
        AFTER DELETE ON word_occurrences
        BEGIN
            UPDATE word_stats_cache
            SET occurrence_count = CASE
                WHEN occurrence_count > 0 THEN occurrence_count - 1
                ELSE 0
            END
            WHERE word_id = OLD.word_id;

            DELETE FROM word_stats_cache
            WHERE word_id = OLD.word_id AND occurrence_count <= 0;
        END;

CREATE TRIGGER IF NOT EXISTS trg_words_stats_cache_delete
        AFTER DELETE ON words
        BEGIN
            DELETE FROM word_stats_cache
            WHERE word_id = OLD.id;
        END;
