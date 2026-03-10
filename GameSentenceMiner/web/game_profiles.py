"""
Game Profiles Module

Aggregates per-game stats (line counts, character counts, date ranges) from
rollup data and today's live game_lines, replacing the N+1 query pattern in
the games management API.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Dict, Optional

from GameSentenceMiner.util.config.configuration import logger


@dataclass(frozen=True)
class GameProfile:
    """Aggregated stats for a single game used by the games list API."""
    line_count: int = 0
    character_count: int = 0
    start_date: Optional[float] = None
    last_played: Optional[float] = None


def _date_str_to_timestamp(date_str: str) -> float:
    """Convert a 'YYYY-MM-DD' date string to a midnight UTC timestamp."""
    return datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp()


def aggregate_game_profiles_from_rollups() -> Dict[str, GameProfile]:
    """
    Query all StatsRollupTable rows, parse game_activity_data JSON from each,
    and aggregate per-game totals (lines, chars) and date ranges.
    """
    from GameSentenceMiner.util.database.stats_rollup_table import StatsRollupTable

    rollups = StatsRollupTable.all()
    return _aggregate_profiles_from_rollup_rows(rollups)


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
        lp = _date_str_to_timestamp(latest[gid]) if gid in latest else None
        result[gid] = GameProfile(
            line_count=lines_acc.get(gid, 0),
            character_count=chars_acc.get(gid, 0),
            start_date=sd,
            last_played=lp,
        )
    return result


def compute_today_game_profiles() -> Dict[str, GameProfile]:
    """
    Query GameLinesTable for un-rolled-up rows (from the day after the last
    rollup through now). If no rollups exist, queries all lines.
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

    lines = GameLinesTable.get_lines_filtered_by_timestamp(start=start_ts)
    return _compute_profiles_from_lines(lines)


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


def build_game_profiles() -> Dict[str, GameProfile]:
    """Convenience: aggregate rollups + today, merge, return."""
    return merge_game_profiles(
        aggregate_game_profiles_from_rollups(),
        compute_today_game_profiles(),
    )
