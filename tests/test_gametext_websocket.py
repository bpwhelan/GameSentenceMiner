import asyncio
from types import SimpleNamespace

import GameSentenceMiner.gametext as gametext


def _make_config(*, use_websocket: bool, ocr_websocket_port: int = 9002):
    return SimpleNamespace(
        general=SimpleNamespace(
            use_websocket=use_websocket,
            use_clipboard=False,
            use_both_clipboard_and_websocket=False,
            websocket_sources=[],
        ),
        advanced=SimpleNamespace(ocr_websocket_port=ocr_websocket_port),
    )


def test_listen_on_websocket_keeps_ocr_listener_active_when_general_websocket_disabled(
    monkeypatch,
):
    stop_event = asyncio.Event()
    attempted_urls = []

    class FailingConnect:
        def __init__(self, url, ping_interval=None):
            attempted_urls.append(url)
            stop_event.set()

        async def __aenter__(self):
            raise ConnectionError("expected test failure")

        async def __aexit__(self, exc_type, exc, tb):
            return False

    async def fake_sleep(_seconds):
        stop_event.set()

    monkeypatch.setattr(gametext, "get_config", lambda: _make_config(use_websocket=False))
    monkeypatch.setattr(
        gametext.websockets,
        "connect",
        lambda url, ping_interval=None: FailingConnect(url, ping_interval),
    )
    monkeypatch.setattr(gametext.asyncio, "sleep", fake_sleep)
    monkeypatch.setattr(gametext, "gsm_status", SimpleNamespace(websockets_connected=[]))
    gametext.websocket_connected.clear()

    asyncio.run(gametext.listen_on_websocket("localhost:9002", stop_event=stop_event))

    assert attempted_urls == ["ws://localhost:9002"]


def test_listen_on_websocket_keeps_non_ocr_listener_paused_when_general_websocket_disabled(
    monkeypatch,
):
    stop_event = asyncio.Event()
    attempted_urls = []
    sleep_calls = []

    async def fake_sleep(seconds):
        sleep_calls.append(seconds)
        stop_event.set()

    monkeypatch.setattr(gametext, "get_config", lambda: _make_config(use_websocket=False))
    monkeypatch.setattr(
        gametext.websockets,
        "connect",
        lambda url, ping_interval=None: attempted_urls.append(url),
    )
    monkeypatch.setattr(gametext.asyncio, "sleep", fake_sleep)
    monkeypatch.setattr(gametext, "gsm_status", SimpleNamespace(websockets_connected=[]))
    gametext.websocket_connected.clear()

    asyncio.run(gametext.listen_on_websocket("localhost:6677", stop_event=stop_event))

    assert attempted_urls == []
    assert sleep_calls == [5]


def test_add_line_to_text_log_uses_display_source_name_for_logging(monkeypatch):
    logged_messages = []

    class DummyLogger:
        def opt(self, **_kwargs):
            return self

        def info(self, message):
            logged_messages.append(message)

    monkeypatch.setattr(gametext, "logger", DummyLogger())
    monkeypatch.setattr(gametext, "get_config", lambda: SimpleNamespace(text_processing=SimpleNamespace()))
    monkeypatch.setattr(gametext, "apply_text_processing", lambda line, _config: line)
    monkeypatch.setattr(gametext, "live_stats_tracker", SimpleNamespace(add_line=lambda *_args, **_kwargs: None))
    monkeypatch.setattr(gametext, "gsm_status", SimpleNamespace(last_line_received=""))
    monkeypatch.setattr(gametext, "add_line", lambda line, line_time, source=None: None)

    asyncio.run(
        gametext.add_line_to_text_log(
            "test line",
            source="secondary",
            source_display_name="Clipboard",
        )
    )

    assert logged_messages == ["<cyan>Line Received from [Clipboard]: test line</cyan>"]


def test_resolve_websocket_source_name_prefers_configured_name(monkeypatch):
    monkeypatch.setattr(
        gametext,
        "get_config",
        lambda: SimpleNamespace(
            general=SimpleNamespace(
                websocket_sources=[SimpleNamespace(uri="localhost:6677", name="Agent", enabled=True)],
            ),
            advanced=SimpleNamespace(ocr_websocket_port=9002),
        ),
    )

    assert gametext.resolve_websocket_source_name("localhost:6677") == "Agent"


