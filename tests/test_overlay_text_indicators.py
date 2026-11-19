import re
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


def test_red_indicator_boxes_follow_overlay_calibration_offset():
    index_html = OVERLAY_INDEX.read_text(encoding="utf-8")
    indicator_rendering = index_html.split("blockIndicatorBounds.forEach((bounds) => {", 1)[1].split(
        "// Add recycled sentence indicator", 1
    )[0]

    # Coordinates may already have been projected or padded for the display.
    # Calibration still applies to the final horizontal and vertical positions.
    for property_name, offset in (("left", "offsetX"), ("top", "offsetY")):
        assert re.search(rf"blockBox\.style\.{property_name}\s*=\s*`\$\{{[^}}]+\+\s*{offset}\}}%`", indicator_rendering)
