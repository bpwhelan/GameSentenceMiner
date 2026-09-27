import json
from datetime import datetime, timedelta
from types import SimpleNamespace

import flask
import pytest

from GameSentenceMiner import anki, clip_cards
from GameSentenceMiner.util import clips
from GameSentenceMiner.web import clips_api, texthooking_page

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
    (folder / clips.MANIFEST_NAME).write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
    (folder / "clip.mkv").write_bytes(b"clip")
    return folder


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(clips_api, "_clips_root", lambda: str(tmp_path))
    app = flask.Flask(__name__)
    clips_api.register_clips_api_routes(app)
    return app.test_client()


def test_list_returns_clips_newest_first(client, tmp_path):
    _write_saved(tmp_path, "2026-09-27", "old", "古い行", 10, cards=[{"note_id": 1, "word": "古い"}])
    _write_saved(tmp_path, "2026-09-28", "new", "新しい行", 20)

    response = client.get("/api/clips")

    assert response.status_code == 200
    items = response.get_json()["clips"]
    assert [item["id"] for item in items] == ["2026-09-28/new", "2026-09-27/old"]
    assert items[1]["cards"] == [{"note_id": 1, "word": "古い"}]
    assert items[0]["sentence"] == "新しい行" and items[0]["game"] == "FFVII"


def test_ids_outside_the_clips_folder_are_rejected(client, tmp_path):
    (tmp_path.parent / "outside").mkdir(exist_ok=True)

    for bad_id in ("../outside", "/etc", "2026-09-27/../../outside", ""):
        assert client.delete("/api/clips", query_string={"id": bad_id}).status_code == 404
        assert client.get("/api/clips/audio", query_string={"id": bad_id}).status_code == 404


def test_delete_sends_the_folder_to_the_trash(client, tmp_path, monkeypatch):
    folder = _write_saved(tmp_path, "2026-09-27", "a", "行", 10)
    trashed = []
    monkeypatch.setattr(clips_api, "send2trash", trashed.append)

    response = client.delete("/api/clips", query_string={"id": "2026-09-27/a"})

    assert response.status_code == 200
    assert trashed == [str(folder)]


def test_audio_is_served_as_mp3(client, tmp_path, monkeypatch):
    _write_saved(tmp_path, "2026-09-27", "a", "行", 10)

    def fake_extract(clip, output_path):
        with open(output_path, "wb") as f:
            f.write(b"ID3fake")
        return output_path

    monkeypatch.setattr(clips, "extract_clip_audio", fake_extract)

    response = client.get("/api/clips/audio", query_string={"id": "2026-09-27/a"})

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
        clip_cards,
        "enrich_from_clip",
        lambda card, clip, line=None, rewrite=False: calls.append((card.noteId, clip.folder, rewrite)),
    )
    return calls


def _check(monkeypatch, *codes):
    monkeypatch.setattr(
        clip_cards,
        "check_enrich",
        lambda card, clip: {"note_id": 42, "warnings": [{"code": c, "message": c} for c in codes]},
    )


def test_enrich_runs_straight_away_for_a_matching_fresh_card(client, enrich, monkeypatch, tmp_path):
    _check(monkeypatch)

    response = client.post("/api/clips/enrich", json={"id": "2026-09-27/a"})

    assert response.status_code == 202
    assert enrich == [(42, str(tmp_path / "2026-09-27" / "a"), False)]


def test_enrich_asks_for_confirmation_then_rewrites_the_card(client, enrich, monkeypatch):
    _check(monkeypatch, "sentence_mismatch", "has_media")

    first = client.post("/api/clips/enrich", json={"id": "2026-09-27/a"})
    assert first.status_code == 409
    assert {w["code"] for w in first.get_json()["warnings"]} == {"sentence_mismatch", "has_media"}
    assert enrich == []

    second = client.post("/api/clips/enrich", json={"id": "2026-09-27/a", "confirm": True})
    assert second.status_code == 202
    assert enrich[0][2] is True


def test_enrich_waits_for_pending_live_work_even_when_confirmed(client, enrich, monkeypatch):
    _check(monkeypatch, "live_pending")

    response = client.post("/api/clips/enrich", json={"id": "2026-09-27/a", "confirm": True})

    assert response.status_code == 409 and enrich == []


