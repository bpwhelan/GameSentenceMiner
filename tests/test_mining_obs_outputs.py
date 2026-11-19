from threading import Event, Lock, Thread
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from GameSentenceMiner import obs
from GameSentenceMiner.obs import actions
from GameSentenceMiner.util.communication import bus_client


@pytest.fixture
def desktop(monkeypatch):
    monkeypatch.setenv("GSM_NATIVE_OBS_OUTPUTS", "1")
    monkeypatch.setenv("GSM_CLIENT_ID", "backend")
    monkeypatch.setattr(actions, "_call_with_obs_client", lambda *a, **k: pytest.fail("used legacy OBS pool"))
    monkeypatch.setattr(actions, "_is_obs_recording_disabled", lambda: False)
    monkeypatch.setattr(
        actions, "get_config", lambda: SimpleNamespace(features=SimpleNamespace(generate_longplay=True))
    )
    monkeypatch.setattr(obs, "obs_service", None)
    monkeypatch.setattr(obs, "longplay_handler", Mock())
    request = Mock()
    monkeypatch.setattr(bus_client, "get_bus", lambda: SimpleNamespace(request=request))
    return request


def test_recording_preserves_longplay_and_saved_path(desktop):
    desktop.side_effect = [{"changed": False}, {"changed": True, "outputPath": "録画.mkv"}, {"changed": False}]
    actions.start_recording(longplay=True)
    assert actions.stop_recording() == "録画.mkv"
    assert actions.stop_recording() is None
    obs.longplay_handler.on_record_start_requested.assert_called_once_with()
    obs.longplay_handler.on_record_stop_response.assert_called_once_with(output_path="録画.mkv")
    assert [call.args[2]["action"] for call in desktop.call_args_list] == ["recordStart", "recordStop", "recordStop"]


def test_mining_save_uses_the_existing_connection_once(desktop, monkeypatch):
    client = Mock()
    client.save_replay_buffer.side_effect = TimeoutError("lost reply")

    def call(operation, **options):
        assert not options["retryable"] and options["raise_exc"]
        return operation(client)

    monkeypatch.setattr(actions, "_call_with_obs_client", call)
    with pytest.raises(TimeoutError):
        actions.save_replay_buffer(_obs_retries=4)
    client.save_replay_buffer.assert_called_once()
    desktop.assert_not_called()


def test_native_save_returns_the_path_for_this_request(desktop, monkeypatch, tmp_path):
    monkeypatch.setenv("GSM_NATIVE_REPLAY_ACQUISITION", "1")
    monkeypatch.setattr(actions, "get_config", lambda: SimpleNamespace(paths=SimpleNamespace(folder_to_watch=tmp_path)))
    replay = tmp_path / "custom name.mov"
    replay.write_bytes(b"completed")
    desktop.return_value = {"savedReplayPath": str(replay)}
    assert actions.save_replay_buffer() == str(replay)
    assert desktop.call_args.args[2]["action"] == "saveReplay"


def test_native_save_never_retries_an_ambiguous_failure(desktop, monkeypatch, tmp_path):
    monkeypatch.setenv("GSM_NATIVE_REPLAY_ACQUISITION", "1")
    monkeypatch.setattr(actions, "get_config", lambda: SimpleNamespace(paths=SimpleNamespace(folder_to_watch=tmp_path)))
    desktop.side_effect = TimeoutError("lost reply")
    with pytest.raises(TimeoutError):
        actions.save_replay_buffer(_obs_retries=4)
    desktop.assert_called_once()


def test_backend_cleanup_cannot_receive_a_file_outside_recordings(desktop, monkeypatch, tmp_path):
    monkeypatch.setenv("GSM_NATIVE_REPLAY_ACQUISITION", "1")
    folder = tmp_path / "recordings"
    folder.mkdir()
    monkeypatch.setattr(actions, "get_config", lambda: SimpleNamespace(paths=SimpleNamespace(folder_to_watch=folder)))
    other_file = tmp_path / "unrelated.mp4"
    other_file.touch()
    desktop.return_value = {"savedReplayPath": str(other_file)}
    with pytest.raises(ValueError, match="recording folder"):
        actions.save_replay_buffer()
    assert other_file.exists()


