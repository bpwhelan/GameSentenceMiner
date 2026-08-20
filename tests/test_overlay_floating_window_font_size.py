from pathlib import Path


OVERLAY_DIR = Path(__file__).resolve().parents[1] / "GSM_Overlay"


def test_settings_page_exposes_floating_window_font_size():
    settings_html = (OVERLAY_DIR / "settings.html").read_text(encoding="utf-8")

    assert 'id="fontSize"' in settings_html
    assert 'createNumberBinding("fontSize", "#fontSize"' in settings_html
    assert "Floating Window Font Size" in settings_html


def test_floating_toolbar_edits_and_tracks_persisted_font_size():
    index_html = (OVERLAY_DIR / "index.html").read_text(encoding="utf-8")
    main_js = (OVERLAY_DIR / "main.js").read_text(encoding="utf-8")

    assert 'id="btn-font-size"' in index_html
    assert 'id="font-size-popover"' in index_html
    assert 'id="floating-font-size"' in index_html
    assert 'type="range"' in index_html
    assert 'type="number"' not in index_html
    assert 'aria-orientation="vertical"' in index_html
    assert "toggleFontSizePopover" in index_html
    assert "applyFloatingWindowFontSize(newsettings.fontSize)" in index_html
    assert 'case "fontSize":' in index_html
    assert "applyFloatingWindowFontSize(value)" in index_html
    assert 'key: "fontSize"' in index_html
    assert 'key === "fontSize"' in main_js
    assert 'settingsWindow.webContents.send("settings-updated", settingUpdate)' in main_js
