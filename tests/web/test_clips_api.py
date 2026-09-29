import flask
import pytest

from GameSentenceMiner.util import clips
from GameSentenceMiner.web import clips_api
from tests.clip_helpers import write_clip


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(clips, "get_clips_root", lambda: str(tmp_path))
    app = flask.Flask(__name__)
    clips_api.register_clips_api_routes(app)
    return app.test_client()


def test_list_returns_clips_newest_first(client, tmp_path):
    write_clip(tmp_path, "old", [("old", "古い行", "selected", 10)], 20)
    write_clip(tmp_path, "new", [("new", "新しい行", "selected", 20)], 30, day="2026-09-28")

    response = client.get("/api/clips")

    assert response.status_code == 200
    items = response.get_json()["clips"]
    assert [item["id"] for item in items] == ["2026-09-28/new", "2026-09-27/old"]
    assert items[0]["lines"] == [{"id": "new", "text": "新しい行"}]
    assert items[0]["size_bytes"] == (tmp_path / "2026-09-28" / "new" / "clip.mkv").stat().st_size


def test_ids_outside_the_clips_folder_are_rejected(client, tmp_path):
    (tmp_path.parent / "outside").mkdir(exist_ok=True)

    for bad_id in ("../outside", "/etc", "2026-09-27/../../outside", ""):
        assert client.post("/api/clips/trash", json={"ids": [bad_id]}).get_json()["trashed"] == []
        assert client.post("/api/clips/open", json={"id": bad_id}).status_code == 404


def test_batch_trash_moves_every_valid_line_and_reports_the_rest(client, tmp_path, monkeypatch):
    first = write_clip(tmp_path, "a", [("a", "一", "selected", 10)], 20)
    second = write_clip(tmp_path, "b", [("b", "二", "selected", 20)], 30)
    trashed = []
    monkeypatch.setattr(clips_api, "send2trash", trashed.append)

    response = client.post(
        "/api/clips/trash", json={"ids": ["2026-09-27/a", "2026-09-27/b", "../outside", "2026-09-27/missing"]}
    )

    data = response.get_json()
    assert response.status_code == 200
    assert trashed == [str(first), str(second)]
    assert data["trashed"] == ["2026-09-27/a", "2026-09-27/b"]
    assert [failure["id"] for failure in data["failed"]] == ["../outside", "2026-09-27/missing"]


def test_open_folder_opens_the_clip_folder(client, tmp_path, monkeypatch):
    from GameSentenceMiner.web import service

    folder = write_clip(tmp_path, "a", [("a", "一", "selected", 10)], 20)
    opened = []
    monkeypatch.setattr(service, "_open_folder", opened.append)

    assert client.post("/api/clips/open", json={"id": "2026-09-27/a"}).status_code == 200
    assert opened == [str(folder)]
