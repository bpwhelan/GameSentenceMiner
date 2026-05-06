"""
Game Profiles Module

Aggregates per-game stats (line counts, character counts, date ranges) from
rollup data and today's live game_lines, replacing the N+1 query pattern in
the games management API.
"""

from __future__ import annotations

import json
import time as _time
from dataclasses import dataclass
from datetime import datetime
from typing import Dict, Optional

from GameSentenceMiner.util.config.configuration import logger


@dataclass(frozen=True)
class GameProfile:
    """Aggregated stats for a single game used by the games list API."""

    line_count: int = 0
    character_count: int = 0
    start_date: Optional[float] = None
    last_played: Optional[float] = None


def _date_str_to_timestamp(date_str: str, *, end_of_day: bool = False) -> float:
    """Convert a 'YYYY-MM-DD' date string using local time semantics."""
    parsed = datetime.strptime(date_str, "%Y-%m-%d")
    if end_of_day:
        parsed = parsed.replace(hour=23, minute=59, second=59, microsecond=999999)
    return parsed.timestamp()


def aggregate_game_profiles_from_rollups() -> Dict[str, GameProfile]:
    """
    Query only ``date`` and ``game_activity_data`` from the rollup table
    (instead of ``SELECT *``) and aggregate per-game totals.
    """
    from GameSentenceMiner.util.database.stats_rollup_table import StatsRollupTable

    rows = StatsRollupTable._db.fetchall(f"SELECT date, game_activity_data FROM {StatsRollupTable._table}")
    return _aggregate_profiles_from_raw_rows(rows)


def _aggregate_profiles_from_raw_rows(rows) -> Dict[str, GameProfile]:
    """Pure logic: aggregate (date, game_activity_data) tuples into GameProfiles."""
    lines_acc: Dict[str, int] = {}
    chars_acc: Dict[str, int] = {}
    earliest: Dict[str, str] = {}
    latest: Dict[str, str] = {}

    for row in rows:
        row_date, raw = row[0], row[1]
        if not raw:
            continue
        try:
            game_data = json.loads(raw) if isinstance(raw, str) else raw
        except (json.JSONDecodeError, TypeError):
            logger.warning(f"Skipping malformed game_activity_data for rollup date {row_date}")
            continue

        if not isinstance(game_data, dict):
            continue

        for game_id, activity in game_data.items():
            if not isinstance(activity, dict):
                continue
            lines_acc[game_id] = lines_acc.get(game_id, 0) + activity.get("lines", 0)
            chars_acc[game_id] = chars_acc.get(game_id, 0) + activity.get("chars", 0)
            if game_id not in earliest or row_date < earliest[game_id]:
                earliest[game_id] = row_date
            if game_id not in latest or row_date > latest[game_id]:
                latest[game_id] = row_date

    result: Dict[str, GameProfile] = {}
    all_ids = set(lines_acc) | set(chars_acc)
    for gid in all_ids:
        sd = _date_str_to_timestamp(earliest[gid]) if gid in earliest else None
        lp = _date_str_to_timestamp(latest[gid], end_of_day=True) if gid in latest else None
        result[gid] = GameProfile(
            line_count=lines_acc.get(gid, 0),
            character_count=chars_acc.get(gid, 0),
            start_date=sd,
            last_played=lp,
        )
    return result


def _aggregate_profiles_from_rollup_rows(rollups) -> Dict[str, GameProfile]:
    """Pure logic: aggregate a list of rollup row objects into GameProfiles."""
    lines_acc: Dict[str, int] = {}
    chars_acc: Dict[str, int] = {}
    earliest: Dict[str, str] = {}
    latest: Dict[str, str] = {}

    for rollup in rollups:
        raw = rollup.game_activity_data
        if not raw:
            continue
        try:
            game_data = json.loads(raw) if isinstance(raw, str) else raw
        except (json.JSONDecodeError, TypeError):
            logger.warning(f"Skipping malformed game_activity_data for rollup date {rollup.date}")
            continue

        if not isinstance(game_data, dict):
            continue

        row_date = rollup.date
        for game_id, activity in game_data.items():
            if not isinstance(activity, dict):
                continue
            lines_acc[game_id] = lines_acc.get(game_id, 0) + activity.get("lines", 0)
            chars_acc[game_id] = chars_acc.get(game_id, 0) + activity.get("chars", 0)
            if game_id not in earliest or row_date < earliest[game_id]:
                earliest[game_id] = row_date
            if game_id not in latest or row_date > latest[game_id]:
                latest[game_id] = row_date

    result: Dict[str, GameProfile] = {}
    all_ids = set(lines_acc) | set(chars_acc)
    for gid in all_ids:
        sd = _date_str_to_timestamp(earliest[gid]) if gid in earliest else None
        lp = _date_str_to_timestamp(latest[gid], end_of_day=True) if gid in latest else None
        result[gid] = GameProfile(
            line_count=lines_acc.get(gid, 0),
            character_count=chars_acc.get(gid, 0),
            start_date=sd,
            last_played=lp,
        )
    return result


