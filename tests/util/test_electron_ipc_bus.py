"""End-to-end test of the backend <-> Electron adapter (electron_ipc) over the bus.

Covers backend.command dispatch, backend.event emission, and the bridge that
turns a broadcast ocr.event(result) into the backend's ocr_result command.
"""

import time

import pytest

from GameSentenceMiner.util.communication import bus_client as bc
from GameSentenceMiner.util.communication import electron_ipc as e
from tests.util.test_bus_client import MiniBroker, TOKEN


@pytest.fixture
def backend_over_bus(monkeypatch):
    broker = MiniBroker()
    broker.start()
    monkeypatch.setenv("GSM_BROKER_PORT", str(broker.port))
    monkeypatch.setenv("GSM_BROKER_TOKEN", TOKEN)
    monkeypatch.setenv("GSM_CLIENT_ID", "backend")
    bc._client = None
    yield broker
    client = bc._client
    if client:
        client.stop()
    bc._client = None
    broker.stop()


def _wait(predicate, timeout=5):
    deadline = time.time() + timeout
    while time.time() < deadline and not predicate():
        time.sleep(0.02)
    return predicate()


def test_send_message_emits_backend_event(backend_over_bus):
    e.register_command_handler(lambda c: None)
    e.start_ipc_listener_in_thread()
    assert bc.get_bus().wait_connected(5)

    e.send_message("initialized", {"ready": True})

    frame = backend_over_bus.wait_for(lambda f: f.get("topic") == e.BACKEND_EVENT_TOPIC)
    assert frame["dst"] == "main"
    assert frame["data"]["function"] == "initialized"
    assert frame["data"]["data"] == {"ready": True}


def test_vad_debug_switch_is_available_over_the_backend_bus(backend_over_bus, monkeypatch, tmp_path):
    from GameSentenceMiner.util import vad_debug
    from GameSentenceMiner.util.config import configuration

    recorder = vad_debug.VADDebugRecorder(tmp_path / "vad-debug")
    monkeypatch.setattr(vad_debug, "recorder", recorder)
    monkeypatch.setattr(configuration, "is_dev", True)
    e.start_ipc_listener_in_thread()
    assert bc.get_bus().wait_connected(5)

    def request(request_id, payload, ok=True):
        backend_over_bus.send(
            {
                "v": 1,
                "id": request_id,
                "src": "main",
                "dst": "backend",
                "kind": "request",
                "topic": vad_debug.VAD_DEBUG_TOPIC,
                "data": payload,
            }
        )
        response = backend_over_bus.wait_for(lambda frame: frame.get("corr") == request_id)
        assert response["ok"] is ok
        return response.get("data", {})

    assert request("vad-debug-initial", {})["enabled"] is False
    assert request("vad-debug-start", {"enabled": True})["enabled"] is True
    assert recorder.root.is_dir()
    request("vad-debug-invalid", {"enabled": "false"}, ok=False)
    assert recorder.enabled is True
    assert request("vad-debug-stop", {"enabled": False})["enabled"] is False
    monkeypatch.setattr(configuration, "is_dev", False)
    request("vad-debug-packaged", {"enabled": True}, ok=False)
    assert recorder.enabled is False


def test_backend_command_dispatched(backend_over_bus):
    received = []
    e.register_command_handler(lambda c: received.append(c))
    e.start_ipc_listener_in_thread()
    assert bc.get_bus().wait_connected(5)

    backend_over_bus.send(
        {
            "v": 1,
            "id": "c1",
            "src": "main",
            "dst": "backend",
            "kind": "command",
            "topic": e.BACKEND_COMMAND_TOPIC,
            "data": {"function": "reload_settings"},
        }
    )

    assert _wait(lambda: len(received) > 0), "command handler not invoked"
    assert received[0]["function"] == "reload_settings"


def test_ocr_broadcast_bridges_to_backend_handler(backend_over_bus):
    received = []
    e.register_command_handler(lambda c: received.append(c))
    e.start_ipc_listener_in_thread()
    assert bc.get_bus().wait_connected(5)

    # Simulate the OCR process broadcasting a result onto the bus.
    backend_over_bus.send(
        {
            "v": 1,
            "id": "o1",
            "src": "ocr",
            "dst": "backend",
            "kind": "event",
            "topic": e.OCR_EVENT_TOPIC,
            "data": {"event": "ocr_result", "data": {"text": "セリフ", "source": "OCR"}},
        }
    )

    assert _wait(lambda: len(received) > 0), "ocr_result was not bridged"
    assert received[0]["function"] == "ocr_result"
    assert received[0]["data"]["text"] == "セリフ"


