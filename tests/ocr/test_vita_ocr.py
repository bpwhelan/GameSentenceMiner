from types import SimpleNamespace

import pytest
from PIL import Image

from GameSentenceMiner.ocr import vita_ocr
from GameSentenceMiner.owocr.owocr import ocr as ocr_module
from GameSentenceMiner.owocr.owocr import ocr_runtime


def make_engine(monkeypatch, lines=None, error=None):
    def recognize(image):
        assert image.mode == "RGB"
        if error:
            raise error
        return lines or []

    monkeypatch.setattr(vita_ocr, "VitaOCRRuntime", lambda: SimpleNamespace(recognize=recognize))
    return ocr_module.VitaOCR(get_furigana_sens_from_file=False)


def test_missing_install_is_optional_and_actionable(monkeypatch):
    def missing():
        raise OSError("VOCR download failed: check your connection and retry")

    monkeypatch.setattr(vita_ocr, "VitaOCRRuntime", missing)
    engine = ocr_module.VitaOCR()
    assert engine.available is False
    assert "retry" in engine.init_error
    assert engine(Image.new("RGB", (100, 60)))[0] is False


def test_engine_recovers_after_settings_retry_completes_installation(monkeypatch):
    from GameSentenceMiner.ocr import vita_model_manager

    attempts = []

    def create():
        attempts.append(True)
        if len(attempts) == 1:
            raise OSError("offline")
        return SimpleNamespace(recognize=lambda image: [])

    monkeypatch.setattr(vita_ocr, "VitaOCRRuntime", create)
    engine = ocr_module.VitaOCR()
    assert engine.available is False
    monkeypatch.setattr(vita_model_manager, "get_model_status", lambda: {"available": True})
    assert engine(Image.new("RGB", (100, 60)))[0] is True
    assert engine.available is True
    engine.close()
    assert engine(Image.new("RGB", (100, 60)))[0] is False


def test_character_and_line_boxes_reach_gsm(monkeypatch):
    engine = make_engine(
        monkeypatch,
        [
            {
                "text": "日本",
                "box": (20, 10, 40, 20),
                "characters": [
                    {"text": "日", "box": (20, 10, 20, 20)},
                    {"text": "本", "box": (40, 10, 20, 20)},
                ],
            },
            {"text": "語です", "box": (20, 35, 60, 20), "characters": []},
        ],
    )
    result = engine(Image.new("RGB", (100, 60)))
    assert len(result) == 6
    assert result[0] is True
    assert result[1].replace("\n", "") == "日本語です"
    assert len(result[2]) == 2
    assert result[2][0]["bounding_rect"]["x1"] == 20
    assert result[2][0]["bounding_rect"]["y1"] == 10
    words = result[2][0]["words"]
    assert [word["text"] for word in words] == ["日", "本"]
    assert words[1]["bounding_rect"]["x3"] == 60


def test_overlay_call_options_preserve_character_geometry(monkeypatch):
    engine = make_engine(
        monkeypatch,
        [
            {
                "text": "日本",
                "box": (20, 10, 40, 20),
                "characters": [
                    {"text": "日", "box": (20, 10, 20, 20)},
                    {"text": "本", "box": (40, 10, 20, 20)},
                ],
            }
        ],
    )
    result = engine(
        Image.new("RGB", (100, 60)),
        return_coords=True,
        multiple_crop_coords=True,
        return_one_box=False,
        furigana_filter_sensitivity=0,
        language="ja",
    )
    assert result[0] is True
    assert result[1] == "日本"
    assert len(result[2][0]["words"]) == 2
    assert result[3]


def test_furigana_size_filter_applies(monkeypatch):
    engine = make_engine(
        monkeypatch,
        [
            {"text": "にほん", "box": (20, 2, 30, 6), "characters": []},
            {"text": "日本", "box": (20, 10, 40, 20), "characters": []},
        ],
    )
    result = engine(Image.new("RGB", (100, 60)), furigana_filter_sensitivity=8)
    assert result[0] is True
    assert result[1] == "日本"


def test_empty_capture_is_successful_without_inventing_text(monkeypatch):
    engine = make_engine(monkeypatch)
    result = engine(Image.new("RGB", (100, 60)))
    assert result[0] is True
    assert result[1] == ""
    assert result[2] == []


def test_invalid_input_and_runtime_errors_are_reported(monkeypatch):
    engine = make_engine(monkeypatch, error=RuntimeError("bad model"))
    assert engine(None)[0] is False
    result = engine(Image.new("RGB", (100, 60)))
    assert result[0] is False
    assert "bad model" in result[1]


