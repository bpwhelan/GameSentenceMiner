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
        template_folder=_normalise_windows_path(repo_root / "GameSentenceMiner" / "web" / "templates"),
        static_folder=_normalise_windows_path(repo_root / "GameSentenceMiner" / "web" / "static"),
    )
    app.config["TESTING"] = True

    @app.route("/tools")
    def tools_page():
        return flask.render_template("database.html")

    @app.route("/database")
    def database_page():
        return flask.redirect("/tools")

    return app.test_client()


def test_database_page_renders_yomitan_frequency_dictionary_card(client):
    response = client.get("/tools")

    assert response.status_code == 200

    html = response.get_data(as_text=True)
    assert "Download GSM Frequency Dictionary" in html
    assert "A word frequency dictionary built from your game data." in html


def test_database_page_renders_hidden_tokenization_warning_for_frequency_dictionary(
    client,
):
    response = client.get("/tools")

    assert response.status_code == 200

    html = response.get_data(as_text=True)
    assert 'id="freqDictTokenizationWarning"' in html
    assert re.search(
        r'id="freqDictTokenizationWarning"[^>]*style="[^"]*display:\s*none',
        html,
    )


def test_database_page_renders_frequency_dictionary_download_button_wiring(client):
    response = client.get("/tools")

    assert response.status_code == 200

    html = response.get_data(as_text=True)
    assert re.search(
        r'<button[^>]*id="downloadFreqDictBtn"[^>]*data-action="downloadFreqDict"',
        html,
    )


def test_database_page_includes_main_database_javascript_bundle(client):
    response = client.get("/tools")

    assert response.status_code == 200

    html = response.get_data(as_text=True)
    assert '<script src="/static/js/database.js"></script>' in html


def test_tools_page_renders_exstatic_import_card(client):
    response = client.get("/tools")

    assert response.status_code == 200

    html = response.get_data(as_text=True)
    assert "Import ExStatic Lines" in html
    assert 'id="toolsExstaticFile"' in html
    assert 'id="toolsImportExstaticBtn"' in html
    assert '<script src="/static/js/database-exstatic-import.js"></script>' in html


def test_tools_page_renders_deduplication_filter_controls(client):
    response = client.get("/tools")

    assert response.status_code == 200

    html = response.get_data(as_text=True)
    assert 'id="gameSelectionSearch"' in html
    assert 'data-action="selectVisibleDedupGames"' in html
    assert 'data-action="clearDedupGames"' in html


def test_database_route_redirects_to_tools(client):
    response = client.get("/database")

    assert response.status_code == 302
    assert response.headers["Location"].endswith("/tools")
