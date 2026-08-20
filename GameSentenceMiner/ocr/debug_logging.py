"""Structured, opt-in diagnostics for the OCR pipeline."""

from __future__ import annotations

import json
import os
import threading
from datetime import date, datetime
from enum import Enum
from pathlib import Path
from typing import Any, TextIO


DEBUG_SCHEMA = "gsm_ocr_debug_v1"
OCR_DEBUG_LOG_GLOB = "ocr_debug_*.jsonl"
MAX_TEXT_PREVIEW = 240

_debug_log_lock = threading.RLock()
_debug_log_path: Path | None = None
_debug_log_stream: TextIO | None = None


def _prune_debug_logs(log_dir: Path, current_log: Path, max_files: int) -> None:
    other_logs = [path for path in log_dir.glob(OCR_DEBUG_LOG_GLOB) if path != current_log]
    other_logs.sort(key=lambda path: (path.stat().st_mtime_ns, path.name), reverse=True)
    for stale_log in other_logs[max_files - 1 :]:
        try:
            stale_log.unlink()
        except OSError:
            pass


def start_ocr_debug_log(temporary_directory: str | Path, max_files: int = 3) -> tuple[Path, bool]:
    """Open this OCR process run's JSONL file, or return the existing file."""
    global _debug_log_path, _debug_log_stream
    with _debug_log_lock:
        if _debug_log_path is not None:
            if _debug_log_stream is None or _debug_log_stream.closed:
                _debug_log_stream = _debug_log_path.open("a", encoding="utf-8", buffering=1)
            return _debug_log_path, False

        max_files = max(1, int(max_files))
        log_dir = Path(temporary_directory) / "ocr_logs"
        log_dir.mkdir(parents=True, exist_ok=True)
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
        _debug_log_path = log_dir / f"ocr_debug_{timestamp}_{os.getpid()}.jsonl"
        _debug_log_stream = _debug_log_path.open("a", encoding="utf-8", buffering=1)
        _prune_debug_logs(log_dir, _debug_log_path, max_files)
        return _debug_log_path, True


def close_ocr_debug_log() -> None:
    """Flush and close the current run's file while retaining its identity."""
    global _debug_log_stream
    with _debug_log_lock:
        if _debug_log_stream is not None and not _debug_log_stream.closed:
            _debug_log_stream.flush()
            _debug_log_stream.close()
        _debug_log_stream = None


def reset_ocr_debug_log_for_tests() -> None:
    """Forget the current process-run file. Intended for isolated tests only."""
    global _debug_log_path
    close_ocr_debug_log()
    with _debug_log_lock:
        _debug_log_path = None


def text_preview(value: Any, limit: int = MAX_TEXT_PREVIEW) -> str:
    text = str(value or "").replace("\r", "\\r").replace("\n", "\\n")
    if len(text) <= limit:
        return text
    return f"{text[:limit]}…"


def _json_safe(value: Any) -> Any:
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, Enum):
        return value.value
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, dict):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_json_safe(item) for item in value]
    return text_preview(value)


def emit_ocr_debug(enabled: bool, event: str, **fields: Any) -> None:
    """Write one compact JSON object to this OCR run's dedicated JSONL file."""
    if not enabled:
        return
    payload = {"schema": DEBUG_SCHEMA, "event": event}
    payload.update({key: _json_safe(value) for key, value in fields.items()})
    line = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    with _debug_log_lock:
        if _debug_log_stream is None or _debug_log_stream.closed:
            return
        _debug_log_stream.write(line + "\n")
