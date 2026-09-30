"""Structured, opt-in diagnostics for the OCR pipeline."""

from __future__ import annotations

import json
import os
import threading
from datetime import date, datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Any

from GameSentenceMiner.util.log_paths import LOG_BACKUP_COUNT, MAX_LOG_BYTES, SharedRotatingLog, get_log_directory

DEBUG_SCHEMA = "gsm_ocr_debug_v1"
MAX_TEXT_PREVIEW = 240

_debug_log_lock = threading.RLock()
_debug_log_path: Path | None = None
_debug_log_stream: SharedRotatingLog | None = None


def start_ocr_debug_log(
    log_directory: str | Path | None = None,
    *,
    max_bytes: int = MAX_LOG_BYTES,
    backup_count: int = LOG_BACKUP_COUNT,
) -> tuple[Path, bool]:
    """Enable persistent JSONL diagnostics, independent of temporary OCR images."""
    global _debug_log_path, _debug_log_stream
    with _debug_log_lock:
        if _debug_log_path is not None:
            if _debug_log_stream is None:
                _debug_log_stream = SharedRotatingLog(_debug_log_path, max_bytes=max_bytes, backup_count=backup_count)
            return _debug_log_path, False

        log_dir = Path(log_directory) if log_directory is not None else get_log_directory()
        _debug_log_path = log_dir / "ocr-debug.jsonl"
        _debug_log_stream = SharedRotatingLog(_debug_log_path, max_bytes=max_bytes, backup_count=backup_count)
        return _debug_log_path, True


def close_ocr_debug_log() -> None:
    """Flush and close the current run's file while retaining its identity."""
    global _debug_log_stream
    with _debug_log_lock:
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
    """Write a timestamped diagnostic, keeping each rotated file valid JSONL."""
    if not enabled:
        return
    payload = {"schema": DEBUG_SCHEMA, "event": event}
    payload.update({key: _json_safe(value) for key, value in fields.items()})
    payload["timestamp"] = datetime.now(timezone.utc).isoformat(timespec="milliseconds")
    payload["pid"] = os.getpid()
    line = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    with _debug_log_lock:
        if _debug_log_stream is None:
            return
        if len((line + "\n").encode("utf-8")) > _debug_log_stream.max_bytes:
            line = json.dumps(
                {
                    "schema": DEBUG_SCHEMA,
                    "event": "diagnostic.oversized",
                    "timestamp": payload["timestamp"],
                    "pid": payload["pid"],
                    "bytes": len(line.encode("utf-8")),
                }
            )
        _debug_log_stream.write(line + "\n")
