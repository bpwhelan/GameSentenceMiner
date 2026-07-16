"""Dedicated, short-lived logging for individual OCR process launches."""

import os
from datetime import datetime
from pathlib import Path


OCR_PROCESS_LOG_GLOB = "ocr_process_*.log"


def _prune_ocr_process_logs(log_dir: Path, current_log: Path, max_files: int) -> None:
    other_logs = [path for path in log_dir.glob(OCR_PROCESS_LOG_GLOB) if path != current_log]
    other_logs.sort(key=lambda path: (path.stat().st_mtime_ns, path.name), reverse=True)
    for stale_log in other_logs[max_files - 1 :]:
        try:
            stale_log.unlink()
        except OSError:
            # A just-stopped OCR process can briefly retain its file handle on
            # Windows. A later launch will retry pruning the same stale log.
            pass


def start_ocr_process_log(logger, temporary_directory, max_files: int = 3) -> tuple[Path, int]:
    """Add a loguru sink for this OCR process and retain only recent runs."""
    max_files = max(1, int(max_files))
    log_dir = Path(temporary_directory) / "ocr_logs"
    log_dir.mkdir(parents=True, exist_ok=True)

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
    log_path = log_dir / f"ocr_process_{timestamp}_{os.getpid()}.log"
    handler_id = logger.add(
        str(log_path),
        format="{time:YYYY-MM-DD HH:mm:ss.SSS} | {level: <8} | {name}:{function}:{line} | {message}",
        level="DEBUG",
        encoding="utf-8",
        colorize=False,
        backtrace=True,
        diagnose=False,
        enqueue=True,
    )
    _prune_ocr_process_logs(log_dir, log_path, max_files)
    logger.info("OCR process log: {}", log_path)
    return log_path, handler_id
