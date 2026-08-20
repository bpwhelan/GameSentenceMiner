from pathlib import Path


OVERLAY_DIR = Path(__file__).resolve().parents[1] / "GSM_Overlay"


def test_overlay_activation_scan_has_one_capture_setting():
    settings_html = (OVERLAY_DIR / "settings.html").read_text(encoding="utf-8")
    manual_mode_card = (OVERLAY_DIR / "components" / "manual-mode-card.js").read_text(encoding="utf-8")

    capture_start = settings_html.index('<div class="setting-group full-width" data-tab="capture">')
    capture_end = settings_html.index('<div class="setting-group" data-tab="capture">', capture_start)
    primary_capture_group = settings_html[capture_start:capture_end]

    assert 'id="scan_on_overlay_activation"' in primary_capture_group
    assert settings_html.count('id="scan_on_overlay_activation"') == 1
    assert "manualModeRescanOnShow" not in settings_html
    assert "manualModeRescanOnShow" not in manual_mode_card


def test_text_appears_instantly_setting_is_in_capture_and_synced_to_backend():
    settings_html = (OVERLAY_DIR / "settings.html").read_text(encoding="utf-8")
    main_js = (OVERLAY_DIR / "main.js").read_text(encoding="utf-8")

    capture_start = settings_html.index('<div class="setting-group full-width" data-tab="capture">')
    capture_end = settings_html.index('<div class="setting-group" data-tab="capture">', capture_start)
    primary_capture_group = settings_html[capture_start:capture_end]

    assert "Text Appears Instantly" in primary_capture_group
    assert 'id="text_appears_instantly"' in primary_capture_group
    assert "Yomitan lookups can miss characters" in primary_capture_group
    assert 'createCheckboxBinding("text_appears_instantly", "#text_appears_instantly")' in settings_html
    assert 'text_appears_instantly: "text_appears_instantly"' in main_js


def test_overlay_activation_scan_covers_each_overlay_entrypoint():
    main_js = (OVERLAY_DIR / "main.js").read_text(encoding="utf-8")
    index_html = (OVERLAY_DIR / "index.html").read_text(encoding="utf-8")

    assert 'requestOverlayScanForActivation("push-to-show")' in main_js
    assert 'requestOverlayScanForActivation("controller-navigation")' in main_js
    assert 'requestOverlayScanForActivation("main-box-show")' in main_js
    assert "overlay-main-box-shown" in index_html
