from pathlib import Path


TEMPLATE_PATH = Path(__file__).resolve().parents[2] / "GameSentenceMiner" / "web" / "templates" / "overview.html"


def test_overview_template_includes_current_session_game_management_controls():
    contents = TEMPLATE_PATH.read_text(encoding="utf-8")

    assert 'id="currentSessionSettingsCogBtn"' in contents
    assert 'id="currentSessionSettingsCogDropdown"' in contents
    assert 'id="editGameModal"' in contents
    assert 'id="mergeGamesModal"' in contents
    assert "{% include 'components/game-import-modals.html' %}" in contents
