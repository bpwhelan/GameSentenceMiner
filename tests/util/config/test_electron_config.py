import json
import time
from pathlib import Path

from GameSentenceMiner.util.config import electron_config


class _DummyStore:
    def __init__(self, data=None, disk_data=None):
        self.data = data or {}
        self.disk_data = disk_data if disk_data is not None else self.data
        self.reloaded = False

    def get(self, key, default=None):
        if not key:
            return self.data
        value = self.data
        for part in key.split("."):
            if isinstance(value, dict) and part in value:
                value = value[part]
            else:
                return default
        return value

    def read_from_disk(self):
        return self.disk_data

    def reload_config(self):
        self.reloaded = True


def test_deep_merge_defaults_preserves_loaded_values():
    defaults = {"a": {"b": 1, "c": [1, 2]}, "d": 9}
    loaded = {"a": {"c": [7]}, "extra": True}
    merged = electron_config._deep_merge_defaults(defaults, loaded)
    assert merged == {"a": {"b": 1, "c": [7]}, "d": 9, "extra": True}


def test_store_creates_file_and_supports_get_set_delete(tmp_path):
    config_path = tmp_path / "electron" / "config.json"
    store = electron_config.Store(config_path=str(config_path), defaults={"OCR": {"scanRate": 0.5}})

    assert config_path.exists()
    assert store.get("OCR.scanRate") == 0.5

    assert store.set("OCR.scanRate", 1.25) is True
    assert store.get("OCR.scanRate") == 1.25

    deleted = False
    last_error = None
    for _ in range(5):
        try:
            deleted = store.delete("OCR.scanRate")
            last_error = None
            break
        except PermissionError as exc:
            last_error = exc
            time.sleep(0.05)
    if last_error is not None:
        raise last_error

    assert deleted is True
    assert store.get("OCR.scanRate", "fallback") == "fallback"


def test_store_handles_invalid_json_file(tmp_path):
    config_path = tmp_path / "config.json"
    config_path.write_text("{ invalid json", encoding="utf-8")
    store = electron_config.Store(config_path=str(config_path), defaults={"foo": "bar"})
    assert store.get("foo") == "bar"


def test_get_ocr_values_basic_mode(monkeypatch):
    store = _DummyStore(
        {
            "OCR": {
                "advancedMode": False,
                "ocr1": "oneocr",
                "ocr2": "glens",
                "scanRate_basic": 0.7,
                "scanRate": None,
                "keep_newline": False,
                "twoPassOCR": False,
            }
        }
    )
    monkeypatch.setattr(electron_config, "electron_store", store)
    monkeypatch.setattr(electron_config, "is_windows", lambda: False)

    assert electron_config.get_ocr_ocr1() == "meikiocr"
    assert electron_config.get_ocr_ocr2() == "glens"
    assert electron_config.get_ocr_scan_rate() == 0.7
    assert electron_config.get_ocr_keep_newline() is True
    assert electron_config.get_ocr_two_pass_ocr() is True


def test_get_ocr_values_advanced_mode(monkeypatch):
    store = _DummyStore(
        {
            "OCR": {
                "advancedMode": True,
                "ocr1": "oneocr",
                "ocr2": "glens",
                "scanRate": "1.5",
                "ocr_screenshots": True,
                "keep_newline": False,
                "twoPassOCR": False,
                "optimize_second_scan": False,
                "manualOcrHotkey": "Alt+M",
            }
        }
    )
    monkeypatch.setattr(electron_config, "electron_store", store)
    monkeypatch.setattr(electron_config, "is_windows", lambda: True)

    assert electron_config.get_ocr_ocr1() == "oneocr"
    assert electron_config.get_ocr_scan_rate() == 1.5
    assert electron_config.get_ocr_ocr_screenshots() is True
    assert electron_config.get_ocr_keep_newline() is False
    assert electron_config.get_ocr_two_pass_ocr() is False
    assert electron_config.get_ocr_optimize_second_scan() is False
    assert electron_config.get_ocr_manual_ocr_hotkey() == "Alt+M"


def test_get_ocr_scan_rate_invalid_value(monkeypatch):
    store = _DummyStore({"OCR": {"advancedMode": True, "scanRate": "bad"}})
    monkeypatch.setattr(electron_config, "electron_store", store)
    assert electron_config.get_ocr_scan_rate() == 0.5


def test_has_ocr_config_changed_reports_diffs(monkeypatch):
    old = {"OCR": {"advancedMode": False, "scanRate": 0.5}}
    new = {"OCR": {"advancedMode": True, "scanRate": 0.7}}
    store = _DummyStore(old, disk_data=new)
    monkeypatch.setattr(electron_config, "electron_store", store)

    changed, changes = electron_config.has_ocr_config_changed()

    assert changed is True
    assert changes["advancedMode"] == (False, True)
    assert changes["scanRate"] == (0.5, 0.7)


def test_reload_electron_config_invokes_store(monkeypatch):
    store = _DummyStore({"OCR": {}})
    monkeypatch.setattr(electron_config, "electron_store", store)
    result = electron_config.reload_electron_config()
    assert result is store
    assert store.reloaded is True


def test_store_read_from_disk_merges_defaults(tmp_path):
    config_path = tmp_path / "config.json"
    Path(config_path).write_text(json.dumps({"OCR": {"advancedMode": True}}), encoding="utf-8")
    store = electron_config.Store(
        config_path=str(config_path),
        defaults={"OCR": {"advancedMode": False, "scanRate": 0.5}},
    )

    value = store.read_from_disk()
    assert value["OCR"]["advancedMode"] is True
    assert value["OCR"]["scanRate"] == 0.5
