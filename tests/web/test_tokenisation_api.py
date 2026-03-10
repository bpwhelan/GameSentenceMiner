"""
Tests for the tokenisation API endpoints.

Covers:
- /api/tokenisation/status
- /api/tokenisation/words
- /api/tokenisation/kanji
- /api/tokenisation/search
- /api/tokenisation/word/<word>
- /api/tokenisation/words/by-game
- Config guard (404 when disabled)
- POS filtering and shorthands
- Pagination
"""

from __future__ import annotations

import json
import time
from unittest.mock import MagicMock, patch

import flask
import pytest

from GameSentenceMiner.mecab.basic_types import (
    MecabParsedToken,
    PartOfSpeech,
    Inflection,
)
from GameSentenceMiner.util.database.db import GameLinesTable, gsm_db
from GameSentenceMiner.util.database.tokenisation_tables import (
    WordsTable,
    KanjiTable,
    WordOccurrencesTable,
    KanjiOccurrencesTable,
    create_tokenisation_indexes,
)
from GameSentenceMiner.web.tokenisation_api import (
    register_tokenisation_api_routes,
    _expand_pos_shorthand,
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

    create_tokenisation_indexes(gsm_db)

    try:
        gsm_db.execute(
            "ALTER TABLE game_lines ADD COLUMN tokenised INTEGER DEFAULT 0",
            commit=True,
        )
    except Exception:
        pass

    for table in ["word_occurrences", "kanji_occurrences", "words", "kanji"]:
        gsm_db.execute(f"DELETE FROM {table}", commit=True)


def _reset_game_lines():
    """Clear game_lines and sync table (tolerates missing tables)."""
    try:
        GameLinesTable._db.execute(f"DELETE FROM {GameLinesTable._table}", commit=True)
    except Exception:
        pass
    try:
        GameLinesTable._db.execute(
            f"DELETE FROM {GameLinesTable._sync_changes_table}", commit=True
        )
    except Exception:
        pass


def _insert_line(
    line_id: str, text: str, game_name: str = "TestGame", timestamp: float | None = None
):
    """Insert a game line directly."""
    ts = timestamp or time.time()
    line = GameLinesTable(
        id=line_id,
        line_text=text,
        game_name=game_name,
        game_id="test-game-id",
        timestamp=ts,
    )
    line.add()
    # Reset tokenised to 0
    gsm_db.execute(
        "UPDATE game_lines SET tokenised = 0 WHERE id = ?",
        (line_id,),
        commit=True,
    )
    return line


def _insert_word(word: str, reading: str = "", pos: str = "名詞") -> int:
    """Insert a word and return its id."""
    return WordsTable.get_or_create(word, reading, pos)


def _insert_kanji(char: str) -> int:
    """Insert a kanji and return its id."""
    return KanjiTable.get_or_create(char)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _setup_tokenisation_tables():
    """Set up tokenisation tables and clean state for each test."""
    _ensure_tokenisation_tables()
    _reset_game_lines()
    yield
    # Clean up after test
    for table in ["word_occurrences", "kanji_occurrences", "words", "kanji"]:
        gsm_db.execute(f"DELETE FROM {table}", commit=True)
    _reset_game_lines()


@pytest.fixture
def app():
    """Create a Flask app with tokenisation routes registered."""
    test_app = flask.Flask(__name__)
    test_app.config["TESTING"] = True
    register_tokenisation_api_routes(test_app)
    return test_app


@pytest.fixture
def client(app):
    """Flask test client."""
    return app.test_client()


@pytest.fixture
def enabled_config():
    """Patch is_tokenisation_enabled to return True."""
    with patch(
        "GameSentenceMiner.web.tokenisation_api.is_tokenisation_enabled",
        return_value=True,
    ):
        yield


@pytest.fixture
def disabled_config():
    """Patch is_tokenisation_enabled to return False."""
    with patch(
        "GameSentenceMiner.web.tokenisation_api.is_tokenisation_enabled",
        return_value=False,
    ):
        yield


# ---------------------------------------------------------------------------
# Helper function tests
# ---------------------------------------------------------------------------


class TestExpandPosShorthand:
    def test_content_shorthand(self):
        result = _expand_pos_shorthand("content")
        assert result == ["名詞", "動詞", "形容詞", "副詞"]

    def test_particles_shorthand(self):
        result = _expand_pos_shorthand("particles")
        assert result == ["助詞", "助動詞"]

    def test_raw_pos_value(self):
        result = _expand_pos_shorthand("名詞")
        assert result == ["名詞"]

    def test_mixed(self):
        result = _expand_pos_shorthand("content,接続詞")
        assert result == ["名詞", "動詞", "形容詞", "副詞", "接続詞"]

    def test_empty_string(self):
        result = _expand_pos_shorthand("")
        assert result == []

    def test_case_insensitive_shorthand(self):
        result = _expand_pos_shorthand("Content")
        assert result == ["名詞", "動詞", "形容詞", "副詞"]


# ---------------------------------------------------------------------------
# /api/tokenisation/status
# ---------------------------------------------------------------------------


class TestStatusEndpoint:
    def test_status_when_disabled(self, client, disabled_config):
        resp = client.get("/api/tokenisation/status")
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["enabled"] is False
        assert data["total_lines"] == 0

    def test_status_when_enabled_empty(self, client, enabled_config):
        resp = client.get("/api/tokenisation/status")
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["enabled"] is True
        assert data["total_lines"] == 0
        assert data["tokenised_lines"] == 0
        assert data["percent_complete"] == 0
        assert data["total_words"] == 0
        assert data["total_kanji"] == 0

    def test_status_with_data(self, client, enabled_config):
        _insert_line("line-1", "テスト")
        _insert_line("line-2", "データ")

        # Mark one as tokenised
        gsm_db.execute(
            "UPDATE game_lines SET tokenised = 1 WHERE id = 'line-1'",
            commit=True,
        )

        # Insert some words and kanji
        _insert_word("テスト")
        _insert_word("データ")
        _insert_kanji("漢")

        resp = client.get("/api/tokenisation/status")
        data = resp.get_json()
        assert data["total_lines"] == 2
        assert data["tokenised_lines"] == 1
        assert data["untokenised_lines"] == 1
        assert data["percent_complete"] == 50.0
        assert data["total_words"] == 2
        assert data["total_kanji"] == 1


# ---------------------------------------------------------------------------
# /api/tokenisation/words
# ---------------------------------------------------------------------------


class TestWordsEndpoint:
    def test_words_disabled(self, client, disabled_config):
        resp = client.get("/api/tokenisation/words")
        assert resp.status_code == 404

    def test_words_empty(self, client, enabled_config):
        resp = client.get("/api/tokenisation/words")
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["words"] == []
        assert data["total"] == 0

    def test_words_basic(self, client, enabled_config):
        line = _insert_line("line-1", "本を読む")

        word_id_hon = _insert_word("本", "ホン", "名詞")
        word_id_yomu = _insert_word("読む", "ヨム", "動詞")
        word_id_wo = _insert_word("を", "", "助詞")

        WordOccurrencesTable.insert_occurrence(word_id_hon, "line-1")
        WordOccurrencesTable.insert_occurrence(word_id_yomu, "line-1")
        WordOccurrencesTable.insert_occurrence(word_id_wo, "line-1")

        resp = client.get("/api/tokenisation/words")
        data = resp.get_json()
        assert data["total"] == 3
        assert len(data["words"]) == 3
        # All should have frequency 1
        for w in data["words"]:
            assert w["frequency"] == 1

    def test_words_frequency_ordering(self, client, enabled_config):
        _insert_line("line-1", "本を読む")
        _insert_line("line-2", "本を買う")
        _insert_line("line-3", "本")

        word_id_hon = _insert_word("本", "ホン", "名詞")
        word_id_yomu = _insert_word("読む", "ヨム", "動詞")
        word_id_kau = _insert_word("買う", "カウ", "動詞")
        word_id_wo = _insert_word("を", "", "助詞")

        # 本 appears in 3 lines
        for lid in ["line-1", "line-2", "line-3"]:
            WordOccurrencesTable.insert_occurrence(word_id_hon, lid)
        # を appears in 2 lines
        for lid in ["line-1", "line-2"]:
            WordOccurrencesTable.insert_occurrence(word_id_wo, lid)
        # 読む appears in 1
        WordOccurrencesTable.insert_occurrence(word_id_yomu, "line-1")
        # 買う appears in 1
        WordOccurrencesTable.insert_occurrence(word_id_kau, "line-2")

        resp = client.get("/api/tokenisation/words")
        data = resp.get_json()
        words = data["words"]
        assert words[0]["word"] == "本"
        assert words[0]["frequency"] == 3
        assert words[1]["word"] == "を"
        assert words[1]["frequency"] == 2

    def test_words_pagination(self, client, enabled_config):
        _insert_line("line-1", "text")
        # Insert 5 words
        for i in range(5):
            wid = _insert_word(f"word{i}", "", "名詞")
            WordOccurrencesTable.insert_occurrence(wid, "line-1")

        resp = client.get("/api/tokenisation/words?limit=2&offset=0")
        data = resp.get_json()
        assert len(data["words"]) == 2
        assert data["total"] == 5
        assert data["limit"] == 2
        assert data["offset"] == 0

        resp2 = client.get("/api/tokenisation/words?limit=2&offset=2")
        data2 = resp2.get_json()
        assert len(data2["words"]) == 2
        assert data2["offset"] == 2

    def test_words_pos_filter_content(self, client, enabled_config):
        _insert_line("line-1", "text")

        wid_noun = _insert_word("本", "", "名詞")
        wid_verb = _insert_word("読む", "", "動詞")
        wid_particle = _insert_word("を", "", "助詞")

        for wid in [wid_noun, wid_verb, wid_particle]:
            WordOccurrencesTable.insert_occurrence(wid, "line-1")

        resp = client.get("/api/tokenisation/words?pos=content")
        data = resp.get_json()
        # "content" = 名詞, 動詞, 形容詞, 副詞 → should match 本, 読む
        assert data["total"] == 2
        returned_words = {w["word"] for w in data["words"]}
        assert returned_words == {"本", "読む"}

    def test_words_exclude_pos_particles(self, client, enabled_config):
        _insert_line("line-1", "text")

        wid_noun = _insert_word("本", "", "名詞")
        wid_particle = _insert_word("を", "", "助詞")
        wid_auxiliary = _insert_word("です", "", "助動詞")

        for wid in [wid_noun, wid_particle, wid_auxiliary]:
            WordOccurrencesTable.insert_occurrence(wid, "line-1")

        resp = client.get("/api/tokenisation/words?exclude_pos=particles")
        data = resp.get_json()
        assert data["total"] == 1
        assert data["words"][0]["word"] == "本"

    def test_words_search_filter(self, client, enabled_config):
        _insert_line("line-1", "text")

        wid1 = _insert_word("食べる", "タベル", "動詞")
        wid2 = _insert_word("本", "ホン", "名詞")
        wid3 = _insert_word("食事", "ショクジ", "名詞")

        for wid in [wid1, wid2, wid3]:
            WordOccurrencesTable.insert_occurrence(wid, "line-1")

        resp = client.get("/api/tokenisation/words?search=食")
        data = resp.get_json()
        assert data["total"] == 2
        returned_words = {w["word"] for w in data["words"]}
        assert returned_words == {"食べる", "食事"}

    def test_words_excludes_symbols(self, client, enabled_config):
        """Words with POS 記号 or その他 are always excluded."""
        _insert_line("line-1", "text")

        wid_noun = _insert_word("本", "", "名詞")
        wid_symbol = _insert_word("。", "", "記号")
        wid_other = _insert_word("ァ", "", "その他")

        for wid in [wid_noun, wid_symbol, wid_other]:
            WordOccurrencesTable.insert_occurrence(wid, "line-1")

        resp = client.get("/api/tokenisation/words")
        data = resp.get_json()
        assert data["total"] == 1
        assert data["words"][0]["word"] == "本"

    def test_words_limit_capped_at_500(self, client, enabled_config):
        resp = client.get("/api/tokenisation/words?limit=1000")
        data = resp.get_json()
        assert data["limit"] == 500


# ---------------------------------------------------------------------------
# /api/tokenisation/kanji
# ---------------------------------------------------------------------------


class TestKanjiEndpoint:
    def test_kanji_disabled(self, client, disabled_config):
        resp = client.get("/api/tokenisation/kanji")
        assert resp.status_code == 404

    def test_kanji_empty(self, client, enabled_config):
        resp = client.get("/api/tokenisation/kanji")
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["kanji"] == []
        assert data["total"] == 0

    def test_kanji_basic(self, client, enabled_config):
        _insert_line("line-1", "漢字")
        _insert_line("line-2", "漢文")

        kid_kan = _insert_kanji("漢")
        kid_ji = _insert_kanji("字")
        kid_bun = _insert_kanji("文")

        KanjiOccurrencesTable.insert_occurrence(kid_kan, "line-1")
        KanjiOccurrencesTable.insert_occurrence(kid_ji, "line-1")
        KanjiOccurrencesTable.insert_occurrence(kid_kan, "line-2")
        KanjiOccurrencesTable.insert_occurrence(kid_bun, "line-2")

        resp = client.get("/api/tokenisation/kanji")
        data = resp.get_json()
        assert data["total"] == 3
        # 漢 appears in 2 lines, should be first
        assert data["kanji"][0]["character"] == "漢"
        assert data["kanji"][0]["frequency"] == 2

    def test_kanji_pagination(self, client, enabled_config):
        _insert_line("line-1", "text")
        for char in ["漢", "字", "文", "本", "読"]:
            kid = _insert_kanji(char)
            KanjiOccurrencesTable.insert_occurrence(kid, "line-1")

        resp = client.get("/api/tokenisation/kanji?limit=2&offset=0")
        data = resp.get_json()
        assert len(data["kanji"]) == 2
        assert data["total"] == 5


# ---------------------------------------------------------------------------
# /api/tokenisation/search
# ---------------------------------------------------------------------------


class TestSearchEndpoint:
    def test_search_disabled(self, client, disabled_config):
        resp = client.get("/api/tokenisation/search?q=本")
        assert resp.status_code == 404

    def test_search_missing_query(self, client, enabled_config):
        resp = client.get("/api/tokenisation/search")
        assert resp.status_code == 400
        data = resp.get_json()
        assert "error" in data

    def test_search_empty_query(self, client, enabled_config):
        resp = client.get("/api/tokenisation/search?q=")
        assert resp.status_code == 400

    def test_search_word_not_found(self, client, enabled_config):
        resp = client.get("/api/tokenisation/search?q=存在しない")
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["total"] == 0
        assert data["lines"] == []

    def test_search_finds_lines(self, client, enabled_config):
        _insert_line("line-1", "本を読む", game_name="Game1")
        _insert_line("line-2", "本を買う", game_name="Game2")
        _insert_line("line-3", "映画を見る", game_name="Game1")

        word_id_hon = _insert_word("本", "ホン", "名詞")
        word_id_yomu = _insert_word("読む", "ヨム", "動詞")

        WordOccurrencesTable.insert_occurrence(word_id_hon, "line-1")
        WordOccurrencesTable.insert_occurrence(word_id_hon, "line-2")
        WordOccurrencesTable.insert_occurrence(word_id_yomu, "line-1")

        resp = client.get("/api/tokenisation/search?q=本")
        data = resp.get_json()
        assert data["total"] == 2
        assert len(data["lines"]) == 2
        assert data["word"]["word"] == "本"
        assert data["word"]["reading"] == "ホン"

        # Lines should have expected fields
        for line in data["lines"]:
            assert "id" in line
            assert "text" in line
            assert "timestamp" in line
            assert "game_name" in line

    def test_search_pagination(self, client, enabled_config):
        for i in range(5):
            _insert_line(f"line-{i}", f"本テキスト{i}")

        word_id = _insert_word("本", "ホン", "名詞")
        for i in range(5):
            WordOccurrencesTable.insert_occurrence(word_id, f"line-{i}")

        resp = client.get("/api/tokenisation/search?q=本&limit=2&offset=0")
        data = resp.get_json()
        assert data["total"] == 5
        assert len(data["lines"]) == 2


# ---------------------------------------------------------------------------
# /api/tokenisation/word/<word>
# ---------------------------------------------------------------------------


class TestWordDetailEndpoint:
    def test_detail_disabled(self, client, disabled_config):
        resp = client.get("/api/tokenisation/word/本")
        assert resp.status_code == 404

    def test_detail_not_found(self, client, enabled_config):
        resp = client.get("/api/tokenisation/word/存在しない")
        assert resp.status_code == 404
        data = resp.get_json()
        assert "error" in data

    def test_detail_basic(self, client, enabled_config):
        _insert_line("line-1", "本", game_name="Game1")
        _insert_line("line-2", "本", game_name="Game1")
        _insert_line("line-3", "本", game_name="Game2")

        word_id = _insert_word("本", "ホン", "名詞")
        for lid in ["line-1", "line-2", "line-3"]:
            WordOccurrencesTable.insert_occurrence(word_id, lid)

        resp = client.get("/api/tokenisation/word/本")
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["word"] == "本"
        assert data["reading"] == "ホン"
        assert data["pos"] == "名詞"
        assert data["total_occurrences"] == 3
        assert len(data["games"]) == 2

        # Game1 has 2 occurrences, Game2 has 1
        games_by_name = {g["game_name"]: g["frequency"] for g in data["games"]}
        assert games_by_name["Game1"] == 2
        assert games_by_name["Game2"] == 1


# ---------------------------------------------------------------------------
# /api/tokenisation/words/by-game
# ---------------------------------------------------------------------------


class TestWordsByGameEndpoint:
    def test_by_game_disabled(self, client, disabled_config):
        resp = client.get("/api/tokenisation/words/by-game")
        assert resp.status_code == 404

    def test_by_game_empty(self, client, enabled_config):
        resp = client.get("/api/tokenisation/words/by-game")
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["games"] == []

    def test_by_game_basic(self, client, enabled_config):
        _insert_line("line-1", "本を読む", game_name="Game1")
        _insert_line("line-2", "映画を見る", game_name="Game2")

        wid1 = _insert_word("本", "ホン", "名詞")
        wid2 = _insert_word("読む", "ヨム", "動詞")
        wid3 = _insert_word("映画", "エイガ", "名詞")

        WordOccurrencesTable.insert_occurrence(wid1, "line-1")
        WordOccurrencesTable.insert_occurrence(wid2, "line-1")
        WordOccurrencesTable.insert_occurrence(wid3, "line-2")

        resp = client.get("/api/tokenisation/words/by-game")
        data = resp.get_json()
        assert len(data["games"]) == 2

        games_by_name = {g["game_name"]: g["unique_words"] for g in data["games"]}
        assert games_by_name["Game1"] == 2
        assert games_by_name["Game2"] == 1

    def test_by_game_excludes_symbols(self, client, enabled_config):
        """Symbols and その他 should not count toward unique words."""
        _insert_line("line-1", "本。", game_name="Game1")

        wid_noun = _insert_word("本", "", "名詞")
        wid_symbol = _insert_word("。", "", "記号")

        WordOccurrencesTable.insert_occurrence(wid_noun, "line-1")
        WordOccurrencesTable.insert_occurrence(wid_symbol, "line-1")

        resp = client.get("/api/tokenisation/words/by-game")
        data = resp.get_json()
        assert data["games"][0]["unique_words"] == 1
