import json
import sqlite3

import pytest

from GameSentenceMiner.util.cloud_sync.store import RelayStore, install_tracking


class TestDatabase:
    __test__ = False

    def __init__(self):
        self.conn = sqlite3.connect(":memory:")
        self.conn.execute("""CREATE TABLE game_lines (
            id TEXT PRIMARY KEY, game_name TEXT, line_text TEXT, language TEXT,
            timestamp REAL, note_ids TEXT, last_modified REAL, original_game_name TEXT,
            game_id TEXT, created_at REAL, audio_path TEXT)""")

    def run_transaction(self, fn):
        with self.conn:
            return fn(self.conn)


@pytest.fixture
def device():
    db = TestDatabase()
    install_tracking(db)
    store = RelayStore(db, "scope", "device-a")
    yield db, store
    db.conn.close()


def line(db, text="first"):
    db.conn.execute(
        "INSERT INTO game_lines(id,game_name,line_text,language,timestamp,note_ids,last_modified) VALUES('one','game',?,'ja',1,'[]',1)",
        (text,),
    )


def record(version, text="remote", deleted=False):
    return {
        "kind": "line",
        "id": "one",
        "version": [version, "device-b"],
        "deleted": deleted,
        "data": None
        if deleted
        else {
            "game_name": "game",
            "line_text": text,
            "language": "ja",
            "timestamp": 1,
            "note_ids": [],
            "last_modified": 1,
        },
    }


def test_upload_ack_cannot_erase_an_edit_made_during_request(device):
    db, store = device
    line(db)
    store.capture_lines(seed=True)
    outgoing = store.pending()
    db.conn.execute("UPDATE game_lines SET line_text='edited during request' WHERE id='one'")
    store.accept([record(0)], [outgoing[0]["id"]], "generation", 1)
    store.capture_lines()
    assert db.conn.execute("SELECT line_text FROM game_lines").fetchone()[0] == "edited during request"
    assert len(store.pending()) == 1


def test_deletions_survive_replays_and_snapshot_merges(device):
    db, store = device
    store.accept([record(5, deleted=True)], [], "generation", 1)
    store.accept([record(2)], [], "generation", 2)
    assert db.conn.execute("SELECT COUNT(*) FROM game_lines").fetchone()[0] == 0
    assert store.snapshot_records()[0]["deleted"] is True


def test_same_counter_conflicts_converge_independently_of_order(device):
    db, store = device
    low = record(3, "low")
    low["version"][1] = "device-a"
    high = record(3, "high")
    store.accept([high, low], [], "generation", 2)
    assert db.conn.execute("SELECT line_text FROM game_lines").fetchone()[0] == "high"


def test_failed_page_does_not_ack_or_advance_cursor(device):
    db, store = device
    line(db)
    store.capture_lines(seed=True)
    outgoing = store.pending()
    invalid = record(9)
    invalid["data"]["timestamp"] = "bad"
    with pytest.raises(ValueError):
        store.accept([record(5), invalid], [outgoing[0]["id"]], "generation", 2)
    assert store.state().get("cursor", 0) == 0
    assert len(store.pending()) == 1
    assert db.conn.execute("SELECT line_text FROM game_lines").fetchone()[0] == "first"


def test_remote_updates_preserve_media_and_do_not_echo(device):
    db, store = device
    line(db)
    db.conn.execute("UPDATE game_lines SET audio_path='local.wav' WHERE id='one'")
    store.capture_lines(seed=True)
    store.accept([record(8)], [p["id"] for p in store.pending()], "generation", 1)
    store.capture_lines()
    assert store.pending() == []
    assert db.conn.execute("SELECT audio_path FROM game_lines").fetchone()[0] == "local.wav"
    db.conn.execute("UPDATE game_lines SET game_id='linked-game' WHERE id='one'")
    store.capture_lines()
    assert store.pending() == []


def test_settings_first_join_adopts_remote_then_tracks_local_edits(device):
    _, store = device
    setting = {
        "kind": "setting",
        "id": "general.target_language",
        "version": [5, "peer"],
        "deleted": False,
        "data": "fr",
    }
    store.accept([setting], [], "generation", 1)
    store.capture_settings({"general.target_language": "ja"})
    assert store.pending() == []
    assert store.settings_to_apply({"general.target_language": "ja"}) == {"general.target_language": "fr"}
    store.mark_settings_applied({"general.target_language": "fr"})
    store.capture_settings({"general.target_language": "de"})
    assert json.loads(store.pending()[0]["record"])["data"] == "de"


def test_scope_keeps_cursors_and_outbox_separate(device):
    db, store = device
    store.accept([], [], "generation", 4)
    other = RelayStore(db, "different-server-and-key", "device-a")
    assert other.state().get("cursor", 0) == 0


def test_switching_scopes_catches_edits_and_deletions_from_other_scope(device):
    db, first = device
    line(db)
    first.capture_lines(seed=True)
    second = RelayStore(db, "second", "a")
    second.capture_lines(seed=True)
    db.conn.execute("DELETE FROM game_lines WHERE id='one'")
    second.capture_lines()
    first.capture_lines()
    assert first.snapshot_records()[0]["deleted"] is True


def test_many_legacy_tombstones_seed_once_without_requeueing_forever(device):
    db, store = device
    db.conn.execute("CREATE TABLE sync_game_line_changes (line_id TEXT, change_type TEXT)")
    db.conn.executemany("INSERT INTO sync_game_line_changes VALUES(?,'delete')", [(str(i),) for i in range(1005)])
    assert store.capture_lines(seed=True) == 1005
    assert store.capture_lines(seed=True) == 0


def test_disabling_settings_drops_unsent_preferences_and_excludes_transfer(device):
    _, store = device
    store.capture_settings({"general.target_language": "ja"})
    assert store.pending_count() == 1
    store.capture_settings({})
    assert store.pending_count() == 0
    store.freeze_snapshot(settings_keys=set())
    assert list(store.staged_pages()) == []


def test_legacy_seeded_tombstone_dominates_unversioned_stale_line(device):
    db, store = device
    db.conn.execute("CREATE TABLE sync_game_line_changes (line_id TEXT, change_type TEXT)")
    db.conn.execute("INSERT INTO sync_game_line_changes VALUES('one','delete')")
    store.capture_lines(seed=True)
    stale = record(0)
    stale["version"][1] = "f" * 64
    store.accept([stale], [], "generation", 1)
    assert db.conn.execute("SELECT COUNT(*) FROM game_lines").fetchone()[0] == 0