def test_enrich_without_a_recent_card_or_without_anki(client, enrich, monkeypatch):
    monkeypatch.setattr(anki, "get_last_anki_card", lambda: {})
    assert client.post("/api/clips/enrich", json={"id": "2026-09-27/a"}).status_code == 404

    def unreachable():
        raise ConnectionError("Anki is closed")

    monkeypatch.setattr(anki, "get_last_anki_card", unreachable)
    response = client.post("/api/clips/enrich", json={"id": "2026-09-27/a"})
    assert response.status_code == 502 and "Anki" in response.get_json()["error"]


def test_clips_page_renders():
    response = texthooking_page.app.test_client().get("/clips")

    assert response.status_code == 200
    assert b"Clips to mine" in response.data


def _anki(monkeypatch, fields, note_id=42, media=None):
    import base64

    media = media or {}
    monkeypatch.setattr(anki, "get_last_anki_card", lambda: SimpleNamespace(noteId=note_id))
    monkeypatch.setattr(
        clips_api,
        "get_config",
        lambda: SimpleNamespace(
            anki=SimpleNamespace(sentence_audio_field="SentenceAudio", picture_field="Picture"),
            paths=SimpleNamespace(output_folder="/out"),
        ),
    )

    def fake_invoke(action, **params):
        if action == "notesInfo":
            assert params["notes"] == [note_id]
            return [{"noteId": note_id, "fields": {k: {"value": v} for k, v in fields.items()}}]
        if action == "retrieveMediaFile":
            data = media.get(params["filename"])
            return base64.b64encode(data).decode() if data is not None else False
        raise AssertionError(action)

    monkeypatch.setattr(anki, "invoke", fake_invoke)


def test_card_media_serves_the_latest_cards_audio_and_picture(client, monkeypatch):
    _anki(
        monkeypatch,
        {"SentenceAudio": "[sound:line.mp3]", "Picture": '<img src="shot.webp">'},
        media={"line.mp3": b"ID3audio", "shot.webp": b"RIFFwebp"},
    )

    audio = client.get("/api/clips/card-media", query_string={"note_id": 42, "kind": "audio"})
    picture = client.get("/api/clips/card-media", query_string={"note_id": 42, "kind": "picture"})

    assert (audio.status_code, audio.mimetype, audio.data) == (200, "audio/mpeg", b"ID3audio")
    assert (picture.status_code, picture.mimetype, picture.data) == (200, "image/webp", b"RIFFwebp")


def test_card_media_only_serves_the_latest_card_and_existing_media(client, monkeypatch):
    _anki(monkeypatch, {"SentenceAudio": "", "Picture": '<img src="gone.png">'})

    assert client.get("/api/clips/card-media", query_string={"note_id": 7, "kind": "audio"}).status_code == 404
    assert client.get("/api/clips/card-media", query_string={"note_id": 42, "kind": "audio"}).status_code == 404
    assert client.get("/api/clips/card-media", query_string={"note_id": 42, "kind": "picture"}).status_code == 404
    assert client.get("/api/clips/card-media", query_string={"note_id": 42, "kind": "video"}).status_code == 404


def test_list_reports_disk_space_per_line_and_in_total(client, tmp_path, monkeypatch):
    small = _write_saved(tmp_path, "2026-09-27", "small", "短い", 10)
    big = _write_saved(tmp_path, "2026-09-27", "big", "長い", 20)
    (small / "clip.mkv").write_bytes(b"x" * 1000)
    (big / "clip.mkv").write_bytes(b"x" * 5000)
    monkeypatch.setattr(
        clips_api.shutil,
        "disk_usage",
        lambda path: SimpleNamespace(total=999999999, used=876543210, free=123456789),
    )

    data = client.get("/api/clips").get_json()

    sizes = {item["id"]: item["size_bytes"] for item in data["clips"]}
    manifest_bytes = (small / clips.MANIFEST_NAME).stat().st_size
    assert sizes["2026-09-27/small"] == 1000 + manifest_bytes
    assert sizes["2026-09-27/big"] == 5000 + (big / clips.MANIFEST_NAME).stat().st_size
    assert data["total_bytes"] == sum(sizes.values())
    assert data["disk_free_bytes"] == 123456789
    assert data["disk_total_bytes"] == 999999999
    assert data["disk_used_bytes"] == 876543210


def test_batch_trash_moves_every_valid_line_and_reports_the_rest(client, tmp_path, monkeypatch):
    first = _write_saved(tmp_path, "2026-09-27", "a", "一", 10)
    second = _write_saved(tmp_path, "2026-09-27", "b", "二", 20)
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


def test_batch_trash_requires_ids(client):
    assert client.post("/api/clips/trash", json={}).status_code == 400
