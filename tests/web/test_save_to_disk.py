from datetime import datetime, timedelta
from types import SimpleNamespace

from GameSentenceMiner.util import saved_lines
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
    monkeypatch.setattr(service.gsm_state, "pending_line_saves", [first, second], raising=False)
    monkeypatch.setattr(service.gsm_state, "videos_to_remove", set(), raising=False)
    monkeypatch.setattr(saved_lines, "get_saved_lines_root", lambda: str(tmp_path))
    monkeypatch.setattr("GameSentenceMiner.obs.get_current_game", lambda *a, **k: "Game")
    calls = []

    def fake_save(video_path, lines, saved_root, game=""):
        calls.append((video_path, lines, saved_root, game))
        return str(tmp_path / "folder")

    monkeypatch.setattr(saved_lines, "save_lines_to_disk", fake_save)
    events = _capture_events(monkeypatch)

    service.handle_texthooker_button("replay.mkv")

    assert calls == [("replay.mkv", first, str(tmp_path), "Game")]
    assert service.gsm_state.pending_line_saves == [second]
    assert events == [("line_saved", {"line_ids": ["a"], "folder": str(tmp_path / "folder")})]


def test_line_outside_replay_reports_a_failure(monkeypatch, tmp_path):
    monkeypatch.setattr(service.gsm_state, "pending_line_saves", [[_line("a", 0)]], raising=False)
    monkeypatch.setattr(service.gsm_state, "videos_to_remove", set(), raising=False)
    monkeypatch.setattr(saved_lines, "get_saved_lines_root", lambda: str(tmp_path))
    monkeypatch.setattr("GameSentenceMiner.obs.get_current_game", lambda *a, **k: "")

    def too_old(*args, **kwargs):
        raise saved_lines.LineOutsideReplayError("too old")

    monkeypatch.setattr(saved_lines, "save_lines_to_disk", too_old)
    events = _capture_events(monkeypatch)

    service.handle_texthooker_button("replay.mkv")

    assert events == [("line_save_failed", {"line_ids": ["a"], "error": "too old"})]


def _config(output_folder):
    return SimpleNamespace(paths=SimpleNamespace(output_folder=output_folder))


def test_save_lines_requires_an_id():
    response = texthooking_page.app.test_client().post("/save-lines", json={})

    assert response.status_code == 400


def test_save_lines_requires_an_output_folder(monkeypatch):
    monkeypatch.setattr(texthooking_page, "get_config", lambda: _config(""))

    response = texthooking_page.app.test_client().post("/save-lines", json={"id": "a"})

    assert response.status_code == 400
    assert "Output Folder" in response.get_json()["error"]


def test_save_lines_queues_lines_in_chronological_order(monkeypatch):
    lines = {"a": _line("a", 0), "b": _line("b", 5)}
    queued = []
    monkeypatch.setattr(texthooking_page, "get_config", lambda: _config("/out"))
    monkeypatch.setattr(texthooking_page, "get_event_line_by_id", lines.get)
    monkeypatch.setattr(saved_lines, "seconds_until_clip_ready", lambda selected: 3.0)
    monkeypatch.setattr(texthooking_page, "_queue_line_save", lambda selected, wait: queued.append((selected, wait)))

    response = texthooking_page.app.test_client().post("/save-lines", json={"ids": ["b", "a"]})

    assert response.status_code == 200
    assert response.get_json() == {"queued": True, "line_ids": ["a", "b"], "wait_seconds": 3.0}
    assert queued == [([lines["a"], lines["b"]], 3.0)]


def test_queued_save_triggers_an_obs_replay(monkeypatch):
    lines = [_line("a", 0)]
    saved = []
    monkeypatch.setattr(texthooking_page.gsm_state, "pending_line_saves", [], raising=False)
    monkeypatch.setattr(texthooking_page.obs, "save_replay_buffer", lambda: saved.append(True))
    started = []

    class ImmediateThread:
        def __init__(self, target, **kwargs):
            self.target = target

        def start(self):
            started.append(True)
            self.target()

    monkeypatch.setattr(texthooking_page.threading, "Thread", ImmediateThread)

    texthooking_page._queue_line_save(lines, 0)

    assert started and saved == [True]
    assert texthooking_page.gsm_state.pending_line_saves == [lines]
