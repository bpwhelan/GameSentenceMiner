import os
from datetime import timedelta
from types import SimpleNamespace

import pytest

import GameSentenceMiner.longplay_handler as longplay_module
from GameSentenceMiner.longplay_handler import LongPlayHandler
from GameSentenceMiner.util.config.configuration import gsm_state


@pytest.fixture(autouse=True)
def _reset_longplay_state():
    gsm_state.recording_started_time = None
    gsm_state.current_srt = None
    gsm_state.current_recording = None
    gsm_state.srt_index = 1
    yield
    gsm_state.recording_started_time = None
    gsm_state.current_srt = None
    gsm_state.current_recording = None
    gsm_state.srt_index = 1


def _make_line(recording_start, text="hello"):
    prev = SimpleNamespace(
        text=text,
        time=recording_start + timedelta(seconds=1),
    )
    return SimpleNamespace(prev=prev)


def test_record_file_event_places_srt_next_to_recording(monkeypatch, tmp_path):
    handler = LongPlayHandler(
        feature_enabled_getter=lambda: True,
        game_name_getter=lambda: "Test Game",
    )

    recording_path = tmp_path / "clip.mkv"
    handler.on_record_state_changed(output_active=True, output_path=None)
    handler.on_record_file_changed(str(recording_path))

    expected_srt = tmp_path / "clip.srt"
    assert gsm_state.current_srt == str(expected_srt)

    line = _make_line(gsm_state.recording_started_time)
    handler.add_srt_line(gsm_state.recording_started_time + timedelta(seconds=2), line)

    monkeypatch.setattr(longplay_module, "get_all_lines", lambda: [line])
    handler.on_record_state_changed(
        output_active=False, output_path=str(recording_path)
    )

    assert expected_srt.exists()
    assert "hello" in expected_srt.read_text(encoding="utf-8")
    assert gsm_state.recording_started_time is None
    assert gsm_state.current_srt is None
    assert gsm_state.current_recording is None


def test_stop_event_moves_temp_srt_to_recording_folder(monkeypatch, tmp_path):
    handler = LongPlayHandler(
        feature_enabled_getter=lambda: True,
        game_name_getter=lambda: "Temp Start",
    )

    handler.on_record_state_changed(output_active=True, output_path=None)
    line = _make_line(gsm_state.recording_started_time, text="line from temp srt")
    handler.add_srt_line(gsm_state.recording_started_time + timedelta(seconds=2), line)

    temp_srt = gsm_state.current_srt
    assert temp_srt

    recording_path = tmp_path / "user_stop.mp4"
    monkeypatch.setattr(longplay_module, "get_all_lines", lambda: [line])
    handler.on_record_state_changed(
        output_active=False, output_path=str(recording_path)
    )

    expected_srt = tmp_path / "user_stop.srt"
    assert expected_srt.exists()
    assert "line from temp srt" in expected_srt.read_text(encoding="utf-8")
    assert not os.path.exists(temp_srt)


def test_stop_response_finalizes_without_stop_event(monkeypatch, tmp_path):
    handler = LongPlayHandler(
        feature_enabled_getter=lambda: True,
        game_name_getter=lambda: "Response Stop",
    )

    recording_path = tmp_path / "response_stop.mkv"
    handler.on_record_start_requested()
    handler.on_record_file_changed(str(recording_path))

    line = _make_line(gsm_state.recording_started_time, text="response-stop")
    handler.add_srt_line(gsm_state.recording_started_time + timedelta(seconds=2), line)

    monkeypatch.setattr(longplay_module, "get_all_lines", lambda: [line])
    handler.on_record_stop_response(output_path=str(recording_path))

    expected_srt = tmp_path / "response_stop.srt"
    assert expected_srt.exists()
    assert "response-stop" in expected_srt.read_text(encoding="utf-8")
    assert gsm_state.recording_started_time is None
    assert gsm_state.current_srt is None
    assert gsm_state.current_recording is None


