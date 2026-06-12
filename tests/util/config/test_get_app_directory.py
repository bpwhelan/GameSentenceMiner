import json
import os
import sys

from GameSentenceMiner.util.config import configuration


def _legacy_app_directory():
    # The exact expression get_app_directory used before the relocation feature existed.
    if sys.platform == "win32":
        appdata_dir = os.getenv("APPDATA")
    else:
        appdata_dir = configuration.sanitize_and_resolve_path("~/.config")
    return os.path.join(appdata_dir, "GameSentenceMiner")


def test_defaults_to_appdata_when_no_override(monkeypatch):
    monkeypatch.delenv("GSM_DATA_DIR", raising=False)
    expected = configuration.get_default_app_directory()
    # Ensure no leftover pointer from another test influences this.
    pointer = os.path.join(expected, "data_dir.json")
    if os.path.exists(pointer):
        os.remove(pointer)
    assert configuration.get_app_directory() == expected


def test_backward_compatible_with_legacy_location(monkeypatch):
    # Existing/new installs (no env, no pointer) resolve to the pre-feature location exactly.
    monkeypatch.delenv("GSM_DATA_DIR", raising=False)
    legacy = _legacy_app_directory()
    pointer = os.path.join(legacy, "data_dir.json")
    if os.path.exists(pointer):
        os.remove(pointer)
    assert configuration.get_default_app_directory() == legacy
    assert configuration.get_app_directory() == legacy


def test_env_var_takes_precedence(monkeypatch, tmp_path):
    target = tmp_path / "env_data"
    monkeypatch.setenv("GSM_DATA_DIR", str(target))
    assert configuration.get_app_directory() == str(target)
    assert target.is_dir()  # created on resolve


def test_pointer_file_used_when_no_env(monkeypatch, tmp_path):
    monkeypatch.delenv("GSM_DATA_DIR", raising=False)
    default_dir = configuration.get_default_app_directory()
    os.makedirs(default_dir, exist_ok=True)
    target = tmp_path / "pointer_data"
    with open(os.path.join(default_dir, "data_dir.json"), "w", encoding="utf-8") as f:
        json.dump({"dataDir": str(target)}, f)
    try:
        assert configuration.get_app_directory() == str(target)
    finally:
        os.remove(os.path.join(default_dir, "data_dir.json"))


def test_env_var_overrides_pointer(monkeypatch, tmp_path):
    default_dir = configuration.get_default_app_directory()
    os.makedirs(default_dir, exist_ok=True)
    pointer_target = tmp_path / "pointer_data"
    env_target = tmp_path / "env_data"
    with open(os.path.join(default_dir, "data_dir.json"), "w", encoding="utf-8") as f:
        json.dump({"dataDir": str(pointer_target)}, f)
    monkeypatch.setenv("GSM_DATA_DIR", str(env_target))
    try:
        assert configuration.get_app_directory() == str(env_target)
    finally:
        os.remove(os.path.join(default_dir, "data_dir.json"))


def test_malformed_pointer_falls_back_to_default(monkeypatch):
    monkeypatch.delenv("GSM_DATA_DIR", raising=False)
    default_dir = configuration.get_default_app_directory()
    os.makedirs(default_dir, exist_ok=True)
    with open(os.path.join(default_dir, "data_dir.json"), "w", encoding="utf-8") as f:
        f.write("not json")
    try:
        assert configuration.get_app_directory() == default_dir
    finally:
        os.remove(os.path.join(default_dir, "data_dir.json"))
