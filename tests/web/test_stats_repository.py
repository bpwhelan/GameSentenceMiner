from types import SimpleNamespace

from GameSentenceMiner.web import stats_repository


class _FakeDB:
    def __init__(self, rows):
        self._rows = rows
        self.last_query = ""
        self.last_params = ()

    def fetchall(self, query, params):
        self.last_query = query
        self.last_params = params
        return self._rows


def _patch_stats_config(monkeypatch, regex_out_repetitions: bool = False, extra_punctuation_regex: str = ""):
    monkeypatch.setattr(
        stats_repository,
        "get_stats_config",
        lambda: SimpleNamespace(
            regex_out_repetitions=regex_out_repetitions,
            extra_punctuation_regex=extra_punctuation_regex,
        ),
    )


def test_query_stats_lines_lean_projection_skips_media_and_note_ids(monkeypatch):
    _patch_stats_config(monkeypatch)
    fake_db = _FakeDB(
        rows=[
            ("line-1", "My Game", "  テスト！！  ", 1700000000.0, "game-1"),
        ]
    )
    monkeypatch.setattr(stats_repository.GameLinesTable, "_db", fake_db)

    records = stats_repository.query_stats_lines(
        where_clause="game_id=?",
        params=("game-1",),
        include_media_fields=False,
        parse_note_ids=False,
    )

    assert len(records) == 1
    line = records[0]
    assert line.id == "line-1"
    assert line.game_name == "My Game"
    assert line.line_text == "テスト"
    assert line.timestamp == 1700000000.0
    assert line.game_id == "game-1"
    assert line.screenshot_in_anki == ""
    assert line.audio_in_anki == ""
    assert line.translation == ""
    assert line.note_ids == []

    assert "screenshot_in_anki" not in fake_db.last_query
    assert "note_ids" not in fake_db.last_query
    assert fake_db.last_params == ("game-1",)


def test_query_stats_lines_parse_note_ids_fast_path(monkeypatch):
    _patch_stats_config(monkeypatch)
    fake_db = _FakeDB(
        rows=[
            ("line-1", "My Game", "abc", 1700000000.0, "game-1", "[]"),
            ("line-2", "My Game", "abc", 1700000001.0, "game-1", '["42","43"]'),
        ]
    )
    monkeypatch.setattr(stats_repository.GameLinesTable, "_db", fake_db)

    records = stats_repository.query_stats_lines(
        where_clause="game_name=?",
        params=("My Game",),
        include_media_fields=False,
        parse_note_ids=True,
    )

    assert [list(record.note_ids) for record in records] == [[], ["42", "43"]]
    assert "note_ids" in fake_db.last_query
    assert "screenshot_in_anki" not in fake_db.last_query


def test_query_stats_lines_applies_extra_punctuation_regex(monkeypatch):
    _patch_stats_config(monkeypatch, extra_punctuation_regex=r"\.?【.*?】")
    fake_db = _FakeDB(
        rows=[
            ("line-1", "My Game", "本文。【speaker】続き", 1700000000.0, "game-1"),
        ]
    )
    monkeypatch.setattr(stats_repository.GameLinesTable, "_db", fake_db)

    records = stats_repository.query_stats_lines(
        where_clause="game_id=?",
        params=("game-1",),
        include_media_fields=False,
        parse_note_ids=False,
    )

    assert records[0].line_text == "本文続き"
