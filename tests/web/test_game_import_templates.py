from pathlib import Path


TEMPLATES_DIR = Path(__file__).resolve().parents[2] / "GameSentenceMiner" / "web" / "templates"
COMPONENT_PATH = TEMPLATES_DIR / "components" / "game-import-modals.html"


def test_shared_game_import_component_contains_full_linking_ui():
    contents = COMPONENT_PATH.read_text(encoding="utf-8")

    assert 'id="linkSearchModal"' in contents
    assert 'id="linkConfirmModal"' in contents
    assert 'id="linkConfirmManualOverridesWarning"' in contents
    assert 'id="linkConfirmOverwriteMetadata"' in contents


def test_pages_use_shared_game_import_component():
    include_directive = "{% include 'components/game-import-modals.html' %}"
    include_targets = [
        TEMPLATES_DIR / "game_stats.html",
        TEMPLATES_DIR / "overview.html",
        TEMPLATES_DIR / "database.html",
        TEMPLATES_DIR / "components" / "game-management-modals.html",
    ]

    for template_path in include_targets:
        contents = template_path.read_text(encoding="utf-8")
        assert include_directive in contents, f"{template_path.name} should include the shared game import component"


def test_game_stats_template_loads_search_css_before_html_head():
    template_path = TEMPLATES_DIR / "game_stats.html"
    contents = template_path.read_text(encoding="utf-8")

    assert "{% set additional_css = ['search.css'] %}" in contents
    assert contents.index("{% set additional_css = ['search.css'] %}") < contents.index(
        "{% include 'components/html-head.html' %}"
    )