def test_resolve_websocket_source_name_uses_gsm_ocr_label_for_ocr_socket(monkeypatch):
    monkeypatch.setattr(
        gametext,
        "get_config",
        lambda: SimpleNamespace(
            general=SimpleNamespace(websocket_sources=[]),
            advanced=SimpleNamespace(ocr_websocket_port=9002),
        ),
    )

    assert gametext.resolve_websocket_source_name("localhost:9002") == "GSM OCR"


def test_handle_new_text_event_is_noop_when_text_intake_paused_and_relay_disabled(monkeypatch):
    add_line_calls = []
    discord_calls = []
    obs_calls = []

    async def fake_add_line_to_text_log(*args, **kwargs):
        add_line_calls.append((args, kwargs))

    monkeypatch.setattr(
        gametext,
        "get_config",
        lambda: SimpleNamespace(
            general=SimpleNamespace(merge_matching_sequential_text=False),
            hotkeys=SimpleNamespace(relay_outputs_when_text_intake_paused=False),
        ),
    )
    monkeypatch.setattr(gametext.obs, "update_current_game", lambda: obs_calls.append(True))
    monkeypatch.setattr(
        gametext.discord_rpc_manager,
        "update",
        lambda *_args, **_kwargs: discord_calls.append(True),
    )
    monkeypatch.setattr(gametext, "add_line_to_text_log", fake_add_line_to_text_log)
    monkeypatch.setattr(gametext.gsm_state, "text_input_paused", True, raising=False)
    monkeypatch.setattr(gametext, "current_line", "")

    asyncio.run(gametext.handle_new_text_event("ignored line"))

    assert gametext.current_line == "ignored line"
    assert obs_calls == []
    assert discord_calls == []
    assert add_line_calls == []


def test_set_text_intake_paused_announces_state_and_notifies(monkeypatch):
    announced_states = []
    paused_notifications = []
    resumed_notifications = []

    monkeypatch.setattr(
        gametext,
        "get_config",
        lambda: SimpleNamespace(
            hotkeys=SimpleNamespace(relay_outputs_when_text_intake_paused=True),
        ),
    )
    monkeypatch.setattr(gametext, "announce_text_intake_state", lambda paused: announced_states.append(paused))
    monkeypatch.setattr(
        gametext,
        "send_text_intake_paused_notification",
        lambda relay_enabled: paused_notifications.append(relay_enabled),
    )
    monkeypatch.setattr(
        gametext,
        "send_text_intake_resumed_notification",
        lambda: resumed_notifications.append(True),
    )
    monkeypatch.setattr(gametext.gsm_state, "text_input_paused", False, raising=False)

    assert gametext.set_text_intake_paused(True) is True
    assert gametext.set_text_intake_paused(False) is False

    assert announced_states == [True, False]
    assert paused_notifications == [True]
    assert resumed_notifications == [True]


def test_add_line_to_text_log_relays_only_to_outputs_when_text_intake_paused(monkeypatch):
    relayed_lines = []
    stats_calls = []
    add_line_calls = []

    class DummyLogger:
        def opt(self, **_kwargs):
            return self

        def info(self, _message):
            return None

    async def fake_add_event_to_texthooker(line):
        relayed_lines.append(line)

    monkeypatch.setattr(
        gametext,
        "get_config",
        lambda: SimpleNamespace(
            text_processing=SimpleNamespace(),
            hotkeys=SimpleNamespace(relay_outputs_when_text_intake_paused=True),
        ),
    )
    monkeypatch.setattr(gametext, "apply_text_processing", lambda line, _config: f"processed:{line}")
    monkeypatch.setattr(
        gametext,
        "live_stats_tracker",
        SimpleNamespace(add_line=lambda *args, **_kwargs: stats_calls.append(args)),
    )
    monkeypatch.setattr(gametext, "logger", DummyLogger())
    monkeypatch.setattr(gametext, "gsm_status", SimpleNamespace(last_line_received=""))
    monkeypatch.setattr(gametext, "_add_event_to_texthooker", fake_add_event_to_texthooker)
    monkeypatch.setattr(gametext, "add_line", lambda *args, **kwargs: add_line_calls.append((args, kwargs)))
    monkeypatch.setattr(gametext.gsm_state, "text_input_paused", True, raising=False)
    monkeypatch.setattr(gametext.gsm_state, "current_game", "Paused Game", raising=False)

    asyncio.run(gametext.add_line_to_text_log("raw line", source="secondary"))

    assert stats_calls == []
    assert add_line_calls == []
    assert len(relayed_lines) == 1
    assert relayed_lines[0].text == "processed:raw line"
    assert relayed_lines[0].scene == "Paused Game"
    assert relayed_lines[0].source == "secondary"
