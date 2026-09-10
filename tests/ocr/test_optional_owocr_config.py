from __future__ import annotations

import urllib.request

from GameSentenceMiner.ocr.ocrconfig import OCRConfig
from GameSentenceMiner.owocr.owocr.config import Config


def test_missing_owocr_config_uses_defaults_without_network_or_file_creation(tmp_path, monkeypatch):
    config_path = tmp_path / "missing-home" / ".config" / "owocr_config_gsm.ini"

    def fail_if_called(*_args, **_kwargs):
        raise AssertionError("optional OWOCR config must not be downloaded")

    monkeypatch.setattr(urllib.request, "urlretrieve", fail_if_called)

    config = Config(False, config_path)

    assert config.has_config is False
    assert config.get_general("websocket_port") == 7331
    assert config.get_general("screen_capture_delay_secs") == 3
    assert config.get_engine("oneocr") is None
    assert not config_path.exists()
    assert not config_path.parent.exists()


def test_existing_owocr_config_is_still_read_as_optional_compatibility(tmp_path):
    config_path = tmp_path / "owocr_config_gsm.ini"
    config_path.write_text(
        "[general]\nwebsocket_port = 7444\n[oneocr]\nurl = http://127.0.0.1:8001\n",
        encoding="utf-8",
    )

    config = Config(False, config_path)

    assert config.has_config is True
    assert config.get_general("websocket_port") == 7444
    assert config.get_engine("oneocr") == {"url": "http://127.0.0.1:8001"}


def test_owocr_config_state_is_not_shared_between_instances(tmp_path):
    configured_path = tmp_path / "configured.ini"
    missing_path = tmp_path / "missing.ini"
    configured_path.write_text("[oneocr]\nurl = http://127.0.0.1:8001\n", encoding="utf-8")

    Config(False, configured_path)
    defaults = Config(False, missing_path)

    assert defaults.has_config is False
    assert defaults.get_engine("oneocr") is None


def test_legacy_ocr_config_defaults_are_in_memory_only(tmp_path):
    config_path = tmp_path / "owocr_config_gsm.ini"

    config = OCRConfig(str(config_path))

    assert config.get_value("general", "websocket_port") == "7331"
    assert not config_path.exists()
