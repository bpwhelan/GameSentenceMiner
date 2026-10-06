"""Wall-clock spans GSM held the game suspended, kept as long as a replay can still contain them."""

import json
import threading
import time
from pathlib import Path

from GameSentenceMiner.util.concurrency.work_pool import submit_background_work
from GameSentenceMiner.util.config.configuration import gsm_state, logger
from GameSentenceMiner.util.data_directory import get_app_directory

# Beyond the replay buffer, room for a confirmation dialog left open or a late Text Feed replay.
RETENTION_MARGIN_SECONDS = 10 * 60

PauseSpan = tuple[float, float]

_lock = threading.Lock()
_save_lock = threading.Lock()
_spans: list[PauseSpan] | None = None
_history_file: Path | None = None


def _get_history_file() -> Path:
    global _history_file
    if _history_file is None:
        _history_file = Path(get_app_directory()) / "process_pause_history.json"
    return _history_file


def _load() -> list[PauseSpan]:
    global _spans
    if _spans is None:
        try:
            path = _get_history_file()
            entries = json.loads(path.read_text(encoding="utf-8"))["pauses"] if path.exists() else []
            _spans = sorted((float(start), float(end)) for start, end in entries)
        except (OSError, ValueError, TypeError, LookupError) as e:
            logger.debug(f"Could not read process pause history: {e}")
            _spans = []
    return _spans


def record_pause(suspended_at: float, resumed_at: float) -> None:
    """Remember that the game was suspended from `suspended_at` to `resumed_at` (epoch seconds)."""
    global _spans
    if resumed_at <= suspended_at:
        return
    cutoff = time.time() - gsm_state.replay_buffer_length - RETENTION_MARGIN_SECONDS
    with _lock:
        _spans = sorted(span for span in [*_load(), (suspended_at, resumed_at)] if span[1] >= cutoff)
    # Resumes can happen on the Qt thread; the file write doesn't need to.
    submit_background_work(_save)


def _save() -> None:
    with _save_lock:
        with _lock:
            spans = list(_spans or [])
        try:
            _get_history_file().write_text(json.dumps({"pauses": spans}), encoding="utf-8")
        except OSError as e:
            logger.debug(f"Could not save process pause history: {e}")


def get_pauses_between(start: float, end: float) -> list[PauseSpan]:
    """Pauses overlapping the wall-clock window [start, end] (epoch seconds)."""
    with _lock:
        return [span for span in _load() if span[1] > start and span[0] < end]


def _reset_for_tests(history_file: Path | None = None) -> None:
    global _spans, _history_file
    with _lock:
        _spans = None
        _history_file = history_file
