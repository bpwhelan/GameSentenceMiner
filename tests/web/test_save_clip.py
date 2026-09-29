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
    first, second = _line("a", 0), _line("b", 5)
    monkeypatch.setattr(service.gsm_state, "pending_clip_saves", [first, second], raising=False)
    monkeypatch.setattr(service.gsm_state, "videos_to_remove", set(), raising=False)
    monkeypatch.setattr(clips, "get_clips_root", lambda: str(tmp_path))
    calls = []

    def fake_save(video_path, line, clips_root):
        calls.append((video_path, line, clips_root))
        return str(tmp_path / "folder")

    monkeypatch.setattr(clips, "save_clip", fake_save)
    events = _capture_events(monkeypatch)

    service.handle_texthooker_button("replay.mkv")

    assert calls == [("replay.mkv", first, str(tmp_path))]
    assert service.gsm_state.pending_clip_saves == [second]
    assert events == [("clip_saved", {"line_ids": ["a"], "folder": str(tmp_path / "folder")})]


def _config(output_folder):
    return SimpleNamespace(paths=SimpleNamespace(output_folder=output_folder))


def test_save_clip_queues_the_line(monkeypatch):
    line = _line("a", 0)
    queued = []
    monkeypatch.setattr(texthooking_page, "get_config", lambda: _config("/out"))
    monkeypatch.setattr(texthooking_page, "get_event_line_by_id", {"a": line}.get)
    monkeypatch.setattr(clips, "find_clip_folder", lambda root, line: None)
    monkeypatch.setattr(clips, "seconds_until_clip_ready", lambda line: 3.0)
    monkeypatch.setattr(texthooking_page, "_queue_clip_save", lambda selected, wait: queued.append((selected, wait)))

    response = texthooking_page.app.test_client().post("/save-clip", json={"id": "a"})

    assert response.status_code == 200
    assert response.get_json() == {"queued": True, "line_ids": ["a"], "wait_seconds": 3.0}
    assert queued == [(line, 3.0)]


def test_a_saved_line_is_not_queued_again(monkeypatch):
    line = _line("a", 0)
    queued = []
    monkeypatch.setattr(texthooking_page, "get_config", lambda: _config("/out"))
    monkeypatch.setattr(texthooking_page, "get_event_line_by_id", {"a": line}.get)
    monkeypatch.setattr(clips, "get_clips_root", lambda: "/out/Clips")
    monkeypatch.setattr(clips, "find_clip_folder", lambda root, line: "/out/Clips/day/folder")
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


def test_text_feed_actions_run_on_the_saved_clip_once_the_line_left_the_buffer(monkeypatch):
    from GameSentenceMiner import clip_cards

    handled, saved = [], []
    monkeypatch.setattr(service, "handle_texthooker_button", handled.append)
    monkeypatch.setattr(texthooking_page.obs, "save_replay_buffer", lambda: saved.append(True))
    monkeypatch.setattr(clip_cards, "replay_for_lines", lambda lines: "clip-copy.mkv" if lines[0].id == "a" else None)

    texthooking_page._save_replay_for([_line("a", 0)])
    texthooking_page._save_replay_for([_line("b", 0)])

    assert (handled, saved) == (["clip-copy.mkv"], [True])


def test_saved_clip_lines_are_found_after_a_restart(monkeypatch):
    saved = _line("a", 0)
    monkeypatch.setattr(texthooking_page, "get_line_by_id", lambda line_id: None)
    monkeypatch.setattr(clips, "find_saved_line", {"a": saved}.get)

    assert texthooking_page.get_event_line_by_id("a") is saved
    assert texthooking_page.get_event_line_by_id("unknown") is None
