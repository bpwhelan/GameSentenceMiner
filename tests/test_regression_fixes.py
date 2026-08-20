import asyncio
import datetime
import importlib.util
import os
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

from GameSentenceMiner.web import service

REPO_ROOT = Path(__file__).resolve().parents[1]
WEBSOCKET_SERVER_PATH = REPO_ROOT / "GSM_Overlay" / "websocket_server.py"
WEBSOCKET_SERVER_SPEC = importlib.util.spec_from_file_location(
    "gsm_overlay_websocket_server",
    WEBSOCKET_SERVER_PATH,
)
assert WEBSOCKET_SERVER_SPEC and WEBSOCKET_SERVER_SPEC.loader is not None
websocket_server = importlib.util.module_from_spec(WEBSOCKET_SERVER_SPEC)
WEBSOCKET_SERVER_SPEC.loader.exec_module(websocket_server)
WebsocketServerThread = websocket_server.WebsocketServerThread


def test_overlay_websocket_healthcheck_does_not_intercept_root_handshake():
    server = WebsocketServerThread(read=True, ws_port=9001)

    root_response = asyncio.run(server.process_request(None, SimpleNamespace(path="/")))
    health_response = asyncio.run(server.process_request(None, SimpleNamespace(path="/health")))

    assert root_response is None
    assert health_response is not None
    assert health_response.status_code == 200


