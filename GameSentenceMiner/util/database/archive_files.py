"""Durable, portable ZIP copies of the original rows removed by game archiving."""

# Archive dates use the same local calendar as GSM's rollups.
# ruff: noqa: DTZ006

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import time
import uuid
import zlib
from datetime import datetime
from pathlib import Path
from zipfile import ZIP_DEFLATED, BadZipFile, ZipFile

from GameSentenceMiner.util.database.db import GameLinesTable
from GameSentenceMiner.util.database.games_table import GamesTable
from GameSentenceMiner.util.database.sqlite_core import durable_replace

FORMAT = "gsm-game-archive"
SUFFIX = ".gsm-archive.zip"


def archive_directory():
    path = GameLinesTable._db.db_path
    if path == ":memory:":
        raise ValueError("An archive directory must be configured for an in-memory database")
    return Path(path).resolve().parent / "archives" / "games"


def _file_id(game_id):
    return hashlib.sha256(game_id.encode("utf-8")).hexdigest()


def archive_file_by_id(file_id):
    if not isinstance(file_id, str) or not re.fullmatch(r"[a-f0-9]{64}", file_id):
        raise ValueError("Invalid archive file ID")
    directory = archive_directory().resolve()
    paths = list(directory.glob(f"*--{file_id}{SUFFIX}"))
    if not paths:
        raise FileNotFoundError("No saved archive file was found")
    if len(paths) != 1 or paths[0].resolve().parent != directory or not paths[0].is_file():
        raise ValueError("Archive file must be a single file inside the archive folder")
    return paths[0]


def archive_file_path(game_id):
    return archive_file_by_id(_file_id(game_id))


def _json_default(value):
    if isinstance(value, bytes):
        return {"$binary": base64.b64encode(value).decode("ascii")}
    raise TypeError(f"Unsupported archive value: {type(value).__name__}")


def _decode_value(value):
    if isinstance(value, dict) and set(value) == {"$binary"}:
        return base64.b64decode(value["$binary"], validate=True)
    return value


def _manifest(path):
    try:
        with ZipFile(path) as archive:
            data = json.loads(archive.read("manifest.json"))
        if not isinstance(data, dict) or data.get("format") != FORMAT or data.get("version") != 1:
            raise ValueError("Unsupported archive file format")
        if (
            not isinstance(data.get("game_id"), str)
            or not data["game_id"]
            or not isinstance(data.get("line_count"), int)
            or data["line_count"] < 0
            or not isinstance(data.get("game_name"), str)
            or not isinstance(data.get("game"), dict)
            or data["game"].get("id") != data["game_id"]
        ):
            raise ValueError("Invalid archive file metadata")
        return data
    except (BadZipFile, KeyError, json.JSONDecodeError, UnicodeError) as exc:
        raise ValueError("Unable to read the archive file. The file may be damaged.") from exc


def _records(path):
    try:
        with ZipFile(path) as archive, archive.open("game_lines.jsonl") as stream:
            for encoded in stream:
                record = json.loads(encoded)
                if not isinstance(record, dict) or not isinstance(record.get("line"), dict):
                    raise TypeError("Invalid sentence in archive file")
                row = record.get("line", {})
                if (
                    not isinstance(row.get("id"), str)
                    or not row["id"]
                    or "line_text" not in row
                    or (row["line_text"] is not None and not isinstance(row["line_text"], str))
                ):
                    raise ValueError("Invalid sentence in archive file")
                float(row["timestamp"])
                yield record
    except (BadZipFile, KeyError, json.JSONDecodeError, UnicodeError, TypeError) as exc:
        raise ValueError("Unable to read sentences from the archive file") from exc


def list_archive_files():
    result = []
    for path in archive_directory().glob(f"*{SUFFIX}"):
        file_id = path.name.removesuffix(SUFFIX).rsplit("--", 1)[-1]
        try:
            archive_file_by_id(file_id)
            stat = path.stat()
            item = {
                "file_id": file_id,
                "filename": path.name,
                "size_bytes": stat.st_size,
                "updated_at": stat.st_mtime,
            }
            try:
                manifest = _manifest(path)
                if _file_id(manifest["game_id"]) != file_id:
                    raise ValueError("Archive file identity does not match its filename")
                item.update(
                    game_id=manifest["game_id"],
                    game_name=manifest["game_name"],
                    line_count=manifest["line_count"],
                    can_restore=True,
                )
            except (ValueError, KeyError) as exc:
                item.update(game_name=path.name, line_count=None, can_restore=False, error=str(exc))
            result.append(item)
        except (OSError, ValueError):
            # Files outside the managed naming/path convention are not actionable through the UI.
            continue
    return sorted(result, key=lambda item: item["updated_at"], reverse=True)


