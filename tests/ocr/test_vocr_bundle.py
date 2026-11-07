"""Production VOCR must work offline from the packaged faithful models."""

import json
import shutil

import pytest
from PIL import Image

from GameSentenceMiner.ocr import vita_model_manager as manager
from GameSentenceMiner.ocr import vita_ocr, vocr_line_finder, vocr_onnx, vocr_runtime


@pytest.fixture
def offline(monkeypatch, tmp_path):
    directory = tmp_path / "user-data"
    monkeypatch.setenv("GSM_VITA_OCR_DIR", str(directory))
    monkeypatch.delenv("GSM_VOCR_BACKEND", raising=False)
    # An old experiment's setting must not change production inference.
    monkeypatch.setenv("GSM_VOCR_ONNX_MODE", "fast")

    def unexpected(*args, **kwargs):
        pytest.fail("Bundled VOCR attempted a download or native VOCR access")

    monkeypatch.setattr(vocr_runtime.urllib.request, "urlopen", unexpected)
    monkeypatch.setattr(vocr_runtime, "_install_runtime", unexpected)
    monkeypatch.setattr(vocr_runtime, "platform_key", unexpected)
    monkeypatch.setattr(vita_ocr, "VitaOCRRuntime", unexpected)
    monkeypatch.setattr(vocr_line_finder, "VOCRLineFinder", unexpected)
    return directory


def test_fresh_status_is_ready_without_mutating_user_data(offline):
    status = manager.get_model_status()
    assert status["available"] and status["supported"]
    assert status["backend"] == "onnx"
    assert status["model"] == "normal"
    assert set(status["installed"]) == {"small", "normal", "large"}
    assert "error" not in status
    assert not offline.exists()


def test_fresh_main_ocr_and_detector_work_and_switch_all_sizes_offline(offline):
    from GameSentenceMiner.owocr.owocr.ocr import VitaOCR, VOCRTextDetector

    engine = VitaOCR(get_furigana_sens_from_file=False)
    detector = VOCRTextDetector()
    image = Image.new("RGB", (320, 120), "black")
    try:
        assert engine.available and detector.available
        assert detector(image)[0]
        # The first scan must work even before a selection file exists.
        assert engine(image)[0]
        assert not offline.exists()
        for tier in ("large", "small", "normal"):
            status = manager.select_model(tier)
            assert status["available"] and status["model"] == tier
            result = engine(image)
            assert result[0], result
            assert result[5]["gsm_model"]["size"] == tier
            assert result[5]["gsm_model"]["backend"] == "onnx"
            assert result[5]["gsm_model"]["mode"] == "faithful"
            assert engine.runtime.session.get_providers() == ["CPUExecutionProvider"]
            assert engine.runtime.finder.mode == "faithful"
        assert {file.name for file in offline.iterdir()} == {"installation.json", ".install.lock"}
    finally:
        engine.close()
        detector.close()


def test_migration_preserves_size_and_ignores_old_local_exports(offline):
    (offline / "onnx").mkdir(parents=True)
    (offline / "onnx" / "manifest.json").write_text('{"revision": "old-trial"}', encoding="utf-8")
    (offline / "installation.json").write_text(
        json.dumps({"revision": "old-native-pin", "model": "large"}), encoding="utf-8"
    )
    assert manager.get_model_status()["model"] == "large"
    runtime = vita_ocr.create_runtime()
    assert runtime.model == "large"
    assert runtime.assets_directory == vocr_onnx.bundled_directory()
    vocr_runtime.ensure_installation()
    assert vita_ocr.read_installation(offline)["model"] == "large"


@pytest.mark.parametrize("failure", ["missing", "checksum", "revision"])
def test_broken_bundle_fails_without_native_fallback(offline, monkeypatch, tmp_path, failure):
    assets = tmp_path / "broken-bundle"
    shutil.copytree(vocr_onnx.bundled_directory(), assets)
    if failure == "missing":
        (assets / "manifest.json").unlink()
    elif failure == "checksum":
        (assets / "normal-faithful.onnx").write_bytes(b"damaged")
    else:
        manifest = json.loads((assets / "manifest.json").read_text(encoding="utf-8"))
        manifest["revision"] = "old"
        (assets / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    monkeypatch.setattr(vocr_onnx, "bundled_directory", lambda: assets)
    status = manager.get_model_status()
    assert not status["available"]
    assert status["error"]
    with pytest.raises((OSError, ValueError), match="VOCR"):
        vita_ocr.create_runtime()
    with pytest.raises((OSError, ValueError), match="VOCR"):
        vocr_runtime.ensure_installation()


def test_failed_model_validation_does_not_change_selection(offline, monkeypatch):
    manager.select_model("small")
    previous = (offline / "installation.json").read_bytes()

    def unavailable(*args, **kwargs):
        raise RuntimeError("VOCR ONNX model could not load")

    monkeypatch.setattr(vocr_onnx, "ONNXRuntime", unavailable)
    with pytest.raises(RuntimeError, match="could not load"):
        manager.select_model("large")
    assert (offline / "installation.json").read_bytes() == previous


def test_invalid_selection_can_be_repaired_explicitly(offline):
    offline.mkdir()
    (offline / "installation.json").write_text("null", encoding="utf-8")
    assert manager.get_model_status()["error"]
    assert manager.select_model("small")["available"]
    assert vita_ocr.read_installation(offline)["model"] == "small"


def test_bundle_contains_only_faithful_graphs_and_upstream_notices():
    assets = vocr_onnx.bundled_directory()
    expected = {f"{tier}-faithful.onnx" for tier in ("small", "normal", "large", "textspot8")}
    manifest = json.loads((assets / "manifest.json").read_text(encoding="utf-8"))
    assert set(manifest["files"]) == expected
    assert {file.name for file in assets.glob("*.onnx")} == expected
    assert set(vocr_onnx.installed_models(assets)) == set(vita_ocr.MODELS)
    assert "GNU GENERAL PUBLIC LICENSE" in (assets / "COPYING").read_text(encoding="utf-8")
    for notice in ("VOCR6-ATTRIBUTION.md", "SPOTTER-ATTRIBUTION.md"):
        assert "non-commercial purposes only" in (assets / notice).read_text(encoding="utf-8")
