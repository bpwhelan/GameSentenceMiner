import pytest
from test_relay_store import TestDatabase, line

from GameSentenceMiner.util.cloud_sync.crypto import SyncCipher, new_sync_key
from GameSentenceMiner.util.cloud_sync.relay_client import RelayClient, SyncProtocolError, validate_relay_url
from GameSentenceMiner.util.cloud_sync.store import RelayStore, install_tracking


@pytest.fixture
def client():
    db = TestDatabase()
    install_tracking(db)
    store = RelayStore(db, "scope", "a")
    cipher = SyncCipher(new_sync_key())
    client = RelayClient(store, cipher, "https://relay.example.test", "token")
    yield db, store, client
    db.conn.close()


@pytest.mark.parametrize(
    "url", ["http://example.com", "https://user:password@example.com", "https://example.com?q=x", "file:///a"]
)
def test_relay_url_rejects_insecure_or_credential_bearing_urls(url):
    with pytest.raises(ValueError):
        validate_relay_url(url)


def test_lost_or_incomplete_ack_does_not_clear_outbox(client, monkeypatch):
    db, store, relay = client
    line(db)
    store.capture_lines(seed=True)
    store.update_state(generation="generation", cursor=0)

    def request(path, body=None, method=None):
        if path == "/state":
            return {"protocol": 2, "generation": "generation", "head": 0, "floor": 0, "snapshot": None}
        return {
            "protocol": 2,
            "generation": "generation",
            "accepted_ids": [],
            "changes": [],
            "cursor": 0,
            "has_more": False,
        }

    monkeypatch.setattr(relay, "request", request)
    with pytest.raises(SyncProtocolError):
        relay.sync()
    assert store.pending_count() == 1
    assert store.state()["cursor"] == 0


def test_expired_device_requires_transfer_and_preserves_local_state(client, monkeypatch):
    db, store, relay = client
    line(db)
    store.capture_lines(seed=True)
    store.update_state(generation="old", cursor=12)
    monkeypatch.setattr(
        relay,
        "request",
        lambda *args, **kwargs: {"protocol": 2, "generation": "new", "head": 0, "floor": 0, "snapshot": None},
    )
    with pytest.raises(SyncProtocolError, match="transfer"):
        relay.sync()
    assert store.state()["generation"] == "old"
    assert store.pending_count() == 1


def test_corrupt_download_never_advances_cursor(client, monkeypatch):
    _db, store, relay = client
    store.update_state(generation="generation", cursor=0)

    def request(path, body=None, method=None):
        if path == "/state":
            return {"protocol": 2, "generation": "generation", "head": 1, "floor": 0, "snapshot": None}
        return {
            "protocol": 2,
            "generation": "generation",
            "accepted_ids": [],
            "changes": [{"seq": 1, "id": "b" * 32, "payload": "bad"}],
            "cursor": 1,
            "has_more": False,
        }

    monkeypatch.setattr(relay, "request", request)
    with pytest.raises(ValueError):
        relay.sync()
    assert store.state()["cursor"] == 0


def test_snapshot_metadata_is_authenticated(client):
    _, _, relay = client
    metadata = {"id": "c" * 32, "generation": "generation", "base": 1, "parts": 1, "part": 0}
    payload = relay.cipher.encrypt({"protocol": 2, "records": [], "snapshot": metadata}, "snapshot:test:0")
    with pytest.raises(SyncProtocolError, match="manifest"):
        relay._records(payload, "snapshot:test:0", {**metadata, "base": 99})
