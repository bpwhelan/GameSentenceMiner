from types import SimpleNamespace

import flask
import pytest

from GameSentenceMiner import anki, clip_cards
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
    write_clip(tmp_path, "old", [("old", "古い行", "selected", 10)], 20, cards=[{"note_id": 1, "word": "古い"}])
    write_clip(tmp_path, "new", [("new", "新しい行", "selected", 20)], 30, day="2026-09-28")

    response = client.get("/api/clips")

    assert response.status_code == 200
    items = response.get_json()["clips"]
    assert [item["id"] for item in items] == ["2026-09-28/new", "2026-09-27/old"]
    assert items[1]["cards"] == [{"note_id": 1, "word": "古い"}]
    assert items[0]["sentence"] == "新しい行" and items[0]["game"] == "FFVII"


def test_ids_outside_the_clips_folder_are_rejected(client, tmp_path):
    (tmp_path.parent / "outside").mkdir(exist_ok=True)

    for bad_id in ("../outside", "/etc", "2026-09-27/../../outside", ""):
        assert client.post("/api/clips/trash", json={"ids": [bad_id]}).get_json()["trashed"] == []
        assert client.get("/api/clips/audio", query_string={"id": bad_id}).status_code == 404


def test_audio_is_the_card_pipeline_preview_served_as_wav(client, tmp_path, monkeypatch):
    folder = write_clip(tmp_path, "a", [("a", "行", "selected", 10)], 20)
    previews = [tmp_path / "first.wav", tmp_path / "second.wav"]
    for index, preview in enumerate(previews):
        preview.write_bytes(b"RIFF%d" % index)
    loaded = []

    def fake_line_audio(clip):
        loaded.append(clip.folder)
        return str(previews[len(loaded) - 1])

    monkeypatch.setattr(clip_cards, "clip_line_audio", fake_line_audio)
    monkeypatch.setattr(clips_api, "_preview_audio", {})

    first = client.get("/api/clips/audio", query_string={"id": "2026-09-27/a"})
    first.close()
    second = client.get("/api/clips/audio", query_string={"id": "2026-09-27/a"}).get_data()
    previews[0].unlink()  # temp was wiped
    third = client.get("/api/clips/audio", query_string={"id": "2026-09-27/a"}).get_data()

    assert (first.status_code, first.mimetype) == (200, "audio/wav")
    # Clips never change, so a preview is extracted once and replayed from temp.
    assert (second, third) == (b"RIFF0", b"RIFF1")
    assert loaded == [str(folder)] * 2


class _Card:
    noteId = 42


@pytest.fixture
def enrich(tmp_path, monkeypatch):
    write_clip(tmp_path, "a", [("a", "心当たりはねえのか", "selected", 10)], 20)
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


def _anki(monkeypatch, fields, note_id=42, media=None):
    import base64

    media = media or {}
    card = SimpleNamespace(noteId=note_id, has_field=fields.__contains__, get_field=fields.__getitem__)
    monkeypatch.setattr(anki, "get_last_anki_card", lambda: card)
    monkeypatch.setattr(
        clips_api,
        "get_config",
        lambda: SimpleNamespace(
            anki=SimpleNamespace(sentence_audio_field="SentenceAudio", picture_field="Picture"),
            paths=SimpleNamespace(output_folder="/out"),
        ),
    )

    def fake_invoke(action, **params):
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
    # Only the latest card, the one Enrich would change, is served.
    assert client.get("/api/clips/card-media", query_string={"note_id": 7, "kind": "audio"}).status_code == 404


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
