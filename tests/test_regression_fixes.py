import asyncio
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
    health_response = asyncio.run(
        server.process_request(None, SimpleNamespace(path="/health"))
    )

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
    monkeypatch.setattr(
        service, "get_audio_from_video", fake_get_audio_from_video, raising=False
    )
    monkeypatch.setattr(service, "_play_audio_from_file", fake_play_audio_from_file)
    monkeypatch.setattr(
        service, "play_audio_data_safe", fail_if_previous_variant_is_reused
    )
    monkeypatch.setattr(
        service, "_send_texthooker_audio_event", lambda *_args, **_kwargs: None
    )

    monkeypatch.setattr(service.gsm_state, "line_for_audio", line, raising=False)
    monkeypatch.setattr(
        service.gsm_state, "previous_line_for_audio", line, raising=False
    )
    monkeypatch.setattr(
        service.gsm_state, "previous_audio", ("old-data", 1), raising=False
    )
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
    assert service.gsm_state.previous_audio_cache_key == service._audio_cache_key(
        line.id, True
    )
