import json
from copy import deepcopy

import pytest

from GameSentenceMiner.util.config import configuration as config


def test_new_and_missing_vad_settings_default_to_firered_without_backup():
    for vad in (config.VAD(), config.VAD.from_dict({}), config.ProfileConfig.from_dict({}).vad):
        assert vad.selected_vad_model_v2 == config.FIRERED
        assert vad.backup_vad_model == config.OFF


@pytest.mark.parametrize("loader", [config.Config.load, config.load_config])
def test_unmarked_profiles_adopt_firered_once_and_preserve_later_choices(tmp_path, monkeypatch, loader):
    config_path = tmp_path / "config.json"
    raw = config.Config.new().to_dict()
    raw["version"] = config.get_current_version()
    raw["configs"] = {}
    cases = {
        "Default": (config.FIRERED, config.OFF, config.FIRERED, config.OFF),
        "Game": (config.SILERO, config.OFF, config.FIRERED, config.OFF),
        "FireRed with backup": (config.FIRERED, config.WHISPER, config.FIRERED, config.WHISPER),
        "FireRed with Silero": (config.FIRERED, config.SILERO, config.FIRERED, config.SILERO),
        "Whisper": (config.WHISPER, config.OFF, config.WHISPER, config.OFF),
        "Silero with backup": (config.SILERO, config.FIRERED, config.FIRERED, config.OFF),
        "Disabled": (config.OFF, config.OFF, config.FIRERED, config.OFF),
        "Explicit Silero": (config.SILERO, config.OFF, config.SILERO, config.OFF),
        "Explicit Disabled": (config.OFF, config.OFF, config.OFF, config.OFF),
    }
    for name, (primary, backup, _expected, _expected_backup) in cases.items():
        profile = config.ProfileConfig(name=name).to_dict()
        profile["vad"] = {
            "selected_vad_model_v2": primary,
            "backup_vad_model": backup,
            "beginning_offset": -0.37,
            "trim_beginning": True,
            "do_vad_postprocessing": False,
            "firered_default_migrated": name.startswith("Explicit"),
        }
        raw["configs"][name] = profile
    config_path.write_text(json.dumps(raw), encoding="utf-8")
    monkeypatch.setattr(config, "get_config_path", lambda: str(config_path))

    loaded = loader()

    for name, (_primary, _backup, expected, expected_backup) in cases.items():
        vad = loaded.configs[name].vad
        assert vad.selected_vad_model_v2 == expected
        assert vad.backup_vad_model == expected_backup
        assert vad.beginning_offset == -0.37
        assert vad.trim_beginning is True
        assert vad.do_vad_postprocessing is False

    # Saving/reloading must preserve explicit choices and backup changes.
    loaded.configs["Default"].vad.selected_vad_model_v2 = config.SILERO
    loaded.configs["FireRed with backup"].vad.backup_vad_model = config.OFF
    loaded.save()
    reloaded = loader()
    assert reloaded.configs["Default"].vad.selected_vad_model_v2 == config.SILERO
    assert reloaded.configs["FireRed with backup"].vad.selected_vad_model_v2 == config.FIRERED
    assert reloaded.configs["Game"].vad.selected_vad_model_v2 == config.FIRERED


@pytest.mark.parametrize("vad_settings", [None, {}, {"selected_vad_model_v2": config.FIRERED}])
def test_migration_handles_missing_vad_and_backup_settings(vad_settings):
    profile = {} if vad_settings is None else {"vad": vad_settings}
    raw = {"configs": {"Default": profile}}

    migrated = config.Config._migrate_raw_data(deepcopy(raw))
    loaded = config.Config.from_dict(migrated)

    assert loaded.get_config().vad.selected_vad_model_v2 == config.FIRERED
    assert loaded.get_config().vad.backup_vad_model == config.OFF
    assert config.Config._migrate_raw_data(deepcopy(migrated)) == migrated


def test_legacy_profileless_config_preserves_firered_choice(tmp_path, monkeypatch):
    config_path = tmp_path / "config.json"
    raw = config.ProfileConfig().to_dict()
    raw["vad"] = {"selected_vad_model_v2": config.FIRERED, "backup_vad_model": config.OFF}
    config_path.write_text(json.dumps(raw), encoding="utf-8")
    monkeypatch.setattr(config, "get_config_path", lambda: str(config_path))

    loaded = config.load_config()

    assert loaded.get_config().vad.selected_vad_model_v2 == config.FIRERED
    assert loaded.get_config().vad.backup_vad_model == config.OFF
    assert (
        json.loads(config_path.read_text(encoding="utf-8"))["configs"]["Default"]["vad"]["selected_vad_model_v2"]
        == config.FIRERED
    )
