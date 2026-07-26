"""Helpers for assigning log files to independently launched processes."""

import os
from pathlib import Path


def get_process_log_path(
    log_dir: str | os.PathLike[str],
    logger_name: str,
    process_id: int | None = None,
) -> Path:
    """Return a log path that cannot be shared by two live processes."""
    if process_id is None:
        process_id = os.getpid()
    return Path(log_dir) / f"{logger_name}.{process_id}.log"
