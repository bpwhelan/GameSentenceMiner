import json
import os
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

from GameSentenceMiner.util import data_directory
from GameSentenceMiner.util.database.data_dir_migration import recover_legacy_database


@pytest.fixture(autouse=True)
def isolated_profile(monkeypatch, tmp_path):
    monkeypatch.setenv("APPDATA", str(tmp_path / "appdata"))
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("USERPROFILE", str(tmp_path / "home"))
    monkeypatch.setenv("GSM_PROFILE_DIR", str(tmp_path / "profile"))
    monkeypatch.delenv("GSM_SHARED_DATA_DIR", raising=False)
    monkeypatch.setenv("GSM_DATA_DIR", str(tmp_path / "old-child-data"))


def test_profile_wins_over_child_environment_and_invalid_pointer(tmp_path):
    pointer = data_directory.get_pointer_path()
    pointer.parent.mkdir(parents=True)
    pointer.write_text("broken", encoding="utf-8")
    assert data_directory.get_app_directory() == str(tmp_path / "profile")
    recover_legacy_database(str(tmp_path / "profile"))
    assert pointer.read_text(encoding="utf-8") == "broken"


def test_shared_assets_resolve_saved_location_without_migrating(tmp_path):
    legacy = Path(data_directory.get_default_app_directory()) / "data_dir.json"
    legacy.parent.mkdir(parents=True)
    content = json.dumps({"dataDir": str(tmp_path / "shared")})
    legacy.write_text(content, encoding="utf-8")
    assert data_directory.get_shared_app_directory() == str(tmp_path / "shared")
    assert legacy.read_text(encoding="utf-8") == content
    if legacy != data_directory.get_pointer_path():
        assert not data_directory.get_pointer_path().exists()


def test_profile_never_commits_a_global_location(tmp_path):
    with pytest.raises(ValueError, match="profile"):
        data_directory.write_data_dir_pointer({"dataDir": str(tmp_path / "elsewhere")})
    assert not data_directory.get_pointer_path().exists()


def test_profile_ocr_and_recordings_paths(tmp_path):
    assert data_directory.get_owocr_config_path() == str(tmp_path / "profile" / "owocr_config_gsm.ini")
    assert data_directory.get_default_recordings_directory() == str(tmp_path / "profile" / "recordings")


def test_shared_environment_is_independent_of_profile(tmp_path, monkeypatch):
    shared = tmp_path / "shared"
    monkeypatch.setenv("GSM_SHARED_DATA_DIR", str(shared))
    assert data_directory.get_shared_app_directory() == str(shared)
    monkeypatch.setenv("GSM_PROFILE_DIR", str(tmp_path / "second"))
    assert data_directory.get_shared_app_directory() == str(shared)
    assert data_directory.get_app_directory() == str(tmp_path / "second")


def test_vocr_shares_model_bytes_but_keeps_selection_in_each_profile(tmp_path, monkeypatch):
    from GameSentenceMiner.ocr import vita_ocr

    monkeypatch.setenv("GSM_SHARED_DATA_DIR", str(tmp_path / "shared"))
    monkeypatch.delenv("GSM_VITA_OCR_DIR", raising=False)
    assets = vita_ocr.get_install_directory()
    assert assets == tmp_path / "shared" / "ocr" / "vita-vn-ocr"
    assets.mkdir(parents=True)
    original = json.dumps({"model": "large", "revision": vita_ocr.UPSTREAM_REVISION})
    (assets / "installation.json").write_text(original, encoding="utf-8")
    assert vita_ocr.read_model_selection() == "normal"
    vita_ocr.write_installation(assets, "small")
    assert vita_ocr.read_model_selection() == "small"
    monkeypatch.setenv("GSM_PROFILE_DIR", str(tmp_path / "second"))
    assert vita_ocr.read_model_selection() == "normal"
    assert vita_ocr.get_install_directory() == assets
    assert (assets / "installation.json").read_text(encoding="utf-8") == original


def test_fresh_backend_creates_only_profile_settings_and_database(tmp_path):
    shared = tmp_path / "shared"
    shared.mkdir()
    (shared / "config.json").write_text("do not load this", encoding="utf-8")
    pointer = data_directory.get_pointer_path()
    pointer.parent.mkdir(parents=True)
    saved_pointer = json.dumps({"version": 2, "dataDir": str(shared), "legacyDatabaseDir": str(shared)})
    pointer.write_text(saved_pointer, encoding="utf-8")
    code = textwrap.dedent("""
        import json, sqlite3
        from pathlib import Path
        from GameSentenceMiner.util.config import configuration as config
        from GameSentenceMiner.util.config.electron_config import ELECTRON_CONFIG_PATH
        from GameSentenceMiner.util.database.db import get_db_directory
        from GameSentenceMiner.ocr.ocrconfig import OCRConfig
        from GameSentenceMiner.util.gpu_runtime import save_preferences
        fresh = config.Config.new()
        fresh.save()
        ocr = OCRConfig()
        ocr.set_value('screenai', 'resources_dir', 'profile-only')
        ocr.save_config()
        save_preferences({'meiki': False})
        database = get_db_directory()
        with sqlite3.connect(database) as connection:
            connection.execute('CREATE TABLE profile_probe (value TEXT)')
        print('PROFILE_PATHS=' + json.dumps({
            'config': config.get_config_path(), 'database': database,
            'electron': ELECTRON_CONFIG_PATH, 'ocr': ocr.config_file,
            'recordings': fresh.get_config().paths.folder_to_watch,
            'output': fresh.get_config().paths.output_folder,
        }))
    """)
    result = subprocess.run(
        [sys.executable, "-c", code],
        env={**os.environ, "GSM_SHARED_DATA_DIR": str(shared), "GAME_SENTENCE_MINER_TESTING": "0"},
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=30,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    paths = json.loads(
        next(
            line.removeprefix("PROFILE_PATHS=")
            for line in result.stdout.splitlines()
            if line.startswith("PROFILE_PATHS=")
        )
    )
    profile = tmp_path / "profile"
    assert all(Path(value).is_relative_to(profile) for value in paths.values())
    assert (profile / "gsm.db").exists()
    assert (profile / "config.json").exists()
    assert (profile / "gpu" / "preferences.json").exists()
    assert (profile / "owocr_config_gsm.ini").exists()
    assert (shared / "config.json").read_text(encoding="utf-8") == "do not load this"
    assert sorted(p.name for p in shared.iterdir()) == ["config.json"]
    assert pointer.read_text(encoding="utf-8") == saved_pointer
