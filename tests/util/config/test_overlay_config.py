from __future__ import annotations

import json
from pathlib import Path

from GameSentenceMiner.util.config.configuration import Overlay


def test_overlay_use_ocr_result_defaults_to_true():
    assert Overlay().use_ocr_result is True


def test_overlay_use_ocr_result_round_trip_and_backward_compatibility():
    overlay = Overlay(use_ocr_result=False)
    data = overlay.to_dict()

    assert data["use_ocr_result"] is False
    assert Overlay.from_dict(data).use_ocr_result is False

    data_without_field = dict(data)
    data_without_field.pop("use_ocr_result", None)
    assert Overlay.from_dict(data_without_field).use_ocr_result is True


def test_overlay_locales_include_use_ocr_result_strings():
    root = Path(__file__).resolve().parents[3]
    locales_dir = root / "GameSentenceMiner" / "locales"
    locale_names = ("en_us", "ja_jp", "zh_cn", "es_es")

    for locale_name in locale_names:
        locale_data = json.loads((locales_dir / f"{locale_name}.json").read_text(encoding="utf-8"))
        use_ocr_result = locale_data["python"]["config"]["tabs"]["overlay"]["use_ocr_result"]
        assert use_ocr_result["label"]
        assert use_ocr_result["tooltip"]
