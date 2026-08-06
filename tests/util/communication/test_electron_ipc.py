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
    payload = json.loads(raw[len("GSMMSG:") :])
    assert payload == {"function": "start", "data": {"ok": True}, "id": "abc"}


def test_send_message_can_wait_until_bus_frame_is_written(monkeypatch):
    calls = []

    class _FakeFuture:
        def result(self, timeout):
            calls.append(("wait", timeout))

    class _FakeBus:
        def publish(self, *args):
            calls.append(("publish", args))
            return _FakeFuture()

    monkeypatch.setattr(electron_ipc, "_use_bus", lambda: True)
    monkeypatch.setattr(electron_ipc.bus_client, "get_bus", lambda: _FakeBus())

    electron_ipc.send_message("cleanup_complete", wait=True)

    assert calls == [
        (
            "publish",
            (
                electron_ipc.bus_client.MAIN,
                electron_ipc.BACKEND_EVENT_TOPIC,
                {"function": "cleanup_complete"},
            ),
        ),
        ("wait", 1.0),
    ]


def test_stop_ipc_listener_can_leave_bus_open_for_final_ack(monkeypatch):
    bus_stops = []
    monkeypatch.setattr(electron_ipc, "_use_bus", lambda: True)
    monkeypatch.setattr(
        electron_ipc.bus_client,
        "get_bus",
        lambda: type("FakeBus", (), {"stop": lambda self: bus_stops.append(True)})(),
    )
    monkeypatch.setattr(electron_ipc, "_command_actor", None)

    electron_ipc.stop_ipc_listener(close_bus=False)

    assert bus_stops == []


def test_stdin_loop_dispatches_only_valid_gsmcmd_lines(monkeypatch):
    received = []
    electron_ipc.register_command_handler(received.append)

    class InlineRef:
        @staticmethod
        def tell(message):
            electron_ipc._safe_dispatch(message)

    monkeypatch.setattr(electron_ipc, "_get_command_actor", lambda: type("InlineActor", (), {"ref": InlineRef()})())

    stdin_data = io.StringIO(
        'ignored\nGSMCMD:{"function":"ping","data":{"x":1}}\nGSMCMD:not-json\nGSMCMD:{"function":"pong"}\n'
    )
    monkeypatch.setattr(electron_ipc.sys, "stdin", stdin_data)

    electron_ipc._stdin_loop()

    assert received == [{"function": "ping", "data": {"x": 1}}, {"function": "pong"}]


def test_start_ipc_listener_starts_named_platform_input_thread(monkeypatch):
    ran = threading.Event()

    def fake_loop():
        ran.set()

    monkeypatch.setattr(electron_ipc, "_stdin_loop", fake_loop)
    thread = electron_ipc.start_ipc_listener_in_thread()
    thread.join(timeout=1)

    assert ran.is_set()
    # stdin is the one listener that cannot be interrupted portably; domain
    # commands still cross into the bounded command actor.
    assert thread.daemon is True
    assert thread.name == "GSM_IPC_Listener"
    electron_ipc.stop_ipc_listener()


def test_convenience_announce_helpers(monkeypatch):
    calls = []
    monkeypatch.setattr(
        electron_ipc,
        "send_message",
        lambda *args, **kwargs: calls.append((args, kwargs)),
    )

    electron_ipc.announce_start()
    electron_ipc.announce_stop()
    electron_ipc.announce_connected()
    electron_ipc.announce_status({"ready": True})
    electron_ipc.request_hoshidicts_settings_open()

    assert calls, "no IPC messages were sent"
    assert calls[0][0] == (electron_ipc.FunctionName.START.value,)
    assert calls[1][0] == (electron_ipc.FunctionName.STOP.value,)
    assert calls[2][0] == (
        electron_ipc.FunctionName.CONNECT.value,
        {"message": "Python Connected"},
    )
    assert calls[3][0] == (electron_ipc.FunctionName.GET_STATUS.value, {"ready": True})
    assert calls[4][0] == (electron_ipc.FunctionName.OPEN_HOSHIDICTS_SETTINGS.value,)


def test_send_install_progress_uses_active_session_id_and_clamps_progress(monkeypatch):
    calls = []
    monkeypatch.setenv("GSM_INSTALL_SESSION_ID", "session-42")
    monkeypatch.setattr(
        electron_ipc,
        "send_message",
        lambda *args, **kwargs: calls.append((args, kwargs)),
    )

    electron_ipc.send_install_progress(
        stage_id="ffmpeg",
        status="running",
        progress_kind="bytes",
        progress=2.0,
        message="Downloading FFmpeg...",
        downloaded_bytes=512,
        total_bytes=1024,
    )

    assert calls == [
        (
            (
                "install_progress",
                {
                    "session_id": "session-42",
                    "stage_id": "ffmpeg",
                    "status": "running",
                    "progress_kind": "bytes",
                    "message": "Downloading FFmpeg...",
                    "progress": 1.0,
                    "downloaded_bytes": 512,
                    "total_bytes": 1024,
                },
            ),
            {},
        )
    ]


def test_get_install_session_id_returns_blank_when_unset(monkeypatch):
    monkeypatch.delenv("GSM_INSTALL_SESSION_ID", raising=False)

    assert electron_ipc.get_install_session_id() == ""