def test_disabled_starts_skip_transport(desktop, monkeypatch):
    monkeypatch.setattr(actions, "_is_obs_recording_disabled", lambda: True)
    monkeypatch.setattr(obs, "obs_service", SimpleNamespace(state=SimpleNamespace(replay_buffer_active=False)))
    actions.start_replay_buffer()
    actions.start_recording()
    desktop.assert_not_called()


def test_longplay_replay_transitions_preserve_state_and_recording_callbacks(desktop, monkeypatch):
    svc = SimpleNamespace(
        state=SimpleNamespace(replay_buffer_active=False),
        _state_lock=Lock(),
        mark_replay_buffer_action=Mock(),
        _auto_start_paused_by_external_replay_stop=True,
    )
    monkeypatch.setattr(obs, "obs_service", svc)
    desktop.side_effect = [
        {"changed": True, "recording": {"changed": False}},
        {"changed": False},
        {"changed": True, "recording": {"changed": True, "outputPath": "game.mkv"}},
    ]
    actions.start_replay_buffer()
    actions.start_replay_buffer()
    assert svc.state.replay_buffer_active is True
    assert actions.gsm_state.replay_buffer_stopped_timestamp is None
    actions.stop_replay_buffer()
    assert svc.state.replay_buffer_active is False
    assert actions.gsm_state.replay_buffer_stopped_timestamp is not None
    assert [call.args for call in svc.mark_replay_buffer_action.call_args_list] == [(True,), (False,)]
    assert [call.args[2]["action"] for call in desktop.call_args_list] == [
        "longplayStart",
        "longplayStart",
        "longplayStop",
    ]
    obs.longplay_handler.on_record_start_requested.assert_called_once_with()
    obs.longplay_handler.on_record_stop_response.assert_called_once_with(output_path="game.mkv")


def test_record_failure_keeps_acknowledged_replay_change(desktop, monkeypatch):
    svc = SimpleNamespace(
        state=SimpleNamespace(replay_buffer_active=True), _state_lock=Lock(), mark_replay_buffer_action=Mock()
    )
    monkeypatch.setattr(obs, "obs_service", svc)
    desktop.return_value = {"changed": True, "recordingError": "OBS disconnected"}
    actions.stop_replay_buffer()
    assert svc.state.replay_buffer_active is False
    svc.mark_replay_buffer_action.assert_called_once_with(False)
    obs.longplay_handler.on_record_stop_response.assert_not_called()
    desktop.assert_called_once()


def test_obs_event_can_arrive_before_the_longplay_stop_acknowledgement(desktop, monkeypatch):
    svc = obs.OBSService.__new__(obs.OBSService)
    svc.check_output = True
    svc._state_lock = Lock()
    svc._replay_buffer_action_grace_seconds = 8
    svc._connection_grace_deadline = 0
    svc.state = SimpleNamespace(replay_buffer_active=True)
    monkeypatch.setattr(obs, "obs_service", svc)
    arrived = Event()

    def deliver():
        arrived.set()
        svc._handle_replay_buffer_state_changed(SimpleNamespace(output_active=False))

    event = Thread(target=deliver)

    def stop(*args, **kwargs):
        event.start()
        assert arrived.wait(1)
        return {"changed": True, "recording": {"changed": False}}

    desktop.side_effect = stop
    actions.stop_replay_buffer()
    event.join(timeout=2)
    assert not event.is_alive()
    assert svc._replay_buffer_action_pending is None
    assert not svc._auto_start_paused_by_external_replay_stop


def test_ordinary_replay_goes_direct_without_retrying_a_native_timeout(desktop, monkeypatch):
    desktop.side_effect = TimeoutError("lost acknowledgement")
    actions.start_replay_buffer(_obs_retries=4)
    desktop.assert_called_once()
    monkeypatch.setattr(
        actions, "get_config", lambda: SimpleNamespace(features=SimpleNamespace(generate_longplay=False))
    )
    client = Mock()
    client.get_replay_buffer_status.return_value.output_active = False
    monkeypatch.setattr(actions, "_call_with_obs_client", lambda operation, **kw: operation(client))
    actions.start_replay_buffer()
    client.start_replay_buffer.assert_called_once()
    desktop.assert_called_once()
