from GameSentenceMiner.util.cloud_sync import service
from GameSentenceMiner.util.cloud_sync.crypto import new_sync_key
from GameSentenceMiner.util.config.configuration import Config


def configure(monkeypatch):
    config = Config.new()
    monkeypatch.setattr(service, "get_config", config.get_config)
    monkeypatch.setattr(service, "get_master_config", lambda: config)
    monkeypatch.setattr(service, "is_gsm_cloud_preview_enabled", lambda: False)
    return config


def test_cloud_sign_in_alone_does_not_enable_sync(monkeypatch):
    config = configure(monkeypatch)
    config.get_config().ai.gsm_cloud_api_url = "https://relay.example.test"
    config.get_config().ai.gsm_cloud_access_token = "secret"
    sync = service.CloudSyncService()
    assert sync._load_runtime_config()["enabled"] is False
    assert sync.sync_once(manual=True)["status"] == "skipped"


def test_relay_works_without_preview_and_keeps_pairing_material_out_of_status(monkeypatch):
    config = configure(monkeypatch)
    advanced = config.get_config().advanced
    advanced.cloud_sync_enabled = True
    advanced.cloud_sync_key = new_sync_key()
    advanced.cloud_sync_api_url = "https://relay.example.test"
    advanced.cloud_sync_api_token = "secret-bearer-token"
    sync = service.CloudSyncService()
    status = sync.get_status()
    assert status["configured"] is True
    assert status["enabled"] is True
    assert advanced.cloud_sync_key not in str(status)
    assert advanced.cloud_sync_api_token not in str(status)
    assert sync._load_runtime_config()["device_id"] != service.CloudSyncService()._load_runtime_config()["device_id"]


def test_missing_pairing_key_never_falls_back_to_plaintext(monkeypatch):
    config = configure(monkeypatch)
    advanced = config.get_config().advanced
    advanced.cloud_sync_enabled = True
    advanced.cloud_sync_api_url = "https://relay.example.test"
    advanced.cloud_sync_api_token = "token"
    monkeypatch.setattr(
        service.requests, "post", lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("plaintext upload"))
    )
    assert service.CloudSyncService().sync_once(manual=True)["status"] == "skipped"
