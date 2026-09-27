import json
from datetime import datetime, timedelta
from types import SimpleNamespace

import flask
import pytest

from GameSentenceMiner import anki, saved_line_cards
from GameSentenceMiner.util import saved_lines
from GameSentenceMiner.web import saved_lines_api, texthooking_page

BASE = datetime(2026, 9, 27, 12, 0, 0)


def _write_saved(root, day, name, text, seconds, cards=None):
    folder = root / day / name
    folder.mkdir(parents=True)
    manifest = {
        "version": 1,
        "game": "FFVII",
        "saved_at": (BASE + timedelta(seconds=seconds)).isoformat(),
        "sentence": text,
        "selected_line_ids": [name],
        "lines": [
            {"id": name, "text": text, "time": (BASE + timedelta(seconds=seconds)).isoformat(), "role": "selected"}
        ],
        "clip": {"file": "clip.mkv", "end_time": (BASE + timedelta(seconds=seconds + 10)).isoformat()},
    }
    if cards:
        manifest["cards"] = cards
    (folder / saved_lines.MANIFEST_NAME).write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
    (folder / "clip.mkv").write_bytes(b"clip")
    return folder


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(saved_lines_api, "_saved_root", lambda: str(tmp_path))
    app = flask.Flask(__name__)
    saved_lines_api.register_saved_lines_api_routes(app)
    return app.test_client()


def test_list_returns_saved_lines_newest_first(client, tmp_path):
    _write_saved(tmp_path, "2026-09-27", "old", "古い行", 10, cards=[{"note_id": 1, "word": "古い"}])
    _write_saved(tmp_path, "2026-09-28", "new", "新しい行", 20)

    response = client.get("/api/saved-lines")

    assert response.status_code == 200
    items = response.get_json()["saved_lines"]
    assert [item["id"] for item in items] == ["2026-09-28/new", "2026-09-27/old"]
    assert items[1]["cards"] == [{"note_id": 1, "word": "古い"}]
    assert items[0]["sentence"] == "新しい行" and items[0]["game"] == "FFVII"


def test_ids_outside_the_saved_folder_are_rejected(client, tmp_path):
    (tmp_path.parent / "outside").mkdir(exist_ok=True)

    for bad_id in ("../outside", "/etc", "2026-09-27/../../outside", ""):
        assert client.delete("/api/saved-lines", query_string={"id": bad_id}).status_code == 404
        assert client.get("/api/saved-lines/audio", query_string={"id": bad_id}).status_code == 404


def test_delete_sends_the_folder_to_the_trash(client, tmp_path, monkeypatch):
    folder = _write_saved(tmp_path, "2026-09-27", "a", "行", 10)
    trashed = []
    monkeypatch.setattr(saved_lines_api, "send2trash", trashed.append)

    response = client.delete("/api/saved-lines", query_string={"id": "2026-09-27/a"})

    assert response.status_code == 200
    assert trashed == [str(folder)]


def test_audio_is_served_as_mp3(client, tmp_path, monkeypatch):
    _write_saved(tmp_path, "2026-09-27", "a", "行", 10)

    def fake_extract(saved, output_path):
        with open(output_path, "wb") as f:
            f.write(b"ID3fake")
        return output_path

    monkeypatch.setattr(saved_lines, "extract_line_audio", fake_extract)

    response = client.get("/api/saved-lines/audio", query_string={"id": "2026-09-27/a"})

    assert response.status_code == 200
    assert response.mimetype == "audio/mpeg"
    assert response.data == b"ID3fake"


class _Card:
    noteId = 42


@pytest.fixture
def enrich(tmp_path, monkeypatch):
    _write_saved(tmp_path, "2026-09-27", "a", "心当たりはねえのか", 10)
    calls = []
    monkeypatch.setattr(anki, "get_last_anki_card", lambda: _Card())
    monkeypatch.setattr(
        saved_line_cards,
        "enrich_from_saved_line",
        lambda card, saved, line=None, rewrite=False: calls.append((card.noteId, saved.folder, rewrite)),
    )
    return calls


def _check(monkeypatch, *codes):
    monkeypatch.setattr(
        saved_line_cards,
        "check_enrich",
        lambda card, saved: {"note_id": 42, "warnings": [{"code": c, "message": c} for c in codes]},
    )


def test_enrich_runs_straight_away_for_a_matching_fresh_card(client, enrich, monkeypatch, tmp_path):
    _check(monkeypatch)

    response = client.post("/api/saved-lines/enrich", json={"id": "2026-09-27/a"})

    assert response.status_code == 202
    assert enrich == [(42, str(tmp_path / "2026-09-27" / "a"), False)]


def test_enrich_asks_for_confirmation_then_rewrites_the_card(client, enrich, monkeypatch):
    _check(monkeypatch, "sentence_mismatch", "has_media")

    first = client.post("/api/saved-lines/enrich", json={"id": "2026-09-27/a"})
    assert first.status_code == 409
    assert {w["code"] for w in first.get_json()["warnings"]} == {"sentence_mismatch", "has_media"}
    assert enrich == []

    second = client.post("/api/saved-lines/enrich", json={"id": "2026-09-27/a", "confirm": True})
    assert second.status_code == 202
    assert enrich[0][2] is True


def test_enrich_waits_for_pending_live_work_even_when_confirmed(client, enrich, monkeypatch):
    _check(monkeypatch, "live_pending")

    response = client.post("/api/saved-lines/enrich", json={"id": "2026-09-27/a", "confirm": True})

    assert response.status_code == 409 and enrich == []


def test_enrich_without_a_recent_card_or_without_anki(client, enrich, monkeypatch):
    monkeypatch.setattr(anki, "get_last_anki_card", lambda: {})
    assert client.post("/api/saved-lines/enrich", json={"id": "2026-09-27/a"}).status_code == 404

    def unreachable():
        raise ConnectionError("Anki is closed")

    monkeypatch.setattr(anki, "get_last_anki_card", unreachable)
    response = client.post("/api/saved-lines/enrich", json={"id": "2026-09-27/a"})
    assert response.status_code == 502 and "Anki" in response.get_json()["error"]


def test_saved_page_renders():
    response = texthooking_page.app.test_client().get("/saved")

    assert response.status_code == 200
    assert b"Saved lines" in response.data
