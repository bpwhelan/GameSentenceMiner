import hashlib
import json

import pytest

from GameSentenceMiner.ocr import vita_model_manager as manager
from GameSentenceMiner.ocr import vita_ocr
from GameSentenceMiner.ocr import vocr_onnx


@pytest.fixture
def installation(monkeypatch, tmp_path):
    monkeypatch.setenv("GSM_VOCR_BACKEND", "c")
    monkeypatch.setattr(vita_ocr, "get_install_directory", lambda: tmp_path)
    monkeypatch.setattr(manager, "get_install_directory", lambda: tmp_path)
    graphs = tmp_path / "graphs"
    graphs.mkdir()
    names = [f"{tier}-faithful.onnx" for tier in vita_ocr.MODELS] + ["textspot8-faithful.onnx"]
    manifest = {
        "revision": vita_ocr.UPSTREAM_REVISION,
        "export_version": 1,
        "files": {name: hashlib.sha256(name.encode()).hexdigest() for name in names},
    }
    (graphs / "manifest.json").write_text(json.dumps(manifest))
    for name in names:
        (graphs / name).write_bytes(name.encode())
    monkeypatch.setattr(vocr_onnx, "bundled_directory", lambda: graphs)
    monkeypatch.setattr(vocr_onnx, "cached_asset_path", lambda *_: None)
    monkeypatch.setattr(vocr_onnx, "ONNXRuntime", lambda *a, **kw: None)
    vita_ocr.write_installation(tmp_path, "normal")
    return tmp_path


def test_switch_uses_pinned_onnx_and_persists_size(installation):
    for tier in ["large", "small", "normal"]:
        result = manager.select_model(tier)
        assert (result["model"], result["backend"], result["available"]) == (tier, "onnx", True)
        assert result["installed"] == ["normal", "small", "large"]
        assert vita_ocr.read_installation(installation)["model"] == tier


@pytest.mark.parametrize("failure", ["load", "save"])
def test_failed_switch_keeps_previous_model(installation, monkeypatch, failure):
    def fail(*args, **kwargs):
        raise OSError(failure)

    if failure == "save":
        monkeypatch.setattr(vita_ocr, "write_installation", fail)
    else:
        monkeypatch.setattr(vocr_onnx, "ONNXRuntime", fail)
    before = (installation / "installation.json").read_bytes()
    reply = manager.handle_model_request({"data": {"model": "large"}})
    assert failure in reply["error"]
    assert (installation / "installation.json").read_bytes() == before


def test_request_validates_size_and_reports_bad_graph(installation):
    result = manager.handle_model_request({"data": {"model": "../../other"}})
    assert result["error"] and result["model"] == "normal"
    (installation / "graphs/normal-faithful.onnx").write_bytes(b"broken")
    result = manager.get_model_status()
    assert result["available"] is False and "checksum" in result["error"]


def test_busy_selection_does_not_queue_another_switch(installation):
    with manager._selection_lock:
        assert manager.get_model_status()["busy"] is True
        result = manager.handle_model_request({"data": {"model": "small"}})
        assert result["error"]
        assert result["model"] == "normal"
