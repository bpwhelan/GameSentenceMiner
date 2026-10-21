"""Import Kizuna session exports as game-linked external reading activity."""

from __future__ import annotations

import csv
import hashlib
import io
import json
import math
import re
from datetime import datetime

from GameSentenceMiner.util.database.games_table import GamesTable
from GameSentenceMiner.util.database.third_party_stats_table import ThirdPartyStatsTable


def parse_kizuna_csv(content: str) -> list[dict]:
    """Validate the entire export before any existing data is changed."""
    reader = csv.DictReader(io.StringIO(content, newline=""), strict=True)
    required = {"vndb_id", "name", "date", "duration_seconds", "chars", "lines"}
    headers = [header.strip() for header in reader.fieldnames or []]
    missing = required - set(headers)
    if missing:
        raise ValueError(f"Invalid Kizuna CSV. Missing required columns: {', '.join(sorted(missing))}")
    if len(headers) != len(set(headers)):
        raise ValueError("Invalid Kizuna CSV: duplicate column names")
    reader.fieldnames = headers
    entries = []
    for row_number, row in enumerate(reader, start=2):
        try:
            if None in row or any(row[column] is None for column in required):
                raise ValueError("incorrect number of columns")
            name = row["name"].strip()
            vndb_id = row["vndb_id"].strip().lower()
            if not name:
                raise ValueError("game name is required")
            if vndb_id and not re.fullmatch(r"v[1-9][0-9]*", vndb_id):
                raise ValueError("vndb_id must be a VNDB ID such as v58562, or empty")
            timestamp = datetime.fromisoformat(row["date"].strip().replace("Z", "+00:00")).timestamp()
            date = datetime.fromtimestamp(timestamp).astimezone().date().isoformat()
            seconds = float(row["duration_seconds"])
            chars = int(row["chars"])
            lines = int(row["lines"])
            if not math.isfinite(seconds) or seconds < 0 or chars < 0 or lines < 0:
                raise ValueError("duration_seconds, chars and lines must be finite, non-negative numbers")
            if chars > 2**63 - 1 or lines > 2**63 - 1:
                raise ValueError("chars and lines are too large")
            if not (seconds or chars or lines):
                continue
            identity = json.dumps([vndb_id or name, timestamp, seconds, chars, lines], ensure_ascii=False)
            entries.append(
                {
                    "name": name,
                    "vndb_id": vndb_id,
                    "timestamp": timestamp,
                    "date": date,
                    "characters_read": chars,
                    "time_read_seconds": seconds,
                    "lines_read": lines,
                    "source_id": hashlib.sha256(identity.encode("utf-8")).hexdigest(),
                }
            )
        except (ValueError, OverflowError, OSError) as error:
            raise ValueError(f"Row {row_number}: {error}") from error
    if not entries:
        raise ValueError("No reading sessions found in the Kizuna CSV")
    return entries


def _find_or_create_game(entry: dict) -> GamesTable:
    name, vndb_id = entry["name"], entry["vndb_id"]
    game = None
    if vndb_id:
        row = GamesTable._db.fetchone("SELECT * FROM games WHERE LOWER(vndb_id) = ?", (vndb_id,))
        game = GamesTable.from_row(row) if row else None
    if game is None:
        # Exact names can link an unlinked game. Conflicting VNDB IDs stay separate.
        candidates = GamesTable._db.fetchall(
            "SELECT * FROM games WHERE title_original = ? OR title_romaji = ? OR title_english = ? OR obs_scene_name = ?",
            (name, name, name, name),
        )
        for row in candidates:
            candidate = GamesTable.from_row(row)
            if not vndb_id or not candidate.vndb_id or candidate.vndb_id.lower() == vndb_id:
                game = candidate
                break
    if game is None:
        game = GamesTable(
            title_original=name, game_type="Visual Novel" if vndb_id else "", obs_scene_name=name, vndb_id=vndb_id
        )
        game.save()
    elif vndb_id and not game.vndb_id:
        game.vndb_id = vndb_id
        game.save()
    return game


def import_kizuna_sessions(entries: list[dict], *, clear_previous: bool = False) -> dict:
    """Atomically save games and sessions; repeated exports skip existing sessions."""

    def save_import(_connection):
        cleared = ThirdPartyStatsTable.delete_by_source("kizuna") if clear_previous else 0
        existing = {
            row[0]
            for row in ThirdPartyStatsTable._db.fetchall(
                "SELECT source_id FROM third_party_stats WHERE source = 'kizuna'"
            )
        }
        imported = []
        games = {}
        skipped = 0
        for entry in entries:
            if entry["source_id"] in existing:
                skipped += 1
                continue
            key = entry["vndb_id"] or entry["name"]
            if key not in games:
                games[key] = _find_or_create_game(entry)
            ThirdPartyStatsTable(
                date=entry["date"],
                characters_read=entry["characters_read"],
                time_read_seconds=entry["time_read_seconds"],
                source="kizuna",
                label=entry["name"],
                game_id=games[key].id,
                lines_read=entry["lines_read"],
                source_id=entry["source_id"],
                timestamp=entry["timestamp"],
            ).save()
            existing.add(entry["source_id"])
            imported.append(entry)
        dates = [entry["date"] for entry in imported]
        return {
            "imported_count": len(imported),
            "skipped_count": skipped,
            "cleared_count": cleared,
            "games_count": len({game.id for game in games.values()}),
            "games": sorted({game.title_original for game in games.values()}),
            "total_characters": sum(entry["characters_read"] for entry in imported),
            "total_lines": sum(entry["lines_read"] for entry in imported),
            "total_time_seconds": sum(entry["time_read_seconds"] for entry in imported),
            "date_range": {"min": min(dates) if dates else None, "max": max(dates) if dates else None},
            "vndb_games_count": len({game.id for game in games.values() if game.vndb_id}),
        }

    result = ThirdPartyStatsTable._db.run_transaction(save_import)
    ThirdPartyStatsTable.invalidate_profiles()
    return result
