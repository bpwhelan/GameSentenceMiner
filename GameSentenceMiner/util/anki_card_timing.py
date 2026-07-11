from __future__ import annotations

import json
import logging
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any, Callable, Iterator

_LOGGER_NAME = "GameSentenceMiner.anki_card_timing"
_LOG_FILENAME = "anki_card_timing.log"
_MAX_LOG_BYTES = 5 * 1024 * 1024
_BACKUP_COUNT = 5

_logger = logging.getLogger(_LOGGER_NAME)
_logger.setLevel(logging.INFO)
_logger.propagate = False

_enabled = False
_configured_path: Path | None = None


@dataclass
class AnkiCardTimingContext:
    timing_id: str
    note_id: str = ""
    line_id: str = ""
    word: str = ""
    selected_line_count: int = 0
    created_at_perf: float = field(default_factory=time.perf_counter)
    queued_at_perf: float = 0.0

    def mark_queued(self) -> None:
        self.queued_at_perf = time.perf_counter()

    def elapsed_since_start_ms(self) -> float:
        return elapsed_ms(self.created_at_perf)

    def elapsed_since_queue_ms(self) -> float | None:
        if not self.queued_at_perf:
            return None
        return elapsed_ms(self.queued_at_perf)


def configure_anki_card_timing_logging(enabled: bool, log_directory: str | Path) -> Path | None:
    """Configure the isolated card timing log sink."""
    global _configured_path, _enabled

    _enabled = bool(enabled)
    if not _enabled:
        _remove_handlers()
        _configured_path = None
        return None

    log_dir = Path(log_directory)
    log_dir.mkdir(parents=True, exist_ok=True)
    log_path = log_dir / _LOG_FILENAME

    if _configured_path == log_path and _logger.handlers:
        return log_path

    _remove_handlers()
    handler = RotatingFileHandler(
        log_path,
        maxBytes=_MAX_LOG_BYTES,
        backupCount=_BACKUP_COUNT,
        encoding="utf-8",
    )
    handler.setFormatter(logging.Formatter("%(message)s"))
    _logger.addHandler(handler)
    _configured_path = log_path
    return log_path


def new_anki_card_timing_context(
    *,
    note_id: Any = "",
    line_id: Any = "",
    word: str = "",
    selected_line_count: int = 0,
) -> AnkiCardTimingContext | None:
    if not is_anki_card_timing_enabled():
        return None
    return AnkiCardTimingContext(
        timing_id=uuid.uuid4().hex[:12],
        note_id=_stringify(note_id),
        line_id=_stringify(line_id),
        word=_stringify(word),
        selected_line_count=int(selected_line_count or 0),
    )


def is_anki_card_timing_enabled() -> bool:
    return bool(_enabled and _logger.handlers)


def elapsed_ms(start: float) -> float:
    return round((time.perf_counter() - start) * 1000.0, 3)


def log_anki_card_timing(
    context: AnkiCardTimingContext | None,
    event: str,
    **fields: Any,
) -> None:
    if not is_anki_card_timing_enabled() or context is None:
        return

    record: dict[str, Any] = {
        "timestamp": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
        "event": event,
        "timing_id": context.timing_id,
        "note_id": context.note_id,
        "line_id": context.line_id,
        "word": context.word,
        "selected_line_count": context.selected_line_count,
        "since_start_ms": context.elapsed_since_start_ms(),
    }
    queue_elapsed = context.elapsed_since_queue_ms()
    if queue_elapsed is not None:
        record["since_queue_ms"] = queue_elapsed

    record.update({key: _json_safe(value) for key, value in fields.items()})
    _logger.info(json.dumps(record, ensure_ascii=False, sort_keys=True, separators=(",", ":")))


@contextmanager
def time_anki_card_block(
    context: AnkiCardTimingContext | None,
    event: str,
    *,
    log_start: bool = False,
    **fields: Any,
) -> Iterator[None]:
    if not is_anki_card_timing_enabled() or context is None:
        yield
        return

    if log_start:
        log_anki_card_timing(context, f"{event}.start", **fields)

    start = time.perf_counter()
    try:
        yield
    except Exception as exc:
        log_anki_card_timing(
            context,
            f"{event}.error",
            elapsed_ms=elapsed_ms(start),
            error_type=type(exc).__name__,
            error=str(exc),
            **fields,
        )
        raise
    else:
        log_anki_card_timing(context, event, elapsed_ms=elapsed_ms(start), **fields)


def run_anki_card_timed(
    context: AnkiCardTimingContext | None,
    event: str,
    func: Callable[..., Any],
    *args: Any,
    **kwargs: Any,
) -> Any:
    with time_anki_card_block(context, event, log_start=True):
        return func(*args, **kwargs)


def _remove_handlers() -> None:
    for handler in list(_logger.handlers):
        _logger.removeHandler(handler)
        handler.close()


def _json_safe(value: Any) -> Any:
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, (list, tuple, set)):
        return [_json_safe(item) for item in value]
    if isinstance(value, dict):
        return {_stringify(key): _json_safe(item) for key, item in value.items()}
    return _stringify(value)


def _stringify(value: Any) -> str:
    if value is None:
        return ""
    return str(value)
