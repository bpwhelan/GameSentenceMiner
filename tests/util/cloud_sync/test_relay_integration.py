"""Run against the sibling Worker's Miniflare harness via GSM_SYNC_TEST_RELAY."""

import os

import pytest
from test_relay_store import TestDatabase, line

from GameSentenceMiner.util.cloud_sync.crypto import SyncCipher, new_sync_key
from GameSentenceMiner.util.cloud_sync.relay_client import RelayClient, SyncProtocolError
from GameSentenceMiner.util.cloud_sync.store import RelayStore

pytestmark = pytest.mark.skipif(
    not os.getenv("GSM_SYNC_TEST_RELAY"), reason="Start the local Worker interoperability harness"
)


def make_device(cipher, name, preferences=None):
    db = TestDatabase()
    store = RelayStore(db, "integration", name)
    preferences = preferences if preferences is not None else {}
    client = RelayClient(
        store,
        cipher,
        os.environ["GSM_SYNC_TEST_RELAY"],
        "local-interoperability-test-token-32-chars",
        settings_provider=lambda: dict(preferences),
        settings_apply=preferences.update,
    )
    return db, store, client


def test_two_devices_bootstrap_offline_edits_deletes_settings_and_recovery():
    cipher = SyncCipher(new_sync_key())
    preferences_a = {"general.target_language": "ja"}
    preferences_b = {"general.target_language": "fr"}
    a, _sa, ca = make_device(cipher, "a", preferences_a)
    b, _sb, cb = make_device(cipher, "b", preferences_b)
    try:
        line(a, "initial")
        result = ca.sync(max_rounds=None)
        assert result["status"] == "success" and result["snapshot"]
        assert cb.sync(max_rounds=None)["status"] == "success"
        assert preferences_b["general.target_language"] == "ja"
        assert b.conn.execute("SELECT line_text FROM game_lines").fetchone()[0] == "initial"

        a.conn.execute("UPDATE game_lines SET line_text='edit from a' WHERE id='one'")
        b.conn.execute("UPDATE game_lines SET line_text='edit from b' WHERE id='one'")
        preferences_b["general.target_language"] = "de"
        ca.sync(max_rounds=None)
        cb.sync(max_rounds=None)
        ca.sync(max_rounds=None)
        assert (
            a.conn.execute("SELECT line_text FROM game_lines").fetchone()
            == b.conn.execute("SELECT line_text FROM game_lines").fetchone()
        )
        assert preferences_a == preferences_b

        b.conn.execute("DELETE FROM game_lines WHERE id='one'")
        cb.sync(max_rounds=None)
        ca.sync(max_rounds=None, publish_snapshot=True)
        c, sc, cc = make_device(cipher, "c")
        try:
            line(c, "stale copy must not resurrect")
            cc.sync(max_rounds=None)
            assert c.conn.execute("SELECT COUNT(*) FROM game_lines").fetchone()[0] == 0
            assert sc.snapshot_records()[0]["deleted"] is True
        finally:
            c.conn.close()

        ca.request("", method="DELETE")
        with pytest.raises(SyncProtocolError, match="transfer"):
            cb.sync()
        assert ca.sync(max_rounds=None, reseed=True, publish_snapshot=True)["status"] == "success"
        assert cb.sync(max_rounds=None)["status"] == "success"
        assert b.conn.execute("SELECT COUNT(*) FROM game_lines").fetchone()[0] == 0
    finally:
        a.conn.close()
        b.conn.close()


def test_lost_http_response_retries_same_ciphertext_without_duplicate_changes():
    cipher = SyncCipher(new_sync_key())
    db, store, client = make_device(cipher, "retry")
    try:
        line(db)
        original = client.request
        dropped = False

        def lose_response(path, body=None, method=None):
            nonlocal dropped
            result = original(path, body, method)
            if path == "/exchange" and body["changes"] and not dropped:
                dropped = True
                raise SyncProtocolError("simulated lost response")
            return result

        client.request = lose_response
        with pytest.raises(SyncProtocolError):
            client.sync()
        assert store.pending_count() == 1
        client.request = original
        assert client.sync(max_rounds=None)["status"] == "success"
        assert client.remote_state()["head"] == 1
    finally:
        db.conn.close()


def test_multipart_bootstrap_reports_imported_lines_and_preserves_unicode():
    cipher = SyncCipher(new_sync_key())
    a, _sa, ca = make_device(cipher, "a")
    b, _sb, cb = make_device(cipher, "b")
    try:
        sentence = "長い日本語の文章🎮" * 150
        a.conn.executemany(
            "INSERT INTO game_lines(id,game_name,line_text,language,timestamp,note_ids,last_modified) VALUES(?,'game',?,'ja',1,'[]',1)",
            [(str(i), sentence) for i in range(300)],
        )
        first = ca.sync(max_rounds=None)
        assert first["snapshot"]["parts"] > 1
        second = cb.sync(max_rounds=None)
        assert second["applied_remote_upserts"] == 300
        assert second["received_changes"] == 300
        assert b.conn.execute("SELECT COUNT(*) FROM game_lines WHERE line_text=?", (sentence,)).fetchone()[0] == 300
    finally:
        a.conn.close()
        b.conn.close()
