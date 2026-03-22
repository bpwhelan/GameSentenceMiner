from types import SimpleNamespace

from flask import Flask

from GameSentenceMiner.web import anki_api_endpoints


def _build_test_client(monkeypatch):
    all_lines = ["all-lines"]
    filtered_lines = ["filtered-lines"]

    notes_by_id = {
        1577750400000: SimpleNamespace(
            note_id=1577750400000,
            mod=1764195220,
            fields_json=None,
            tags=[],
        ),
        1578009600000: SimpleNamespace(
            note_id=1578009600000,
            mod=1764195220,
            fields_json=None,
            tags=["Game::Tagged"],
        ),
        1577836800000: SimpleNamespace(
            note_id=1577836800000,
            mod=1764195220,
            fields_json=None,
            tags=["Other"],
        ),
    }
    note_fields_by_id = {
        1577750400000: {
            "Expression": {"value": "漢外"},
            "Sentence": {"value": "語"},
        },
        1578009600000: {
            "Expression": {"value": "字"},
            "Sentence": {"value": "学"},
        },
        1577836800000: {
            "Sentence": {"value": "猫"},
        },
    }

    def fake_calculate_kanji_frequency(lines):
        if lines is all_lines:
            return {
                "kanji_data": [
                    {"kanji": "漢", "frequency": 5, "color": "#111111"},
                    {"kanji": "字", "frequency": 4, "color": "#222222"},
                    {"kanji": "語", "frequency": 3, "color": "#333333"},
                ],
                "unique_count": 3,
                "max_frequency": 5,
            }
        if lines is filtered_lines:
            return {
                "kanji_data": [
                    {"kanji": "字", "frequency": 4, "color": "#222222"},
                    {"kanji": "語", "frequency": 2, "color": "#333333"},
                ],
                "unique_count": 2,
                "max_frequency": 4,
            }
        raise AssertionError(f"Unexpected GSM lines input: {lines!r}")

    def fake_get_lines_filtered_by_timestamp(start, end, for_stats=False):
        if start < 1_600_000_000:
            return filtered_lines
        return []

    monkeypatch.setattr(anki_api_endpoints, "_is_cache_empty", lambda: False)
    monkeypatch.setattr(
        anki_api_endpoints,
        "_get_anki_data",
        lambda: {
            "notes_by_id": notes_by_id,
            "note_fields_by_id": note_fields_by_id,
        },
    )
    monkeypatch.setattr(
        anki_api_endpoints,
        "get_config",
        lambda: SimpleNamespace(anki=SimpleNamespace(parent_tag="Game", word_field="Expression")),
    )
    monkeypatch.setattr(
        anki_api_endpoints,
        "combine_rollup_and_live_stats",
        lambda rollup_stats, live_stats: {},
    )
    monkeypatch.setattr(
        anki_api_endpoints,
        "calculate_live_stats_for_today",
        lambda today_lines: {},
    )
    monkeypatch.setattr(
        anki_api_endpoints,
        "calculate_kanji_frequency",
        fake_calculate_kanji_frequency,
    )
    monkeypatch.setattr(
        anki_api_endpoints.StatsRollupTable,
        "get_date_range",
        staticmethod(lambda start_date, end_date: []),
    )
    monkeypatch.setattr(
        anki_api_endpoints.StatsRollupTable,
        "get_first_date",
        staticmethod(lambda: None),
    )
    monkeypatch.setattr(
        anki_api_endpoints.GameLinesTable,
        "all",
        staticmethod(lambda: all_lines),
    )
    monkeypatch.setattr(
        anki_api_endpoints.GameLinesTable,
        "get_lines_filtered_by_timestamp",
        staticmethod(fake_get_lines_filtered_by_timestamp),
    )

    app = Flask(__name__)
    anki_api_endpoints.register_anki_api_endpoints(app)
    return app.test_client()


def test_anki_kanji_stats_uses_parent_tagged_word_field_entries(monkeypatch):
    client = _build_test_client(monkeypatch)

    response = client.get("/api/anki_kanji_stats")

    assert response.status_code == 200
    assert response.get_json() == {
        "missing_kanji": [
            {"kanji": "漢", "frequency": 5},
            {"kanji": "語", "frequency": 3},
        ],
        "anki_kanji_count": 1,
        "gsm_kanji_count": 3,
        "coverage_percent": 33.3,
    }


def test_anki_kanji_stats_date_range_filters_gsm_and_anki_sides(monkeypatch):
    client = _build_test_client(monkeypatch)

    response = client.get("/api/anki_kanji_stats?start_timestamp=1577836800000&end_timestamp=1577923199999")

    assert response.status_code == 200
    assert response.get_json() == {
        "missing_kanji": [
            {"kanji": "字", "frequency": 4},
            {"kanji": "語", "frequency": 2},
        ],
        "anki_kanji_count": 0,
        "gsm_kanji_count": 2,
        "coverage_percent": 0.0,
    }
