from types import SimpleNamespace

import pytest

from GameSentenceMiner.ocr import adhoc_ocr
from GameSentenceMiner.owocr.owocr import ocr as ocr_module


@pytest.mark.parametrize("override", ["glens", "bing"])
def test_online_override_takes_precedence_over_loaded_main_engine(monkeypatch, override):
    local = object()
    lens = object()
    bing = object()
    overlay = SimpleNamespace(screenai=local, _get_effective_engine=lambda: "screenai")
    monkeypatch.setattr(adhoc_ocr, "_get_overlay_processor", lambda: overlay)
    monkeypatch.setattr(adhoc_ocr, "get_ocr_ocr2", lambda: "screenai")
    monkeypatch.setattr(adhoc_ocr, "get_ocr_menu_area_engine", lambda: override)
    monkeypatch.setattr(adhoc_ocr, "_get_default_lens", lambda: lens)
    monkeypatch.setattr(adhoc_ocr, "_get_bing", lambda: bing)

    primary, fallback = adhoc_ocr._resolve_engines()

    assert primary == ((lens, "lens") if override == "glens" else (bing, "bing"))
    assert fallback == (local, "screenai")


def test_main_bing_engine_is_used_without_overlay(monkeypatch):
    bing = object()
    monkeypatch.setattr(adhoc_ocr, "_get_overlay_processor", lambda: None)
    monkeypatch.setattr(adhoc_ocr, "get_ocr_menu_area_engine", lambda: "main")
    monkeypatch.setattr(adhoc_ocr, "get_ocr_ocr2", lambda: "bing")
    monkeypatch.setattr(adhoc_ocr, "_get_bing", lambda: bing)
    assert adhoc_ocr._resolve_engines() == ((bing, "bing"), (None, None))


def test_main_does_not_load_a_different_local_model(monkeypatch):
    lens = object()
    monkeypatch.setattr(adhoc_ocr, "_get_overlay_processor", lambda: None)
    monkeypatch.setattr(adhoc_ocr, "get_ocr_menu_area_engine", lambda: "main")
    monkeypatch.setattr(adhoc_ocr, "get_ocr_ocr2", lambda: "vitaocr")
    monkeypatch.setattr(adhoc_ocr, "_get_default_lens", lambda: lens)
    monkeypatch.setattr(ocr_module, "VitaOCR", lambda **_kwargs: pytest.fail("Must not load another local model"))
    assert adhoc_ocr._resolve_engines() == ((lens, "lens"), (None, None))


def test_bing_engine_is_created_once_without_local_models(monkeypatch):
    created = []

    def create(**kwargs):
        engine = SimpleNamespace(**kwargs)
        created.append(engine)
        return engine

    monkeypatch.setattr(adhoc_ocr, "_bing_engine", None)
    monkeypatch.setattr(adhoc_ocr, "get_ocr_language", lambda: "en")
    monkeypatch.setattr(ocr_module, "Bing", create)
    assert adhoc_ocr._get_bing() is adhoc_ocr._get_bing()
    assert len(created) == 1
    assert created[0].lang == "en"
