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