def test_capture_preview_request_returns_a_frame_without_dispatching_an_ocr_command(backend_over_bus, monkeypatch):
    from GameSentenceMiner.ocr import preview

    commands = []
    e.register_command_handler(commands.append)
    monkeypatch.setattr(
        preview, "capture_preview", lambda request: {"sceneId": request["sceneId"], "imageData": "jpeg-frame"}
    )
    e.start_ipc_listener_in_thread()
    assert bc.get_bus().wait_connected(5)
    backend_over_bus.send(
        {
            "v": 1,
            "id": "preview-request",
            "src": "main",
            "dst": "backend",
            "kind": "request",
            "topic": preview.PREVIEW_FRAME_TOPIC,
            "data": {"sceneId": "scene", "sceneName": "Game"},
        }
    )
    response = backend_over_bus.wait_for(lambda frame: frame.get("corr") == "preview-request")
    assert response["ok"] is True
    assert response["data"] == {"sceneId": "scene", "imageData": "jpeg-frame"}
    assert commands == []


def test_benchmark_switch_controls_real_bus_ingress(backend_over_bus, monkeypatch, tmp_path):
    import csv
    from types import SimpleNamespace

    from GameSentenceMiner import gametext
    from GameSentenceMiner.ocr import benchmark
    from GameSentenceMiner.text_pipeline.models import IngressAck, IngressStatus
    from GameSentenceMiner.util.config import configuration

    recorder = benchmark.OCRBenchmarkRecorder(tmp_path)
    monkeypatch.setattr(benchmark, "recorder", recorder)
    monkeypatch.setattr(configuration, "is_dev", True)
    monkeypatch.setattr(gametext, "is_message_rate_limited", lambda _source: False)
    accepted = []

    def ingest(observation):
        accepted.append(observation.source_kind.value)
        return SimpleNamespace(ack=IngressAck(IngressStatus.ACCEPTED, observation.observation_id))

    monkeypatch.setattr(gametext, "get_authoritative_text_runtime", lambda: SimpleNamespace(ingest=ingest))
    e.register_text_ingress_handler(gametext.ingest_text_v2_payload)
    e.start_ipc_listener_in_thread()
    assert bc.get_bus().wait_connected(5)

    def request(request_id, topic, data):
        backend_over_bus.send(
            {"v": 1, "id": request_id, "src": "main", "dst": "backend", "kind": "request", "topic": topic, "data": data}
        )
        response = backend_over_bus.wait_for(lambda frame: frame.get("corr") == request_id)
        assert response["ok"] is True
        return response["data"]

    try:
        started = request("benchmark-start", benchmark.BENCHMARK_TOPIC, {"enabled": True})
        assert started["enabled"] is True
        for index, source in enumerate(("ocr", "texthook", "ocr_manual", "screen_cropper")):
            ack = request(
                f"benchmark-text-{index}",
                e.TEXT_INGRESS_TOPIC,
                {"source": source, "text": "日本語の台詞", "ocr_engine": "vitaocr"},
            )
            assert ack["status"] == ("rejected" if source == "ocr" else "accepted")
        stopped = request("benchmark-stop", benchmark.BENCHMARK_TOPIC, {"enabled": False})
        assert stopped["enabled"] is False
        assert accepted == ["texthook", "ocr_manual", "screen_cropper"]
        resumed = request("benchmark-resumed", e.TEXT_INGRESS_TOPIC, {"source": "ocr", "text": "通常のOCR"})
        assert resumed["status"] == "accepted"
        with open(started["csv_path"], encoding="utf-8-sig", newline="") as stream:
            assert [row["source"] for row in csv.DictReader(stream)] == [
                "ocr",
                "texthook",
                "ocr_manual",
                "screen_cropper",
            ]
    finally:
        recorder.set_enabled(False)


def test_vita_model_selection_is_available_over_the_backend_bus(backend_over_bus, monkeypatch):
    from GameSentenceMiner.ocr import vita_model_manager

    requested = []
    monkeypatch.setattr(vita_model_manager, "select_model", lambda model: requested.append(model) or {"model": model})
    e.start_ipc_listener_in_thread()
    assert bc.get_bus().wait_connected(5)
    backend_over_bus.send(
        {
            "v": 1,
            "id": "model-request",
            "src": "main",
            "dst": "backend",
            "kind": "request",
            "topic": vita_model_manager.MODEL_TOPIC,
            "data": {"model": "large"},
        }
    )
    response = backend_over_bus.wait_for(lambda frame: frame.get("corr") == "model-request")
    assert response["ok"] is True
    assert response["data"] == {"model": "large"}
    assert requested == ["large"]
