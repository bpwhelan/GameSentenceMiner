import copy

import pytest
from flask import Flask

from GameSentenceMiner.util.config.configuration import Config
from GameSentenceMiner.web import cloud_sync_api


@pytest.fixture
def api(monkeypatch):
    config = Config.new()
    monkeypatch.setattr(config, "save", lambda: None)
    monkeypatch.setattr(cloud_sync_api, "get_config", config.get_config)
    monkeypatch.setattr(cloud_sync_api, "get_master_config", lambda: config)
    monkeypatch.setattr(cloud_sync_api.cloud_sync_service, "refresh_background_loop", lambda: None)
    monkeypatch.setattr(cloud_sync_api.cloud_sync_service, "get_status", lambda: {"configured": False})
    app = Flask(__name__)
    cloud_sync_api.register_cloud_sync_api_routes(app)
    return app.test_client(), config


def test_invalid_config_is_atomic(api):
    client, config = api
    before = copy.deepcopy(config.get_config().advanced)
    response = client.post("/api/cloud-sync/settings", json={"enabled": True, "settings_groups": ["credentials"]})
    assert response.status_code == 400
    assert config.get_config().advanced == before


def test_control_endpoints_reject_cross_origin_and_non_local_requests(api):
    client, _ = api
    assert (
        client.post(
            "/api/cloud-sync/settings", json={"enabled": True}, headers={"Origin": "https://evil.test"}
        ).status_code
        == 403
    )
    assert client.get("/api/cloud-sync/status", environ_overrides={"REMOTE_ADDR": "192.168.0.2"}).status_code == 403
    assert client.get("/api/cloud-sync/status", headers={"Host": "rebind.example"}).status_code == 403


def test_run_rejects_invalid_round_count_instead_of_500(api):
    client, _ = api
    assert client.post("/api/cloud-sync/run", json={"max_rounds": "bad"}).status_code == 400
    assert client.post("/api/cloud-sync/run", json=[]).status_code == 400


def test_settings_sync_groups_and_protocol_save_without_returning_secrets(api):
    client, config = api
    response = client.post(
        "/api/cloud-sync/settings",
        json={"settings_groups": ["language"], "protocol": "relay-v2", "api_token": "private-token"},
    )
    assert response.status_code == 200
    assert config.get_config().advanced.cloud_sync_settings_groups == ["language"]
    assert "private-token" not in response.text
