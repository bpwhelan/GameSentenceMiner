import hashlib
import io
import json

import pytest

from GameSentenceMiner.ocr import vita_model_manager as manager
from GameSentenceMiner.ocr import vita_ocr
from GameSentenceMiner.ocr import vocr_runtime as installer
from GameSentenceMiner.ocr.vocr_line_finder import spotter_library_name


@pytest.fixture
def installation(monkeypatch, tmp_path):
    monkeypatch.setattr(vita_ocr, "get_install_directory", lambda: tmp_path)
    monkeypatch.setattr(manager, "get_install_directory", lambda: tmp_path)
    models = {tier: (f"{tier}.vocr", hashlib.sha256(tier.encode()).hexdigest()) for tier in vita_ocr.MODELS}
    monkeypatch.setattr(vita_ocr, "MODELS", models)
    monkeypatch.setattr(manager, "MODELS", models)
    (tmp_path / vita_ocr.library_name()).write_bytes(b"runtime")
    (tmp_path / spotter_library_name()).write_bytes(b"spotter")
    support = {name: hashlib.sha256(name.encode()).hexdigest() for name in installer.SUPPORT_ASSETS}
    monkeypatch.setattr(installer, "SUPPORT_ASSETS", support)
    for name in support:
        (tmp_path / name).write_bytes(name.encode())
    (tmp_path / "normal.vocr").write_bytes(b"normal")
    vita_ocr.write_installation(tmp_path, "normal")
    monkeypatch.setattr(installer, "validate_installation", lambda *a, **kw: None)
    return tmp_path


def test_select_downloads_verifies_and_persists_without_rebuilding_runtime(installation, monkeypatch):
    urls = []

    def download(request, **kwargs):
        urls.append(request.full_url)
        return io.BytesIO(b"large")

    monkeypatch.setattr(installer.urllib.request, "urlopen", download)
    result = manager.select_model("large")
    assert result["available"] is True
    assert result["model"] == "large"
    assert result["installed"] == ["normal", "large"]
    assert vita_ocr.read_installation(installation)["model"] == "large"
    assert len(urls) == 1
    assert urls[0].endswith("/large.vocr")
    assert (installation / vita_ocr.library_name()).read_bytes() == b"runtime"
    assert manager.select_model("normal")["model"] == "normal"
    assert manager.select_model("large")["model"] == "large"
    assert len(urls) == 1


@pytest.mark.parametrize("failure", ["checksum", "network", "native", "save"])
def test_failed_switch_keeps_previous_model(installation, monkeypatch, failure):
    before = (installation / "installation.json").read_bytes()

    def download(*args, **kwargs):
        if failure == "network":
            raise OSError("offline")
        return io.BytesIO(b"broken" if failure == "checksum" else b"large")

    monkeypatch.setattr(installer.urllib.request, "urlopen", download)
    if failure == "native":
        monkeypatch.setattr(
            installer, "validate_installation", lambda *a, **k: (_ for _ in ()).throw(ValueError("native"))
        )
    if failure == "save":
        monkeypatch.setattr(vita_ocr, "write_installation", lambda *a: (_ for _ in ()).throw(OSError("read only")))
    with pytest.raises((OSError, ValueError)):
        manager.select_model("large")
    assert (installation / "installation.json").read_bytes() == before
    assert manager.get_model_status()["model"] == "normal"
    assert not list(installation.glob("*.download"))


def test_request_validates_model_and_reports_download_errors(installation, monkeypatch):
    result = manager.handle_model_request({"data": {"model": "../../other"}})
    assert result["error"]
    assert result["model"] == "normal"
    (installation / vita_ocr.library_name()).unlink()
    assert manager.get_model_status()["available"] is False
    monkeypatch.setattr(installer.urllib.request, "urlopen", lambda *a, **kw: (_ for _ in ()).throw(OSError("offline")))
    assert manager.handle_model_request({"data": {"model": "large"}})["error"]


def test_busy_selection_does_not_queue_another_switch(installation):
    with manager._selection_lock:
        assert manager.get_model_status()["busy"] is True
        result = manager.handle_model_request({"data": {"model": "small"}})
        assert result["error"]
        assert result["model"] == "normal"


def test_runtime_can_load_a_candidate_without_changing_active_manifest(installation, monkeypatch):
    (installation / "large.vocr").write_bytes(b"broken")
    with pytest.raises(ValueError, match="checksum"):
        vita_ocr.VitaOCRRuntime(installation, model="large")
    assert json.loads((installation / "installation.json").read_text())["model"] == "normal"
