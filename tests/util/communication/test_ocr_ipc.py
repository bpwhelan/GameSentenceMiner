import io
import json
import threading

from GameSentenceMiner.util.communication import ocr_ipc


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
    payload = json.loads(raw[len("OCRMSG:"):])
    assert payload == {"event": "started", "data": {"ok": True}, "id": "evt1"}


def test_stdin_loop_dispatches_ocr_commands(monkeypatch):
    received = []
    ocr_ipc.register_command_handler(received.append)
    monkeypatch.setattr(
        ocr_ipc.sys,
        "stdin",
        io.StringIO(
            "noop\n"
            "OCRCMD:{\"command\":\"pause\"}\n"
            "OCRCMD:bad-json\n"
            "OCRCMD:{\"command\":\"get_status\",\"id\":\"7\"}\n"
        ),
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

    assert calls[0][0] == (ocr_ipc.OCREvent.STARTED.value,)
    assert calls[1][0] == (ocr_ipc.OCREvent.STOPPED.value,)
    assert calls[2][0] == (ocr_ipc.OCREvent.PAUSED.value, {"paused": True})
    assert calls[3][0] == (ocr_ipc.OCREvent.UNPAUSED.value, {"paused": False})
    assert calls[4][0] == (ocr_ipc.OCREvent.STATUS.value, {"scan_rate": 1.0})
    assert calls[5][0] == (ocr_ipc.OCREvent.ERROR.value, {"error": "boom", "code": 500})
    assert calls[6][0] == (ocr_ipc.OCREvent.OCR_RESULT.value, {"text": "hello", "lang": "ja"})
    assert calls[7][0] == (ocr_ipc.OCREvent.CONFIG_RELOADED.value,)
    assert calls[8][0] == (ocr_ipc.OCREvent.FORCE_STABLE_CHANGED.value, {"enabled": True})
