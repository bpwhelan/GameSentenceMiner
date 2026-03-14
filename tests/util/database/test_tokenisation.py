"""
Tests for the tokenisation feature.

Covers:
- tokenise_line() core logic with mocked MeCab
- Table classes (WordsTable, KanjiTable, WordOccurrencesTable, KanjiOccurrencesTable)
- Backfill cron (run_tokenise_backfill)
- Orphan cleanup
- is_kanji() helper
- Config guards
- Throttle mode
"""

from __future__ import annotations

import time
import re
from datetime import datetime
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from GameSentenceMiner.mecab.basic_types import (
    MecabParsedToken,
    PartOfSpeech,
    Inflection,
)
from GameSentenceMiner.util.database.anki_tables import (
    AnkiCardsTable,
    CardKanjiLinksTable,
    WordAnkiLinksTable,
    setup_anki_tables,
)
from GameSentenceMiner.util.database.db import GameLinesTable, gsm_db
from GameSentenceMiner.util.text_log import GameLine
from GameSentenceMiner.util.database.tokenisation_tables import (
    WORD_STATS_CACHE_TABLE,
    WordsTable,
    KanjiTable,
    WordOccurrencesTable,
    KanjiOccurrencesTable,
    recompute_word_first_seen_metadata,
    setup_tokenisation,
    teardown_tokenisation,
    create_tokenisation_indexes,
    create_tokenisation_trigger,
    drop_tokenisation_trigger,
    refresh_word_stats_active_global_ranks,
)
from GameSentenceMiner.util.cron.tokenise_lines import (
    tokenise_line,
    run_tokenise_backfill,
    cleanup_orphaned_occurrences,
    is_kanji,
    MIN_ADAPTIVE_BATCH_SLEEP_SECONDS,
    MAX_ADAPTIVE_BATCH_SLEEP_SECONDS,
    LOW_PERFORMANCE_BACKFILL_BATCH_SIZE,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _tok(
    word: str, headword: str, reading: str | None, pos: PartOfSpeech
) -> MecabParsedToken:
    """Shorthand to build a MecabParsedToken with default inflection."""
    return MecabParsedToken(
        word=word,
        headword=headword,
        katakana_reading=reading,
        part_of_speech=pos,
        inflection_type=Inflection.unknown,
    )


def _ensure_tokenisation_tables():
    """Ensure tokenisation tables exist and are empty."""
    for cls in [WordsTable, KanjiTable, WordOccurrencesTable, KanjiOccurrencesTable]:
        cls.set_db(gsm_db)

    # Create indexes for uniqueness constraints
    create_tokenisation_indexes(gsm_db)
    setup_anki_tables(gsm_db)
    create_tokenisation_trigger(gsm_db)

    # Ensure tokenised column exists
    try:
        gsm_db.execute(
            "ALTER TABLE game_lines ADD COLUMN tokenised INTEGER DEFAULT 0",
            commit=True,
        )
    except Exception:
        pass

    # Clean all tokenisation and Anki cache tables
    for table in [
        "word_global_frequencies",
        "global_frequency_sources",
        "word_occurrences",
        "kanji_occurrences",
        "words",
        "kanji",
        WORD_STATS_CACHE_TABLE,
        "anki_notes",
        "anki_cards",
        "anki_reviews",
        "word_anki_links",
        "card_kanji_links",
    ]:
        gsm_db.execute(f"DELETE FROM {table}", commit=True)


def _reset_game_lines():
    """Clear game_lines and sync table."""
    GameLinesTable._db.execute(f"DELETE FROM {GameLinesTable._table}", commit=True)
    GameLinesTable._db.execute(
        f"DELETE FROM {GameLinesTable._sync_changes_table}", commit=True
    )


def _insert_line(line_id: str, text: str, timestamp: float | None = None):
    """Insert a game line directly."""
    ts = timestamp or time.time()
    line = GameLinesTable(
        id=line_id,
        game_name="TestGame",
        line_text=text,
        timestamp=ts,
    )
    line.add()
    # Reset tokenised to 0
    gsm_db.execute(
        f"UPDATE game_lines SET tokenised = 0 WHERE id = ?",
        (line_id,),
        commit=True,
    )
    return line


def _make_mock_mecab(monkeypatch, token_map: dict):
    """
    Mock MeCab so that mecab.translate(text) returns tokens from token_map.
    token_map: {text: [MecabParsedToken, ...]}
    Patches at the module level so the deferred import inside tokenise_line picks it up.
    """
    # Ensure the real mecab package is loaded (not a leftover MagicMock stub).
    import GameSentenceMiner.mecab as mecab_mod

    mock_mecab = MagicMock()
    mock_mecab.translate = MagicMock(side_effect=lambda text: token_map.get(text, []))

    monkeypatch.setattr(mecab_mod, "mecab", mock_mecab)
    return mock_mecab


def _extract_progress_milestones(info_mock: MagicMock) -> list[int]:
    milestones: list[int] = []
    for call in info_mock.call_args_list:
        if not call.args:
            continue
        message = str(call.args[0])
        match = re.search(r"Tokenise backfill progress: (\d+)%", message)
        if match:
            milestones.append(int(match.group(1)))
    return milestones


# ---------------------------------------------------------------------------
# is_kanji() tests
# ---------------------------------------------------------------------------


class TestIsKanji:
    def test_basic_kanji(self):
        assert is_kanji("漢") is True
        assert is_kanji("字") is True
        assert is_kanji("一") is True  # U+4E00 (start of range)

    def test_hiragana_not_kanji(self):
        assert is_kanji("あ") is False
        assert is_kanji("ん") is False

    def test_katakana_not_kanji(self):
        assert is_kanji("ア") is False

    def test_ascii_not_kanji(self):
        assert is_kanji("A") is False
        assert is_kanji("1") is False

    def test_boundary_below(self):
        # U+4DFF is just below the CJK range
        assert is_kanji("\u4dff") is False

    def test_boundary_above(self):
        # U+A000 is above the CJK range
        assert is_kanji("\ua000") is False

    def test_boundary_end(self):
        # U+9FFF is the end of the CJK range
        assert is_kanji("\u9fff") is True


# ---------------------------------------------------------------------------
# Table class tests
# ---------------------------------------------------------------------------


class TestWordsTable:
    def setup_method(self):
        _ensure_tokenisation_tables()

    def test_get_or_create_new(self):
        word_id = WordsTable.get_or_create("食べる", "タベル", "動詞")
        assert isinstance(word_id, int)
        assert word_id > 0

    def test_get_or_create_existing(self):
        id1 = WordsTable.get_or_create("走る", "ハシル", "動詞")
        id2 = WordsTable.get_or_create("走る", "ハシル", "動詞")
        assert id1 == id2

    def test_get_or_create_reading_first_wins(self):
        WordsTable.get_or_create("食べる", "タベル", "動詞")
        WordsTable.get_or_create("食べる", "タベタ", "動詞")
        word = WordsTable.get_by_word("食べる")
        assert word is not None
        assert word.reading == "タベル"

    def test_get_by_word(self):
        WordsTable.get_or_create("本", "ホン", "名詞")
        word = WordsTable.get_by_word("本")
        assert word is not None
        assert word.word == "本"
        assert word.reading == "ホン"

    def test_get_by_word_not_found(self):
        result = WordsTable.get_by_word("存在しない")
        assert result is None


class TestKanjiTable:
    def setup_method(self):
        _ensure_tokenisation_tables()

    def test_get_or_create(self):
        kanji_id = KanjiTable.get_or_create("漢")
        assert isinstance(kanji_id, int)
        assert kanji_id > 0

    def test_get_or_create_duplicate(self):
        id1 = KanjiTable.get_or_create("字")
        id2 = KanjiTable.get_or_create("字")
        assert id1 == id2


class TestWordOccurrencesTable:
    def setup_method(self):
        _ensure_tokenisation_tables()
        _reset_game_lines()

    def test_insert_and_query(self):
        _insert_line("occ_line_1", "テスト")
        word_id = WordsTable.get_or_create("テスト", "テスト", "名詞")
        WordOccurrencesTable.insert_occurrence(word_id, "occ_line_1")

        lines = WordOccurrencesTable.get_lines_for_word(word_id)
        assert "occ_line_1" in lines

    def test_unique_constraint(self):
        _insert_line("occ_line_2", "テスト")
        word_id = WordsTable.get_or_create("重複", "チョウフク", "名詞")
        WordOccurrencesTable.insert_occurrence(word_id, "occ_line_2")
        WordOccurrencesTable.insert_occurrence(word_id, "occ_line_2")  # duplicate

        lines = WordOccurrencesTable.get_lines_for_word(word_id)
        assert len(lines) == 1

    def test_get_words_for_line(self):
        _insert_line("occ_line_3", "テスト")
        w1 = WordsTable.get_or_create("word_a", None, "名詞")
        w2 = WordsTable.get_or_create("word_b", None, "動詞")
        WordOccurrencesTable.insert_occurrence(w1, "occ_line_3")
        WordOccurrencesTable.insert_occurrence(w2, "occ_line_3")

        words = WordOccurrencesTable.get_words_for_line("occ_line_3")
        # word_ids may come back as strings from SQLite TEXT columns
        assert set(int(w) for w in words) == {w1, w2}


class TestKanjiOccurrencesTable:
    def setup_method(self):
        _ensure_tokenisation_tables()
        _reset_game_lines()

    def test_unique_constraint(self):
        _insert_line("kocc_line_1", "漢字")
        kanji_id = KanjiTable.get_or_create("漢")
        KanjiOccurrencesTable.insert_occurrence(kanji_id, "kocc_line_1")
        KanjiOccurrencesTable.insert_occurrence(kanji_id, "kocc_line_1")

        lines = KanjiOccurrencesTable.get_lines_for_kanji(kanji_id)
        assert len(lines) == 1


# ---------------------------------------------------------------------------
# tokenise_line() tests
# ---------------------------------------------------------------------------


class TestTokeniseLine:
    def setup_method(self):
        _ensure_tokenisation_tables()
        _reset_game_lines()

    def test_basic(self, monkeypatch):
        text = "彼女は本を読んだ。"
        tokens = [
            _tok("彼女", "彼女", "カノジョ", PartOfSpeech.noun),
            _tok("は", "は", None, PartOfSpeech.particle),
            _tok("本", "本", "ホン", PartOfSpeech.noun),
            _tok("を", "を", None, PartOfSpeech.particle),
            _tok("読ん", "読む", "ヨン", PartOfSpeech.verb),
            _tok("だ", "だ", None, PartOfSpeech.bound_auxiliary),
            _tok("。", "。", None, PartOfSpeech.symbol),
        ]
        _make_mock_mecab(monkeypatch, {text: tokens})

        _insert_line("tok_1", text)
        result = tokenise_line("tok_1", text)
        assert result is True

        # Check words (symbol should be filtered out)
        for headword in ["彼女", "は", "本", "を", "読む", "だ"]:
            assert WordsTable.get_by_word(headword) is not None
        assert WordsTable.get_by_word("。") is None

        # Check kanji
        kanji_chars = set()
        for char in text:
            if is_kanji(char):
                kanji_chars.add(char)
        assert kanji_chars == {"彼", "女", "本", "読"}

        # Check tokenised flag
        row = gsm_db.fetchone(
            "SELECT tokenised FROM game_lines WHERE id = ?", ("tok_1",)
        )
        assert row[0] == 1

    def test_idempotent(self, monkeypatch):
        text = "テスト"
        tokens = [_tok("テスト", "テスト", "テスト", PartOfSpeech.noun)]
        _make_mock_mecab(monkeypatch, {text: tokens})

        _insert_line("tok_2", text)
        tokenise_line("tok_2", text)

        count1 = gsm_db.fetchone(
            "SELECT COUNT(*) FROM word_occurrences WHERE line_id = ?", ("tok_2",)
        )[0]

        # Second call should not duplicate
        gsm_db.execute(
            "UPDATE game_lines SET tokenised = 0 WHERE id = ?", ("tok_2",), commit=True
        )
        tokenise_line("tok_2", text)

        count2 = gsm_db.fetchone(
            "SELECT COUNT(*) FROM word_occurrences WHERE line_id = ?", ("tok_2",)
        )[0]
        assert count1 == count2

    def test_skips_symbols(self, monkeypatch):
        text = "。！"
        tokens = [
            _tok("。", "。", None, PartOfSpeech.symbol),
            _tok("！", "！", None, PartOfSpeech.symbol),
        ]
        _make_mock_mecab(monkeypatch, {text: tokens})

        _insert_line("tok_3", text)
        tokenise_line("tok_3", text)

        word_count = gsm_db.fetchone("SELECT COUNT(*) FROM words")[0]
        # No words should be stored (all symbols)
        assert word_count == 0

    def test_skips_other_pos(self, monkeypatch):
        text = "ァ"
        tokens = [_tok("ァ", "ァ", None, PartOfSpeech.other)]
        _make_mock_mecab(monkeypatch, {text: tokens})

        _insert_line("tok_4", text)
        tokenise_line("tok_4", text)

        word_count = gsm_db.fetchone(
            "SELECT COUNT(*) FROM word_occurrences WHERE line_id = ?", ("tok_4",)
        )[0]
        assert word_count == 0

    def test_stores_all_non_filtered_pos(self, monkeypatch):
        text = "テスト"
        tokens = [
            _tok("は", "は", None, PartOfSpeech.particle),
            _tok("だ", "だ", None, PartOfSpeech.bound_auxiliary),
            _tok("美しい", "美しい", "ウツクシイ", PartOfSpeech.i_adjective),
            _tok("とても", "とても", "トテモ", PartOfSpeech.adverb),
            _tok("しかし", "しかし", None, PartOfSpeech.conjunction),
            _tok("ああ", "ああ", None, PartOfSpeech.interjection),
            _tok("えーと", "えーと", None, PartOfSpeech.filler),
            _tok("お", "お", None, PartOfSpeech.prefix),
            _tok("この", "この", None, PartOfSpeech.adnominal_adjective),
        ]
        _make_mock_mecab(monkeypatch, {text: tokens})

        _insert_line("tok_5", text)
        tokenise_line("tok_5", text)

        occ_count = gsm_db.fetchone(
            "SELECT COUNT(*) FROM word_occurrences WHERE line_id = ?", ("tok_5",)
        )[0]
        assert occ_count == 9  # All 9 tokens stored

    def test_empty_text(self, monkeypatch):
        _insert_line("tok_6", "")
        result = tokenise_line("tok_6", "")
        assert result is True

        row = gsm_db.fetchone(
            "SELECT tokenised FROM game_lines WHERE id = ?", ("tok_6",)
        )
        assert row[0] == 1

    def test_whitespace_only(self, monkeypatch):
        _insert_line("tok_7", "   \n\t")
        result = tokenise_line("tok_7", "   \n\t")
        assert result is True

    def test_no_kanji_line(self, monkeypatch):
        text = "おはようございます"
        tokens = [_tok("おはよう", "おはよう", None, PartOfSpeech.interjection)]
        _make_mock_mecab(monkeypatch, {text: tokens})

        _insert_line("tok_8", text)
        tokenise_line("tok_8", text)

        kanji_count = gsm_db.fetchone(
            "SELECT COUNT(*) FROM kanji_occurrences WHERE line_id = ?", ("tok_8",)
        )[0]
        assert kanji_count == 0

    def test_empty_headword_skipped(self, monkeypatch):
        text = "test"
        tokens = [
            _tok("test", "", None, PartOfSpeech.noun),
            _tok("test2", "   ", None, PartOfSpeech.noun),
        ]
        _make_mock_mecab(monkeypatch, {text: tokens})

        _insert_line("tok_9", text)
        tokenise_line("tok_9", text)

        word_count = gsm_db.fetchone(
            "SELECT COUNT(*) FROM word_occurrences WHERE line_id = ?", ("tok_9",)
        )[0]
        assert word_count == 0

    def test_mecab_failure(self, monkeypatch):
        mock_mecab = MagicMock()
        mock_mecab.translate = MagicMock(side_effect=RuntimeError("MeCab crashed"))
        monkeypatch.setattr(
            "GameSentenceMiner.mecab.mecab",
            mock_mecab,
        )

        _insert_line("tok_10", "テスト")
        result = tokenise_line("tok_10", "テスト")
        assert result is False

        row = gsm_db.fetchone(
            "SELECT tokenised FROM game_lines WHERE id = ?", ("tok_10",)
        )
        assert row[0] == 0

    def test_conjugations_collapse_to_headword(self, monkeypatch):
        text1 = "食べた"
        text2 = "食べない"
        tokens1 = [_tok("食べた", "食べる", "タベタ", PartOfSpeech.verb)]
        tokens2 = [_tok("食べない", "食べる", "タベナイ", PartOfSpeech.verb)]
        _make_mock_mecab(monkeypatch, {text1: tokens1, text2: tokens2})

        _insert_line("tok_11a", text1)
        _insert_line("tok_11b", text2)
        tokenise_line("tok_11a", text1)
        tokenise_line("tok_11b", text2)

        # Only one word row for 食べる
        word_count = gsm_db.fetchone(
            "SELECT COUNT(*) FROM words WHERE word = ?", ("食べる",)
        )[0]
        assert word_count == 1

        # But two occurrence rows
        word = WordsTable.get_by_word("食べる")
        lines = WordOccurrencesTable.get_lines_for_word(word.id)
        assert set(lines) == {"tok_11a", "tok_11b"}

    def test_same_kanji_multiple_times_in_line(self, monkeypatch):
        text = "漢字漢字"
        tokens = [_tok("漢字", "漢字", "カンジ", PartOfSpeech.noun)]
        _make_mock_mecab(monkeypatch, {text: tokens})

        _insert_line("tok_12", text)
        tokenise_line("tok_12", text)

        # 漢 appears twice but should have only one occurrence row
        kanji_id = KanjiTable.get_or_create("漢")
        lines = KanjiOccurrencesTable.get_lines_for_kanji(kanji_id)
        assert len(lines) == 1


# ---------------------------------------------------------------------------
# Backfill cron tests
# ---------------------------------------------------------------------------


class TestRunTokeniseBackfill:
    def setup_method(self):
        _ensure_tokenisation_tables()
        _reset_game_lines()

    def test_skips_when_disabled(self, monkeypatch):
        monkeypatch.setattr(
            "GameSentenceMiner.util.cron.tokenise_lines.is_tokenisation_enabled",
            lambda: False,
        )

        result = run_tokenise_backfill()
        assert result["skipped"] is True

    def test_processes_all_lines(self, monkeypatch):
        text = "テスト"
        tokens = [_tok("テスト", "テスト", "テスト", PartOfSpeech.noun)]
        _make_mock_mecab(monkeypatch, {text: tokens})

        monkeypatch.setattr(
            "GameSentenceMiner.util.cron.tokenise_lines.is_tokenisation_enabled",
            lambda: True,
        )
        monkeypatch.setattr(
            "GameSentenceMiner.util.cron.tokenise_lines.is_tokenisation_low_performance",
            lambda: False,
        )

        _insert_line("bf_1", text)
        _insert_line("bf_2", text)
        _insert_line("bf_3", text)

        result = run_tokenise_backfill()
        assert result["skipped"] is False
        assert result["total_lines"] == 3
        assert result["attempted_lines"] == 3
        assert result["processed"] == 3

        # All should be tokenised
        untokenised = gsm_db.fetchone(
            "SELECT COUNT(*) FROM game_lines WHERE tokenised = 0"
        )[0]
        assert untokenised == 0

    def test_skips_already_tokenised(self, monkeypatch):
        text = "テスト"
        tokens = [_tok("テスト", "テスト", "テスト", PartOfSpeech.noun)]
        mock = _make_mock_mecab(monkeypatch, {text: tokens})

        monkeypatch.setattr(
            "GameSentenceMiner.util.cron.tokenise_lines.is_tokenisation_enabled",
            lambda: True,
        )
        monkeypatch.setattr(
            "GameSentenceMiner.util.cron.tokenise_lines.is_tokenisation_low_performance",
            lambda: False,
        )

        _insert_line("bf_4", text)
        _insert_line("bf_5", text)
        # Mark bf_4 as already tokenised
        gsm_db.execute(
            "UPDATE game_lines SET tokenised = 1 WHERE id = ?", ("bf_4",), commit=True
        )

        result = run_tokenise_backfill()
        assert result["processed"] == 1  # Only bf_5

    def test_zero_lines(self, monkeypatch):
        monkeypatch.setattr(
            "GameSentenceMiner.util.cron.tokenise_lines.is_tokenisation_enabled",
            lambda: True,
        )
        monkeypatch.setattr(
            "GameSentenceMiner.util.cron.tokenise_lines.is_tokenisation_low_performance",
            lambda: False,
        )

        result = run_tokenise_backfill()
        assert result["processed"] == 0
        assert result["errors"] == 0
        assert result["total_lines"] == 0
        assert result["attempted_lines"] == 0

    def test_throttle_mode(self, monkeypatch):
        text = "テスト"
        tokens = [_tok("テスト", "テスト", "テスト", PartOfSpeech.noun)]
        _make_mock_mecab(monkeypatch, {text: tokens})

        monkeypatch.setattr(
            "GameSentenceMiner.util.cron.tokenise_lines.is_tokenisation_enabled",
            lambda: True,
        )
        monkeypatch.setattr(
            "GameSentenceMiner.util.cron.tokenise_lines.is_tokenisation_low_performance",
            lambda: True,
        )

        sleep_mock = MagicMock()
        monkeypatch.setattr(
            "GameSentenceMiner.util.cron.tokenise_lines.time.sleep", sleep_mock
        )

        for idx in range(LOW_PERFORMANCE_BACKFILL_BATCH_SIZE + 1):
            _insert_line(f"bf_t_{idx}", text)

        run_tokenise_backfill()
        assert sleep_mock.call_count >= 1
        for call in sleep_mock.call_args_list:
            sleep_seconds = call.args[0]
            assert (
                MIN_ADAPTIVE_BATCH_SLEEP_SECONDS
                <= sleep_seconds
                <= MAX_ADAPTIVE_BATCH_SLEEP_SECONDS
            )

    def test_no_throttle_when_disabled(self, monkeypatch):
        text = "テスト"
        tokens = [_tok("テスト", "テスト", "テスト", PartOfSpeech.noun)]
        _make_mock_mecab(monkeypatch, {text: tokens})

        monkeypatch.setattr(
            "GameSentenceMiner.util.cron.tokenise_lines.is_tokenisation_enabled",
            lambda: True,
        )
        monkeypatch.setattr(
            "GameSentenceMiner.util.cron.tokenise_lines.is_tokenisation_low_performance",
            lambda: False,
        )

        sleep_mock = MagicMock()
        monkeypatch.setattr(
            "GameSentenceMiner.util.cron.tokenise_lines.time.sleep", sleep_mock
        )

        _insert_line("bf_nt1", text)
        run_tokenise_backfill()
        sleep_mock.assert_not_called()

    def test_progress_logs_10_percent_milestones_without_duplicates(self, monkeypatch):
        text = "テスト"
        tokens = [_tok("テスト", "テスト", "テスト", PartOfSpeech.noun)]
        _make_mock_mecab(monkeypatch, {text: tokens})

        monkeypatch.setattr(
            "GameSentenceMiner.util.cron.tokenise_lines.is_tokenisation_enabled",
            lambda: True,
        )
        monkeypatch.setattr(
            "GameSentenceMiner.util.cron.tokenise_lines.is_tokenisation_low_performance",
            lambda: False,
        )
        info_mock = MagicMock()
        monkeypatch.setattr(
            "GameSentenceMiner.util.cron.tokenise_lines.logger.info", info_mock
        )

        for idx in range(10):
            _insert_line(f"bf_prog_{idx}", text)

        result = run_tokenise_backfill()
        assert result["processed"] == 10
        assert result["attempted_lines"] == 10

        milestones = _extract_progress_milestones(info_mock)
        assert milestones == [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]
        assert len(milestones) == len(set(milestones))

    def test_progress_small_backlog_logs_only_completion_milestone(self, monkeypatch):
        text = "テスト"
        tokens = [_tok("テスト", "テスト", "テスト", PartOfSpeech.noun)]
        _make_mock_mecab(monkeypatch, {text: tokens})

        monkeypatch.setattr(
            "GameSentenceMiner.util.cron.tokenise_lines.is_tokenisation_enabled",
            lambda: True,
        )
        monkeypatch.setattr(
            "GameSentenceMiner.util.cron.tokenise_lines.is_tokenisation_low_performance",
            lambda: False,
        )
        info_mock = MagicMock()
        monkeypatch.setattr(
            "GameSentenceMiner.util.cron.tokenise_lines.logger.info", info_mock
        )

        _insert_line("bf_prog_small", text)
        run_tokenise_backfill()

        milestones = _extract_progress_milestones(info_mock)
        assert milestones == [100]


# ---------------------------------------------------------------------------
# Real-time tokenisation path tests
# ---------------------------------------------------------------------------


class TestRealtimeTokenisationPath:
    def setup_method(self):
        _ensure_tokenisation_tables()
        _reset_game_lines()

    def test_low_performance_mode_does_not_sleep_on_add_line(self, monkeypatch):
        monkeypatch.setattr(
            "GameSentenceMiner.util.database.db._is_tokenisation_enabled",
            lambda: True,
        )
        monkeypatch.setattr(
            "GameSentenceMiner.util.cron.tokenise_lines.is_tokenisation_low_performance",
            lambda: True,
        )

        sleep_mock = MagicMock()
        monkeypatch.setattr(
            "GameSentenceMiner.util.cron.tokenise_lines.time.sleep", sleep_mock
        )

        tokenise_mock = MagicMock(return_value=True)
        monkeypatch.setattr(
            "GameSentenceMiner.util.cron.tokenise_lines.tokenise_line", tokenise_mock
        )
        monkeypatch.setattr(
            "GameSentenceMiner.util.gsm_utils.run_new_thread",
            lambda worker: worker(),
        )

        line = GameLine(
            id="rt_1",
            text="テスト",
            time=datetime.now(),
            prev=None,
            next=None,
            scene="TestGame",
        )

        GameLinesTable.add_line(line)
        tokenise_mock.assert_called_once()
        sleep_mock.assert_not_called()


# ---------------------------------------------------------------------------
# Orphan cleanup tests
# ---------------------------------------------------------------------------


class TestOrphanCleanup:
    def setup_method(self):
        _ensure_tokenisation_tables()
        _reset_game_lines()

    def test_cleanup_removes_orphans(self, monkeypatch):
        text = "テスト漢字"
        tokens = [_tok("テスト", "テスト", "テスト", PartOfSpeech.noun)]
        _make_mock_mecab(monkeypatch, {text: tokens})

        _insert_line("oc_1", text)
        tokenise_line("oc_1", text)

        # Verify data exists
        wo_count = gsm_db.fetchone(
            "SELECT COUNT(*) FROM word_occurrences WHERE line_id = ?", ("oc_1",)
        )[0]
        assert wo_count > 0
        assert gsm_db.fetchone("SELECT COUNT(*) FROM words")[0] == 1
        assert gsm_db.fetchone("SELECT COUNT(*) FROM kanji")[0] == 2
        assert gsm_db.fetchone(f"SELECT COUNT(*) FROM {WORD_STATS_CACHE_TABLE}")[0] == 1

        # Delete line directly (bypassing trigger for test purposes)
        # First drop trigger so deletion doesn't auto-clean
        drop_tokenisation_trigger(gsm_db)
        gsm_db.execute("DELETE FROM game_lines WHERE id = ?", ("oc_1",), commit=True)
        # Also clean sync table
        gsm_db.execute(f"DELETE FROM {GameLinesTable._sync_changes_table}", commit=True)

        # Orphans should still exist
        wo_count = gsm_db.fetchone(
            "SELECT COUNT(*) FROM word_occurrences WHERE line_id = ?", ("oc_1",)
        )[0]
        assert wo_count > 0

        # Run cleanup
        cleaned = cleanup_orphaned_occurrences()
        assert cleaned > 0

        # Orphans should be gone
        wo_count = gsm_db.fetchone(
            "SELECT COUNT(*) FROM word_occurrences WHERE line_id = ?", ("oc_1",)
        )[0]
        assert wo_count == 0
        assert gsm_db.fetchone("SELECT COUNT(*) FROM words")[0] == 0
        assert gsm_db.fetchone("SELECT COUNT(*) FROM kanji")[0] == 0
        assert gsm_db.fetchone(f"SELECT COUNT(*) FROM {WORD_STATS_CACHE_TABLE}")[0] == 0

    def test_cleanup_no_orphans(self, monkeypatch):
        text = "テスト"
        tokens = [_tok("テスト", "テスト", "テスト", PartOfSpeech.noun)]
        _make_mock_mecab(monkeypatch, {text: tokens})

        _insert_line("oc_2", text)
        tokenise_line("oc_2", text)

        cleaned = cleanup_orphaned_occurrences()
        assert cleaned == 0

    def test_cleanup_preserves_shared_words_and_kanji(self, monkeypatch):
        text = "共有漢"
        tokens = [_tok("共有", "共有", "キョウユウ", PartOfSpeech.noun)]
        _make_mock_mecab(monkeypatch, {text: tokens})

        _insert_line("oc_3a", text)
        _insert_line("oc_3b", text)
        tokenise_line("oc_3a", text)
        tokenise_line("oc_3b", text)

        drop_tokenisation_trigger(gsm_db)
        gsm_db.execute("DELETE FROM game_lines WHERE id = ?", ("oc_3a",), commit=True)
        gsm_db.execute(f"DELETE FROM {GameLinesTable._sync_changes_table}", commit=True)

        cleaned = cleanup_orphaned_occurrences()
        assert cleaned > 0

        assert gsm_db.fetchone("SELECT COUNT(*) FROM words")[0] == 1
        assert gsm_db.fetchone("SELECT COUNT(*) FROM kanji")[0] == 3
        assert (
            gsm_db.fetchone(
                "SELECT COUNT(*) FROM word_occurrences WHERE line_id = ?", ("oc_3b",)
            )[0]
            == 1
        )
        assert (
            gsm_db.fetchone(
                "SELECT COUNT(*) FROM kanji_occurrences WHERE line_id = ?", ("oc_3b",)
            )[0]
            == 3
        )
        assert (
            gsm_db.fetchone(f"SELECT occurrence_count FROM {WORD_STATS_CACHE_TABLE}")[0]
            == 1
        )

    def test_cleanup_recomputes_first_seen_after_original_line_is_deleted(
        self, monkeypatch
    ):
        text = "再会"
        tokens = [_tok("再会", "再会", "サイカイ", PartOfSpeech.noun)]
        _make_mock_mecab(monkeypatch, {text: tokens})

        first_timestamp = 1700000000.0
        second_timestamp = 1700100000.0
        _insert_line("oc_fs_1", text, timestamp=first_timestamp)
        _insert_line("oc_fs_2", text, timestamp=second_timestamp)
        tokenise_line("oc_fs_1", text, line_timestamp=first_timestamp)
        tokenise_line("oc_fs_2", text, line_timestamp=second_timestamp)

        drop_tokenisation_trigger(gsm_db)
        gsm_db.execute("DELETE FROM game_lines WHERE id = ?", ("oc_fs_1",), commit=True)
        gsm_db.execute(f"DELETE FROM {GameLinesTable._sync_changes_table}", commit=True)

        cleaned = cleanup_orphaned_occurrences()
        word = WordsTable.get_by_word("再会")

        assert cleaned > 0
        assert word is not None
        assert word.first_seen == second_timestamp
        assert word.first_seen_line_id == "oc_fs_2"

    def test_cleanup_clears_first_seen_when_only_anki_link_preserves_word(
        self, monkeypatch
    ):
        text = "既知語"
        tokens = [_tok("既知語", "既知語", "キチゴ", PartOfSpeech.noun)]
        _make_mock_mecab(monkeypatch, {text: tokens})

        timestamp = 1700000000.0
        _insert_line("oc_fs_3", text, timestamp=timestamp)
        tokenise_line("oc_fs_3", text, line_timestamp=timestamp)

        word = WordsTable.get_by_word("既知語")
        assert word is not None

        card = AnkiCardsTable(
            card_id=5002,
            note_id=6002,
            deck_name="Deck",
            queue=0,
            type=0,
            due=0,
            interval=5,
            factor=0,
            reps=0,
            lapses=0,
            synced_at=time.time(),
        )
        card.add()
        WordAnkiLinksTable.link(word.id, card.note_id)

        drop_tokenisation_trigger(gsm_db)
        gsm_db.execute("DELETE FROM game_lines WHERE id = ?", ("oc_fs_3",), commit=True)
        gsm_db.execute(f"DELETE FROM {GameLinesTable._sync_changes_table}", commit=True)

        cleaned = cleanup_orphaned_occurrences()
        row = gsm_db.fetchone(
            "SELECT first_seen, first_seen_line_id FROM words WHERE id = ?",
            (word.id,),
        )

        assert cleaned > 0
        assert row == (None, None)

    def test_cleanup_preserves_linked_words_and_kanji_without_occurrences(self):
        word_id = WordsTable.get_or_create("既知語", "キチゴ", "名詞")
        kanji_id = KanjiTable.get_or_create("既")

        card = AnkiCardsTable(
            card_id=5001,
            note_id=6001,
            deck_name="Deck",
            queue=0,
            type=0,
            due=0,
            interval=5,
            factor=0,
            reps=0,
            lapses=0,
            synced_at=time.time(),
        )
        card.add()
        WordAnkiLinksTable.link(word_id, card.note_id)
        CardKanjiLinksTable.link(card.card_id, kanji_id)

        cleaned = cleanup_orphaned_occurrences()
        assert cleaned == 0

        assert (
            gsm_db.fetchone("SELECT COUNT(*) FROM words WHERE id = ?", (word_id,))[0]
            == 1
        )
        assert (
            gsm_db.fetchone("SELECT COUNT(*) FROM kanji WHERE id = ?", (kanji_id,))[0]
            == 1
        )
        assert WordsTable.get_or_create("既知語", "キチゴ", "名詞") == word_id


# ---------------------------------------------------------------------------
# Trigger tests
# ---------------------------------------------------------------------------


class TestTriggerCleanup:
    def setup_method(self):
        _ensure_tokenisation_tables()
        _reset_game_lines()
        create_tokenisation_trigger(gsm_db)

    def test_trigger_cleans_on_delete(self, monkeypatch):
        text = "漢字テスト"
        tokens = [_tok("テスト", "テスト", "テスト", PartOfSpeech.noun)]
        _make_mock_mecab(monkeypatch, {text: tokens})

        _insert_line("trig_1", text)
        tokenise_line("trig_1", text)

        # Verify data
        wo_before = gsm_db.fetchone(
            "SELECT COUNT(*) FROM word_occurrences WHERE line_id = ?", ("trig_1",)
        )[0]
        ko_before = gsm_db.fetchone(
            "SELECT COUNT(*) FROM kanji_occurrences WHERE line_id = ?", ("trig_1",)
        )[0]
        assert wo_before > 0
        assert ko_before > 0

        # Delete line (trigger should fire)
        GameLinesTable.delete_line("trig_1")

        # Occurrences should be cleaned
        wo_after = gsm_db.fetchone(
            "SELECT COUNT(*) FROM word_occurrences WHERE line_id = ?", ("trig_1",)
        )[0]
        ko_after = gsm_db.fetchone(
            "SELECT COUNT(*) FROM kanji_occurrences WHERE line_id = ?", ("trig_1",)
        )[0]
        assert wo_after == 0
        assert ko_after == 0

    def test_trigger_preserves_other_lines(self, monkeypatch):
        text = "共有テスト"
        tokens = [_tok("テスト", "テスト", "テスト", PartOfSpeech.noun)]
        _make_mock_mecab(monkeypatch, {text: tokens})

        _insert_line("trig_2a", text)
        _insert_line("trig_2b", text)
        tokenise_line("trig_2a", text)
        tokenise_line("trig_2b", text)

        # Delete line A
        GameLinesTable.delete_line("trig_2a")

        # Line B's occurrences should still exist
        wo_b = gsm_db.fetchone(
            "SELECT COUNT(*) FROM word_occurrences WHERE line_id = ?", ("trig_2b",)
        )[0]
        assert wo_b > 0


class TestWordStatsCache:
    def setup_method(self):
        _ensure_tokenisation_tables()
        _reset_game_lines()

    def _seed_global_rank(self, word: str, rank: int) -> None:
        gsm_db.execute("DELETE FROM word_global_frequencies", commit=True)
        gsm_db.execute("DELETE FROM global_frequency_sources", commit=True)
        gsm_db.execute(
            """
            INSERT INTO global_frequency_sources
            (id, name, version, source_url, is_default, max_rank, entry_count, synced_at)
            VALUES ('jiten-global', 'Jiten Global', 'test-v1', 'https://jiten.moe/other', 1, ?, 1, ?)
            """,
            (rank, time.time()),
            commit=True,
        )
        gsm_db.execute(
            """
            INSERT INTO word_global_frequencies (source_id, word, rank)
            VALUES ('jiten-global', ?, ?)
            """,
            (word, rank),
            commit=True,
        )
        refresh_word_stats_active_global_ranks(gsm_db)

    def test_setup_backfills_existing_occurrences_when_cache_table_is_new(self):
        _insert_line("cache_backfill_1", "本")
        _insert_line("cache_backfill_2", "本")

        word_id = WordsTable.get_or_create("本", "ホン", "名詞")
        WordOccurrencesTable.insert_occurrence(word_id, "cache_backfill_1")
        WordOccurrencesTable.insert_occurrence(word_id, "cache_backfill_2")
        self._seed_global_rank("本", 42)

        drop_tokenisation_trigger(gsm_db)
        gsm_db.execute(f"DROP TABLE IF EXISTS {WORD_STATS_CACHE_TABLE}", commit=True)

        setup_tokenisation(gsm_db)

        row = gsm_db.fetchone(
            f"""
            SELECT occurrence_count, active_global_rank
            FROM {WORD_STATS_CACHE_TABLE}
            WHERE word_id = ?
            """,
            (word_id,),
        )
        assert row == (2, 42)

    def test_occurrence_triggers_keep_cache_counts_and_rank_current(self):
        word_id = WordsTable.get_or_create("語彙", "ゴイ", "名詞")
        self._seed_global_rank("語彙", 15)

        _insert_line("cache_trig_1", "語彙")
        WordOccurrencesTable.insert_occurrence(word_id, "cache_trig_1")
        assert gsm_db.fetchone(
            f"""
            SELECT occurrence_count, active_global_rank
            FROM {WORD_STATS_CACHE_TABLE}
            WHERE word_id = ?
            """,
            (word_id,),
        ) == (1, 15)

        _insert_line("cache_trig_2", "語彙")
        WordOccurrencesTable.insert_occurrence(word_id, "cache_trig_2")
        assert gsm_db.fetchone(
            f"""
            SELECT occurrence_count, active_global_rank
            FROM {WORD_STATS_CACHE_TABLE}
            WHERE word_id = ?
            """,
            (word_id,),
        ) == (2, 15)

        GameLinesTable.delete_line("cache_trig_1")
        assert gsm_db.fetchone(
            f"""
            SELECT occurrence_count, active_global_rank
            FROM {WORD_STATS_CACHE_TABLE}
            WHERE word_id = ?
            """,
            (word_id,),
        ) == (1, 15)

        GameLinesTable.delete_line("cache_trig_2")
        assert (
            gsm_db.fetchone(
                f"SELECT COUNT(*) FROM {WORD_STATS_CACHE_TABLE} WHERE word_id = ?",
                (word_id,),
            )[0]
            == 0
        )


# ---------------------------------------------------------------------------
# mark_tokenised / get_untokenised_lines tests
# ---------------------------------------------------------------------------


class TestGameLinesTokenisedMethods:
    def setup_method(self):
        _ensure_tokenisation_tables()
        _reset_game_lines()

    def test_mark_tokenised(self):
        _insert_line("mt_1", "テスト")
        GameLinesTable.mark_tokenised("mt_1")

        row = gsm_db.fetchone(
            "SELECT tokenised FROM game_lines WHERE id = ?", ("mt_1",)
        )
        assert row[0] == 1

    def test_get_untokenised_lines(self):
        _insert_line("ut_1", "テスト1")
        _insert_line("ut_2", "テスト2")
        _insert_line("ut_3", "テスト3")

        # Mark 1 as tokenised
        gsm_db.execute(
            "UPDATE game_lines SET tokenised = 1 WHERE id = ?", ("ut_1",), commit=True
        )

        untokenised = GameLinesTable.get_untokenised_lines()
        ids = [l.id for l in untokenised]
        assert "ut_1" not in ids
        assert "ut_2" in ids
        assert "ut_3" in ids


# ---------------------------------------------------------------------------
# setup_tokenisation() reset behaviour tests
# ---------------------------------------------------------------------------


class TestSetupTokenisationReset:
    """Verify that setup_tokenisation() only resets tokenised flags on fresh setup."""

    def setup_method(self):
        # Drop trigger FIRST (it references word_occurrences/kanji_occurrences,
        # so deleting game_lines while the trigger exists and tables are gone fails)
        drop_tokenisation_trigger(gsm_db)
        # Drop tokenisation tables so the next setup is "fresh"
        for table in [
            "word_occurrences",
            "kanji_occurrences",
            "words",
            "kanji",
            WORD_STATS_CACHE_TABLE,
        ]:
            gsm_db.execute(f"DROP TABLE IF EXISTS {table}", commit=True)
        _reset_game_lines()

    def test_fresh_setup_resets_tokenised_flags(self):
        """First setup (tables don't exist yet) should reset all tokenised = 0."""
        # Ensure tokenised column exists before inserting lines
        try:
            gsm_db.execute(
                "ALTER TABLE game_lines ADD COLUMN tokenised INTEGER DEFAULT 0",
                commit=True,
            )
        except Exception:
            pass

        # Insert a line and mark it tokenised
        _insert_line("reset_1", "テスト")
        gsm_db.execute(
            "UPDATE game_lines SET tokenised = 1 WHERE id = ?",
            ("reset_1",),
            commit=True,
        )

        # Verify it's marked
        row = gsm_db.fetchone(
            "SELECT tokenised FROM game_lines WHERE id = ?", ("reset_1",)
        )
        assert row[0] == 1

        # Run setup for the first time (tables don't exist yet)
        setup_tokenisation(gsm_db)

        # Should be reset to 0 (fresh setup)
        row = gsm_db.fetchone(
            "SELECT tokenised FROM game_lines WHERE id = ?", ("reset_1",)
        )
        assert row[0] == 0

    def test_repeat_setup_preserves_tokenised_flags(self):
        """Second setup (tables already exist) must NOT reset tokenised flags."""
        # First setup (creates tables)
        setup_tokenisation(gsm_db)

        # Insert a line and mark it tokenised
        _insert_line("reset_2", "テスト")
        gsm_db.execute(
            "UPDATE game_lines SET tokenised = 1 WHERE id = ?",
            ("reset_2",),
            commit=True,
        )

        # Run setup AGAIN (simulates normal app restart)
        setup_tokenisation(gsm_db)

        # tokenised flag must still be 1
        row = gsm_db.fetchone(
            "SELECT tokenised FROM game_lines WHERE id = ?", ("reset_2",)
        )
        assert row[0] == 1

    def test_teardown_then_setup_resets_flags(self):
        """Re-enable after teardown should reset flags (tables were dropped)."""
        # First setup
        setup_tokenisation(gsm_db)

        # Insert a line and mark it tokenised
        _insert_line("reset_3", "テスト")
        gsm_db.execute(
            "UPDATE game_lines SET tokenised = 1 WHERE id = ?",
            ("reset_3",),
            commit=True,
        )

        # Teardown (drops tables)
        teardown_tokenisation(gsm_db)

        # Re-enable
        setup_tokenisation(gsm_db)

        # Should be reset to 0 (tables were dropped, so this is a fresh setup)
        row = gsm_db.fetchone(
            "SELECT tokenised FROM game_lines WHERE id = ?", ("reset_3",)
        )
        assert row[0] == 0


# ---------------------------------------------------------------------------
# Rollup integration tests
# ---------------------------------------------------------------------------


class TestRollupWordFrequency:
    """Test word_frequency_data merge logic in rollup_stats."""

    def test_merge_word_frequency(self):
        from GameSentenceMiner.web.rollup_stats import aggregate_rollup_data

        r1 = SimpleNamespace(
            total_lines=10,
            total_characters=100,
            total_sessions=2,
            total_reading_time_seconds=3600.0,
            total_active_time_seconds=3000.0,
            peak_reading_speed_chars_per_hour=2000.0,
            longest_session_seconds=1800.0,
            shortest_session_seconds=600.0,
            average_session_seconds=900.0,
            average_reading_speed_chars_per_hour=1500.0,
            max_chars_in_session=50,
            max_time_in_session_seconds=1800.0,
            games_completed=0,
            anki_cards_created=0,
            lines_with_screenshots=0,
            lines_with_audio=0,
            lines_with_translations=0,
            games_played_ids="[]",
            game_activity_data="{}",
            kanji_frequency_data='{"漢": 5}',
            hourly_activity_data="{}",
            hourly_reading_speed_data="{}",
            genre_activity_data="{}",
            type_activity_data="{}",
            word_frequency_data='{"食べる": 5, "本": 3}',
            date="2025-01-01",
        )
        r2 = SimpleNamespace(
            total_lines=5,
            total_characters=50,
            total_sessions=1,
            total_reading_time_seconds=1800.0,
            total_active_time_seconds=1500.0,
            peak_reading_speed_chars_per_hour=1800.0,
            longest_session_seconds=1800.0,
            shortest_session_seconds=1800.0,
            average_session_seconds=1800.0,
            average_reading_speed_chars_per_hour=1200.0,
            max_chars_in_session=50,
            max_time_in_session_seconds=1800.0,
            games_completed=0,
            anki_cards_created=0,
            lines_with_screenshots=0,
            lines_with_audio=0,
            lines_with_translations=0,
            games_played_ids="[]",
            game_activity_data="{}",
            kanji_frequency_data='{"漢": 2}',
            hourly_activity_data="{}",
            hourly_reading_speed_data="{}",
            genre_activity_data="{}",
            type_activity_data="{}",
            word_frequency_data='{"食べる": 2, "読む": 1}',
            date="2025-01-02",
        )

        result = aggregate_rollup_data([r1, r2])
        assert result["word_frequency_data"]["食べる"] == 7
        assert result["word_frequency_data"]["本"] == 3
        assert result["word_frequency_data"]["読む"] == 1
        assert result["unique_words_seen"] == 3

    def test_merge_empty_word_frequency(self):
        from GameSentenceMiner.web.rollup_stats import aggregate_rollup_data

        r1 = SimpleNamespace(
            total_lines=0,
            total_characters=0,
            total_sessions=0,
            total_reading_time_seconds=0.0,
            total_active_time_seconds=0.0,
            peak_reading_speed_chars_per_hour=0.0,
            longest_session_seconds=0.0,
            shortest_session_seconds=0.0,
            average_session_seconds=0.0,
            average_reading_speed_chars_per_hour=0.0,
            max_chars_in_session=0,
            max_time_in_session_seconds=0.0,
            games_completed=0,
            anki_cards_created=0,
            lines_with_screenshots=0,
            lines_with_audio=0,
            lines_with_translations=0,
            games_played_ids="[]",
            game_activity_data="{}",
            kanji_frequency_data="{}",
            hourly_activity_data="{}",
            hourly_reading_speed_data="{}",
            genre_activity_data="{}",
            type_activity_data="{}",
            word_frequency_data="{}",
            date="2025-01-01",
        )

        result = aggregate_rollup_data([r1])
        assert result["word_frequency_data"] == {}
        assert result["unique_words_seen"] == 0

    def test_combine_live_and_rollup_word_frequency(self):
        from GameSentenceMiner.web.rollup_stats import combine_rollup_and_live_stats

        rollup = {
            "total_lines": 100,
            "total_characters": 1000,
            "total_sessions": 10,
            "total_reading_time_seconds": 36000.0,
            "total_active_time_seconds": 30000.0,
            "average_reading_speed_chars_per_hour": 1500.0,
            "peak_reading_speed_chars_per_hour": 2000.0,
            "longest_session_seconds": 3600.0,
            "shortest_session_seconds": 600.0,
            "average_session_seconds": 3000.0,
            "max_chars_in_session": 200,
            "max_time_in_session_seconds": 3600.0,
            "games_completed": 0,
            "games_started": 3,
            "anki_cards_created": 5,
            "lines_with_screenshots": 0,
            "lines_with_audio": 0,
            "lines_with_translations": 0,
            "games_played_ids": [],
            "game_activity_data": {},
            "kanji_frequency_data": {},
            "hourly_activity_data": {},
            "hourly_reading_speed_data": {},
            "genre_activity_data": {},
            "type_activity_data": {},
            "unique_kanji_seen": 0,
            "unique_games_played": 0,
            "word_frequency_data": {"食べる": 10},
            "unique_words_seen": 1,
        }
        live = {
            "total_lines": 5,
            "total_characters": 50,
            "total_sessions": 1,
            "total_reading_time_seconds": 1800.0,
            "total_active_time_seconds": 1500.0,
            "average_reading_speed_chars_per_hour": 1200.0,
            "peak_reading_speed_chars_per_hour": 1200.0,
            "longest_session_seconds": 1800.0,
            "shortest_session_seconds": 1800.0,
            "average_session_seconds": 1800.0,
            "max_chars_in_session": 50,
            "max_time_in_session_seconds": 1800.0,
            "games_completed": 0,
            "games_started": 1,
            "anki_cards_created": 1,
            "lines_with_screenshots": 0,
            "lines_with_audio": 0,
            "lines_with_translations": 0,
            "games_played_ids": [],
            "game_activity_data": {},
            "kanji_frequency_data": {},
            "hourly_activity_data": {},
            "hourly_reading_speed_data": {},
            "genre_activity_data": {},
            "type_activity_data": {},
            "unique_kanji_seen": 0,
            "unique_games_played": 0,
            "word_frequency_data": {"食べる": 3, "新しい": 1},
            "unique_words_seen": 2,
        }

        result = combine_rollup_and_live_stats(rollup, live)
        assert result["word_frequency_data"]["食べる"] == 13
        assert result["word_frequency_data"]["新しい"] == 1
        assert result["unique_words_seen"] == 2


# ---------------------------------------------------------------------------
# setup_tokenisation last_seen column & update_last_seen tests
# ---------------------------------------------------------------------------


class TestLastSeenColumn:
    """Verify setup_tokenisation creates the last_seen column and update_last_seen works correctly."""

    def setup_method(self):
        _ensure_tokenisation_tables()

    def test_setup_creates_last_seen_column(self):
        """After setup_tokenisation, the words table should have a last_seen column."""
        columns = [col[1] for col in gsm_db.fetchall("PRAGMA table_info(words)")]
        assert "last_seen" in columns

    def test_setup_last_seen_defaults_to_null(self):
        """New words should have last_seen = NULL by default."""
        word_id = WordsTable.get_or_create("テスト語", "テストゴ", "名詞")
        row = gsm_db.fetchone("SELECT last_seen FROM words WHERE id = ?", (word_id,))
        assert row[0] is None

    def test_setup_idempotent(self):
        """Calling setup_tokenisation twice should not error."""
        # First call already happened in _ensure_tokenisation_tables.
        # Call it again explicitly — should not raise.
        setup_tokenisation(gsm_db)

        columns = [col[1] for col in gsm_db.fetchall("PRAGMA table_info(words)")]
        assert "last_seen" in columns

    def test_update_last_seen_sets_value(self):
        """update_last_seen should set last_seen on a word that had NULL."""
        word_id = WordsTable.get_or_create("設定", "セッテイ", "名詞")
        WordsTable.update_last_seen(word_id, 1700000000.0)

        word = WordsTable.get_by_word("設定")
        assert word.last_seen == 1700000000.0

    def test_update_last_seen_newer_overwrites(self):
        """A newer timestamp should overwrite an older last_seen."""
        word_id = WordsTable.get_or_create("更新", "コウシン", "名詞")
        WordsTable.update_last_seen(word_id, 1700000000.0)
        WordsTable.update_last_seen(word_id, 1700099999.0)

        word = WordsTable.get_by_word("更新")
        assert word.last_seen == 1700099999.0

    def test_update_last_seen_preserves_newer_existing(self):
        """An older timestamp should NOT overwrite a newer existing last_seen."""
        word_id = WordsTable.get_or_create("保持", "ホジ", "名詞")
        WordsTable.update_last_seen(word_id, 1700099999.0)
        WordsTable.update_last_seen(word_id, 1700000000.0)  # older

        word = WordsTable.get_by_word("保持")
        assert word.last_seen == 1700099999.0


class TestFirstSeenMetadata:
    """Verify setup and maintenance for word first-seen metadata."""

    def setup_method(self):
        _ensure_tokenisation_tables()
        _reset_game_lines()

    def test_setup_creates_first_seen_columns(self):
        columns = [col[1] for col in gsm_db.fetchall("PRAGMA table_info(words)")]
        assert "first_seen" in columns
        assert "first_seen_line_id" in columns

    def test_set_first_seen_if_missing_only_sets_once(self):
        word_id = WordsTable.get_or_create("初見", "ショケン", "名詞")
        WordsTable.set_first_seen_if_missing(word_id, 1700000000.0, "line_a")
        WordsTable.set_first_seen_if_missing(word_id, 1700100000.0, "line_b")

        row = gsm_db.fetchone(
            "SELECT first_seen, first_seen_line_id FROM words WHERE id = ?",
            (word_id,),
        )
        assert float(row[0]) == 1700000000.0
        assert row[1] == "line_a"

    def test_recompute_first_seen_prefers_smallest_line_id_when_timestamps_tie(self):
        timestamp = 1700000000.0
        _insert_line("tie_b", "猫", timestamp=timestamp)
        _insert_line("tie_a", "猫", timestamp=timestamp)

        word_id = WordsTable.get_or_create("猫", "ネコ", "名詞")
        WordOccurrencesTable.insert_occurrence(word_id, "tie_b")
        WordOccurrencesTable.insert_occurrence(word_id, "tie_a")

        updated = recompute_word_first_seen_metadata(gsm_db, [word_id])
        word = WordsTable.get_by_word("猫")

        assert updated == 1
        assert word is not None
        assert word.first_seen == timestamp
        assert word.first_seen_line_id == "tie_a"


class TestTokeniseLineFirstSeen:
    """Verify tokenise_line sets and preserves first-seen metadata."""

    def setup_method(self):
        _ensure_tokenisation_tables()
        _reset_game_lines()

    def test_tokenise_line_sets_first_seen_for_new_words(self, monkeypatch):
        text = "犬"
        tokens = [_tok("犬", "犬", "イヌ", PartOfSpeech.noun)]
        _make_mock_mecab(monkeypatch, {text: tokens})

        timestamp = 1700000000.0
        _insert_line("fs_1", text, timestamp=timestamp)
        tokenise_line("fs_1", text, line_timestamp=timestamp)

        word = WordsTable.get_by_word("犬")
        assert word is not None
        assert word.first_seen == timestamp
        assert word.first_seen_line_id == "fs_1"

    def test_tokenise_line_preserves_existing_first_seen(self, monkeypatch):
        text = "犬"
        tokens = [_tok("犬", "犬", "イヌ", PartOfSpeech.noun)]
        _make_mock_mecab(monkeypatch, {text: tokens})

        first_timestamp = 1700000000.0
        second_timestamp = 1700100000.0
        _insert_line("fs_2a", text, timestamp=first_timestamp)
        tokenise_line("fs_2a", text, line_timestamp=first_timestamp)

        _insert_line("fs_2b", text, timestamp=second_timestamp)
        tokenise_line("fs_2b", text, line_timestamp=second_timestamp)

        word = WordsTable.get_by_word("犬")
        assert word is not None
        assert word.first_seen == first_timestamp
        assert word.first_seen_line_id == "fs_2a"


# ---------------------------------------------------------------------------
# tokenise_line last_seen integration tests (Task 2.3)
# ---------------------------------------------------------------------------


class TestTokeniseLineLastSeen:
    """Verify tokenise_line updates last_seen for words when line_timestamp is provided."""

    def setup_method(self):
        _ensure_tokenisation_tables()
        _reset_game_lines()

    def test_tokenise_line_updates_last_seen_for_all_words(self, monkeypatch):
        """Tokenising a line with a timestamp should set last_seen on every extracted word."""
        text = "彼女は本を読んだ。"
        tokens = [
            _tok("彼女", "彼女", "カノジョ", PartOfSpeech.noun),
            _tok("は", "は", None, PartOfSpeech.particle),
            _tok("本", "本", "ホン", PartOfSpeech.noun),
            _tok("を", "を", None, PartOfSpeech.particle),
            _tok("読ん", "読む", "ヨン", PartOfSpeech.verb),
            _tok("だ", "だ", None, PartOfSpeech.bound_auxiliary),
            _tok("。", "。", None, PartOfSpeech.symbol),  # filtered out
        ]
        _make_mock_mecab(monkeypatch, {text: tokens})

        ts = 1700000000.0
        _insert_line("ls_1", text, timestamp=ts)
        tokenise_line("ls_1", text, line_timestamp=ts)

        # Every non-symbol headword should have last_seen == ts
        for headword in ["彼女", "は", "本", "を", "読む", "だ"]:
            word = WordsTable.get_by_word(headword)
            assert word is not None, f"Word '{headword}' not found"
            assert word.last_seen == ts, (
                f"Expected last_seen={ts} for '{headword}', got {word.last_seen}"
            )

    def test_tokenise_line_without_timestamp_leaves_last_seen_null(self, monkeypatch):
        """Tokenising without line_timestamp should not set last_seen."""
        text = "テスト"
        tokens = [_tok("テスト", "テスト", "テスト", PartOfSpeech.noun)]
        _make_mock_mecab(monkeypatch, {text: tokens})

        _insert_line("ls_2", text)
        tokenise_line("ls_2", text)  # no line_timestamp

        word = WordsTable.get_by_word("テスト")
        assert word is not None
        assert word.last_seen is None

    def test_tokenise_line_newer_timestamp_overwrites(self, monkeypatch):
        """A second line with a newer timestamp should update last_seen."""
        text = "テスト"
        tokens = [_tok("テスト", "テスト", "テスト", PartOfSpeech.noun)]
        _make_mock_mecab(monkeypatch, {text: tokens})

        _insert_line("ls_3a", text, timestamp=1700000000.0)
        tokenise_line("ls_3a", text, line_timestamp=1700000000.0)

        _insert_line("ls_3b", text, timestamp=1700099999.0)
        # Reset tokenised flag so we can re-tokenise with the same word
        gsm_db.execute(
            "UPDATE game_lines SET tokenised = 0 WHERE id = ?", ("ls_3b",), commit=True
        )
        tokenise_line("ls_3b", text, line_timestamp=1700099999.0)

        word = WordsTable.get_by_word("テスト")
        assert word.last_seen == 1700099999.0

    def test_tokenise_line_older_timestamp_preserves_newer(self, monkeypatch):
        """An older line timestamp should NOT overwrite a newer last_seen."""
        text = "テスト"
        tokens = [_tok("テスト", "テスト", "テスト", PartOfSpeech.noun)]
        _make_mock_mecab(monkeypatch, {text: tokens})

        # Tokenise with newer timestamp first
        _insert_line("ls_4a", text, timestamp=1700099999.0)
        tokenise_line("ls_4a", text, line_timestamp=1700099999.0)

        # Then tokenise with older timestamp
        _insert_line("ls_4b", text, timestamp=1700000000.0)
        tokenise_line("ls_4b", text, line_timestamp=1700000000.0)

        word = WordsTable.get_by_word("テスト")
        assert word.last_seen == 1700099999.0

    def test_backfill_multiple_lines_max_timestamp(self, monkeypatch):
        """Backfill processing multiple lines should leave last_seen = max(timestamps)."""
        text = "食べる"
        tokens = [_tok("食べる", "食べる", "タベル", PartOfSpeech.verb)]
        _make_mock_mecab(monkeypatch, {text: tokens})

        monkeypatch.setattr(
            "GameSentenceMiner.util.cron.tokenise_lines.is_tokenisation_enabled",
            lambda: True,
        )
        monkeypatch.setattr(
            "GameSentenceMiner.util.cron.tokenise_lines.is_tokenisation_low_performance",
            lambda: False,
        )

        timestamps = [1700000100.0, 1700000300.0, 1700000200.0]
        for i, ts in enumerate(timestamps):
            _insert_line(f"bf_ls_{i}", text, timestamp=ts)

        result = run_tokenise_backfill()
        assert result["processed"] == 3

        word = WordsTable.get_by_word("食べる")
        assert word is not None
        assert word.last_seen == max(timestamps)

    def test_backfill_different_words_get_own_last_seen(self, monkeypatch):
        """Each word should track its own last_seen independently during backfill."""
        text_a = "犬"
        text_b = "猫"
        tokens_a = [_tok("犬", "犬", "イヌ", PartOfSpeech.noun)]
        tokens_b = [_tok("猫", "猫", "ネコ", PartOfSpeech.noun)]
        _make_mock_mecab(monkeypatch, {text_a: tokens_a, text_b: tokens_b})

        monkeypatch.setattr(
            "GameSentenceMiner.util.cron.tokenise_lines.is_tokenisation_enabled",
            lambda: True,
        )
        monkeypatch.setattr(
            "GameSentenceMiner.util.cron.tokenise_lines.is_tokenisation_low_performance",
            lambda: False,
        )

        _insert_line("bf_ls_a", text_a, timestamp=1700000100.0)
        _insert_line("bf_ls_b", text_b, timestamp=1700000200.0)

        run_tokenise_backfill()

        dog = WordsTable.get_by_word("犬")
        cat = WordsTable.get_by_word("猫")
        assert dog.last_seen == 1700000100.0
        assert cat.last_seen == 1700000200.0


class TestCreateTokenisationIndexes:
    """Verify that create_tokenisation_indexes creates the expected indexes."""

    def setup_method(self):
        _ensure_tokenisation_tables()

    def test_idx_words_in_anki_exists(self):
        """idx_words_in_anki index must exist on the words table after setup."""
        indexes = gsm_db.fetchall("PRAGMA index_list('words')")
        index_names = [row[1] for row in indexes]
        assert "idx_words_in_anki" in index_names

    def test_idx_words_in_anki_covers_in_anki_column(self):
        """idx_words_in_anki must be on the in_anki column."""
        columns = gsm_db.fetchall("PRAGMA index_info('idx_words_in_anki')")
        col_names = [row[2] for row in columns]
        assert col_names == ["in_anki"]

    def test_first_seen_indexes_exist(self):
        indexes = gsm_db.fetchall("PRAGMA index_list('words')")
        index_names = [row[1] for row in indexes]
        assert "idx_words_first_seen" in index_names
        assert "idx_words_first_seen_line_id" in index_names