def write_archive_file(conn, game):
    """Publish and verify a complete copy before the enclosing DB transaction deletes rows."""
    directory = archive_directory()
    directory.mkdir(parents=True, exist_ok=True)
    try:
        destination = archive_file_path(game.id)
    except FileNotFoundError:
        title = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", game.title_original or "game").strip(" .")[:60]
        destination = directory / f"game-{title}--{_file_id(game.id)}{SUFFIX}"
    temporary = destination.with_name(f".{destination.name}.{uuid.uuid4().hex}.tmp")
    current_ids = {row[0] for row in conn.execute("SELECT id FROM game_lines WHERE game_id=?", (game.id,))}
    db = GameLinesTable._db
    have_tokens = all(db.table_exists(table) for table in ("words", "word_occurrences", "kanji", "kanji_occurrences"))
    count = 0
    try:
        with ZipFile(temporary, "w", compression=ZIP_DEFLATED, compresslevel=6, allowZip64=True) as output:
            with output.open("game_lines.jsonl", "w", force_zip64=True) as stream:
                if destination.exists():
                    manifest = _manifest(destination)
                    if manifest["game_id"] != game.id:
                        raise ValueError("Archive file belongs to a different game")
                    seen = set()
                    for record in _records(destination):
                        line_id = record["line"]["id"]
                        if line_id in seen:
                            raise ValueError("Duplicate sentence IDs in archive file")
                        seen.add(line_id)
                        if line_id not in current_ids:
                            stream.write(
                                (json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n").encode()
                            )
                            count += 1
                    if len(seen) != manifest["line_count"]:
                        raise ValueError("Archive file sentence count does not match its metadata")
                cursor = conn.execute("SELECT * FROM game_lines WHERE game_id=? ORDER BY id", (game.id,))
                columns = [column[0] for column in cursor.description]
                for values in cursor:
                    row = dict(zip(columns, values))
                    words, kanji = [], []
                    if have_tokens:
                        words = conn.execute(
                            """SELECT w.word, w.reading, w.pos, w.in_anki FROM word_occurrences wo
                            JOIN words w ON w.id=wo.word_id WHERE wo.line_id=?""",
                            (row["id"],),
                        ).fetchall()
                        kanji = [
                            r[0]
                            for r in conn.execute(
                                """SELECT k.character FROM kanji_occurrences ko JOIN kanji k ON k.id=ko.kanji_id
                            WHERE ko.line_id=?""",
                                (row["id"],),
                            )
                        ]
                    record = {
                        "line": row,
                        "words": words,
                        "kanji": kanji,
                        "tokens_available": bool(have_tokens and row.get("tokenized")),
                    }
                    stream.write(
                        (
                            json.dumps(record, ensure_ascii=False, default=_json_default, separators=(",", ":")) + "\n"
                        ).encode()
                    )
                    count += 1
            cursor = conn.execute("SELECT * FROM games WHERE id=?", (game.id,))
            metadata = dict(zip([column[0] for column in cursor.description], cursor.fetchone()))
            manifest = {
                "format": FORMAT,
                "version": 1,
                "game_id": game.id,
                "game_name": game.title_original or game.id,
                "game": metadata,
                "line_count": count,
                "updated_at": time.time(),
            }
            output.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, default=_json_default))
        with ZipFile(temporary) as verified:
            if verified.testzip() is not None:
                raise ValueError("Archive file verification failed. Original sentences were kept.")
        with temporary.open("r+b") as handle:
            os.fsync(handle.fileno())
        durable_replace(temporary, destination)
        return {
            "file_id": _file_id(game.id),
            "filename": destination.name,
            "line_count": count,
            "size_bytes": destination.stat().st_size,
        }
    finally:
        temporary.unlink(missing_ok=True)


def delete_archive_file(game_id):
    """Delete only the external copy; database rollups remain untouched."""
    archive_file_path(game_id).unlink()


def delete_archive_file_by_id(file_id):
    path = archive_file_by_id(file_id)
    path.unlink()
    return {"filename": path.name}


def restore_archive_file_by_id(file_id):
    metadata = _manifest(archive_file_by_id(file_id))
    if _file_id(metadata["game_id"]) != file_id:
        raise ValueError("Archive file identity does not match its filename")
    return restore_archive_file(metadata["game_id"])


def _insert_row(conn, table, row):
    columns = {r[1] for r in conn.execute(f'PRAGMA table_info("{table}")')}
    unknown = set(row) - columns - {"tokenized"}
    if unknown:
        raise ValueError("Archive file contains unsupported columns; update GSM before restoring it")
    fields = [name for name in row if name in columns]
    quoted = ",".join('"' + name.replace('"', '""') + '"' for name in fields)
    placeholders = ",".join("?" for _ in fields)
    conn.execute(
        f'INSERT INTO "{table}" ({quoted}) VALUES ({placeholders})', tuple(_decode_value(row[name]) for name in fields)
    )


