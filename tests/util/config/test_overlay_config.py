from __future__ import annotations

import json
from pathlib import Path

from GameSentenceMiner.util.config.configuration import Overlay


def test_overlay_use_ocr_result_defaults_to_true():
    assert Overlay().use_ocr_result is True


def test_overlay_ocr_area_subset_defaults_preserve_existing_behavior():
    overlay = Overlay()

    assert overlay.use_overlay_area_config is False
    assert overlay.ocr_area_config_include_primary_areas is True
    assert overlay.ocr_area_config_include_secondary_areas is True
    assert overlay.ocr_area_config_use_exclusion_zones is True


def test_overlay_use_ocr_result_round_trip_and_backward_compatibility():
    overlay = Overlay(use_ocr_result=False)
    data = overlay.to_dict()

    assert data["use_ocr_result"] is False
    assert Overlay.from_dict(data).use_ocr_result is False

    data_without_field = dict(data)
    data_without_field.pop("use_ocr_result", None)
    assert Overlay.from_dict(data_without_field).use_ocr_result is True


def test_overlay_ocr_area_subset_round_trip_and_backward_compatibility():
    overlay = Overlay(
        ocr_area_config_include_primary_areas=False,
        ocr_area_config_include_secondary_areas=True,
        ocr_area_config_use_exclusion_zones=False,
    )
    data = overlay.to_dict()

    assert data["ocr_area_config_include_primary_areas"] is False
    assert data["ocr_area_config_include_secondary_areas"] is True
    assert data["ocr_area_config_use_exclusion_zones"] is False

    restored = Overlay.from_dict(data)
    assert restored.ocr_area_config_include_primary_areas is False
    assert restored.ocr_area_config_include_secondary_areas is True
    assert restored.ocr_area_config_use_exclusion_zones is False

    data_without_fields = dict(data)
    data_without_fields.pop("ocr_area_config_include_primary_areas", None)
    data_without_fields.pop("ocr_area_config_include_secondary_areas", None)
    data_without_fields.pop("ocr_area_config_use_exclusion_zones", None)

    restored_without_fields = Overlay.from_dict(data_without_fields)
    assert restored_without_fields.use_overlay_area_config is False
    assert restored_without_fields.ocr_area_config_include_primary_areas is True
    assert restored_without_fields.ocr_area_config_include_secondary_areas is True
    assert restored_without_fields.ocr_area_config_use_exclusion_zones is True


def test_overlay_use_overlay_area_config_round_trip_and_backward_compatibility():
    overlay = Overlay(use_overlay_area_config=True)
    data = overlay.to_dict()

    assert data["use_overlay_area_config"] is True
    assert Overlay.from_dict(data).use_overlay_area_config is True

    data_without_field = dict(data)
    data_without_field.pop("use_overlay_area_config", None)
    assert Overlay.from_dict(data_without_field).use_overlay_area_config is False


def test_overlay_locales_include_use_ocr_result_strings():
    root = Path(__file__).resolve().parents[3]
    locales_dir = root / "GameSentenceMiner" / "locales"
    locale_names = ("en_us", "ja_jp", "zh_cn", "es_es")

    for locale_name in locale_names:
        locale_data = json.loads((locales_dir / f"{locale_name}.json").read_text(encoding="utf-8"))
        use_ocr_result = locale_data["python"]["config"]["tabs"]["overlay"]["use_ocr_result"]
        assert use_ocr_result["label"]
        assert use_ocr_result["tooltip"]

        include_primary = locale_data["python"]["config"]["tabs"]["overlay"]["ocr_area_config_include_primary_areas"]
        include_secondary = locale_data["python"]["config"]["tabs"]["overlay"][
            "ocr_area_config_include_secondary_areas"
        ]
        use_exclusions = locale_data["python"]["config"]["tabs"]["overlay"]["ocr_area_config_use_exclusion_zones"]
        use_overlay_area = locale_data["python"]["config"]["tabs"]["overlay"]["use_overlay_area_config"]
        overlay_selector_button = locale_data["python"]["config"]["tabs"]["overlay"]["overlay_area_selector_button"]

        assert include_primary["label"]
        assert include_primary["tooltip"]
        assert include_secondary["label"]
        assert include_secondary["tooltip"]
        assert use_exclusions["label"]
        assert use_exclusions["tooltip"]
        assert use_overlay_area["label"]
        assert use_overlay_area["tooltip"]
        assert overlay_selector_button["label"]
        assert overlay_selector_button["tooltip"]
