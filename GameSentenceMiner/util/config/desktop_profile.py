"""Coordinate the settings editor with the desktop's active profile writer."""

import json
import os
import tempfile
from contextlib import contextmanager
from pathlib import Path


def enabled():
    return os.environ.get("GSM_NATIVE_GAME_SESSION") == "1" and os.environ.get("GSM_CLIENT_ID") == "backend"


@contextmanager
def _settings_lock(path):
    # Same file and overlapping byte range as gsm_settings::with_lock.
    with path.with_suffix(".json.lock").open("a+b") as lock:
        lock.seek(0)
        if os.name == "nt":
            import msvcrt

            msvcrt.locking(lock.fileno(), msvcrt.LK_LOCK, 1)
        else:
            import fcntl

            fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            yield
        finally:
            if os.name == "nt":
                lock.seek(0)
                msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(lock, fcntl.LOCK_UN)


def write_settings(path, data):
    path = Path(path)
    with _settings_lock(path):
        if path.exists():
            try:
                current = json.loads(path.read_text(encoding="utf-8-sig")).get("current_profile")
            except json.JSONDecodeError:
                # load_config already backs up a corrupt configuration during recovery.
                current = None
            if current in data.get("configs", {}):
                data["current_profile"] = current
        temp = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as output:
                temp = Path(output.name)
                json.dump(data, output, indent=4)
            temp.replace(path)
        finally:
            if temp:
                temp.unlink(missing_ok=True)
