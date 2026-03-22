from __future__ import annotations

import json

from GameSentenceMiner.util.config import configuration


def test_load_config_strips_legacy_stats_afk_timer(tmp_path, monkeypatch):
    config_path = tmp_path / "config.json"
    legacy_config = configuration.Config.new().to_dict()
    legacy_config["stats"]["afk_timer_seconds"] = 120
    config_path.write_text(json.dumps(legacy_config), encoding="utf-8")

    monkeypatch.setattr(configuration, "get_config_path", lambda: str(config_path))

    loaded = configuration.load_config()

    assert not hasattr(loaded.stats, "afk_timer_seconds")
    assert loaded.stats.session_gap_seconds == legacy_config["stats"]["session_gap_seconds"]
