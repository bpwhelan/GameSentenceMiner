from __future__ import annotations

import os
import sqlite3
import tempfile

from GameSentenceMiner.util.database import db as db_mod
from GameSentenceMiner.util.database.anki_tables import (
    AnkiCardsTable,
    AnkiNotesTable,
    AnkiReviewsTable,
    setup_anki_tables,
)
from GameSentenceMiner.util.database.cron_table import CronTable
from GameSentenceMiner.util.database.db import SQLiteDB, sync_tokenization_schema_state


def test_read_only_connection_can_query_without_setting_wal():
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)

    try:
        conn = sqlite3.connect(path)
        conn.execute("CREATE TABLE sample (value INTEGER)")
        conn.execute("INSERT INTO sample (value) VALUES (1)")
        conn.commit()
        conn.close()

        read_only_db = SQLiteDB(path, read_only=True)
        try:
            assert read_only_db.fetchone("SELECT value FROM sample") == (1,)
        finally:
            read_only_db.close()
    finally:
        os.unlink(path)


def test_sync_tokenization_schema_state_skips_read_only_db(monkeypatch):
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)

    try:
        conn = sqlite3.connect(path)
        conn.execute("CREATE TABLE game_lines (id TEXT PRIMARY KEY)")
        conn.commit()
        conn.close()

        read_only_db = SQLiteDB(path, read_only=True)
        monkeypatch.setattr("GameSentenceMiner.util.database.db._is_tokenization_enabled", lambda: False)

        try:
            sync_tokenization_schema_state(read_only_db)
            assert read_only_db.table_exists("game_lines") is True
            columns = read_only_db.fetchall("PRAGMA table_info(game_lines)")
            assert [column[1] for column in columns] == ["id"]
        finally:
            read_only_db.close()
    finally:
        os.unlink(path)


def test_user_plugins_migration_preserves_canonical_row():
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)

    original_db = CronTable._db
    test_db = SQLiteDB(path)

    try:
        CronTable.set_db(test_db)
        canonical_cron = CronTable.create_cron_entry(
            name="user_plugins",
            description="User plugins cron",
            next_run=1234567890.0,
            schedule="minutely",
            enabled=True,
        )
        canonical_cron.last_run = 1234567000.0
        canonical_cron.save()

        db_mod.migrate_user_plugins_cron_job()

        user_plugins_cron = CronTable.get_by_name("user_plugins")
        legacy_cron = CronTable.get_by_name("plugins")

        assert user_plugins_cron is not None
        assert user_plugins_cron.enabled is True
        assert user_plugins_cron.last_run == 1234567000.0
        assert legacy_cron is None
        assert [cron.name for cron in CronTable.get_all_enabled()] == ["user_plugins"]
        assert user_plugins_cron.next_run == canonical_cron.next_run
        assert user_plugins_cron.description == "User plugins cron"
    finally:
        CronTable.set_db(original_db)
        test_db.close()
        os.unlink(path)


def test_user_plugins_migration_renames_branch_local_plugins_row():
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)

    original_db = CronTable._db
    test_db = SQLiteDB(path)

    try:
        CronTable.set_db(test_db)
        legacy_cron = CronTable.create_cron_entry(
            name="plugins",
            description="Migrated plugins cron",
            next_run=1234567890.0,
            schedule="minutely",
            enabled=True,
        )
        legacy_cron.last_run = 1234567000.0
        legacy_cron.save()

        db_mod.migrate_user_plugins_cron_job()

        user_plugins_cron = CronTable.get_by_name("user_plugins")
        migrated_cron = CronTable.get_by_name("plugins")

        assert user_plugins_cron is not None
        assert migrated_cron is None
        assert user_plugins_cron.enabled is True
        assert user_plugins_cron.last_run == 1234567000.0
        assert [cron.name for cron in CronTable.get_all_enabled()] == ["user_plugins"]
        assert user_plugins_cron.description == "Migrated plugins cron"
    finally:
        CronTable.set_db(original_db)
        test_db.close()
        os.unlink(path)


def test_user_plugins_migration_removes_branch_local_plugins_duplicate():
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)

    original_db = CronTable._db
    test_db = SQLiteDB(path)

    try:
        CronTable.set_db(test_db)
        CronTable.create_cron_entry(
            name="user_plugins",
            description="Canonical plugins cron",
            next_run=1234567890.0,
            schedule="minutely",
            enabled=True,
        )
        CronTable.create_cron_entry(
            name="plugins",
            description="Branch-local plugins cron",
            next_run=1234567800.0,
            schedule="minutely",
            enabled=True,
        )

        db_mod.migrate_user_plugins_cron_job()

        user_plugins_cron = CronTable.get_by_name("user_plugins")
        legacy_cron = CronTable.get_by_name("plugins")

        assert user_plugins_cron is not None
        assert legacy_cron is None
        assert user_plugins_cron.description == "Canonical plugins cron"
        assert [cron.name for cron in CronTable.get_all_enabled()] == ["user_plugins"]
    finally:
        CronTable.set_db(original_db)
        test_db.close()
        os.unlink(path)


def test_sync_tokenization_schema_state_preserves_anki_cache_and_sync_cron_when_disabled(monkeypatch):
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)

    original_db = CronTable._db
    test_db = SQLiteDB(path)

    try:
        test_db.execute("CREATE TABLE game_lines (id TEXT PRIMARY KEY)", commit=True)
        CronTable.set_db(test_db)
        setup_anki_tables(test_db)

        AnkiNotesTable(
            note_id=1,
            model_name="Basic",
            fields_json="{}",
            tags='["Game::Test"]',
            mod=0,
            synced_at=1.0,
        ).save()
        AnkiCardsTable(
            card_id=10,
            note_id=1,
            deck_name="Default",
            queue=0,
            type=0,
            due=0,
            interval=0,
            factor=0,
            reps=0,
            lapses=0,
            synced_at=1.0,
        ).save()
        AnkiReviewsTable(
            review_id="10_1",
            card_id=10,
            note_id=1,
            review_time=1,
            ease=2,
            interval=1,
            last_interval=0,
            time_taken=1000,
            synced_at=1.0,
        ).save()

        monkeypatch.setattr("GameSentenceMiner.util.database.db._is_tokenization_enabled", lambda: False)
        sync_tokenization_schema_state(test_db)

        assert test_db.table_exists("anki_notes") is True
        assert test_db.table_exists("anki_cards") is True
        assert test_db.table_exists("anki_reviews") is True
        assert test_db.table_exists("word_anki_links") is False
        assert test_db.table_exists("card_kanji_links") is False
        assert AnkiNotesTable.get(1) is not None
        assert AnkiCardsTable.get(10) is not None
        assert AnkiReviewsTable.get("10_1") is not None

        cron = CronTable.get_by_name("anki_card_sync")
        assert cron is not None
        assert cron.enabled is True
    finally:
        CronTable.set_db(original_db)
        test_db.close()
        os.unlink(path)
