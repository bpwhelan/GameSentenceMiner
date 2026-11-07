from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from types import SimpleNamespace

import pytest
from PIL import Image

from GameSentenceMiner.ocr import gsm_ocr


@pytest.fixture(params=[False, True], ids=["sync", "running-event-loop"])
def run_delivery(request):
    def run(callback):
        if not request.param:
            return callback()

        async def invoke():
            return callback()

        return asyncio.run(invoke())

    return run


@pytest.fixture
def delivery(monkeypatch):
    state = SimpleNamespace(
        text="サクヤ「あたし的には切ってるのが大根のときで良かったよ」",
        time=datetime(2026, 10, 24, 16, 23, 10, tzinfo=UTC),
        payload={"pipeline": {"engine": "glens"}},
        overlay_payload={"data": [{"text": "recognized text"}]},
        sent=[],
        previews=[],
        metrics=[],
    )
    monkeypatch.setattr(gsm_ocr, "shutdown_requested", False)
    monkeypatch.setattr(gsm_ocr, "get_ocr_advanced_debug_logging", lambda: False)
    monkeypatch.setattr(gsm_ocr, "is_windows", lambda: True)
    monkeypatch.setattr(gsm_ocr, "_overlay_coordinate_output_enabled", lambda: True)
    monkeypatch.setattr(gsm_ocr, "build_overlay_coordinate_payload", lambda _payload: state.overlay_payload)
    monkeypatch.setattr(gsm_ocr, "_update_capture_preview", state.previews.append)
    monkeypatch.setattr(gsm_ocr.obs, "get_current_game", lambda: "game.exe")
    monkeypatch.setattr(gsm_ocr, "get_ocr_send_to_clipboard", lambda source: source == gsm_ocr.TextSource.MANUAL)
    monkeypatch.setattr(
        gsm_ocr.ocr_ipc, "announce_ocr_result", lambda text, metadata: state.sent.append((text, metadata))
    )
    monkeypatch.setattr(
        gsm_ocr, "capture_ocr_metrics_sample", lambda *args, **kwargs: state.metrics.append((args, kwargs))
    )
    return state


