import io
import json
import threading

from GameSentenceMiner.util.communication import electron_ipc


def test_send_message_prints_structured_payload(monkeypatch):
    lines = []

    def fake_print(value, flush=False):
        lines.append((value, flush))

    monkeypatch.setattr(electron_ipc, "print", fake_print, raising=False)

    electron_ipc.send_message("start", {"ok": True}, id="abc")

    assert len(lines) == 1
    raw, flush = lines[0]
    assert flush is True
    assert raw.startswith("GSMMSG:")
    payload = json.loads(raw[len("GSMMSG:"):])
    assert payload == {"function": "start", "data": {"ok": True}, "id": "abc"}


def test_stdin_loop_dispatches_only_valid_gsmcmd_lines(monkeypatch):
    received = []
    electron_ipc.register_command_handler(received.append)

    stdin_data = io.StringIO(
        "ignored\n"
        "GSMCMD:{\"function\":\"ping\",\"data\":{\"x\":1}}\n"
        "GSMCMD:not-json\n"
        "GSMCMD:{\"function\":\"pong\"}\n"
    )
    monkeypatch.setattr(electron_ipc.sys, "stdin", stdin_data)

    electron_ipc._stdin_loop()

    assert received == [{"function": "ping", "data": {"x": 1}}, {"function": "pong"}]


def test_start_ipc_listener_starts_daemon_thread(monkeypatch):
    ran = threading.Event()

    def fake_loop():
        ran.set()

    monkeypatch.setattr(electron_ipc, "_stdin_loop", fake_loop)
    thread = electron_ipc.start_ipc_listener_in_thread()
    thread.join(timeout=1)

    assert ran.is_set()
    assert thread.daemon is True
    assert thread.name == "GSM_IPC_Listener"


def test_convenience_announce_helpers(monkeypatch):
    calls = []
    monkeypatch.setattr(electron_ipc, "send_message", lambda *args, **kwargs: calls.append((args, kwargs)))

    electron_ipc.announce_start()
    electron_ipc.announce_stop()
    electron_ipc.announce_connected()
    electron_ipc.announce_status({"ready": True})

    assert calls[0][0] == (electron_ipc.FunctionName.START.value,)
    assert calls[1][0] == (electron_ipc.FunctionName.STOP.value,)
    assert calls[2][0] == (electron_ipc.FunctionName.CONNECT.value, {"message": "Python Connected"})
    assert calls[3][0] == (electron_ipc.FunctionName.GET_STATUS.value, {"ready": True})
