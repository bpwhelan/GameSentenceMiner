"""Migrate GSM's old per-process logs and expire only managed log history."""

import gzip
import io
import re
import time
import zipfile
from pathlib import Path

from GameSentenceMiner.util.log_paths import LOG_RETENTION_DAYS, SharedRotatingLog, log_file_lock

LOG_DIRECTORY_GUIDE = """GameSentenceMiner logs

backend.log       Python backend and helper diagnostics, including errors.
ocr.log           Persistent OCR diagnostics, including OCR inside the backend.
desktop.log       Desktop app, updates, and embedded overlay diagnostics.
process-output.log  Raw managed process output and startup failures.
ocr-debug.jsonl    Optional advanced OCR traces, with timestamps and process IDs.
anki-timing.log   Optional Anki card timing diagnostics (development builds).
history/          Rotated logs and consolidated logs from older GSM versions.
.locks/           Internal file locks. These are not logs and are not exported.

Files append across restarts. Each active log is limited to 5 MiB with up to
five backups in history/. History older than seven days is removed on startup.
Legacy logs are consolidated by component, keeping up to three 5 MiB files each.
Empty error files are removed; errors stay with their component's diagnostics.
Process IDs are recorded inside logs instead of creating a new file per launch.

Use Export Logs in GSM to include current logs, OCR debug traces, and history.
The export redacts copies; local logs can contain private paths and game text.
"""

_PYTHON_LOG = re.compile(r"^(gamesentenceminer|misc_ocr_utils|gsm_overlay|error)(?:\.[\d_.-]+)?\.log(?:\.(?:zip|gz))?$")
_PROCESS_ID = re.compile(r"^(?:gamesentenceminer|misc_ocr_utils|gsm_overlay|error)\.(\d+)\.")
_NATIVE_LOG = re.compile(r"^rust-ocr-(?:area|runtime)-(\d+)\.log$")
_TEMP_OCR_LOG = re.compile(r"^ocr_(process|debug)_[\d_]+\.(?:log|jsonl)$")
_MANAGED_HISTORY = re.compile(
    r"^(?:backend|ocr|overlay|desktop|process-output|anki-timing)\.log\.\d+$|^ocr-debug\.jsonl\.\d+$|^legacy-[a-z-]+\.log(?:\.\d+)?$"
)
_ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")


def _process_is_running(pid: int, modified_at: float | None = None) -> bool:
    import psutil

    try:
        process = psutil.Process(pid)
        # Windows reuses PIDs frequently. A newer unrelated process must not
        # prevent cleanup of a log written by the previous owner of that PID.
        return process.is_running() and (modified_at is None or process.create_time() <= modified_at)
    except (psutil.NoSuchProcess, ValueError):
        return False
    except psutil.AccessDenied:
        return True


def _legacy_component(name: str) -> str | None:
    match = _PYTHON_LOG.fullmatch(name)
    if match:
        return {"gamesentenceminer": "backend", "misc_ocr_utils": "ocr", "gsm_overlay": "overlay", "error": "errors"}[
            match[1]
        ]
    if _NATIVE_LOG.fullmatch(name):
        return "native-ocr"
    if re.fullmatch(r"rust-ocr-\d+\.jsonl", name):
        return "native-ocr"
    if name in ("main.log", "main.old.log"):
        return "desktop"
    if re.fullmatch(r"anki_card_timing\.log(?:\.\d+)?", name):
        return "anki-timing"
    if _TEMP_OCR_LOG.fullmatch(name):
        return "ocr"
    return None


def _copy_text(stream, sink: SharedRotatingLog) -> None:
    # Older PowerShell logs may have a UTF-16 BOM. Stream inputs to avoid loading
    # hundreds of MB during an upgrade, including decompressed rotations.
    buffered = io.BufferedReader(stream)
    encoding = "utf-16" if buffered.peek(2).startswith((b"\xff\xfe", b"\xfe\xff")) else "utf-8-sig"
    with io.TextIOWrapper(buffered, encoding=encoding, errors="replace") as text:
        while chunk := text.read(1024 * 1024):
            sink.write(_ANSI.sub("", chunk))
    sink.write("\n")


