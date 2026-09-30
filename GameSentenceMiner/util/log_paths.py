"""Stable log names and bounded, cross-process-safe file rotation.

Every writer takes the same OS lock and closes the log before releasing it.
Unlike independent Loguru file sinks, this allows Windows helpers to share a
readable filename without holding a handle open across another writer's rename.
"""

import os
import threading
from contextlib import contextmanager
from pathlib import Path

from GameSentenceMiner.util.data_directory import get_app_directory

MAX_LOG_BYTES = 5 * 1024 * 1024
LOG_BACKUP_COUNT = 5
LOG_RETENTION_DAYS = 7
_thread_locks: dict[str, threading.RLock] = {}


def get_log_directory() -> Path:
    return Path(get_app_directory()) / "logs"


def get_component_log_path(log_dir: str | os.PathLike[str], logger_name: str) -> Path:
    names = {
        "gamesentenceminer": "backend",
        "backend": "backend",
        "misc_ocr_utils": "ocr",
        "ocr": "ocr",
        "gsm_overlay": "overlay",
        "overlay": "overlay",
    }
    return Path(log_dir) / f"{names.get(logger_name, 'backend')}.log"


@contextmanager
def log_file_lock(lock_path: Path):
    """An OS-owned lock is automatically released if its process crashes."""
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    key = os.path.normcase(str(lock_path.resolve()))
    thread_lock = _thread_locks.setdefault(key, threading.RLock())
    with thread_lock, lock_path.open("a+b") as handle:
        if os.name == "nt":
            import msvcrt

            if handle.seek(0, os.SEEK_END) == 0:
                handle.write(b"\0")
                handle.flush()
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK, 1)
        else:
            import fcntl

            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            if os.name == "nt":
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


class SharedRotatingLog:
    """A file-like Loguru/stdlib sink; no file is created until the first write."""

    def __init__(
        self,
        path: str | Path,
        *,
        max_bytes: int = MAX_LOG_BYTES,
        backup_count: int = LOG_BACKUP_COUNT,
        history_directory: Path | None = None,
    ):
        self.path = Path(path)
        self.max_bytes = max(1, max_bytes)
        self.backup_count = max(1, backup_count)
        self.history = history_directory or self.path.parent / "history"
        self.lock_path = self.path.parent / ".locks" / f"{self.path.name}.lock"

    def write(self, message: str) -> None:
        if not message:
            return
        content = str(message).encode("utf-8", errors="replace")
        if len(content) > self.max_bytes:
            # Bound even a runaway third-party response or exception dump.
            marker = b"[Oversized log record truncated]\n"
            tail = content[-max(1, self.max_bytes - len(marker)) :].decode("utf-8", errors="ignore").encode("utf-8")
            content = (marker + tail)[-self.max_bytes :]
        with log_file_lock(self.lock_path):
            self.path.parent.mkdir(parents=True, exist_ok=True)
            size = self.path.stat().st_size if self.path.exists() else 0
            if size and size + len(content) > self.max_bytes:
                self._rotate()
            with self.path.open("ab") as stream:
                stream.write(content)

    def _rotate(self) -> None:
        self.history.mkdir(parents=True, exist_ok=True)
        for index in range(self.backup_count, 0, -1):
            destination = self.history / f"{self.path.name}.{index}"
            source = self.path if index == 1 else self.history / f"{self.path.name}.{index - 1}"
            if source.exists():
                source.replace(destination)

    def flush(self) -> None:
        # Each write closes (and therefore flushes) its own file handle.
        pass
