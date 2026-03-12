"""
Tests for the tokenisation API endpoints.

Covers:
- /api/tokenisation/status
- /api/tokenisation/words
- /api/tokenisation/words/not-in-anki
- /api/tokenisation/words/card-data
- /api/tokenisation/kanji
- /api/tokenisation/search
- /api/tokenisation/word/<word>
- /api/tokenisation/words/by-game
- Config guard (404 when disabled)
- POS filtering and shorthands
- Pagination
"""

from __future__ import annotations

import datetime
import time
from unittest.mock import patch

import flask
import pytest

from GameSentenceMiner.mecab.basic_types import (
    MecabParsedToken,
    PartOfSpeech,
    Inflection,
)
from GameSentenceMiner.util.database.anki_tables import (
    AnkiCardsTable,
    AnkiReviewsTable,
    CardKanjiLinksTable,
    WordAnkiLinksTable,
    setup_anki_tables,
)
from GameSentenceMiner.util.database.db import GameLinesTable, gsm_db
from GameSentenceMiner.util.database.tokenisation_tables import (
    WordsTable,
    KanjiTable,
    WordOccurrencesTable,
    KanjiOccurrencesTable,
    create_tokenisation_indexes,
    create_tokenisation_trigger,
    refresh_word_stats_active_global_ranks,
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
    setup_anki_tables(gsm_db)
    create_tokenisation_trigger(gsm_db)

    try:
        gsm_db.execute(
            "ALTER TABLE game_lines ADD COLUMN tokenised INTEGER DEFAULT 0",
            commit=True,
        )
    except Exception:
        pass

    for table in [
        "word_global_frequencies",
        "global_frequency_sources",
        "word_occurrences",
        "kanji_occurrences",
        "words",
        "kanji",
        "word_stats_cache",
        "anki_notes",
        "anki_cards",
        "anki_reviews",
        "word_anki_links",
        "card_kanji_links",
    ]:
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


def _link_word_to_card(
    word_id: int,
    note_id: int,
    card_id: int,
    *,
    deck_name: str = "Deck",
    interval: int = 0,
    due: int = 0,
):
    """Insert cached Anki card metadata and link it to a tokenised word."""
    card = AnkiCardsTable(
        card_id=card_id,
        note_id=note_id,
        deck_name=deck_name,
        queue=0,
        type=0,
        due=due,
        interval=interval,
        factor=0,
        reps=0,
        lapses=0,
        synced_at=time.time(),
    )
    card.add()
    WordAnkiLinksTable.link(word_id, note_id)


def _insert_anki_review(
    *,
    card_id: int,
    note_id: int,
    review_time_ms: int,
    interval: int,
    last_interval: int,
):
    """Insert a cached Anki review row."""
    review = AnkiReviewsTable(
        review_id=f"{card_id}_{review_time_ms}",
        card_id=card_id,
        note_id=note_id,
        review_time=review_time_ms,
        ease=3,
        interval=interval,
        last_interval=last_interval,
        time_taken=0,
        synced_at=time.time(),
    )
    review.add()


def _link_kanji_to_card(
    kanji_id: int,
    note_id: int,
    card_id: int,
    *,
    deck_name: str = "Deck",
    interval: int = 0,
    due: int = 0,
):
    """Insert cached card metadata and link it to a kanji."""
    card = AnkiCardsTable(
        card_id=card_id,
        note_id=note_id,
        deck_name=deck_name,
        queue=0,
        type=0,
        due=due,
        interval=interval,
        factor=0,
        reps=0,
        lapses=0,
        synced_at=time.time(),
    )
    card.add()
    CardKanjiLinksTable.link(card_id, kanji_id)


def _review_time_ms(target_date: datetime.date) -> int:
    """Return a stable midday local timestamp in milliseconds for the given date."""
    return int(
        datetime.datetime.combine(target_date, datetime.time(hour=12)).timestamp()
        * 1000
    )


def _seed_global_frequency_source(
    entries: list[tuple[str, int]],
    *,
    source_id: str = "jiten-global",
    name: str = "Jiten Global",
    version: str = "test-v1",
    source_url: str = "https://jiten.moe/other",
) -> None:
    """Insert a default global-frequency source and its word ranks."""
    gsm_db.execute("DELETE FROM word_global_frequencies", commit=True)
    gsm_db.execute("DELETE FROM global_frequency_sources", commit=True)
    gsm_db.execute(
        """
        INSERT INTO global_frequency_sources
        (id, name, version, source_url, is_default, max_rank, entry_count, synced_at)
        VALUES (?, ?, ?, ?, 1, ?, ?, ?)
        """,
        (
            source_id,
            name,
            version,
            source_url,
            max((rank for _, rank in entries), default=0),
            len(entries),
            time.time(),
        ),
        commit=True,
    )
    gsm_db.executemany(
        """
        INSERT INTO word_global_frequencies (source_id, word, rank)
        VALUES (?, ?, ?)
        """,
        [(source_id, word, rank) for word, rank in entries],
        commit=True,
    )
    refresh_word_stats_active_global_ranks(gsm_db)


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
    for table in [
        "word_global_frequencies",
        "global_frequency_sources",
        "word_occurrences",
        "kanji_occurrences",
        "words",
        "kanji",
        "word_stats_cache",
        "anki_notes",
        "anki_cards",
        "anki_reviews",
        "word_anki_links",
        "card_kanji_links",
    ]:
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
# /api/tokenisation/maturity-history
# ---------------------------------------------------------------------------


class TestMaturityHistoryEndpoint:
    def test_maturity_history_disabled(self, client, disabled_config):
        resp = client.get("/api/tokenisation/maturity-history")
        assert resp.status_code == 404
        assert resp.get_json() == {"error": "Tokenisation is not enabled"}

    def test_maturity_history_empty(self, client, enabled_config):
        resp = client.get("/api/tokenisation/maturity-history")
        assert resp.status_code == 200

        data = resp.get_json()
        assert data == {
            "labels": [],
            "series": {
                "mature_words": {
                    "label": "Mature Words",
                    "daily_new": [],
                    "cumulative": [],
                    "total": 0,
                },
                "unique_kanji": {
                    "label": "Unique Kanji",
                    "daily_new": [],
                    "cumulative": [],
                    "total": 0,
                },
            },
        }

    def test_maturity_history_counts_first_transition_and_dedupes(self, client, enabled_config):
        today = datetime.date.today()
        day_0 = today - datetime.timedelta(days=3)
        day_1 = today - datetime.timedelta(days=2)
        day_2 = today - datetime.timedelta(days=1)

        word_one_id = _insert_word("本", "ホン", "名詞")
        word_two_id = _insert_word("読む", "ヨム", "動詞")
        kanji_one_id = _insert_kanji("漢")
        kanji_two_id = _insert_kanji("字")
        kanji_three_id = _insert_kanji("語")

        _link_word_to_card(word_one_id, note_id=100, card_id=1000)
        _link_word_to_card(word_one_id, note_id=100, card_id=1001)
        _link_word_to_card(word_two_id, note_id=200, card_id=2000)
        WordAnkiLinksTable.link(word_two_id, 201)
        _link_kanji_to_card(kanji_one_id, note_id=300, card_id=3000)
        _link_kanji_to_card(kanji_one_id, note_id=301, card_id=3001)
        _link_kanji_to_card(kanji_two_id, note_id=400, card_id=4000)
        _link_kanji_to_card(kanji_two_id, note_id=401, card_id=4001)
        _link_kanji_to_card(kanji_three_id, note_id=402, card_id=4002)

        # Word one matures once on day_1 and should ignore later mature reviews.
        _insert_anki_review(
            card_id=1000,
            note_id=100,
            review_time_ms=_review_time_ms(day_0),
            interval=10,
            last_interval=5,
        )
        _insert_anki_review(
            card_id=1000,
            note_id=100,
            review_time_ms=_review_time_ms(day_1),
            interval=21,
            last_interval=10,
        )
        _insert_anki_review(
            card_id=1001,
            note_id=100,
            review_time_ms=_review_time_ms(day_2),
            interval=30,
            last_interval=20,
        )
        _insert_anki_review(
            card_id=1000,
            note_id=100,
            review_time_ms=_review_time_ms(today),
            interval=35,
            last_interval=21,
        )

        # Word two is linked to two notes and should use the earlier mature date.
        _insert_anki_review(
            card_id=2000,
            note_id=200,
            review_time_ms=_review_time_ms(day_2),
            interval=23,
            last_interval=15,
        )
        _insert_anki_review(
            card_id=2001,
            note_id=201,
            review_time_ms=_review_time_ms(day_0),
            interval=25,
            last_interval=18,
        )

        # Kanji one appears on two mature cards; earliest mature date wins.
        _insert_anki_review(
            card_id=3000,
            note_id=300,
            review_time_ms=_review_time_ms(day_2),
            interval=22,
            last_interval=17,
        )
        _insert_anki_review(
            card_id=3001,
            note_id=301,
            review_time_ms=_review_time_ms(day_1),
            interval=24,
            last_interval=19,
        )

        # Kanji two should count once even with two cards maturing the same day.
        _insert_anki_review(
            card_id=4000,
            note_id=400,
            review_time_ms=_review_time_ms(today),
            interval=21,
            last_interval=12,
        )
        _insert_anki_review(
            card_id=4001,
            note_id=401,
            review_time_ms=_review_time_ms(today),
            interval=28,
            last_interval=20,
        )
        _insert_anki_review(
            card_id=4002,
            note_id=402,
            review_time_ms=_review_time_ms(day_2),
            interval=26,
            last_interval=18,
        )

        resp = client.get("/api/tokenisation/maturity-history")
        assert resp.status_code == 200

        data = resp.get_json()
        expected_labels = [
            day_0.isoformat(),
            day_1.isoformat(),
            day_2.isoformat(),
            today.isoformat(),
        ]
        assert data["labels"] == expected_labels

        mature_words = data["series"]["mature_words"]
        unique_kanji = data["series"]["unique_kanji"]

        assert mature_words["daily_new"] == [1, 1, 0, 0]
        assert mature_words["cumulative"] == [1, 2, 2, 2]
        assert mature_words["total"] == 2

        assert unique_kanji["daily_new"] == [0, 1, 1, 1]
        assert unique_kanji["cumulative"] == [0, 1, 2, 3]
        assert unique_kanji["total"] == 3

    def test_maturity_history_uses_first_known_mature_review_when_transition_missing(
        self, client, enabled_config
    ):
        today = datetime.date.today()
        day_1 = today - datetime.timedelta(days=1)

        word_id = _insert_word("語彙", "ゴイ", "名詞")
        kanji_id = _insert_kanji("語")

        _link_word_to_card(word_id, note_id=700, card_id=7000)
        _link_kanji_to_card(kanji_id, note_id=800, card_id=8000)

        # Simulate partial review history where the 20->21 transition row is unavailable.
        _insert_anki_review(
            card_id=7000,
            note_id=700,
            review_time_ms=_review_time_ms(day_1),
            interval=32,
            last_interval=25,
        )
        _insert_anki_review(
            card_id=8000,
            note_id=800,
            review_time_ms=_review_time_ms(today),
            interval=29,
            last_interval=24,
        )

        resp = client.get("/api/tokenisation/maturity-history")
        assert resp.status_code == 200

        data = resp.get_json()
        assert data["labels"] == [day_1.isoformat(), today.isoformat()]

        mature_words = data["series"]["mature_words"]
        unique_kanji = data["series"]["unique_kanji"]

        assert mature_words["daily_new"] == [1, 0]
        assert mature_words["cumulative"] == [1, 1]
        assert mature_words["total"] == 1

        assert unique_kanji["daily_new"] == [0, 1]
        assert unique_kanji["cumulative"] == [0, 1]
        assert unique_kanji["total"] == 1

    def test_maturity_history_series_shape_matches_labels(self, client, enabled_config):
        today = datetime.date.today()
        start_date = today - datetime.timedelta(days=2)

        word_id = _insert_word("映画", "エイガ", "名詞")
        kanji_id = _insert_kanji("映")

        _link_word_to_card(word_id, note_id=500, card_id=5000)
        _link_kanji_to_card(kanji_id, note_id=600, card_id=6000)

        _insert_anki_review(
            card_id=5000,
            note_id=500,
            review_time_ms=_review_time_ms(start_date),
            interval=21,
            last_interval=10,
        )
        _insert_anki_review(
            card_id=6000,
            note_id=600,
            review_time_ms=_review_time_ms(today),
            interval=22,
            last_interval=15,
        )

        resp = client.get("/api/tokenisation/maturity-history")
        assert resp.status_code == 200

        data = resp.get_json()
        labels = data["labels"]
        assert labels == [
            start_date.isoformat(),
            (start_date + datetime.timedelta(days=1)).isoformat(),
            today.isoformat(),
        ]

        for series in data["series"].values():
            assert len(series["daily_new"]) == len(labels)
            assert len(series["cumulative"]) == len(labels)
            assert series["cumulative"] == sorted(series["cumulative"])
            assert series["cumulative"][-1] == series["total"]


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

    def test_words_days_filter_uses_live_occurrence_query(self, client, enabled_config):
        now = time.time()
        old_timestamp = now - (10 * 24 * 60 * 60)

        _insert_line("line-old", "text", timestamp=old_timestamp)
        _insert_line("line-new", "text", timestamp=now)

        word_id = _insert_word("最近", "サイキン", "名詞")
        WordOccurrencesTable.insert_occurrence(word_id, "line-old")
        WordOccurrencesTable.insert_occurrence(word_id, "line-new")

        resp = client.get("/api/tokenisation/words?days=2")
        assert resp.status_code == 200

        data = resp.get_json()
        assert data["total"] == 1
        assert data["words"][0]["word"] == "最近"
        assert data["words"][0]["frequency"] == 1

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
# /api/tokenisation/words/not-in-anki
# ---------------------------------------------------------------------------


class TestWordsNotInAnkiEndpoint:
    def test_words_not_in_anki_disabled(self, client, disabled_config):
        resp = client.get("/api/tokenisation/words/not-in-anki")
        assert resp.status_code == 404

    def test_words_not_in_anki_empty(self, client, enabled_config):
        resp = client.get("/api/tokenisation/words/not-in-anki")
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["words"] == []
        assert data["total"] == 0

    def test_words_not_in_anki_excludes_in_anki_and_zero_occurrence_words(
        self, client, enabled_config
    ):
        _insert_line("line-1", "text")
        _insert_line("line-2", "text")

        missing_word_id = _insert_word("missing", "mi", "noun")
        in_anki_word_id = _insert_word("known", "kn", "noun")
        orphan_word_id = _insert_word("orphan", "or", "noun")

        WordOccurrencesTable.insert_occurrence(missing_word_id, "line-1")
        WordOccurrencesTable.insert_occurrence(missing_word_id, "line-2")
        WordOccurrencesTable.insert_occurrence(in_anki_word_id, "line-1")
        WordsTable.mark_in_anki(in_anki_word_id)

        resp = client.get("/api/tokenisation/words/not-in-anki")
        assert resp.status_code == 200

        data = resp.get_json()
        assert data["total"] == 1
        assert len(data["words"]) == 1
        assert orphan_word_id not in {w["word_id"] for w in data["words"]}

        word = data["words"][0]
        assert word["word_id"] == missing_word_id
        assert word["word"] == "missing"
        assert word["frequency"] == 2
        assert "deck_name" not in word
        assert "interval" not in word
        assert "due" not in word

    def test_words_not_in_anki_pagination(self, client, enabled_config):
        _insert_line("line-1", "text")
        _insert_line("line-2", "text")
        _insert_line("line-3", "text")

        for index, line_id in enumerate(["line-1", "line-2", "line-3"], start=1):
            word_id = _insert_word(f"word-{index}", f"reading-{index}", "noun")
            WordOccurrencesTable.insert_occurrence(word_id, line_id)

        resp = client.get("/api/tokenisation/words/not-in-anki?limit=2&offset=1")
        assert resp.status_code == 200

        data = resp.get_json()
        assert data["total"] == 3
        assert len(data["words"]) == 2
        assert data["limit"] == 2
        assert data["offset"] == 1

    def test_words_not_in_anki_search_matches_word_and_reading(
        self, client, enabled_config
    ):
        _insert_line("line-1", "text")

        word_ids = [
            _insert_word("apple", "fruit", "noun"),
            _insert_word("banana", "yellow", "noun"),
            _insert_word("carrot", "orange", "noun"),
        ]
        for word_id in word_ids:
            WordOccurrencesTable.insert_occurrence(word_id, "line-1")

        resp = client.get("/api/tokenisation/words/not-in-anki?search=yellow")
        assert resp.status_code == 200

        data = resp.get_json()
        assert data["total"] == 1
        assert data["words"][0]["word"] == "banana"

    def test_words_not_in_anki_pos_filters(self, client, enabled_config):
        _insert_line("line-1", "text")

        noun_id = _insert_word("noun-word", "", "名詞")
        verb_id = _insert_word("verb-word", "", "動詞")
        particle_id = _insert_word("particle-word", "", "助詞")
        for word_id in [noun_id, verb_id, particle_id]:
            WordOccurrencesTable.insert_occurrence(word_id, "line-1")

        resp = client.get("/api/tokenisation/words/not-in-anki?pos=content")
        data = resp.get_json()
        assert {word["word"] for word in data["words"]} == {"noun-word", "verb-word"}

        resp = client.get("/api/tokenisation/words/not-in-anki?exclude_pos=particles")
        data = resp.get_json()
        assert {word["word"] for word in data["words"]} == {"noun-word", "verb-word"}

    def test_words_not_in_anki_vocab_only_excludes_grammar_noise(
        self, client, enabled_config
    ):
        _insert_line("line-1", "text")

        grammar_entries = [
            ("ga", "", "助詞"),
            ("desu", "", "助動詞"),
            ("ano", "", "フィラー"),
            ("o", "", "接頭詞"),
            ("kono", "", "連体詞"),
            ("こと", "", "名詞"),
            ("よう", "", "名詞"),
            ("もの", "", "名詞"),
        ]
        lexical_entries = [
            ("本", "", "名詞"),
            ("読む", "", "動詞"),
            ("速い", "", "形容詞"),
            ("かなり", "", "副詞"),
            ("ありがとう", "", "感動詞"),
            ("ただし", "", "接続詞"),
        ]

        for word, reading, pos in grammar_entries + lexical_entries:
            word_id = _insert_word(word, reading, pos)
            WordOccurrencesTable.insert_occurrence(word_id, "line-1")

        resp = client.get("/api/tokenisation/words/not-in-anki?vocab_only=true")
        assert resp.status_code == 200

        data = resp.get_json()
        returned_words = {word["word"] for word in data["words"]}
        assert returned_words == {entry[0] for entry in lexical_entries}

    def test_words_not_in_anki_cjk_only_hides_non_cjk_words(
        self, client, enabled_config
    ):
        _insert_line("line-1", "text")

        cjk_word_id = _insert_word("本", "", "名詞")
        kana_word_id = _insert_word("ありがとう", "", "感動詞")
        non_cjk_word_id = _insert_word("banana", "", "名詞")

        for word_id in [cjk_word_id, kana_word_id, non_cjk_word_id]:
            WordOccurrencesTable.insert_occurrence(word_id, "line-1")

        resp = client.get("/api/tokenisation/words/not-in-anki?cjk_only=true")
        assert resp.status_code == 200

        data = resp.get_json()
        assert {word["word"] for word in data["words"]} == {"本", "ありがとう"}

    def test_words_not_in_anki_omitted_cjk_only_preserves_existing_behavior(
        self, client, enabled_config
    ):
        _insert_line("line-1", "text")

        cjk_word_id = _insert_word("本", "", "名詞")
        non_cjk_word_id = _insert_word("banana", "", "名詞")
        for word_id in [cjk_word_id, non_cjk_word_id]:
            WordOccurrencesTable.insert_occurrence(word_id, "line-1")

        resp = client.get("/api/tokenisation/words/not-in-anki")
        assert resp.status_code == 200

        data = resp.get_json()
        assert {word["word"] for word in data["words"]} == {"本", "banana"}

    def test_words_not_in_anki_omitted_vocab_only_preserves_existing_behavior(
        self, client, enabled_config
    ):
        _insert_line("line-1", "text")

        noun_id = _insert_word("本", "", "名詞")
        particle_id = _insert_word("が", "", "助詞")
        grammar_noun_id = _insert_word("こと", "", "名詞")

        for word_id in [noun_id, particle_id, grammar_noun_id]:
            WordOccurrencesTable.insert_occurrence(word_id, "line-1")

        resp = client.get("/api/tokenisation/words/not-in-anki")
        assert resp.status_code == 200

        data = resp.get_json()
        assert {word["word"] for word in data["words"]} == {"本", "が", "こと"}

    def test_words_not_in_anki_sorts_stably(self, client, enabled_config):
        for line_id in ["line-1", "line-2", "line-3", "line-4", "line-5"]:
            _insert_line(line_id, "text")

        alpha_id = _insert_word("alpha", "reading-a", "b-pos")
        bravo_id = _insert_word("bravo", "reading-b", "a-pos")
        charlie_id = _insert_word("charlie", "reading-c", "c-pos")

        for line_id in ["line-1", "line-2"]:
            WordOccurrencesTable.insert_occurrence(alpha_id, line_id)
        for line_id in ["line-3", "line-4"]:
            WordOccurrencesTable.insert_occurrence(bravo_id, line_id)
        WordOccurrencesTable.insert_occurrence(charlie_id, "line-5")

        resp = client.get("/api/tokenisation/words/not-in-anki?sort=frequency&order=desc")
        data = resp.get_json()
        assert [word["word"] for word in data["words"]] == ["alpha", "bravo", "charlie"]

        resp = client.get("/api/tokenisation/words/not-in-anki?sort=word&order=asc")
        data = resp.get_json()
        assert [word["word"] for word in data["words"]] == ["alpha", "bravo", "charlie"]

        resp = client.get("/api/tokenisation/words/not-in-anki?sort=reading&order=desc")
        data = resp.get_json()
        assert [word["word"] for word in data["words"]] == ["charlie", "bravo", "alpha"]

        resp = client.get("/api/tokenisation/words/not-in-anki?sort=pos&order=asc")
        data = resp.get_json()
        assert [word["word"] for word in data["words"]] == ["bravo", "alpha", "charlie"]

    def test_words_not_in_anki_returns_global_rank_metadata(self, client, enabled_config):
        _insert_line("line-1", "text")
        _insert_line("line-2", "text")

        ranked_id = _insert_word("ranked", "ランク", "名詞")
        unranked_id = _insert_word("unranked", "アンランク", "名詞")
        WordOccurrencesTable.insert_occurrence(ranked_id, "line-1")
        WordOccurrencesTable.insert_occurrence(unranked_id, "line-2")
        _seed_global_frequency_source([("ranked", 12)])

        resp = client.get("/api/tokenisation/words/not-in-anki")
        assert resp.status_code == 200

        data = resp.get_json()
        assert data["global_rank_bounds"] == {"min": 12, "max": 12}
        assert data["global_rank_source"] == {
            "id": "jiten-global",
            "name": "Jiten Global",
            "version": "test-v1",
            "source_url": "https://jiten.moe/other",
            "max_rank": 12,
        }

        words_by_text = {word["word"]: word for word in data["words"]}
        assert words_by_text["ranked"]["global_rank"] == 12
        assert words_by_text["unranked"]["global_rank"] is None

    def test_words_not_in_anki_sort_global_rank_excludes_unranked_and_orders_stably(
        self, client, enabled_config
    ):
        for line_id in ["line-1", "line-2", "line-3", "line-4"]:
            _insert_line(line_id, "text")

        alpha_id = _insert_word("alpha", "", "名詞")
        bravo_id = _insert_word("bravo", "", "名詞")
        charlie_id = _insert_word("charlie", "", "名詞")
        delta_id = _insert_word("delta", "", "名詞")

        WordOccurrencesTable.insert_occurrence(alpha_id, "line-1")
        WordOccurrencesTable.insert_occurrence(bravo_id, "line-2")
        WordOccurrencesTable.insert_occurrence(charlie_id, "line-3")
        WordOccurrencesTable.insert_occurrence(delta_id, "line-4")

        _seed_global_frequency_source(
            [
                ("alpha", 5),
                ("bravo", 5),
                ("delta", 12),
            ]
        )

        resp = client.get("/api/tokenisation/words/not-in-anki?sort=global_rank&order=asc")
        assert resp.status_code == 200
        data = resp.get_json()
        assert [word["word"] for word in data["words"]] == ["alpha", "bravo", "delta"]
        assert data["total"] == 3
        assert "charlie" not in {word["word"] for word in data["words"]}

        resp = client.get("/api/tokenisation/words/not-in-anki?sort=global_rank&order=desc")
        assert resp.status_code == 200
        data = resp.get_json()
        assert [word["word"] for word in data["words"]] == ["delta", "alpha", "bravo"]

    def test_words_not_in_anki_global_rank_filters_and_bounds_ignore_active_range(
        self, client, enabled_config
    ):
        for line_id in ["line-1", "line-2", "line-3", "line-4"]:
            _insert_line(line_id, "text")

        alpha_id = _insert_word("alpha", "", "名詞")
        bravo_id = _insert_word("bravo", "", "名詞")
        charlie_id = _insert_word("charlie", "", "名詞")
        delta_id = _insert_word("delta", "", "名詞")

        WordOccurrencesTable.insert_occurrence(alpha_id, "line-1")
        WordOccurrencesTable.insert_occurrence(bravo_id, "line-2")
        WordOccurrencesTable.insert_occurrence(charlie_id, "line-3")
        WordOccurrencesTable.insert_occurrence(delta_id, "line-4")

        _seed_global_frequency_source(
            [
                ("alpha", 10),
                ("bravo", 50),
                ("charlie", 80),
            ]
        )

        resp = client.get(
            "/api/tokenisation/words/not-in-anki?global_rank_min=60&global_rank_max=40"
        )
        assert resp.status_code == 200

        data = resp.get_json()
        assert data["total"] == 1
        assert [word["word"] for word in data["words"]] == ["bravo"]
        assert data["words"][0]["global_rank"] == 50
        assert data["global_rank_bounds"] == {"min": 10, "max": 80}
        assert "delta" not in {word["word"] for word in data["words"]}


# ---------------------------------------------------------------------------
# /api/tokenisation/words/card-data
# ---------------------------------------------------------------------------


class TestWordCardDataEndpoint:
    def test_word_card_data_disabled(self, client, disabled_config):
        resp = client.get("/api/tokenisation/words/card-data?word_ids=1,2")
        assert resp.status_code == 404

    def test_word_card_data_empty(self, client, enabled_config):
        resp = client.get("/api/tokenisation/words/card-data")
        assert resp.status_code == 200
        assert resp.get_json() == {"cards": []}

    def test_word_card_data_returns_linked_cards_in_request_order(
        self, client, enabled_config
    ):
        word_one_id = _insert_word("one", "", "noun")
        word_two_id = _insert_word("two", "", "noun")
        word_three_id = _insert_word("three", "", "noun")

        _link_word_to_card(
            word_two_id, note_id=200, card_id=2000, deck_name="Deck Two", interval=12, due=24
        )
        _link_word_to_card(
            word_three_id,
            note_id=300,
            card_id=3000,
            deck_name="Deck Three",
            interval=21,
            due=42,
        )

        resp = client.get(
            f"/api/tokenisation/words/card-data?word_ids=abc,{word_three_id},{word_two_id},{word_three_id},{word_one_id}"
        )
        assert resp.status_code == 200

        data = resp.get_json()
        assert data["cards"] == [
            {
                "word_id": word_three_id,
                "deck_name": "Deck Three",
                "interval": 21,
                "due": 42,
            },
            {
                "word_id": word_two_id,
                "deck_name": "Deck Two",
                "interval": 12,
                "due": 24,
            },
        ]

    def test_word_card_data_caps_requested_ids(self, client, enabled_config):
        tracked_ids = []
        for index in range(101):
            word_id = _insert_word(f"word-{index}", "", "noun")
            tracked_ids.append(word_id)

        _link_word_to_card(
            tracked_ids[99],
            note_id=999,
            card_id=9990,
            deck_name="Included Deck",
            interval=5,
            due=10,
        )
        _link_word_to_card(
            tracked_ids[100],
            note_id=1000,
            card_id=10000,
            deck_name="Excluded Deck",
            interval=6,
            due=11,
        )

        raw_ids = ",".join(str(word_id) for word_id in tracked_ids)
        resp = client.get(f"/api/tokenisation/words/card-data?word_ids={raw_ids}")
        assert resp.status_code == 200

        data = resp.get_json()
        assert data["cards"] == [
            {
                "word_id": tracked_ids[99],
                "deck_name": "Included Deck",
                "interval": 5,
                "due": 10,
            }
        ]


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