def _restore_tokens(conn, record, touched_words):
    row = record["line"]
    for word, reading, pos, in_anki in record.get("words", []):
        conn.execute(
            "INSERT OR IGNORE INTO words(word,reading,pos,in_anki) VALUES (?,?,?,?)", (word, reading, pos, in_anki)
        )
        word_id = conn.execute("SELECT id FROM words WHERE word=?", (word,)).fetchone()[0]
        conn.execute("INSERT OR IGNORE INTO word_occurrences(word_id,line_id) VALUES (?,?)", (word_id, row["id"]))
        conn.execute(
            "UPDATE words SET last_seen=MAX(COALESCE(CAST(last_seen AS REAL),0),?) WHERE id=?",
            (float(row["timestamp"]), word_id),
        )
        touched_words.add(word_id)
    for character in record.get("kanji", []):
        conn.execute("INSERT OR IGNORE INTO kanji(character) VALUES (?)", (character,))
        kanji_id = conn.execute("SELECT id FROM kanji WHERE character=?", (character,)).fetchone()[0]
        conn.execute("INSERT OR IGNORE INTO kanji_occurrences(kanji_id,line_id) VALUES (?,?)", (kanji_id, row["id"]))


def restore_archive_file(game_id):
    """Restore raw rows and replace the corresponding rollups without double counting."""
    from GameSentenceMiner.util.config.feature_flags import is_tokenization_enabled
    from GameSentenceMiner.util.cron.daily_rollup import replace_rollup_for_date
    from GameSentenceMiner.util.database.game_archive import ensure_archive_schema
    from GameSentenceMiner.util.database.tokenization_tables import recompute_word_first_seen_metadata
    from GameSentenceMiner.web.game_profiles import invalidate_game_profiles_cache

    db = GameLinesTable._db
    path = archive_file_path(game_id)
    manifest = _manifest(path)
    if manifest["game_id"] != game_id:
        raise ValueError("Archive file belongs to a different game")
    ids, has_tokens = set(), False
    for record in _records(path):
        if record["line"]["id"] in ids:
            raise ValueError("Duplicate sentence IDs in archive file")
        ids.add(record["line"]["id"])
        has_tokens |= bool(record.get("tokens_available") or record.get("words") or record.get("kanji"))
    if len(ids) != manifest["line_count"]:
        raise ValueError("Archive file sentence count does not match its metadata")
    if has_tokens and not is_tokenization_enabled():
        raise ValueError("Enable tokenization before restoring this archive to preserve its saved vocabulary")
    ensure_archive_schema(db)

    def restore(conn):
        affected, owner_by_id, touched_words = [], {}, set()
        for gid, date, blob in conn.execute("SELECT game_id,date,events FROM archived_game_days"):
            event_ids = {event[6] for event in json.loads(zlib.decompress(blob))}
            overlap = ids & event_ids
            if not overlap:
                continue
            if overlap != event_ids:
                raise ValueError(
                    "This file contains only part of an archived day, possibly because an earlier file was deleted "
                    "or games were merged. Download the ZIP to recover its text; automatic restore would double-count statistics."
                )
            affected.append((gid, date))
            owner_by_id.update((line_id, gid) for line_id in overlap)
        dates = {date for _, date in affected}
        restored, skipped = 0, 0
        for record in _records(path):
            row = record["line"]
            existing = conn.execute("SELECT game_id FROM game_lines WHERE id=?", (row["id"],)).fetchone()
            if existing:
                if row["id"] in owner_by_id:
                    raise ValueError("A sentence exists in both live and archived history; restore was cancelled")
                skipped += 1
                continue
            gid = owner_by_id.get(row["id"], game_id)
            if not conn.execute("SELECT 1 FROM games WHERE id=?", (gid,)).fetchone():
                if gid != game_id:
                    raise ValueError("The game owning these archived sentences no longer exists")
                _insert_row(conn, "games", manifest["game"])
            if gid != row.get("game_id"):
                row["original_game_name"] = row.get("original_game_name") or row.get("game_name")
                row["game_name"] = conn.execute(
                    "SELECT COALESCE(NULLIF(obs_scene_name,''),title_original) FROM games WHERE id=?", (gid,)
                ).fetchone()[0]
            row["game_id"] = gid
            if "tokenized" in row:
                row["tokenized"] = int(bool(record.get("tokens_available")))
            _insert_row(conn, "game_lines", row)
            if has_tokens:
                _restore_tokens(conn, record, touched_words)
            dates.add(datetime.fromtimestamp(float(row["timestamp"])).date().isoformat())
            restored += 1
        for gid, date in affected:
            conn.execute("DELETE FROM archived_game_days WHERE game_id=? AND date=?", (gid, date))
            conn.execute("DELETE FROM archived_word_stats WHERE game_id=? AND date=?", (gid, date))
        if touched_words:
            recompute_word_first_seen_metadata(db, list(touched_words))
        for date in sorted(dates):
            replace_rollup_for_date(date)
        return {"restored_lines": restored, "skipped_lines": skipped}

    result = db.run_transaction(restore)
    GamesTable.clear_name_id_cache()
    invalidate_game_profiles_cache()
    return result
