from unittest.mock import Mock

import pytest

from GameSentenceMiner.util.communication import bus_client
from GameSentenceMiner.util import anki_yomitan
from GameSentenceMiner.web import onboarding_api
from GameSentenceMiner.web.gsm_websocket import websocket_manager


@pytest.fixture
def desktop(monkeypatch):
    bus = Mock()
    monkeypatch.setattr(bus_client, "is_bus_available", lambda: True)
    monkeypatch.setattr(bus_client, "get_bus", lambda: bus)
    monkeypatch.setattr(websocket_manager, "has_clients", lambda _: False)
    return bus


def test_dictionary_setup_works_without_overlay(desktop):
    desktop.request.return_value = {"success": True, "status": {"reader": "yomitan"}}
    assert onboarding_api.request_dictionary_setup({"action": "status"}) == {"reader": "yomitan"}
    args, kwargs = desktop.request.call_args
    assert args[:2] == (bus_client.MAIN, "dictionary.setup")
    assert args[2]["data"] == {"action": "status"}
    assert args[2]["deadline"] > 0
    assert kwargs["timeout"] == 20


def test_anki_setup_works_without_overlay(desktop):
    desktop.request.return_value = {"success": True, "profileName": "GSM - Lapis"}
    assert anki_yomitan.configure_yomitan({"preset": "lapis"}) == "GSM - Lapis"
    assert desktop.request.call_args.args[1] == "dictionary.ankiSetup"


def test_desktop_failure_does_not_retry_a_mutation_through_overlay(desktop, monkeypatch):
    send = Mock()
    monkeypatch.setattr(websocket_manager, "send_nowait", send)
    desktop.request.side_effect = TimeoutError("Desktop timeout")
    with pytest.raises(TimeoutError, match="Desktop timeout"):
        onboarding_api.request_dictionary_setup({"action": "install"})
    send.assert_not_called()


def test_dictionary_failure_is_reported(desktop):
    desktop.request.return_value = {"success": False, "error": "Dictionary unavailable"}
    with pytest.raises(RuntimeError, match="Dictionary unavailable"):
        onboarding_api.request_dictionary_setup({"action": "status"})
