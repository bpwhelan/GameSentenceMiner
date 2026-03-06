from __future__ import annotations

from types import SimpleNamespace

from PIL import Image

import GameSentenceMiner.ocr.gsm_ocr as gsm_ocr
from GameSentenceMiner.owocr.owocr import run as run_module


def test_resolve_requested_engines_prioritizes_cli_values():
    engines = run_module._resolve_requested_engines(
        "meikiocr",
        "glens",
        requested_engine="alivetext",
        requested_ocr1="alivetext",
        requested_ocr2="alivetext",
    )

    assert engines[0] == "alivetext"
    assert engines.count("alivetext") == 1
    assert "meikiocr" in engines
    assert "glens" in engines


def test_resolve_requested_engines_falls_back_to_config_values():
    engines = run_module._resolve_requested_engines(
        "meikiocr",
        "glens",
        requested_engine=None,
        requested_ocr1=None,
        requested_ocr2=None,
    )

    assert engines == ["meikiocr", "glens"]


def test_run_oneocr_disables_manual_combo_in_auto_mode(monkeypatch):
    captured = {}

    monkeypatch.setattr(gsm_ocr.run, "init_config", lambda _parse_args: None)
    monkeypatch.setattr(gsm_ocr.run, "run", lambda **kwargs: captured.update(kwargs))

    monkeypatch.setattr(gsm_ocr, "obs_ocr", True)
    monkeypatch.setattr(gsm_ocr, "window", None)
    monkeypatch.setattr(gsm_ocr, "ss_clipboard", False, raising=False)
    monkeypatch.setattr(gsm_ocr, "ocr1", "alivetext", raising=False)
    monkeypatch.setattr(gsm_ocr, "ocr2", "alivetext", raising=False)
    monkeypatch.setattr(gsm_ocr, "manual", False)
    monkeypatch.setattr(gsm_ocr, "manual_ocr_hotkey_combo", "<alt>+b")
    monkeypatch.setattr(gsm_ocr, "global_pause_hotkey", "ctrl+shift+p")
    monkeypatch.setattr(gsm_ocr, "furigana_filter_sensitivity", 0)
    monkeypatch.setattr(gsm_ocr, "ocr_result_callback", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(gsm_ocr, "get_ocr_scan_rate", lambda: 0.5)

    gsm_ocr.run_oneocr(None, [])

    assert captured["screen_capture_combo"] == ""


def test_run_oneocr_uses_manual_combo_in_manual_mode(monkeypatch):
    captured = {}

    monkeypatch.setattr(gsm_ocr.run, "init_config", lambda _parse_args: None)
    monkeypatch.setattr(gsm_ocr.run, "run", lambda **kwargs: captured.update(kwargs))

    monkeypatch.setattr(gsm_ocr, "obs_ocr", True)
    monkeypatch.setattr(gsm_ocr, "window", None)
    monkeypatch.setattr(gsm_ocr, "ss_clipboard", False, raising=False)
    monkeypatch.setattr(gsm_ocr, "ocr1", "alivetext", raising=False)
    monkeypatch.setattr(gsm_ocr, "ocr2", "alivetext", raising=False)
    monkeypatch.setattr(gsm_ocr, "manual", True)
    monkeypatch.setattr(gsm_ocr, "manual_ocr_hotkey_combo", "<alt>+b")
    monkeypatch.setattr(gsm_ocr, "global_pause_hotkey", "ctrl+shift+p")
    monkeypatch.setattr(gsm_ocr, "furigana_filter_sensitivity", 0)
    monkeypatch.setattr(gsm_ocr, "ocr_result_callback", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(gsm_ocr, "get_ocr_scan_rate", lambda: 0.5)

    gsm_ocr.run_oneocr(None, [])

    assert captured["screen_capture_combo"] == "<alt>+b"


def test_apply_ocr_config_to_image_supports_grayscale_masking():
    img = Image.new("L", (12, 12), color=255)
    config = SimpleNamespace(
        rectangles=[
            SimpleNamespace(coordinates=[0, 0, 3, 3], is_excluded=True, is_secondary=False),
            SimpleNamespace(coordinates=[0, 0, 12, 12], is_excluded=False, is_secondary=False),
        ]
    )

    processed, offset = run_module.apply_ocr_config_to_image(
        img,
        config,
        return_full_size=False,
    )

    assert processed.mode == "L"
    assert offset == (0, 0)
    assert processed.getpixel((0, 0)) == 0
    assert processed.getpixel((8, 8)) == 255
