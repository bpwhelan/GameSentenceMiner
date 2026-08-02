from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
OVERLAY_DIR = REPO_ROOT / "GSM_Overlay"


def test_renderer_forwards_exclusive_fullscreen_state_to_main_process():
    index_html = (OVERLAY_DIR / "index.html").read_text(encoding="utf-8")

    assert "isExclusiveFullscreen: data.is_exclusive_fullscreen || false" in index_html


def test_main_process_prioritizes_fullscreen_mode_recommendation():
    main_js = (OVERLAY_DIR / "main.js").read_text(encoding="utf-8")

    assert "isExclusiveFullscreen" in main_js
    assert "maybeShowFullscreenModeRecommendation(game)" in main_js
    assert "Math.min(850, workArea.height)" in main_js
    assert "dismissedExclusiveFullscreenRecommendations" in main_js
    assert "https://github.com/Blinue/Magpie" in main_js
    assert "https://www.special-k.info/" in main_js


def test_fullscreen_recommendation_explains_both_workarounds():
    recommendation_html = OVERLAY_DIR / "fullscreen-mode-recommendation.html"

    assert recommendation_html.is_file()
    page = recommendation_html.read_text(encoding="utf-8")
    assert "Exclusive fullscreen detected" in page
    assert "Borderless Fullscreen" in page
    assert "Windowed" in page
    assert "Magpie" in page
    assert "Special K" in page
    assert "anti-cheat" in page