def compute_today_game_profiles() -> Dict[str, GameProfile]:
    """
    Aggregate per-game stats from game_lines for un-rolled-up rows (from the
    day after the last rollup through now).

    Uses a SQL ``GROUP BY`` with aggregate functions so that SQLite does the
    heavy lifting instead of fetching every row into Python.
    """
    from GameSentenceMiner.util.database.db import GameLinesTable
    from GameSentenceMiner.util.database.stats_rollup_table import StatsRollupTable

    last_date = StatsRollupTable.get_last_date()
    if last_date:
        # Start from midnight of the day after the last rollup
        day_after = datetime.strptime(last_date, "%Y-%m-%d")
        day_after = day_after.replace(hour=0, minute=0, second=0, microsecond=0)
        from datetime import timedelta

        start_ts = (day_after + timedelta(days=1)).timestamp()
    else:
        start_ts = None  # no rollups — include all lines

    # Use SQL aggregation: returns one row per game_id instead of every line.
    query = (
        f"SELECT game_id, COUNT(*), SUM(LENGTH(line_text)), "
        f"MIN(timestamp), MAX(timestamp) "
        f"FROM {GameLinesTable._table} "
        f"WHERE game_id IS NOT NULL AND game_id != ''"
    )
    params: list = []
    if start_ts is not None:
        query += " AND timestamp >= ?"
        params.append(start_ts)
    query += " GROUP BY game_id"

    rows = GameLinesTable._db.fetchall(query, tuple(params))
    return _compute_profiles_from_aggregate_rows(rows)


def _compute_profiles_from_aggregate_rows(rows) -> Dict[str, GameProfile]:
    """Pure logic: build GameProfiles from pre-aggregated SQL rows.

    Each row is expected to be:
        (game_id, line_count, total_chars, min_timestamp, max_timestamp)
    """
    result: Dict[str, GameProfile] = {}
    for row in rows:
        gid = row[0]
        if not gid:
            continue
        result[gid] = GameProfile(
            line_count=row[1] or 0,
            character_count=row[2] or 0,
            start_date=float(row[3]) if row[3] is not None else None,
            last_played=float(row[4]) if row[4] is not None else None,
        )
    return result


def load_game_timestamp_profiles() -> Dict[str, GameProfile]:
    """Load exact per-game start/end timestamps from raw line data."""
    from GameSentenceMiner.util.database.db import GameLinesTable

    rows = GameLinesTable._db.fetchall(
        f"""
        SELECT game_id, MIN(timestamp), MAX(timestamp)
        FROM {GameLinesTable._table}
        WHERE game_id IS NOT NULL AND game_id != ''
        GROUP BY game_id
        """
    )

    result: Dict[str, GameProfile] = {}
    for row in rows:
        gid = row[0]
        if not gid:
            continue
        result[gid] = GameProfile(
            start_date=float(row[1]) if row[1] is not None else None,
            last_played=float(row[2]) if row[2] is not None else None,
        )
    return result


def _compute_profiles_from_raw_rows(rows) -> Dict[str, GameProfile]:
    """Pure logic: compute per-game profiles from (game_id, line_text, timestamp) tuples."""
    lines_acc: Dict[str, int] = {}
    chars_acc: Dict[str, int] = {}
    min_ts: Dict[str, float] = {}
    max_ts: Dict[str, float] = {}

    for row in rows:
        gid, text, ts = row[0], row[1], row[2]
        if not gid:
            continue
        text_len = len(text) if text else 0
        lines_acc[gid] = lines_acc.get(gid, 0) + 1
        chars_acc[gid] = chars_acc.get(gid, 0) + text_len
        if ts is not None:
            ts_f = float(ts)
            if gid not in min_ts or ts_f < min_ts[gid]:
                min_ts[gid] = ts_f
            if gid not in max_ts or ts_f > max_ts[gid]:
                max_ts[gid] = ts_f

    return {
        gid: GameProfile(
            line_count=lines_acc[gid],
            character_count=chars_acc[gid],
            start_date=min_ts.get(gid),
            last_played=max_ts.get(gid),
        )
        for gid in lines_acc
    }


