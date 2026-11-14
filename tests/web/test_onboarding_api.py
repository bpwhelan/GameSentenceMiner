from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from flask import Flask

from GameSentenceMiner.web import onboarding_api as onboarding
from GameSentenceMiner.web.gsm_websocket import websocket_manager


@pytest.fixture
def setup_api(monkeypatch):
    config = SimpleNamespace(general=SimpleNamespace(target_language="ja"))
    save = Mock()
    monkeypatch.setattr(onboarding, "get_config", lambda: config)
    monkeypatch.setattr(onboarding, "save_current_config", save)
    app = Flask(__name__)
    app.testing = True
    onboarding.register_onboarding_routes(app)
    return app.test_client(), config, save


def test_language_updates_only_learning_language(setup_api):
    client, config, save = setup_api
    response = client.post("/api/onboarding/language", json={"language": "ko"})
    assert response.status_code == 200
    assert response.json == {"success": True, "language": "ko"}
    assert config.general.target_language == "ko"
    save.assert_called_once_with(config)


@pytest.mark.parametrize("payload", [None, [], {}, {"language": "invalid"}, {"language": {"value": "ja"}}])
def test_rejects_bad_languages_without_writing(setup_api, payload):
    client, config, save = setup_api
    assert client.post("/api/onboarding/language", json=payload).status_code == 400
    assert config.general.target_language == "ja"
    save.assert_not_called()


def test_failed_save_restores_language(setup_api):
    client, config, save = setup_api
    save.side_effect = OSError("disk full")
    with pytest.raises(OSError):
        client.post("/api/onboarding/language", json={"language": "ko"})
    assert config.general.target_language == "ja"


def test_dictionary_uses_configured_language_and_ignores_untrusted_download_url(setup_api, monkeypatch):
    client, _, _ = setup_api
    request = Mock(return_value={"reader": "yomitan", "installed": []})
    monkeypatch.setattr(onboarding, "request_dictionary_setup", request)
    response = client.post(
        "/api/onboarding/dictionary",
        json={
            "action": "install",
            "language": "ko",
            "downloadUrl": "file:///private",
        },
    )
    assert response.status_code == 200
    request.assert_called_once_with({"action": "install", "language": "ja"})


def test_dictionary_request_is_acknowledged_and_cleaned_up(monkeypatch):
    monkeypatch.setattr(websocket_manager, "has_clients", lambda _: True)

    def send(_channel, request):
        assert onboarding.accept_dictionary_setup_result(
            {
                "request_id": request["request_id"],
                "success": True,
                "status": {"busy": True},
            }
        )

    monkeypatch.setattr(websocket_manager, "send_nowait", send)
    assert onboarding.request_dictionary_setup({"action": "install"}) == {"busy": True}
    assert onboarding._pending == {}


def test_dictionary_timeout_does_not_leave_pending_requests(monkeypatch):
    monkeypatch.setattr(websocket_manager, "has_clients", lambda _: True)
    monkeypatch.setattr(websocket_manager, "send_nowait", lambda *_: None)
    with pytest.raises(TimeoutError):
        onboarding.request_dictionary_setup({"action": "status"}, timeout=0)
    assert onboarding._pending == {}
    assert not onboarding.accept_dictionary_setup_result({"request_id": "late"})


def test_disconnected_overlay_reports_retryable_startup(setup_api, monkeypatch):
    client, _, _ = setup_api
    monkeypatch.setattr(websocket_manager, "has_clients", lambda _: False)
    response = client.post("/api/onboarding/dictionary", json={"action": "status"})
    assert response.status_code == 503
    assert response.json["code"] == "overlay_starting"


def test_sudachi_status_never_installs_and_install_uses_validated_edition(setup_api, monkeypatch):
    from GameSentenceMiner.sudachi import setup

    client, _, _ = setup_api
    status = Mock(return_value={"state": "setup_required", "dictionary": "core"})
    install = Mock(return_value={"state": "installing"})
    monkeypatch.setattr(setup, "dictionary_status", status)
    monkeypatch.setattr(setup, "install_dictionary", install)
    assert client.post("/api/onboarding/sudachi", json={"action": "status"}).json["state"] == "setup_required"
    install.assert_not_called()
    assert (
        client.post(
            "/api/onboarding/sudachi", json={"action": "install", "dictionary": "full", "url": "untrusted"}
        ).json["state"]
        == "installing"
    )
    install.assert_called_once_with("full")
    assert (
        client.post("/api/onboarding/sudachi", json={"action": "install", "dictionary": "unknown"}).status_code == 400
    )
    assert client.post("/api/onboarding/sudachi", json=[]).status_code == 400
