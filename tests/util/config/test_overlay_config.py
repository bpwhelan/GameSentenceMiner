from __future__ import annotations

import json
from pathlib import Path

from GameSentenceMiner.util.config import configuration
from GameSentenceMiner.util.platform import monitor_selection
from GameSentenceMiner.util.config.configuration import Config, Overlay, ProcessPausing, ProfileConfig


def test_overlay_use_ocr_result_defaults_to_true():
    assert Overlay().use_ocr_result_v2 is False


def test_overlay_ocr_area_subset_defaults_preserve_existing_behavior():
    overlay = Overlay()

    assert overlay.use_overlay_area_config is False
    assert overlay.ocr_area_config_include_primary_areas is True
    assert overlay.ocr_area_config_include_secondary_areas is True
    assert overlay.ocr_area_config_use_exclusion_zones is True


def test_overlay_use_ocr_result_round_trip_and_backward_compatibility():
    overlay = Overlay(use_ocr_result_v2=False)
    data = overlay.to_dict()

    assert data["use_ocr_result_v2"] is False
    assert Overlay.from_dict(data).use_ocr_result_v2 is False

    data_without_field = dict(data)
    data_without_field.pop("use_ocr_result_v2", None)
    assert Overlay.from_dict(data_without_field).use_ocr_result_v2 is False


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


def test_overlay_monitor_identity_round_trip_and_backward_compatibility(monkeypatch):
    monkeypatch.setattr(
        monitor_selection,
        "get_mss_monitor_descriptors",
        lambda: [
            {
                "index": 0,
                "id": "bounds:0:0:1920:1080",
                "bounds": {"left": 0, "top": 0, "width": 1920, "height": 1080},
            },
            {
                "index": 1,
                "id": "bounds:1920:0:1920:1080",
                "bounds": {"left": 1920, "top": 0, "width": 1920, "height": 1080},
            },
        ],
    )
    overlay = Overlay(
        monitor_to_capture=1,
        monitor_to_capture_id="bounds:1920:0:1920:1080",
        monitor_to_capture_bounds={"left": 1920, "top": 0, "width": 1920, "height": 1080},
    )
    data = overlay.to_dict()

    restored = Overlay.from_dict(data)
    assert restored.monitor_to_capture == 1
    assert restored.monitor_to_capture_id == "bounds:1920:0:1920:1080"
    assert restored.monitor_to_capture_bounds == {"left": 1920, "top": 0, "width": 1920, "height": 1080}

    data_without_fields = dict(data)
    data_without_fields.pop("monitor_to_capture_id", None)
    data_without_fields.pop("monitor_to_capture_bounds", None)
    restored_without_fields = Overlay.from_dict(data_without_fields)
    assert isinstance(restored_without_fields.monitor_to_capture_id, str)
    assert isinstance(restored_without_fields.monitor_to_capture_bounds, dict)


def test_global_overlay_config_is_authoritative(monkeypatch):
    config = Config(
        configs={
            "Default": ProfileConfig(overlay=Overlay(periodic=False)),
        },
        current_profile="Default",
        overlay=Overlay(periodic=True),
    )

    monkeypatch.setattr(configuration, "config_instance", config)

    assert configuration.get_overlay_config().periodic is True
    assert config.get_config().overlay is config.overlay


def test_legacy_profile_overlay_migrates_when_global_overlay_missing():
    raw_config = {
        "configs": {
            "Default": ProfileConfig(overlay=Overlay(periodic=True)).to_dict(),
        },
        "current_profile": "Default",
    }

    migrated = Config._migrate_raw_data(raw_config)

    assert migrated["overlay"]["periodic"] is True


def test_legacy_global_process_pausing_migrates_into_profiles():
    legacy_process_pausing = ProcessPausing(
        enabled=True,
        auto_resume_seconds=45,
        denylist=["steam.exe"],
    ).to_dict()
    legacy_process_pausing["allowlist"] = ["game.exe"]
    raw_config = {
        "configs": {
            "Default": ProfileConfig().to_dict(),
            "Game": ProfileConfig().to_dict(),
        },
        "current_profile": "Default",
        "process_pausing": legacy_process_pausing,
    }
    for profile_data in raw_config["configs"].values():
        profile_data.pop("process_pausing", None)

    migrated = Config._migrate_raw_data(raw_config)

    assert "process_pausing" not in migrated
    assert migrated["configs"]["Default"]["process_pausing"]["enabled"] is True
    assert migrated["configs"]["Default"]["process_pausing"]["auto_resume_seconds"] == 45
    assert "allowlist" not in migrated["configs"]["Game"]["process_pausing"]
    assert migrated["configs"]["Game"]["process_pausing"]["denylist"] == ["steam.exe"]


def test_deprecated_process_pausing_allowlist_removed_from_profileless_config():
    config_data = {
        "process_pausing": {
            "allowlist": ["game.exe"],
            "denylist": ["steam.exe"],
        },
    }

    migrated = configuration._remove_deprecated_config_settings(config_data)

    assert "allowlist" not in migrated["process_pausing"]
    assert migrated["process_pausing"]["denylist"] == ["steam.exe"]


def test_process_pausing_is_profile_scoped_round_trip():
    config = Config(
        configs={
            "Default": ProfileConfig(process_pausing=ProcessPausing(enabled=True)),
            "Game": ProfileConfig(process_pausing=ProcessPausing(enabled=False)),
        },
        current_profile="Game",
    )

    data = config.to_dict()
    restored = Config.from_dict(data)

    assert "process_pausing" not in data
    assert restored.configs["Default"].process_pausing.enabled is True
    assert restored.get_config().process_pausing.enabled is False


def test_overlay_locales_include_use_ocr_result_strings():
    root = Path(__file__).resolve().parents[3]
    locales_dir = root / "GameSentenceMiner" / "locales"
    locale_names = ("en_us", "ja_jp", "zh_cn", "es_es", "ko_kr", "ukr_ua")

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