def test_read_only_db_import_skips_write_migrations(tmp_path):
    env = os.environ.copy()
    env["APPDATA"] = str(tmp_path)
    env["GSM_DB_READ_ONLY"] = "1"

    result = subprocess.run(
        [
            sys.executable,
            "-c",
            "import GameSentenceMiner.util.database.db; print('db import ok')",
        ],
        capture_output=True,
        text=True,
        cwd=REPO_ROOT,
        env=env,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert "db import ok" in result.stdout


def test_same_line_audio_reextracts_when_vad_variant_changes(monkeypatch, tmp_path):
    line = SimpleNamespace(id="line-1", text="hello", next=None)
    new_audio_path = tmp_path / "trimmed.wav"
    new_audio_path.write_bytes(b"audio")

    extracted = []
    played = []

    def fake_get_audio_from_video(*_args, **_kwargs):
        extracted.append(True)
        return str(new_audio_path)

    def fake_play_audio_from_file(path, line_id):
        played.append((path, line_id))
        return True

    def fail_if_previous_variant_is_reused(*_args, **_kwargs):
        raise AssertionError("previous audio variant should not be reused")

    monkeypatch.setattr(
        service,
        "get_config",
        lambda: SimpleNamespace(advanced=SimpleNamespace(video_player_path="")),
    )
    monkeypatch.setattr(service, "get_audio_from_video", fake_get_audio_from_video, raising=False)
    monkeypatch.setattr(service, "_play_audio_from_file", fake_play_audio_from_file)
    monkeypatch.setattr(service, "play_audio_data_safe", fail_if_previous_variant_is_reused)
    monkeypatch.setattr(service, "_send_texthooker_audio_event", lambda *_args, **_kwargs: None)

    monkeypatch.setattr(service.gsm_state, "line_for_audio", line, raising=False)
    monkeypatch.setattr(service.gsm_state, "previous_line_for_audio", line, raising=False)
    monkeypatch.setattr(service.gsm_state, "previous_audio", ("old-data", 1), raising=False)
    monkeypatch.setattr(
        service.gsm_state,
        "previous_audio_cache_key",
        service._audio_cache_key(line.id, False),
        raising=False,
    )
    monkeypatch.setattr(
        service.gsm_state,
        "previous_audio_path",
        str(tmp_path / "old.wav"),
        raising=False,
    )
    monkeypatch.setattr(service.gsm_state, "current_audio_stream", None, raising=False)
    monkeypatch.setattr(
        service.gsm_state,
        "texthooker_audio_request",
        {"trim_with_vad": True, "playback_mode": "native"},
        raising=False,
    )
    monkeypatch.setattr(service.gsm_state, "texthooker_audio_cache", {}, raising=False)

    service.handle_texthooker_button("video.mp4")

    assert extracted == [True]
    assert played == [(str(new_audio_path), line.id)]
    assert service.gsm_state.previous_audio_cache_key == service._audio_cache_key(line.id, True)


def test_save_texthooker_video_clip_uses_dated_output_folder(monkeypatch, tmp_path):
    trimmed_video = tmp_path / "trimmed.mp4"
    trimmed_video.write_bytes(b"video")
    output_folder = tmp_path / "output"
    line = SimpleNamespace(text="A line: with invalid? filename characters")

    monkeypatch.setattr(
        service,
        "get_config",
        lambda: SimpleNamespace(paths=SimpleNamespace(output_folder=str(output_folder))),
    )
    monkeypatch.setattr(
        service.time,
        "strftime",
        lambda pattern: {"%Y-%m": "2026-07", "%d": "27", "%H-%M-%S": "12-34-56"}[pattern],
    )

    saved_path = service._save_texthooker_video_clip(str(trimmed_video), line)

    expected_folder = output_folder / "2026-07" / "27"
    assert os.path.dirname(saved_path) == str(expected_folder)
    assert os.path.isfile(saved_path)
    assert saved_path.endswith("_Alinewithinvalidfilenamecharacters.mp4")


def test_show_item_in_folder_selects_file_on_windows(monkeypatch, tmp_path):
    clip_path = tmp_path / "saved clip.mp4"
    launched = []

    monkeypatch.setattr(service.platform, "system", lambda: "Windows")
    monkeypatch.setattr(service.subprocess, "Popen", lambda command: launched.append(command))

    service._show_item_in_folder(str(clip_path))

    assert launched == [["explorer.exe", f"/select,{os.path.normpath(clip_path)}"]]


def test_video_trim_button_persists_clip_and_selects_it(monkeypatch, tmp_path):
    line = SimpleNamespace(id="line-1", text="hello")
    trimmed_path = tmp_path / "trimmed.mp4"
    saved_path = tmp_path / "output" / "saved.mp4"
    selected = []

    monkeypatch.setattr(service.gsm_state, "lines_for_media_creation", None, raising=False)
    monkeypatch.setattr(service.gsm_state, "line_for_audio", None, raising=False)
    monkeypatch.setattr(service.gsm_state, "line_for_video_trim", line, raising=False)
    monkeypatch.setattr(
        service.gsm_state,
        "texthooker_video_trim_request",
        {"trim_with_vad": True, "show_in_explorer": True},
        raising=False,
    )
    monkeypatch.setattr(
        service,
        "_trim_video_for_line",
        lambda actual_line, video_path, trim_with_vad: (
            str(trimmed_path) if (actual_line, video_path, trim_with_vad) == (line, "replay.mp4", True) else ""
        ),
    )
    monkeypatch.setattr(
        service,
        "_save_texthooker_video_clip",
        lambda actual_path, actual_line: (
            str(saved_path) if (actual_path, actual_line) == (str(trimmed_path), line) else ""
        ),
    )
    monkeypatch.setattr(service, "_show_item_in_folder", selected.append)

    service.handle_texthooker_button("replay.mp4")

    assert service.gsm_state.previous_trimmed_video_path == str(saved_path)
    assert selected == [str(saved_path)]


def test_trim_video_uses_the_same_line_window_as_audio(monkeypatch):
    line_time = datetime.datetime(2026, 7, 27, 12, 0, 0)
    line = SimpleNamespace(
        text="hello",
        time=line_time,
        next=SimpleNamespace(time=line_time + datetime.timedelta(seconds=3)),
        source_padding=0,
    )
    trim_calls = []

    monkeypatch.setattr(
        service,
        "get_config",
        lambda: SimpleNamespace(audio=SimpleNamespace(pre_vad_end_offset=0.5)),
    )
    monkeypatch.setattr(
        service,
        "get_video_timings",
        lambda _video_path, _line: (40.2, 40.0, 40.2, 60.0),
    )
    monkeypatch.setattr(
        service.ffmpeg,
        "trim_replay_for_gameline",
        lambda path, start, end, accurate: trim_calls.append((path, start, end, accurate)) or "clip.mp4",
    )

    result = service._trim_video_for_line(line, "replay.mp4", trim_with_vad=False)

    assert result == "clip.mp4"
    assert trim_calls == [("replay.mp4", 40.2, 43.5, True)]
