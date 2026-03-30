from __future__ import annotations

import os
import tempfile

import flask

from GameSentenceMiner.util.database import db as db_mod
from GameSentenceMiner.web.routes.cron_routes import cron_bp

CronTable = db_mod.CronTable
SQLiteDB = db_mod.SQLiteDB


def _make_client():
    app = flask.Flask(__name__)
    app.config["TESTING"] = True
    app.register_blueprint(cron_bp)
    return app.test_client()


def test_list_cron_tasks_sorts_using_serialized_next_run():
    original_db = CronTable._db
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)

    try:
        test_db = SQLiteDB(path)
        CronTable.set_db(test_db)

        CronTable.create_cron_entry(
            name="daily_stats_rollup",
            description="Daily stats rollup",
            next_run=2000.0,
            schedule="daily",
            enabled=True,
        )
        CronTable.create_cron_entry(
            name="populate_games",
            description="One-time populate",
            next_run=1000.0,
            schedule="weekly",
            enabled=False,
        )

        client = _make_client()
        response = client.get("/api/cron/tasks")

        assert response.status_code == 200
        tasks = response.get_json()["tasks"]
        assert [task["name"] for task in tasks] == ["daily_stats_rollup", "populate_games"]
        assert tasks[1]["next_run"] is None
    finally:
        CronTable.set_db(original_db)
        if "test_db" in locals():
            test_db.close()

        os.unlink(path)


def test_list_cron_tasks_includes_user_plugins_task():
    original_db = CronTable._db
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)

    try:
        test_db = SQLiteDB(path)
        CronTable.set_db(test_db)

        CronTable.create_cron_entry(
            name="user_plugins",
            description="User plugins task",
            next_run=1000.0,
            schedule="minutely",
            enabled=True,
        )

        client = _make_client()
        response = client.get("/api/cron/tasks")

        assert response.status_code == 200
        tasks = response.get_json()["tasks"]
        assert [task["name"] for task in tasks] == ["user_plugins"]
        assert tasks[0]["canonical_name"] == "user_plugins"
    finally:
        CronTable.set_db(original_db)
        if "test_db" in locals():
            test_db.close()

        os.unlink(path)


def test_run_user_plugins_task_uses_canonical_row(monkeypatch):
    original_db = CronTable._db
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)

    captured = {}

    try:
        test_db = SQLiteDB(path)
        CronTable.set_db(test_db)

        canonical = CronTable.create_cron_entry(
            name="user_plugins",
            description="User plugins task",
            next_run=1000.0,
            schedule="minutely",
            enabled=True,
        )

        def fake_run_cron_blocking(task_row):
            captured["task_name"] = task_row.name
            captured["task_id"] = task_row.id
            return {"details": [{"success": True, "result": {}}]}

        monkeypatch.setattr(
            "GameSentenceMiner.web.routes.cron_routes.cron_scheduler.run_cron_blocking",
            fake_run_cron_blocking,
        )

        client = _make_client()
        response = client.post("/api/cron/tasks/user_plugins/run")

        assert response.status_code == 200
        assert captured == {"task_name": "user_plugins", "task_id": canonical.id}
        assert response.get_json()["task"]["name"] == "user_plugins"
    finally:
        CronTable.set_db(original_db)
        if "test_db" in locals():
            test_db.close()

        os.unlink(path)