def _compute_profiles_from_lines(lines) -> Dict[str, GameProfile]:
    """Pure logic: compute per-game profiles from a list of GameLinesTable rows."""
    lines_acc: Dict[str, int] = {}
    chars_acc: Dict[str, int] = {}
    min_ts: Dict[str, float] = {}
    max_ts: Dict[str, float] = {}

    for line in lines:
        gid = line.game_id
        if not gid:
            continue
        text_len = len(line.line_text) if line.line_text else 0
        lines_acc[gid] = lines_acc.get(gid, 0) + 1
        chars_acc[gid] = chars_acc.get(gid, 0) + text_len
        ts = line.timestamp
        if gid not in min_ts or ts < min_ts[gid]:
            min_ts[gid] = ts
        if gid not in max_ts or ts > max_ts[gid]:
            max_ts[gid] = ts

    return {
        gid: GameProfile(
            line_count=lines_acc[gid],
            character_count=chars_acc[gid],
            start_date=min_ts.get(gid),
            last_played=max_ts.get(gid),
        )
        for gid in lines_acc
    }


def _min_optional(a: Optional[float], b: Optional[float]) -> Optional[float]:
    if a is None:
        return b
    if b is None:
        return a
    return min(a, b)


def _max_optional(a: Optional[float], b: Optional[float]) -> Optional[float]:
    if a is None:
        return b
    if b is None:
        return a
    return max(a, b)


def merge_game_profiles(
    rollup: Dict[str, GameProfile],
    live: Dict[str, GameProfile],
) -> Dict[str, GameProfile]:
    """
    Merge rollup profiles with today's live profiles.
    - line_count and character_count: additive
    - start_date: min of both (earlier)
    - last_played: max of both (later)
    - Games in only one source pass through unchanged.
    """
    result: Dict[str, GameProfile] = {}
    all_ids = set(rollup) | set(live)
    for gid in all_ids:
        r = rollup.get(gid, GameProfile())
        l = live.get(gid, GameProfile())
        result[gid] = GameProfile(
            line_count=r.line_count + l.line_count,
            character_count=r.character_count + l.character_count,
            start_date=_min_optional(r.start_date, l.start_date),
            last_played=_max_optional(r.last_played, l.last_played),
        )
    return result


def merge_game_profile_timestamps(
    profiles: Dict[str, GameProfile],
    timestamp_profiles: Dict[str, GameProfile],
) -> Dict[str, GameProfile]:
    """Overlay exact timestamp bounds onto existing per-game aggregates."""
    result: Dict[str, GameProfile] = {}
    all_ids = set(profiles) | set(timestamp_profiles)
    for gid in all_ids:
        profile = profiles.get(gid, GameProfile())
        timestamps = timestamp_profiles.get(gid)
        result[gid] = GameProfile(
            line_count=profile.line_count,
            character_count=profile.character_count,
            start_date=(
                timestamps.start_date if timestamps and timestamps.start_date is not None else profile.start_date
            ),
            last_played=(
                timestamps.last_played if timestamps and timestamps.last_played is not None else profile.last_played
            ),
        )
    return result


# Simple TTL cache for build_game_profiles (avoids recomputation on rapid reloads)
_profiles_cache: Dict[str, GameProfile] | None = None
_profiles_cache_ts: float = 0.0
_PROFILES_CACHE_TTL: float = 30.0  # seconds

import os as _os

_TESTING = _os.environ.get("GAME_SENTENCE_MINER_TESTING") == "1"


def invalidate_game_profiles_cache() -> None:
    """Clear the in-process games-management profile cache."""
    global _profiles_cache, _profiles_cache_ts
    _profiles_cache = None
    _profiles_cache_ts = 0.0


def build_game_profiles() -> Dict[str, GameProfile]:
    """Convenience: aggregate rollups + today, merge, return.

    Results are cached for up to 30 seconds to avoid redundant DB work on
    rapid reloads / multiple concurrent requests.  Caching is disabled in
    test mode to prevent cross-test pollution.
    """
    global _profiles_cache, _profiles_cache_ts

    if not _TESTING:
        now = _time.monotonic()
        if _profiles_cache is not None and (now - _profiles_cache_ts) < _PROFILES_CACHE_TTL:
            return _profiles_cache

    result = merge_game_profile_timestamps(
        merge_game_profiles(
            aggregate_game_profiles_from_rollups(),
            compute_today_game_profiles(),
        ),
        load_game_timestamp_profiles(),
    )

    if not _TESTING:
        _profiles_cache = result
        _profiles_cache_ts = _time.monotonic()

    return result