def test_benchmark_engine_identifies_text_when_geometry_falls_back(monkeypatch, delivery):
    ctrl = SimpleNamespace(last_sent_result="", last_ocr2_result=[], config=gsm_ocr.TwoPassConfig())
    monkeypatch.setattr(gsm_ocr, "get_controller", lambda: ctrl)
    monkeypatch.setattr(gsm_ocr, "TextFiltering", lambda lang: object())
    monkeypatch.setattr(gsm_ocr, "build_overlay_coordinate_payload", lambda _payload: None)
    monkeypatch.setattr(gsm_ocr, "get_ocr_language", lambda: "ja")
    monkeypatch.setattr(gsm_ocr, "get_ocr_ocr2", lambda: "glens")
    monkeypatch.setattr(gsm_ocr, "save_result_image", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(
        gsm_ocr.ocr_runtime,
        "process_and_write_results",
        lambda *_args, **_kwargs: ([delivery.text], delivery.text, delivery.payload),
    )
    first_pass = {"pipeline": {"engine": "screenai"}}
    gsm_ocr.OCRProcessor().do_second_ocr(
        "", delivery.time, Image.new("RGB", (100, 50)), filtering=None, response_dict=first_pass
    )
    assert delivery.sent[0][1]["ocr_engine"] == "glens"


def test_delivery_preserves_vita_model_provenance(delivery):
    model = {"size": "large", "revision": "pinned"}
    payload = {"pipeline": {"engine": "vitaocr", "model": model}}
    gsm_ocr.send_result(delivery.text, delivery.time, response_dict=payload, source=gsm_ocr.TextSource.MANUAL)
    assert delivery.sent[0][1]["ocr_model"] == model
    # OCR2 may supply text while OCR1 supplies geometry. Never attribute the
    # geometry model to text recognized by another engine.
    payload["recognition"] = {"engine": "glens"}
    gsm_ocr.send_result(delivery.text, delivery.time, response_dict=payload, source=gsm_ocr.TextSource.MANUAL)
    assert "ocr_model" not in delivery.sent[1][1]


@pytest.mark.parametrize("obs_capture", [True, False], ids=["obs", "screen"])
def test_whole_window_command_delivers_result(monkeypatch, run_delivery, delivery, obs_capture):
    image = Image.new("RGB", (100, 50), "white")
    ctrl = SimpleNamespace(
        last_sent_result=delivery.text,
        last_ocr2_result=[delivery.text],
        config=gsm_ocr.TwoPassConfig(),
    )
    monkeypatch.setattr(gsm_ocr, "get_controller", lambda: ctrl)
    monkeypatch.setattr(gsm_ocr, "datetime", SimpleNamespace(now=lambda: delivery.time))
    monkeypatch.setattr(gsm_ocr, "TextFiltering", lambda lang: object())
    monkeypatch.setattr(gsm_ocr, "get_ocr_language", lambda: "ja")
    monkeypatch.setattr(gsm_ocr, "get_ocr_ocr2", lambda: "glens")
    monkeypatch.setattr(gsm_ocr, "obs_ocr", obs_capture)
    monkeypatch.setattr(gsm_ocr.obs, "get_screenshot_PIL", lambda **kwargs: image)
    monkeypatch.setattr(gsm_ocr, "_capture_monitor_image", lambda: (image, {}))
    monkeypatch.setattr(gsm_ocr, "save_result_image", lambda *args, **kwargs: None)
    monkeypatch.setattr(
        gsm_ocr.ocr_runtime,
        "process_and_write_results",
        lambda *args, **kwargs: ([delivery.text], delivery.text, delivery.payload),
    )
    processor = gsm_ocr.OCRProcessor()
    monkeypatch.setattr(gsm_ocr, "get_second_ocr_processor", lambda: processor)

    response = run_delivery(
        lambda: gsm_ocr._handle_command(
            {"command": gsm_ocr.ocr_ipc.OCRCommand.WHOLE_WINDOW_OCR.value},
            announce_ipc=False,
        )
    )

    assert response["success"] is True
    assert delivery.sent == [
        (
            delivery.text,
            {
                "sentence": delivery.text,
                "time": delivery.time.isoformat(),
                "process_path": "game.exe",
                "source": gsm_ocr.TextSource.MANUAL,
                "copyToClipboard": True,
                "ocr_engine": "glens",
                "ocr_scene": "",
                "dict_from_ocr": delivery.overlay_payload,
            },
        )
    ]
    assert delivery.previews == [delivery.payload]
    assert len(delivery.metrics) == 1


@pytest.mark.parametrize("source", [None, gsm_ocr.TextSource.OCR_MANUAL], ids=["automatic", "manual"])
def test_controller_callback_delivers_result(monkeypatch, run_delivery, delivery, source):
    image = Image.new("RGB", (100, 50), "white")
    monkeypatch.setattr(gsm_ocr, "_last_metrics_img", image)

    run_delivery(
        lambda: gsm_ocr._send_result_callback(
            delivery.text, delivery.time, response_dict=delivery.payload, source=source
        )
    )

    assert len(delivery.sent) == 1
    text, metadata = delivery.sent[0]
    assert text == delivery.text
    assert metadata["source"] == (source or gsm_ocr.TextSource.OCR)
    assert metadata["time"] == delivery.time.isoformat()
    assert metadata["dict_from_ocr"] == delivery.overlay_payload
    assert metadata["copyToClipboard"] is False
    assert delivery.previews == [delivery.payload]
    assert delivery.metrics == [
        ((image, delivery.text), {"source": source or gsm_ocr.TextSource.OCR, "response_dict": delivery.payload})
    ]
    assert gsm_ocr._last_metrics_img is None
