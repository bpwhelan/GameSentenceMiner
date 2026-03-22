from __future__ import annotations

import io
from types import SimpleNamespace

import flask

from GameSentenceMiner.web.import_api import register_import_api_routes


def _make_app():
    app = flask.Flask(__name__)
    app.config["TESTING"] = True
    register_import_api_routes(app)
    return app


def test_import_exstatic_queues_rollup_instead_of_waiting(monkeypatch):
    app = _make_app()
    client = app.test_client()

    captured_batches = []
    called = {"rollup": 0}

    monkeypatch.setattr(
        "GameSentenceMiner.web.import_api.GameLinesTable.all",
        lambda: [],
    )
    monkeypatch.setattr(
        "GameSentenceMiner.web.import_api.GameLinesTable.add_lines",
        lambda batch: captured_batches.append(list(batch)),
    )
    monkeypatch.setattr(
        "GameSentenceMiner.web.import_api.cron_scheduler.force_daily_rollup",
        lambda: called.__setitem__("rollup", called["rollup"] + 1),
    )

    response = client.post(
        "/api/import-exstatic",
        data={
            "file": (
                io.BytesIO(
                    ("uuid,given_identifier,name,line,time\nrow-1,scene-1,Game One,こんにちは,1710000000\n").encode(
                        "utf-8"
                    )
                ),
                "import.csv",
            )
        },
        content_type="multipart/form-data",
    )

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["rollup_status"] == "queued"
    assert payload["rollup_message"] == "Daily rollup has been queued."
    assert "queued" in payload["message"]
    assert called["rollup"] == 1
    assert len(captured_batches) == 1
    assert len(captured_batches[0]) == 1


def test_import_exstatic_preserves_identical_lines_with_distinct_given_identifiers(
    monkeypatch,
):
    app = _make_app()
    client = app.test_client()

    captured_batches = []

    monkeypatch.setattr(
        "GameSentenceMiner.web.import_api.GameLinesTable.all",
        lambda: [],
    )
    monkeypatch.setattr(
        "GameSentenceMiner.web.import_api.GameLinesTable.add_lines",
        lambda batch: captured_batches.append(list(batch)),
    )
    monkeypatch.setattr(
        "GameSentenceMiner.web.import_api.cron_scheduler.force_daily_rollup",
        lambda: None,
    )

    response = client.post(
        "/api/import-exstatic",
        data={
            "file": (
                io.BytesIO(
                    (
                        "uuid,given_identifier,name,line,time\n"
                        "game-1,row-1,Game One,Repeated line,1710000000\n"
                        "game-1,row-2,Game One,Repeated line,1710000060\n"
                    ).encode("utf-8")
                ),
                "import.csv",
            )
        },
        content_type="multipart/form-data",
    )

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["imported_count"] == 2
    assert len(captured_batches) == 1
    assert [line.id for line in captured_batches[0]] == ["game-1|row-1", "game-1|row-2"]
    assert [line.text for line in captured_batches[0]] == ["Repeated line", "Repeated line"]


def test_import_exstatic_treats_legacy_line_ids_as_existing_once(monkeypatch):
    app = _make_app()
    client = app.test_client()

    captured_batches = []

    monkeypatch.setattr(
        "GameSentenceMiner.web.import_api.GameLinesTable.all",
        lambda: [SimpleNamespace(id="game-1|Repeated line")],
    )
    monkeypatch.setattr(
        "GameSentenceMiner.web.import_api.GameLinesTable.add_lines",
        lambda batch: captured_batches.append(list(batch)),
    )
    monkeypatch.setattr(
        "GameSentenceMiner.web.import_api.cron_scheduler.force_daily_rollup",
        lambda: None,
    )

    response = client.post(
        "/api/import-exstatic",
        data={
            "file": (
                io.BytesIO(
                    (
                        "uuid,given_identifier,name,line,time\n"
                        "game-1,row-1,Game One,Repeated line,1710000000\n"
                        "game-1,row-2,Game One,Repeated line,1710000060\n"
                    ).encode("utf-8")
                ),
                "import.csv",
            )
        },
        content_type="multipart/form-data",
    )

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["imported_count"] == 1
    assert len(captured_batches) == 1
    assert [line.id for line in captured_batches[0]] == ["game-1|row-2"]
    assert [line.text for line in captured_batches[0]] == ["Repeated line"]
