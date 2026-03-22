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