def test_engine_is_discoverable_by_current_runtime(monkeypatch):
    engine = make_engine(monkeypatch)
    monkeypatch.setattr(ocr_runtime, "engine_instances", [], raising=False)
    monkeypatch.setattr(ocr_runtime, "engine_keys", [], raising=False)
    monkeypatch.setattr(ocr_runtime, "engine_index", 0, raising=False)
    monkeypatch.setattr(ocr_runtime, "config", SimpleNamespace(get_engine=lambda _name: None), raising=False)
    monkeypatch.setattr(ocr_runtime, "get_ocr_language", lambda: "ja")
    ocr_runtime.engine_change_handler_name("vitaocr", switch=False)
    assert ocr_runtime.get_engine_names() == [engine.name]


def test_install_location_honors_gsm_data_directory(monkeypatch, tmp_path):
    monkeypatch.delenv("GSM_VITA_OCR_DIR", raising=False)
    monkeypatch.setenv("GSM_DATA_DIR", str(tmp_path))
    assert vita_ocr.get_install_directory() == tmp_path / "ocr" / "vita-vn-ocr"


def test_unrecognized_runtime_revision_is_rejected(tmp_path):
    (tmp_path / "installation.json").write_text('{"revision": "unknown"}', encoding="utf-8")
    try:
        vita_ocr.VitaOCRRuntime(tmp_path)
    except ValueError as error:
        assert "automatically" in str(error)
    else:
        raise AssertionError("An incompatible runtime must not be loaded through ctypes")


def test_damaged_model_is_rejected_before_loading_native_code(tmp_path):
    import json

    (tmp_path / "installation.json").write_text(
        json.dumps({"revision": vita_ocr.UPSTREAM_REVISION, "model": "normal"}), encoding="utf-8"
    )
    (tmp_path / vita_ocr.MODELS["normal"][0]).write_bytes(b"broken model")
    with pytest.raises(ValueError, match="checksum"):
        vita_ocr.VitaOCRRuntime(tmp_path)


def test_failed_download_keeps_existing_file(monkeypatch, tmp_path):
    import io

    from scripts import setup_vita_ocr

    target = tmp_path / "model.vocr"
    target.write_bytes(b"previous model")
    monkeypatch.setattr(setup_vita_ocr.urllib.request, "urlopen", lambda *_args, **_kw: io.BytesIO(b"corrupt"))
    with pytest.raises(ValueError, match="Checksum mismatch"):
        setup_vita_ocr.download_verified("https://example.com/model.vocr", target, "0" * 64)
    assert target.read_bytes() == b"previous model"


def test_verified_download_is_reused_without_network(monkeypatch, tmp_path):
    import hashlib

    from scripts import setup_vita_ocr

    target = tmp_path / "model.vocr"
    target.write_bytes(b"verified model")

    def unexpected(*_args, **_kwargs):
        raise AssertionError("Verified local assets should not be downloaded again")

    monkeypatch.setattr(setup_vita_ocr.urllib.request, "urlopen", unexpected)
    setup_vita_ocr.download_verified(
        "https://example.com/model.vocr", target, hashlib.sha256(target.read_bytes()).hexdigest()
    )


def test_opened_image_file_is_closed(monkeypatch, tmp_path):
    engine = make_engine(monkeypatch)
    path = tmp_path / "capture.png"
    Image.new("RGB", (100, 60)).save(path)
    image = Image.open(path)
    monkeypatch.setattr(ocr_module, "input_to_pil_image", lambda _input: (image, True))
    assert engine(path)[0] is True
    with pytest.raises(ValueError, match="closed image"):
        image.getpixel((0, 0))


def test_model_switch_is_picked_up_by_existing_engine_and_tags_actual_scan(monkeypatch, tmp_path):
    vita_ocr.write_installation(tmp_path, "normal")
    created = []

    def create(directory=tmp_path):
        model = vita_ocr.read_installation(directory)["model"]

        def recognize(_image):
            # Selection may change during an in-flight scan. Its provenance
            # must still describe the runtime that actually read this frame.
            vita_ocr.write_installation(directory, "large")
            return []

        runtime = SimpleNamespace(
            model=model,
            directory=directory,
            recognize=recognize,
            metadata={"size": model, "revision": vita_ocr.UPSTREAM_REVISION},
        )
        created.append(runtime)
        return runtime

    monkeypatch.setattr(vita_ocr, "VitaOCRRuntime", create)
    engine = ocr_module.VitaOCR()
    image = Image.new("RGB", (100, 60))
    assert engine(image)[5]["gsm_model"]["size"] == "normal"
    assert engine(image)[5]["gsm_model"]["size"] == "large"
    assert engine(image)[5]["gsm_model"]["size"] == "large"
    assert len(created) == 2
