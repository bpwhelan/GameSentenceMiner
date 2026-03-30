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
