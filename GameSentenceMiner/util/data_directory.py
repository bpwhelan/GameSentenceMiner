"""Dependency-free data location bootstrap, shared by config, logging and databases.

Keep this contract in sync with electron-src/main/data_dir.ts and build/data-directory.ps1.
Only the small pointer belongs in ~/.config/GameSentenceMiner on Windows; bulk data
continues to use AppData by default. GSM_DATA_DIR overrides the pointer for child processes.
"""

import json
import os
import sys
import uuid
from pathlib import Path


def get_default_app_directory() -> str:
    root = os.environ.get("APPDATA") if sys.platform == "win32" else None
    return str(Path(root) / "GameSentenceMiner" if root else Path.home() / ".config" / "GameSentenceMiner")


def get_pointer_path() -> Path:
    return Path.home() / ".config" / "GameSentenceMiner" / "data_dir.json"


def _normalize_directory(value) -> str:
    value = os.path.expanduser(value.strip()) if isinstance(value, str) else ""
    if not value or not os.path.isabs(value) or "\0" in value:
        raise ValueError("dataDir must be an absolute folder path")
    return os.path.normpath(value)


def _read_pointer(pointer: Path) -> dict | None:
    try:
        data = json.loads(pointer.read_text(encoding="utf-8-sig"))
        if not isinstance(data, dict):
            raise TypeError("expected a JSON object")
        return {**data, "dataDir": _normalize_directory(data.get("dataDir"))}
    except FileNotFoundError:
        return None
    except (OSError, ValueError, TypeError) as error:
        raise ValueError(f"Cannot read GSM data location from {pointer}: {error}") from error


def write_data_dir_pointer(data: dict, *, only_if_missing: bool = False) -> None:
    pointer = get_pointer_path()
    pointer.parent.mkdir(parents=True, exist_ok=True)
    temporary = pointer.with_name(f"{pointer.name}.{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("x", encoding="utf-8") as handle:
            json.dump(data, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        if only_if_missing:
            try:
                os.link(temporary, pointer)
            except FileExistsError:
                pass
        else:
            os.replace(temporary, pointer)
    finally:
        temporary.unlink(missing_ok=True)


def read_data_dir_pointer() -> dict | None:
    pointer = get_pointer_path()
    legacy = Path(get_default_app_directory()) / "data_dir.json"
    data = _read_pointer(pointer)
    if data and (pointer != legacy or data.get("version") == 2):
        return data
    if data is None:
        try:
            data = _read_pointer(legacy)
        except ValueError:
            # Historical behavior for invalid legacy pointers; stable files fail closed.
            return None
    if data is None:
        return None
    migrated = {**data, "version": 2}
    if os.path.normcase(data["dataDir"]) != os.path.normcase(get_default_app_directory()):
        migrated["legacyDatabaseDir"] = get_default_app_directory()
    write_data_dir_pointer(migrated, only_if_missing=pointer != legacy)
    return _read_pointer(pointer)


def resolve_data_directory() -> str:
    override = os.environ.get("GSM_DATA_DIR", "").strip()
    if override:
        return _normalize_directory(override)
    pointer = read_data_dir_pointer()
    return pointer["dataDir"] if pointer else get_default_app_directory()


def get_app_directory() -> str:
    directory = resolve_data_directory()
    Path(directory).mkdir(parents=True, exist_ok=True)
    return directory
