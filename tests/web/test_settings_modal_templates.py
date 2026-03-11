from pathlib import Path


TEMPLATES_DIR = (
    Path(__file__).resolve().parents[2] / "GameSentenceMiner" / "web" / "templates"
)
NAV_INCLUDE = "{% include 'components/navigation.html' %}"
SETTINGS_MODAL_INCLUDE = "{% include 'components/settings-modal.html' %}"
SETTINGS_MODAL_EXCEPTIONS = {"goals.html"}


def test_navigation_pages_include_settings_modal_or_are_explicit_exceptions():
    template_names = sorted(path.name for path in TEMPLATES_DIR.glob("*.html"))

    for template_name in template_names:
        template_path = TEMPLATES_DIR / template_name
        contents = template_path.read_text(encoding="utf-8")

        if NAV_INCLUDE not in contents:
            continue

        if template_name in SETTINGS_MODAL_EXCEPTIONS:
            continue

        assert SETTINGS_MODAL_INCLUDE in contents, (
            f"{template_name} renders the shared navigation and settings button, "
            "so it must also include the shared settings modal."
        )
