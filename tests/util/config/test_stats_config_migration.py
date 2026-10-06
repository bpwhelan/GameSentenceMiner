from __future__ import annotations

import json

import pytest

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


@pytest.mark.parametrize("legacy_value", [False, True])
def test_load_config_strips_legacy_reading_time_toggle(tmp_path, monkeypatch, legacy_value):
    config_path = tmp_path / "config.json"
    legacy_config = configuration.Config.new().to_dict()
    legacy_config["stats"]["reading_time_adaptive_v2"] = legacy_value
    legacy_config["stats"]["session_gap_seconds"] = 900
    config_path.write_text(json.dumps(legacy_config), encoding="utf-8")
    monkeypatch.setattr(configuration, "get_config_path", lambda: str(config_path))

    loaded = configuration.load_config()

    assert not hasattr(loaded.stats, "reading_time_adaptive_v2")
    assert "reading_time_adaptive_v2" not in loaded.to_dict()["stats"]
    assert loaded.stats.session_gap_seconds == 900


def test_load_config_strips_legacy_ocr_websocket_port(tmp_path, monkeypatch):
    config_path = tmp_path / "config.json"
    legacy_config = configuration.Config.new().to_dict()
    legacy_config["configs"]["Default"]["advanced"]["ocr_websocket_port"] = 9002
    config_path.write_text(json.dumps(legacy_config), encoding="utf-8")

    monkeypatch.setattr(configuration, "get_config_path", lambda: str(config_path))

    loaded = configuration.load_config()

    assert not hasattr(loaded.configs["Default"].advanced, "ocr_websocket_port")


def test_stats_config_defaults_to_english_tadoku_titles_for_existing_configs():
    assert configuration.StatsConfig.from_dict({}).tadoku_title_source == "english"


@pytest.mark.parametrize("title_source", ["english", "original", "romaji"])
def test_stats_config_preserves_tadoku_title_source(title_source):
    config = configuration.StatsConfig(tadoku_title_source=title_source)

    assert configuration.StatsConfig.from_dict(config.to_dict()).tadoku_title_source == title_source