def _import_log(source: Path, sink: SharedRotatingLog) -> None:
    sink.write(f"\n--- Imported from {source.name} ---\n")
    if source.suffix == ".zip":
        with zipfile.ZipFile(source) as archive:
            for entry in archive.infolist():
                if entry.is_dir():
                    continue
                if not re.search(r"\.(?:log|jsonl)(?:\.\d+)?$", entry.filename):
                    raise ValueError("Unsupported legacy log archive")
                if entry.file_size > 64 * 1024 * 1024:
                    raise ValueError("Oversized legacy log archive")
                with archive.open(entry) as stream:
                    _copy_text(stream, sink)
    elif source.suffix == ".gz":
        with gzip.open(source, "rb") as stream:
            _copy_text(stream, sink)
    else:
        with source.open("rb") as stream:
            _copy_text(stream, sink)


def maintain_logs(log_directory: str | Path, days: int = LOG_RETENTION_DAYS) -> dict[str, int]:
    """Leave unknown files and live processes alone; retry locked files next time."""
    root = Path(log_directory).resolve()
    root.mkdir(parents=True, exist_ok=True)
    counts = {"imported": 0, "removed": 0, "skipped": 0}
    with log_file_lock(root / ".locks" / "maintenance.lock"):
        guide = root / "README.txt"
        if not guide.exists() or guide.read_text(encoding="utf-8") != LOG_DIRECTORY_GUIDE:
            guide.write_text(LOG_DIRECTORY_GUIDE, encoding="utf-8")
        candidates = []
        staging = root / ".migration"
        locations = [root, root.parent / "temp" / "ocr_logs", root / "ocr", staging]
        for location in locations:
            if not location.is_dir() or location.resolve() != location:
                continue
            for source in location.iterdir():
                component = _legacy_component(source.name)
                if component and source.is_file() and not source.is_symlink():
                    try:
                        candidates.append((source.stat().st_mtime_ns, source, component))
                    except OSError:
                        counts["skipped"] += 1
        for modified_ns, source, component in sorted(candidates):
            match = _PROCESS_ID.match(source.name) or _NATIVE_LOG.match(source.name)
            if not match and _TEMP_OCR_LOG.fullmatch(source.name):
                match = re.search(r"_(\d+)\.(?:log|jsonl)$", source.name)
            if match:
                pid = int(match[1])
                if _process_is_running(pid, modified_ns / 1e9):
                    counts["skipped"] += 1
                    continue
            claimed = staging / source.name
            # Both sides of every move must remain within the explicit data
            # directories, including Windows junctions in an old logs folder.
            if source.resolve().parent not in locations or not claimed.resolve().is_relative_to(root):
                counts["skipped"] += 1
                continue
            try:
                if source != claimed:
                    staging.mkdir(exist_ok=True)
                    if claimed.exists():
                        counts["skipped"] += 1
                        continue
                    # Claim before reading. A Windows logger holding this file
                    # open prevents the rename, so repeated cleanup cannot copy
                    # the same live log into history over and over.
                    source.rename(claimed)
                before = claimed.stat()
                if before.st_size:
                    sink = SharedRotatingLog(
                        root / "history" / f"legacy-{component}.log",
                        backup_count=2,
                        history_directory=root / "history",
                    )
                    _import_log(claimed, sink)
                after = claimed.stat()
                if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
                    raise OSError("Legacy log changed during migration")
                claimed.unlink()
                counts["imported" if before.st_size else "removed"] += 1
            except (OSError, ValueError, zipfile.BadZipFile):
                counts["skipped"] += 1
                if source != claimed and claimed.exists() and not source.exists():
                    try:
                        claimed.rename(source)
                    except OSError:
                        pass  # The next startup recovers anything left in .migration/.

        for directory in locations[1:]:
            if directory.resolve() == directory:
                try:
                    directory.rmdir()  # Only empty, recognized legacy directories.
                except OSError:
                    pass

        cutoff = time.time() - max(1, days) * 86400
        history = root / "history"
        if history.is_dir() and not history.is_symlink():
            for source in history.iterdir():
                if not source.is_symlink() and source.is_file() and _MANAGED_HISTORY.fullmatch(source.name):
                    try:
                        base_name = re.sub(r"\.\d+$", "", source.name)
                        lock_root = history if base_name.startswith("legacy-") else root
                        with log_file_lock(lock_root / ".locks" / f"{base_name}.lock"):
                            if source.stat().st_mtime < cutoff:
                                source.unlink()
                                counts["removed"] += 1
                    except OSError:
                        counts["skipped"] += 1
    return counts