def test_finalize_renames_mp4_and_srt_with_sanitized_game_name(monkeypatch, tmp_path):
    expected_prefix = longplay_module.sanitize_filename("Game: Name?")
    handler = LongPlayHandler(
        feature_enabled_getter=lambda: True,
        game_name_getter=lambda: "Game: Name?",
    )

    recording_path = tmp_path / "user_stop.mp4"
    recording_path.write_bytes(b"video")

    handler.on_record_state_changed(output_active=True, output_path=None)
    handler.on_record_file_changed(str(recording_path))

    line = _make_line(gsm_state.recording_started_time, text="rename-success")
    handler.add_srt_line(gsm_state.recording_started_time + timedelta(seconds=2), line)

    monkeypatch.setattr(longplay_module, "get_all_lines", lambda: [line])
    handler.on_record_state_changed(
        output_active=False, output_path=str(recording_path)
    )

    expected_recording = tmp_path / f"{expected_prefix}_user_stop.mp4"
    expected_srt = tmp_path / f"{expected_prefix}_user_stop.srt"
    assert expected_recording.exists()
    assert expected_srt.exists()
    assert "rename-success" in expected_srt.read_text(encoding="utf-8")
    assert not recording_path.exists()
    assert not (tmp_path / "user_stop.srt").exists()


def test_finalize_retries_mp4_rename_once_before_renaming_srt(monkeypatch, tmp_path):
    expected_prefix = longplay_module.sanitize_filename("Retry Game")
    handler = LongPlayHandler(
        feature_enabled_getter=lambda: True,
        game_name_getter=lambda: "Retry Game",
    )

    recording_path = tmp_path / "retry.mp4"
    recording_path.write_bytes(b"video")

    handler.on_record_state_changed(output_active=True, output_path=None)
    handler.on_record_file_changed(str(recording_path))

    line = _make_line(gsm_state.recording_started_time, text="retry-success")
    handler.add_srt_line(gsm_state.recording_started_time + timedelta(seconds=2), line)

    rename_calls = []
    sleep_calls = []
    original_rename = os.rename

    def flaky_rename(src, dst):
        rename_calls.append((src, dst))
        if len(rename_calls) == 1:
            raise PermissionError("file is busy")
        return original_rename(src, dst)

    monkeypatch.setattr(longplay_module.os, "rename", flaky_rename)
    monkeypatch.setattr(
        longplay_module.time, "sleep", lambda seconds: sleep_calls.append(seconds)
    )
    monkeypatch.setattr(longplay_module, "get_all_lines", lambda: [line])

    handler.on_record_state_changed(
        output_active=False, output_path=str(recording_path)
    )

    assert sleep_calls == [2]
    assert rename_calls[0][0].endswith("retry.mp4")
    assert rename_calls[1][0].endswith("retry.mp4")
    assert rename_calls[2][0].endswith("retry.srt")
    assert (tmp_path / f"{expected_prefix}_retry.mp4").exists()
    assert (tmp_path / f"{expected_prefix}_retry.srt").exists()


def test_finalize_leaves_mp4_and_srt_unchanged_when_mp4_cannot_be_renamed(
    monkeypatch, tmp_path
):
    expected_prefix = longplay_module.sanitize_filename("Blocked Rename")
    handler = LongPlayHandler(
        feature_enabled_getter=lambda: True,
        game_name_getter=lambda: "Blocked Rename",
    )

    recording_path = tmp_path / "blocked.mp4"
    recording_path.write_bytes(b"video")

    handler.on_record_state_changed(output_active=True, output_path=None)
    handler.on_record_file_changed(str(recording_path))

    line = _make_line(gsm_state.recording_started_time, text="still-here")
    handler.add_srt_line(gsm_state.recording_started_time + timedelta(seconds=2), line)

    sleep_calls = []

    def always_fail_rename(src, dst):
        raise PermissionError(f"cannot rename {src}")

    monkeypatch.setattr(longplay_module.os, "rename", always_fail_rename)
    monkeypatch.setattr(
        longplay_module.time, "sleep", lambda seconds: sleep_calls.append(seconds)
    )
    monkeypatch.setattr(longplay_module, "get_all_lines", lambda: [line])

    handler.on_record_state_changed(
        output_active=False, output_path=str(recording_path)
    )

    original_srt = tmp_path / "blocked.srt"
    assert sleep_calls == [2]
    assert recording_path.exists()
    assert original_srt.exists()
    assert not (tmp_path / f"{expected_prefix}_blocked.mp4").exists()
    assert not (tmp_path / f"{expected_prefix}_blocked.srt").exists()
