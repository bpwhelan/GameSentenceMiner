import json
from copy import deepcopy

import pytest

from GameSentenceMiner.util.config import configuration as config


def test_new_and_missing_vad_settings_default_to_silero_without_backup():
    for vad in (config.VAD(), config.VAD.from_dict({}), config.ProfileConfig.from_dict({}).vad):
        assert vad.selected_vad_model_v2 == config.SILERO
        assert vad.backup_vad_model == config.OFF


@pytest.mark.parametrize("loader", [config.Config.load, config.load_config])
def test_existing_firered_defaults_migrate_in_all_profiles_and_allow_later_opt_in(tmp_path, monkeypatch, loader):
    config_path = tmp_path / "config.json"
    raw = config.Config.new().to_dict()
    raw["version"] = config.get_current_version()
    raw["configs"] = {}
    cases = {
        "Default": (config.FIRERED, config.OFF, config.SILERO),
        "Game": (config.FIRERED, config.OFF, config.SILERO),
        "FireRed with backup": (config.FIRERED, config.WHISPER, config.FIRERED),
        "FireRed with Silero": (config.FIRERED, config.SILERO, config.FIRERED),
        "Whisper": (config.WHISPER, config.OFF, config.WHISPER),
        "Silero with backup": (config.SILERO, config.FIRERED, config.SILERO),
        "Disabled": (config.OFF, config.OFF, config.OFF),
    }
    for name, (primary, backup, _expected) in cases.items():
        profile = config.ProfileConfig(name=name).to_dict()
        profile["vad"] = {
            "selected_vad_model_v2": primary,
            "backup_vad_model": backup,
            "beginning_offset": -0.37,
            "trim_beginning": True,
            "do_vad_postprocessing": False,
        }
        raw["configs"][name] = profile
    config_path.write_text(json.dumps(raw), encoding="utf-8")
    monkeypatch.setattr(config, "get_config_path", lambda: str(config_path))

    loaded = loader()

    for name, (_primary, backup, expected) in cases.items():
        vad = loaded.configs[name].vad
        assert vad.selected_vad_model_v2 == expected
        assert vad.backup_vad_model == backup
        assert vad.beginning_offset == -0.37
        assert vad.trim_beginning is True
        assert vad.do_vad_postprocessing is False

    # Saving/reloading must not force a user who explicitly selects FireRed back
    # to Silero, including profiles that were ineligible for the migration.
    loaded.configs["Default"].vad.selected_vad_model_v2 = config.FIRERED
    loaded.configs["FireRed with backup"].vad.backup_vad_model = config.OFF
    loaded.save()
    reloaded = loader()
    assert reloaded.configs["Default"].vad.selected_vad_model_v2 == config.FIRERED
    assert reloaded.configs["FireRed with backup"].vad.selected_vad_model_v2 == config.FIRERED
    assert reloaded.configs["Game"].vad.selected_vad_model_v2 == config.SILERO


@pytest.mark.parametrize("vad_settings", [None, {}, {"selected_vad_model_v2": config.FIRERED}])
def test_migration_handles_missing_vad_and_backup_settings(vad_settings):
    profile = {} if vad_settings is None else {"vad": vad_settings}
    raw = {"configs": {"Default": profile}}

    migrated = config.Config._migrate_raw_data(deepcopy(raw))
    loaded = config.Config.from_dict(migrated)

    assert loaded.get_config().vad.selected_vad_model_v2 == config.SILERO
    assert loaded.get_config().vad.backup_vad_model == config.OFF
    assert config.Config._migrate_raw_data(deepcopy(migrated)) == migrated


def test_legacy_profileless_config_migrates_firered_default(tmp_path, monkeypatch):
    config_path = tmp_path / "config.json"
    raw = config.ProfileConfig().to_dict()
    raw["vad"] = {"selected_vad_model_v2": config.FIRERED, "backup_vad_model": config.OFF}
    config_path.write_text(json.dumps(raw), encoding="utf-8")
    monkeypatch.setattr(config, "get_config_path", lambda: str(config_path))

    loaded = config.load_config()

    assert loaded.get_config().vad.selected_vad_model_v2 == config.SILERO
    assert loaded.get_config().vad.backup_vad_model == config.OFF
    assert (
        json.loads(config_path.read_text(encoding="utf-8"))["configs"]["Default"]["vad"]["selected_vad_model_v2"]
        == config.SILERO
    )
