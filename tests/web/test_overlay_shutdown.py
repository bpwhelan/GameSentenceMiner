from types import SimpleNamespace

from GameSentenceMiner.web import gsm_websocket


def test_overlay_shutdown_targets_the_managed_launch(monkeypatch):
    sent = []
    monkeypatch.setattr(
        gsm_websocket,
        "websocket_manager",
        SimpleNamespace(has_clients=lambda _: True, send_nowait=lambda *args: sent.append(args)),
    )

    assert gsm_websocket.request_overlay_shutdown("managed-launch") is True
    assert sent == [(gsm_websocket.ID_OVERLAY, {"type": "shutdown-overlay", "launchId": "managed-launch"})]


def test_overlay_shutdown_does_not_broadcast_without_a_launch_id_or_clients(monkeypatch):
    sent = []
    monkeypatch.setattr(
        gsm_websocket,
        "websocket_manager",
        SimpleNamespace(has_clients=lambda _: False, send_nowait=lambda *args: sent.append(args)),
    )
    assert gsm_websocket.request_overlay_shutdown("managed-launch") is False
    gsm_websocket.websocket_manager.has_clients = lambda _: True
    for launch_id in (None, "", 123):
        assert gsm_websocket.request_overlay_shutdown(launch_id) is False
    assert sent == []
