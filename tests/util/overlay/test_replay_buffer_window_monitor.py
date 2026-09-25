import asyncio
from types import SimpleNamespace

import pytest

import GameSentenceMiner.obs as obs_module
from GameSentenceMiner.util.overlay import get_overlay_coords


@pytest.mark.parametrize("auto_manage, expected_checks", [(True, 1), (False, 0)])
def test_window_monitor_tracks_replay_buffer_without_overlay_clients(monkeypatch, auto_manage, expected_checks):
    checks = []
    wakeups = []

    class FakeMonitor:
        last_state = "background"
        poll_interval = 0.3

        async def check_and_send(self):
            checks.append(True)
            self.last_state = "active"

    async def stop_after_first_iteration(delay):
        raise asyncio.CancelledError()

    monkeypatch.setattr(get_overlay_coords.websocket_manager, "has_clients", lambda client_id: False)
    monkeypatch.setattr(
        get_overlay_coords,
        "get_config",
        lambda: SimpleNamespace(
            obs=SimpleNamespace(automatically_manage_replay_buffer=auto_manage, disable_recording=False)
        ),
    )
    monkeypatch.setattr(obs_module, "obs_service", SimpleNamespace(check_output=True))
    monkeypatch.setattr(
        obs_module, "obs_connection_manager", SimpleNamespace(request_tick=lambda: wakeups.append(True))
    )
    monkeypatch.setattr(get_overlay_coords.asyncio, "sleep", stop_after_first_iteration)

    with pytest.raises(asyncio.CancelledError):
        asyncio.run(get_overlay_coords._window_monitor_loop(FakeMonitor()))

    assert len(checks) == expected_checks
    assert len(wakeups) == expected_checks
