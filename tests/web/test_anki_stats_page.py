from pathlib import Path

import flask
import pytest


def _normalise_windows_path(path: Path) -> str:
    path_str = str(path)
    return path_str[4:] if path_str.startswith('\\\\?\\') else path_str


@pytest.fixture()
def client():
    repo_root = Path(__file__).resolve().parents[2]
    app = flask.Flask(
        __name__,
        template_folder=_normalise_windows_path(
            repo_root / 'GameSentenceMiner' / 'web' / 'templates'
        ),
        static_folder=_normalise_windows_path(
            repo_root / 'GameSentenceMiner' / 'web' / 'static'
        ),
    )
    app.config['TESTING'] = True

    @app.route('/anki_stats')
    def anki_stats_page():
        return flask.render_template('anki_stats.html')

    return app.test_client()


def test_anki_stats_page_renders_pagination_controls_for_game_tables(client):
    response = client.get('/anki_stats')

    assert response.status_code == 200

    html = response.get_data(as_text=True)
    expected_ids = [
        'cardsPerGamePagination',
        'cardsPerGamePrev',
        'cardsPerGamePageInfo',
        'cardsPerGameNext',
        'gameStatsPagination',
        'gameStatsPrev',
        'gameStatsPageInfo',
        'gameStatsNext',
    ]

    for element_id in expected_ids:
        assert f'id="{element_id}"' in html


def test_anki_stats_page_uses_five_rows_per_page_for_game_tables(client):
    response = client.get('/anki_stats')

    assert response.status_code == 200

    html = response.get_data(as_text=True)

    assert 'id="cardsPerGameTable" class="stats-table" data-page-size="5"' in html
    assert 'id="gameStatsTable" class="stats-table" data-page-size="5"' in html


def test_anki_stats_page_renders_non_cjk_toggle_for_words_not_in_anki(client):
    response = client.get('/anki_stats')

    assert response.status_code == 200

    html = response.get_data(as_text=True)
    assert 'id="wordsNotInAnkiCjkOnly"' in html
