import io
import json
import threading
from types import SimpleNamespace

import pytest

from GameSentenceMiner.util.communication import ocr_ipc


def test_announce_stopped_does_not_join_outbox_on_bus_callback_thread(monkeypatch):
    events = []
    monkeypatch.setattr(ocr_ipc, "send_event", lambda event: events.append(event))

    def unexpected_join():
        pytest.fail("The bus callback must remain free to process delivery acknowledgements")

    monkeypatch.setattr(ocr_ipc, "stop_text_ingress_outbox", unexpected_join)
    ocr_ipc.announce_stopped()
    assert events == ["stopped"]


@pytest.mark.parametrize("outbox_fails", [False, True])
def test_stop_listener_drains_outbox_before_bus_and_prevents_late_results(monkeypatch, outbox_fails):
    calls = []
    monkeypatch.setattr(ocr_ipc, "_stopping", False)
    monkeypatch.setattr(ocr_ipc, "_command_handler", lambda _cmd: None)
    monkeypatch.setattr(ocr_ipc, "_use_bus", lambda: True)
    monkeypatch.setattr(ocr_ipc.bus_client, "get_bus", lambda: SimpleNamespace(stop=lambda: calls.append("bus")))

    def drain():
        calls.append("outbox")
        if outbox_fails:
            raise RuntimeError("outbox failed")
        return True

    monkeypatch.setattr(ocr_ipc, "stop_text_ingress_outbox", drain)
    if outbox_fails:
        with pytest.raises(RuntimeError, match="outbox failed"):
            ocr_ipc.stop_ipc_listener()
    else:
        ocr_ipc.stop_ipc_listener()

    assert calls == ["outbox", "bus"]
    assert ocr_ipc._command_handler is None
    ocr_ipc.announce_ocr_result("late result")
    assert ocr_ipc.get_text_ingress_outbox() is None
    assert calls == ["outbox", "bus"]


def test_send_event_prints_structured_payload(monkeypatch):
    lines = []

    def fake_print(value, flush=False):
        lines.append((value, flush))

    monkeypatch.setattr(ocr_ipc, "print", fake_print, raising=False)
    ocr_ipc.send_event("started", {"ok": True}, id="evt1")

    assert len(lines) == 1
    raw, flush = lines[0]
    assert flush is True
    assert raw.startswith("OCRMSG:")
    payload = json.loads(raw[len("OCRMSG:") :])
    assert payload == {"event": "started", "data": {"ok": True}, "id": "evt1"}


def test_stdin_loop_dispatches_ocr_commands(monkeypatch):
    received = []
    ocr_ipc.register_command_handler(received.append)
    monkeypatch.setattr(
        ocr_ipc.sys,
        "stdin",
        io.StringIO('noop\nOCRCMD:{"command":"pause"}\nOCRCMD:bad-json\nOCRCMD:{"command":"get_status","id":"7"}\n'),
    )

    ocr_ipc._stdin_loop()

    assert received == [{"command": "pause"}, {"command": "get_status", "id": "7"}]


def test_start_ipc_listener_reuses_running_thread(monkeypatch):
    event = threading.Event()

    def fake_loop():
        event.set()

    ocr_ipc._stdin_thread = None
    monkeypatch.setattr(ocr_ipc, "_stdin_loop", fake_loop)
    first = ocr_ipc.start_ipc_listener()
    first.join(timeout=1)
    assert event.is_set()

    class _AliveThread:
        def is_alive(self):
            return True

    alive = _AliveThread()
    ocr_ipc._stdin_thread = alive
    second = ocr_ipc.start_ipc_listener()
    assert second is alive


def test_convenience_announce_helpers(monkeypatch):
    calls = []
    monkeypatch.setattr(ocr_ipc, "send_event", lambda *args, **kwargs: calls.append((args, kwargs)))

    ocr_ipc.announce_started()
    ocr_ipc.announce_stopped()
    ocr_ipc.announce_paused()
    ocr_ipc.announce_unpaused()
    ocr_ipc.announce_status({"scan_rate": 1.0})
    ocr_ipc.announce_error("boom", {"code": 500})
    ocr_ipc.announce_ocr_result("hello", {"lang": "ja"})
    ocr_ipc.announce_config_reloaded()
    ocr_ipc.announce_force_stable_changed(True)

    assert calls, "no IPC messages were sent"
    assert calls[0][0] == (ocr_ipc.OCREvent.STARTED.value,)
    assert calls[1][0] == (ocr_ipc.OCREvent.STOPPED.value,)
    assert calls[2][0] == (ocr_ipc.OCREvent.PAUSED.value, {"paused": True})
    assert calls[3][0] == (ocr_ipc.OCREvent.UNPAUSED.value, {"paused": False})
    assert calls[4][0] == (ocr_ipc.OCREvent.STATUS.value, {"scan_rate": 1.0})
    assert calls[5][0] == (ocr_ipc.OCREvent.ERROR.value, {"error": "boom", "code": 500})
    assert calls[6][0] == (
        ocr_ipc.OCREvent.OCR_RESULT.value,
        {"text": "hello", "lang": "ja"},
    )
    assert calls[7][0] == (ocr_ipc.OCREvent.CONFIG_RELOADED.value,)
    assert calls[8][0] == (
        ocr_ipc.OCREvent.FORCE_STABLE_CHANGED.value,
        {"enabled": True},
    )
