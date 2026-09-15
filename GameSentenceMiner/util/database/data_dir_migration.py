"""One-time repair for releases that relocated configs but kept writing the old DB."""

import os
import shutil
import sqlite3
import uuid
from contextlib import closing
from pathlib import Path

from GameSentenceMiner.util.data_directory import (
    get_pointer_path,
    read_data_dir_pointer,
    write_data_dir_pointer,
)
from GameSentenceMiner.util.database.sqlite_core import atomic_sqlite_backup, durable_replace, sqlite_file_uri


def recover_legacy_database(directory: str) -> None:
    try:
        pointer = read_data_dir_pointer()
    except ValueError:
        if os.environ.get("GSM_DATA_DIR", "").strip():
            return  # Explicit standalone overrides also work when the saved file is invalid.
        raise
    if not pointer or not pointer.get("legacyDatabaseDir"):
        return
    target = Path(directory)
    if os.path.normcase(str(target)) != os.path.normcase(pointer["dataDir"]):
        return  # An explicit environment override must not migrate someone else's selection.

    # SQLite provides a cross-process lock released automatically on a crash. Every new
    # backend takes it before opening gsm.db; no backend can see a half-completed repair.
    lock_path = get_pointer_path().with_name("database-migration.lock")
    with closing(sqlite3.connect(lock_path, timeout=30)) as lock:
        lock.execute("BEGIN EXCLUSIVE")
        pointer = read_data_dir_pointer()
        if not pointer or not pointer.get("legacyDatabaseDir"):
            return
        if os.path.normcase(pointer["dataDir"]) != os.path.normcase(str(target)):
            return
        source_dir = Path(pointer["legacyDatabaseDir"])
        if not source_dir.is_absolute():
            raise ValueError(f"Invalid legacyDatabaseDir in {get_pointer_path()}")
        source = source_dir / "gsm.db"
        destination = target / "gsm.db"
        if source_dir != target and source.is_file():
            target.mkdir(parents=True, exist_ok=True)
            staged = target / f".gsm-db-migration-{uuid.uuid4().hex}.tmp"
            try:
                # A file copy would lose committed rows that are still in the source WAL.
                with closing(sqlite3.connect(sqlite_file_uri(source, "ro"), uri=True)) as connection:
                    atomic_sqlite_backup(connection, staged)
                existing = [Path(str(destination) + suffix) for suffix in ("", "-wal", "-shm", "-journal")]
                existing = [file for file in existing if file.exists()]
                if existing:
                    archive = target / "backup" / "data-directory-migration" / uuid.uuid4().hex
                    archive.mkdir(parents=True)
                    # Preserve the old copy even if corrupt; do not require it to open.
                    for file in existing:
                        shutil.copy2(file, archive / file.name)
                    for file in existing:
                        if file != destination:
                            file.unlink()
                durable_replace(staged, destination)
            finally:
                staged.unlink(missing_ok=True)
        pointer.pop("legacyDatabaseDir", None)
        write_data_dir_pointer(pointer)
        lock.commit()
