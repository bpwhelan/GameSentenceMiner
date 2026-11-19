"""Transport for mining output operations on a Tauri-managed backend."""

import os
import threading
import time

# OBS can deliver ReplayBufferStateChanged before the desktop's command reply.
# Apply the acknowledged intent before the event classifies a stop as external.
replay_action_lock = threading.Lock()


def set_replay_buffer_active(state, active):
    changed = bool(state.replay_buffer_active) != bool(active)
    state.replay_buffer_active = active
    if changed:
        from GameSentenceMiner.native import anki_monitor

        anki_monitor.wake(replay_changed=True)


def desktop_managed():
    return os.environ.get("GSM_NATIVE_OBS_OUTPUTS") == "1" and os.environ.get("GSM_CLIENT_ID") == "backend"


def native_replay_acquisition():
    return desktop_managed() and os.environ.get("GSM_NATIVE_REPLAY_ACQUISITION") == "1"


def request(action):
    from GameSentenceMiner.util.communication import bus_client

    timeout = 36 if action in ("recordStop", "longplayStop", "saveReplay") else 11
    payload = {"action": action, "deadline": int((time.time() + timeout - 1) * 1000)}
    return bus_client.get_bus().request(
        bus_client.MAIN,
        "obs.outputs",
        payload,
        timeout=timeout,
    )
