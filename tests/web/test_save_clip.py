from datetime import datetime, timedelta
from types import SimpleNamespace

from GameSentenceMiner.util import clips
from GameSentenceMiner.util.text_log import GameLine
from GameSentenceMiner.web import service, texthooking_page


def _line(line_id, seconds):
    return GameLine(
        id=line_id,
        text=f"line {line_id}",
        time=datetime(2026, 9, 27, 12) + timedelta(seconds=seconds),
        prev=None,
        next=None,
    )


def _capture_events(monkeypatch):
    events = []
    monkeypatch.setattr(service, "_send_texthooker_audio_event", lambda name, **payload: events.append((name, payload)))
    return events


def test_replay_is_routed_to_the_oldest_pending_save(monkeypatch, tmp_path):
    first, second = [_line("a", 0)], [_line("b", 5)]
    monkeypatch.setattr(service.gsm_state, "pending_clip_saves", [first, second], raising=False)
    monkeypatch.setattr(service.gsm_state, "videos_to_remove", set(), raising=False)
    monkeypatch.setattr(clips, "get_clips_root", lambda: str(tmp_path))
    monkeypatch.setattr("GameSentenceMiner.obs.get_current_game", lambda *a, **k: "Game")
    calls = []

    def fake_save(video_path, lines, clips_root, game=""):
        calls.append((video_path, lines, clips_root, game))
        return str(tmp_path / "folder")

    monkeypatch.setattr(clips, "save_clip", fake_save)
    events = _capture_events(monkeypatch)

    service.handle_texthooker_button("replay.mkv")

    assert calls == [("replay.mkv", first, str(tmp_path), "Game")]
    assert service.gsm_state.pending_clip_saves == [second]
    assert events == [("clip_saved", {"line_ids": ["a"], "folder": str(tmp_path / "folder")})]


def _config(output_folder):
    return SimpleNamespace(paths=SimpleNamespace(output_folder=output_folder))


def test_save_clip_queues_lines_in_chronological_order(monkeypatch):
    lines = {"a": _line("a", 0), "b": _line("b", 5)}
    queued = []
    monkeypatch.setattr(texthooking_page, "get_config", lambda: _config("/out"))
    monkeypatch.setattr(texthooking_page, "get_event_line_by_id", lines.get)
    monkeypatch.setattr(clips, "seconds_until_clip_ready", lambda selected: 3.0)
    monkeypatch.setattr(texthooking_page, "_queue_clip_save", lambda selected, wait: queued.append((selected, wait)))

    response = texthooking_page.app.test_client().post("/save-clip", json={"ids": ["b", "a"]})

    assert response.status_code == 200
    assert response.get_json() == {"queued": True, "line_ids": ["a", "b"], "wait_seconds": 3.0}
    assert queued == [([lines["a"], lines["b"]], 3.0)]


def test_already_clip_is_not_queued_again(monkeypatch):
    line = _line("a", 0)
    queued = []
    monkeypatch.setattr(texthooking_page, "get_config", lambda: _config("/out"))
    monkeypatch.setattr(texthooking_page, "get_event_line_by_id", {"a": line}.get)
    monkeypatch.setattr(clips, "get_clips_root", lambda: "/out/Clips")
    monkeypatch.setattr(clips, "find_clip_folder", lambda root, lines: "/out/Clips/day/folder")
    monkeypatch.setattr(texthooking_page, "_queue_clip_save", lambda selected, wait: queued.append(selected))

    response = texthooking_page.app.test_client().post("/save-clip", json={"id": "a"})

    assert response.status_code == 200
    assert response.get_json() == {
        "queued": False,
        "already_saved": True,
        "line_ids": ["a"],
        "folder": "/out/Clips/day/folder",
    }
    assert queued == []
