import time

from GameSentenceMiner.util.config.configuration import get_config
from GameSentenceMiner.util.database.db import GameLinesTable


def _reset_tables() -> None:
    GameLinesTable._db.execute(
        f"DELETE FROM {GameLinesTable._table}",
        commit=True,
    )
    GameLinesTable._db.execute(
        f"DELETE FROM {GameLinesTable._sync_changes_table}",
        commit=True,
    )


def test_triggers_track_insert_update_delete() -> None:
    _reset_tables()

    line = GameLinesTable(
        id="sync_line_1",
        game_name="Test Game",
        line_text="first line",
        timestamp=time.time(),
    )
    line.add()

    pending = GameLinesTable.get_pending_sync_changes()
    assert len(pending) == 1
    assert pending[0]["id"] == "sync_line_1"
    assert pending[0]["operation"] == "upsert"
    assert pending[0]["data"]["line_text"] == "first line"
    assert pending[0]["data"]["language"] == get_config().general.target_language

    GameLinesTable.update("sync_line_1", translation="translated")
    pending_after_update = GameLinesTable.get_pending_sync_changes()
    assert len(pending_after_update) == 1
    assert pending_after_update[0]["operation"] == "upsert"
    assert "translation" not in pending_after_update[0]["data"]

    GameLinesTable.delete_line("sync_line_1")
    pending_after_delete = GameLinesTable.get_pending_sync_changes()
    assert len(pending_after_delete) == 1
    assert pending_after_delete[0]["id"] == "sync_line_1"
    assert pending_after_delete[0]["operation"] == "delete"


def test_acknowledge_and_queue_all_lines_for_sync() -> None:
    _reset_tables()

    GameLinesTable(
        id="sync_line_2",
        game_name="Game A",
        line_text="line a",
        timestamp=time.time(),
    ).add()
    GameLinesTable(
        id="sync_line_3",
        game_name="Game B",
        line_text="line b",
        timestamp=time.time(),
    ).add()

    # Simulate a clean pending queue, then bootstrap from full table scan.
    GameLinesTable._db.execute(
        f"DELETE FROM {GameLinesTable._sync_changes_table}",
        commit=True,
    )

    queued_count = GameLinesTable.queue_all_lines_for_sync()
    assert queued_count == 2

    pending = GameLinesTable.get_pending_sync_changes(limit=10)
    assert len(pending) == 2

    removed = GameLinesTable.acknowledge_sync_changes(["sync_line_2"])
    assert removed == 1
    remaining = GameLinesTable.get_pending_sync_changes(limit=10)
    assert len(remaining) == 1
    assert remaining[0]["id"] == "sync_line_3"


def test_apply_remote_sync_changes_clears_local_tracking() -> None:
    _reset_tables()

    upsert_stats = GameLinesTable.apply_remote_sync_changes(
        [
            {
                "id": "remote_line_1",
                "operation": "upsert",
                "changed_at": time.time(),
                "data": {
                    "game_name": "Remote Game",
                    "line_text": "remote text",
                    "screenshot_in_anki": True,
                    "audio_in_anki": False,
                    "screenshot_path": None,
                    "audio_path": None,
                    "replay_path": None,
                    "translation": "remote translation",
                    "language": "fr",
                    "timestamp": time.time(),
                    "original_game_name": "Remote Original",
                    "game_id": "remote_game_id",
                    "last_modified": time.time(),
                },
            }
        ]
    )
    assert upsert_stats["upserts"] == 1

    inserted = GameLinesTable.get("remote_line_1")
    assert inserted is not None
    assert inserted.line_text == "remote text"
    assert inserted.language == "fr"

    pending_after_upsert = GameLinesTable.get_pending_sync_changes()
    assert pending_after_upsert == []

    delete_stats = GameLinesTable.apply_remote_sync_changes(
        [
            {
                "id": "remote_line_1",
                "operation": "delete",
                "changed_at": time.time(),
            }
        ]
    )
    assert delete_stats["deletes"] == 1
    assert GameLinesTable.get("remote_line_1") is None
    assert GameLinesTable.get_pending_sync_changes() == []
