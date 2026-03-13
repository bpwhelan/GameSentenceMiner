from pathlib import Path

import flask
import pytest
import re


def _normalise_windows_path(path: Path) -> str:
    path_str = str(path)
    return path_str[4:] if path_str.startswith("\\\\?\\") else path_str


@pytest.fixture()
def client():
    repo_root = Path(__file__).resolve().parents[2]
    app = flask.Flask(
        __name__,
        template_folder=_normalise_windows_path(
            repo_root / "GameSentenceMiner" / "web" / "templates"
        ),
        static_folder=_normalise_windows_path(
            repo_root / "GameSentenceMiner" / "web" / "static"
        ),
    )
    app.config["TESTING"] = True

    @app.route("/anki_stats")
    def anki_stats_page():
        return flask.render_template("anki_stats.html")

    return app.test_client()


def test_anki_stats_page_renders_pagination_controls_for_game_tables(client):
    response = client.get("/anki_stats")

    assert response.status_code == 200

    html = response.get_data(as_text=True)
    expected_ids = [
        "cardsPerGamePagination",
        "cardsPerGamePrev",
        "cardsPerGamePageInfo",
        "cardsPerGameNext",
        "gameStatsPagination",
        "gameStatsPrev",
        "gameStatsPageInfo",
        "gameStatsNext",
    ]

    for element_id in expected_ids:
        assert f'id="{element_id}"' in html


def test_anki_stats_page_uses_five_rows_per_page_for_game_tables(client):
    response = client.get("/anki_stats")

    assert response.status_code == 200

    html = response.get_data(as_text=True)

    assert re.search(
        r'<table[^>]*id="cardsPerGameTable"[^>]*data-page-size="5"',
        html,
    )
    assert re.search(
        r'<table[^>]*id="gameStatsTable"[^>]*data-page-size="5"',
        html,
    )


def test_anki_stats_page_renders_words_not_in_anki_power_user_controls(client):
    response = client.get("/anki_stats")

    assert response.status_code == 200

    html = response.get_data(as_text=True)
    expected_ids = [
        "wordsNotInAnkiDownloadCsv",
        "wordsNotInAnkiResetFilters",
        "wordsNotInAnkiPowerUserPanel",
        "wordsNotInAnkiPowerUserSummaryCount",
        "wordsNotInAnkiScriptFilter",
        "wordsNotInAnkiGameFilter",
        "wordsNotInAnkiGameFilterToggle",
        "wordsNotInAnkiGameFilterSummary",
        "wordsNotInAnkiGameFilterMenu",
        "wordsNotInAnkiGameFilterSelectAll",
        "wordsNotInAnkiGameFilterClearAll",
        "wordsNotInAnkiGameFilterList",
        "wordsNotInAnkiIncludeGrammar",
        "wordsNotInAnkiHasMissingAnkiKanji",
        "wordsNotInAnkiPosInclude",
        "wordsNotInAnkiPosExclude",
        "wordsNotInAnkiFrequencyCard",
        "wordsNotInAnkiFrequencyMin",
        "wordsNotInAnkiFrequencyMax",
        "wordsNotInAnkiFrequencyMinRange",
        "wordsNotInAnkiFrequencyMaxRange",
        "wordsNotInAnkiFrequencyReset",
        "wordsNotInAnkiPageSize",
    ]

    for element_id in expected_ids:
        assert f'id="{element_id}"' in html

    expected_layout_classes = [
        "words-filter-group",
        "words-power-user-summary-icon",
        "words-filter-checkbox-copy",
        "words-filter-dropdown",
        "words-filter-dropdown-toggle",
        "words-filter-dropdown-list",
        "words-rank-slider-inner",
        "words-not-in-anki-results",
        "words-not-in-anki-table-wrap",
        "words-table-pagination",
    ]

    for class_name in expected_layout_classes:
        assert class_name in html

    assert 'id="wordsNotInAnkiCjkOnly"' not in html


def test_anki_stats_page_renders_reading_impact_section(client):
    response = client.get("/anki_stats")

    assert response.status_code == 200

    html = response.get_data(as_text=True)
    expected_ids = [
        "readingImpactOverviewCard",
        "readingImpactImmediateChart",
        "readingImpactRollupCard",
        "readingImpactRollupTable",
        "readingImpactRollupTableBody",
        "readingImpactPipelineChart",
        "readingImpactCardsPer10kChars",
        "readingImpactMaturityYield",
    ]

    for element_id in expected_ids:
        assert f'id="{element_id}"' in html


def test_anki_stats_page_renders_reading_impact_rollup_pagination_controls(client):
    response = client.get("/anki_stats")

    assert response.status_code == 200

    html = response.get_data(as_text=True)
    expected_ids = [
        "readingImpactRollupPagination",
        "readingImpactRollupPrev",
        "readingImpactRollupPageInfo",
        "readingImpactRollupNext",
    ]

    for element_id in expected_ids:
        assert f'id="{element_id}"' in html


def test_anki_stats_page_limits_reading_impact_rollup_to_four_rows_per_page(client):
    response = client.get("/anki_stats")

    assert response.status_code == 200

    html = response.get_data(as_text=True)

    assert re.search(
        r'<table[^>]*id="readingImpactRollupTable"[^>]*data-page-size="4"',
        html,
    )


def test_anki_stats_page_renders_reading_impact_metric_toggle(client):
    response = client.get("/anki_stats")

    assert response.status_code == 200

    html = response.get_data(as_text=True)
    assert 'id="readingImpactMetricWords"' in html
    assert 'id="readingImpactMetricKanji"' in html
    assert 'data-reading-impact-metric="words"' in html
    assert 'data-reading-impact-metric="kanji"' in html


def test_anki_stats_page_removes_weak_reading_impact_charts(client):
    response = client.get("/anki_stats")

    assert response.status_code == 200

    html = response.get_data(as_text=True)
    assert "Which Games Produce Durable Cards?" not in html
    assert "Reading → Mature Later" not in html
