from pathlib import Path


OVERLAY_INDEX = Path(__file__).resolve().parents[1] / "GSM_Overlay" / "index.html"


def test_modern_indicator_setting_wins_over_legacy_full_snapshot_value():
    index_html = OVERLAY_INDEX.read_text(encoding="utf-8")
    settings_updated_handler = index_html.split('ipcRenderer.on("settings-updated", (event, updatedSettings) => {', 1)[
        1
    ].split("function updateMagpieCompatibility", 1)[0]
    legacy_case = settings_updated_handler.split('case "showTextBackground":', 1)[1].split(
        'case "showReadyIndicator":', 1
    )[0]

    assert '!Object.prototype.hasOwnProperty.call(updatedSettings, "showTextIndicators")' in legacy_case
