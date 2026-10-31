from types import SimpleNamespace

from GameSentenceMiner.ocr import adhoc_ocr
from GameSentenceMiner.util.config.configuration import OverlayEngine
from GameSentenceMiner.util.overlay import get_overlay_coords


def test_vita_can_be_selected_and_loaded_once_for_overlay(monkeypatch):
    assert OverlayEngine("vitaocr").value == "vitaocr"
    created = []

    def create(**kwargs):
        model = SimpleNamespace(available=True, **kwargs)
        created.append(model)
        return model

    monkeypatch.setattr(get_overlay_coords, "VitaOCR", create)
    processor = get_overlay_coords.OverlayProcessor()
    monkeypatch.setattr(processor, "_get_effective_engine", lambda: "vitaocr")
    first = processor._load_local_ocr_engine()
    assert processor._load_local_ocr_engine() is first
    assert len(created) == 1
    assert first.get_furigana_sens_from_file is False
    assert processor.lens is None


def test_vita_overlay_instance_is_reused_for_area_select(monkeypatch):
    model = object()
    overlay = SimpleNamespace(vitaocr=model, _get_effective_engine=lambda: "vitaocr")
    monkeypatch.setattr(adhoc_ocr, "_get_overlay_processor", lambda: overlay)
    monkeypatch.setattr(adhoc_ocr, "get_ocr_ocr2", lambda: "vitaocr")
    primary, fallback = adhoc_ocr._resolve_engines()
    assert primary == (model, "vitaocr")
    assert fallback == (model, "vitaocr")


def test_vita_is_released_when_overlay_engines_are_unloaded():
    processor = get_overlay_coords.OverlayProcessor()
    closed = []
    processor.vitaocr = SimpleNamespace(close=lambda: closed.append(True))
    processor._close_ocr_engines()
    assert closed == [True]
    assert processor.vitaocr is None
