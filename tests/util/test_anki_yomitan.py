from unittest.mock import Mock

import pytest

from GameSentenceMiner.anki_setup import AnkiSetupError
from GameSentenceMiner.util import anki_yomitan
from GameSentenceMiner.web.gsm_websocket import websocket_manager


def test_overlay_success_requires_correlated_acknowledgement(monkeypatch):
    monkeypatch.setattr(websocket_manager, "has_clients", lambda _: True)

    def send(_, message):
        assert message["type"] == "anki-setup-yomitan"
        assert not anki_yomitan.accept_yomitan_setup_result({"request_id": "unrelated", "success": True})
        assert anki_yomitan.accept_yomitan_setup_result(
            {
                "request_id": message["request_id"],
                "success": True,
                "profileName": "GSM - Lapis",
            }
        )

    monkeypatch.setattr(websocket_manager, "send_nowait", send)
    assert anki_yomitan.configure_yomitan({"preset": "lapis"}) == "GSM - Lapis"
    assert not anki_yomitan._pending


def test_overlay_timeout_discards_late_acknowledgement(monkeypatch):
    monkeypatch.setattr(websocket_manager, "has_clients", lambda _: True)
    send = Mock()
    monkeypatch.setattr(websocket_manager, "send_nowait", send)
    with pytest.raises(AnkiSetupError, match="did not confirm"):
        anki_yomitan.configure_yomitan({}, timeout=0.01)
    request = send.call_args.args[1]
    assert not anki_yomitan.accept_yomitan_setup_result({"request_id": request["request_id"], "success": True})
    assert not anki_yomitan._pending


def test_missing_overlay_fails_immediately(monkeypatch):
    monkeypatch.setattr(websocket_manager, "has_clients", lambda _: False)
    with pytest.raises(AnkiSetupError, match="Start the GSM overlay"):
        anki_yomitan.configure_yomitan({})


def test_overlay_failure_is_not_success(monkeypatch):
    monkeypatch.setattr(websocket_manager, "has_clients", lambda _: True)
    monkeypatch.setattr(
        websocket_manager,
        "send_nowait",
        lambda _, message: anki_yomitan.accept_yomitan_setup_result(
            {
                "request_id": message["request_id"],
                "success": False,
                "error": "Yomitan is not loaded",
            }
        ),
    )
    with pytest.raises(AnkiSetupError, match="Yomitan is not loaded"):
        anki_yomitan.configure_yomitan({})
    assert not anki_yomitan._pending
