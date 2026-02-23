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
    handler.on_record_state_changed(output_active=False, output_path=str(recording_path))

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
    handler.on_record_state_changed(output_active=False, output_path=str(recording_path))

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
