import json

import pytest

from GameSentenceMiner.util.config import configuration


@pytest.mark.parametrize("loader", [configuration.Config.load, configuration.load_config])
def test_standalone_save_keeps_layers_and_plugin_fields(tmp_path, monkeypatch, loader):
    pytest.importorskip("GameSentenceMiner._native")
    path = tmp_path / "config.json"
    document = {
        "version": "0.0.0",
        "current_profile": "Game",
        "configs": {
            "VN": {"audio": {"enabled": True}},
            "Game": {"audio": {"enabled": True}, "plugin": {"value": 7}},
        },
        "profile_layers": {"version": 1, "global": {}, "scenes": {"Game": {"parent": "VN", "overrides": {}}}},
    }
    path.write_text(json.dumps(document), encoding="utf-8")
    monkeypatch.setattr(configuration, "get_config_path", lambda: str(path))
    monkeypatch.delenv("GSM_CLIENT_ID", raising=False)
    config = loader()
    assert json.loads(path.read_text(encoding="utf-8")) == document
    config.get_config().audio.enabled = False
    config.save()
    saved = json.loads(path.read_text(encoding="utf-8"))
    assert saved["profile_layers"]["scenes"]["Game"]["overrides"] == {"audio.enabled": False}
    assert saved["configs"]["VN"]["audio"]["enabled"] is True
    assert saved["configs"]["Game"]["plugin"] == {"value": 7}
