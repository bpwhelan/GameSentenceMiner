import json

import pytest

from GameSentenceMiner.util.config import configuration


@pytest.mark.parametrize("loader_name", ["load", "load_config"])
def test_existing_profiles_get_repeated_line_default_once(tmp_path, monkeypatch, loader_name):
    config_path = tmp_path / "config.json"
    raw_config = configuration.Config.new().to_dict()
    raw_config["configs"]["Other"] = configuration.ProfileConfig().to_dict()
    for profile in raw_config["configs"].values():
        processing = profile["text_processing"]
        processing.pop("remove_repeated_lines_v2", None)
        processing["remove_repeated_lines"] = False
        processing["remove_repeated_lines_config"]["repeat_count"] = 3
    config_path.write_text(json.dumps(raw_config), encoding="utf-8")
    monkeypatch.setattr(configuration, "get_config_path", lambda: str(config_path))
    loader = configuration.Config.load if loader_name == "load" else configuration.load_config

    loaded = loader()

    for profile in loaded.configs.values():
        assert profile.text_processing.remove_repeated_lines_v2 is True
        assert profile.text_processing.remove_repeated_lines_config.repeat_count == 3

    loaded.configs["Other"].text_processing.remove_repeated_lines_v2 = False
    loaded.save()
    restored = loader()

    assert restored.configs["Default"].text_processing.remove_repeated_lines_v2 is True
    assert restored.configs["Other"].text_processing.remove_repeated_lines_v2 is False
