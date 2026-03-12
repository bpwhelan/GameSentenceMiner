from __future__ import annotations

import datetime
import json
from functools import lru_cache

from GameSentenceMiner.web.rollup_stats import (
    aggregate_rollup_data,
    calculate_live_stats_for_today,
    combine_rollup_and_live_stats,
    get_third_party_stats_by_date,
    enrich_aggregated_stats,
)
from GameSentenceMiner.web.stats import (
    calculate_actual_reading_time,
    calculate_current_game_stats,
    format_large_number,
    format_time_human_readable,
)
from GameSentenceMiner.web.stats_repository import (
    fetch_today_lines,
    get_date_range_params,
    query_stats_lines,
)
from GameSentenceMiner.util.database.games_table import GamesTable


@lru_cache(maxsize=8192)
def _json_loads_cached(raw_json: str):
    return json.loads(raw_json)


def load_stats_range_context(
    start_timestamp: float | None,
    end_timestamp: float | None,
) -> tuple[list, list, str, str, dict[str, dict]]:
    """Load the rollup/live inputs shared by the stats endpoints."""
    today = datetime.date.today()
    today_str = today.strftime("%Y-%m-%d")

    start_date_str, end_date_str = get_date_range_params(
        start_timestamp, end_timestamp, today
    )

    today_in_range = (not end_date_str) or (end_date_str >= today_str)

    rollups: list = []
    if start_date_str:
        yesterday = today - datetime.timedelta(days=1)
        yesterday_str = yesterday.strftime("%Y-%m-%d")

        if start_date_str <= yesterday_str:
            rollup_end = (
                min(end_date_str, yesterday_str) if end_date_str else yesterday_str
            )
            from GameSentenceMiner.util.database.stats_rollup_table import StatsRollupTable

            rollups = StatsRollupTable.get_date_range(start_date_str, rollup_end)

    today_lines: list = []
    if today_in_range:
        today_lines = fetch_today_lines(today)

    third_party_by_date = get_third_party_stats_by_date(start_date_str, end_date_str)
    return rollups, today_lines, start_date_str, end_date_str, third_party_by_date


def build_combined_stats(
    start_timestamp: float | None,
    end_timestamp: float | None,
    *,
    include_frequency_data: bool = True,
) -> tuple[dict, dict | None, dict | None, list, list, str, str, dict[str, dict]]:
    """Fetch rollups + today's live data and return combined stats payload."""
    rollups, today_lines, start_date_str, end_date_str, third_party_by_date = (
        load_stats_range_context(start_timestamp, end_timestamp)
    )

    rollup_stats = (
        aggregate_rollup_data(
            rollups, include_frequency_data=include_frequency_data
        )
        if rollups
        else None
    )
    live_stats = (
        calculate_live_stats_for_today(
            today_lines, include_frequency_data=include_frequency_data
        )
        if today_lines
        else None
    )

    combined_stats = combine_rollup_and_live_stats(rollup_stats, live_stats)
    enrich_aggregated_stats(combined_stats, third_party_by_date)

    return (
        combined_stats,
        rollup_stats,
        live_stats,
        rollups,
        today_lines,
        start_date_str,
        end_date_str,
        third_party_by_date,
    )


def _build_current_game_stats_from_rollups(
    current_game_line,
    current_game_name: str,
    current_game_id: str,
    today_lines: list,
    rollups: list,
) -> dict | None:
    """Build current-game stats from daily rollups plus today's live lines."""
    today = datetime.date.today()
    today_str = today.isoformat()
    game_metadata = GamesTable.get(current_game_id) or GamesTable.get_by_game_line(
        current_game_line
    )

    total_characters = 0
    total_sentences = 0
    total_time_seconds = 0.0
    daily_activity: dict[str, int] = {}

    for rollup in rollups:
        raw_activity = rollup.game_activity_data
        if not raw_activity:
            continue

        try:
            game_activity = (
                _json_loads_cached(raw_activity)
                if isinstance(raw_activity, str)
                else raw_activity
            )
        except (json.JSONDecodeError, TypeError):
            continue

        activity = game_activity.get(current_game_id)
        if not activity:
            continue

        day_chars = int(activity.get("chars", 0) or 0)
        day_lines = int(activity.get("lines", 0) or 0)
        day_time_seconds = float(activity.get("time", 0) or 0.0)

        total_characters += day_chars
        total_sentences += day_lines
        total_time_seconds += day_time_seconds

        if day_chars > 0 or day_lines > 0 or day_time_seconds > 0:
            daily_activity[rollup.date] = daily_activity.get(rollup.date, 0) + day_chars

    current_game_today_lines = [
        line for line in today_lines if getattr(line, "game_id", "") == current_game_id
    ]
    if current_game_today_lines:
        today_chars = sum(
            len(line.line_text) if line.line_text else 0
            for line in current_game_today_lines
        )
        total_characters += today_chars
        total_sentences += len(current_game_today_lines)
        daily_activity[today_str] = daily_activity.get(today_str, 0) + today_chars

        timestamps = [float(line.timestamp) for line in current_game_today_lines]
        line_texts = [line.line_text or "" for line in current_game_today_lines]
        total_time_seconds += calculate_actual_reading_time(
            timestamps, line_texts=line_texts
        )

    if total_characters <= 0 and total_sentences <= 0 and not daily_activity:
        return None

    date_keys = sorted(daily_activity.keys())
    fallback_date = datetime.date.fromtimestamp(
        float(current_game_line.timestamp)
    ).isoformat()
    first_date = date_keys[0] if date_keys else fallback_date
    last_date = date_keys[-1] if date_keys else fallback_date

    total_time_hours = total_time_seconds / 3600
    reading_speed = (
        int(total_characters / total_time_hours) if total_time_hours > 0 else 0
    )

    monthly_start = today - datetime.timedelta(days=29)
    monthly_characters = sum(
        chars
        for date_str, chars in daily_activity.items()
        if datetime.date.fromisoformat(date_str) >= monthly_start
    )

    progress_percentage = 0.0
    if (
        game_metadata
        and game_metadata.character_count
        and game_metadata.character_count > 0
    ):
        progress_percentage = min(
            100, (total_characters / game_metadata.character_count) * 100
        )

    result: dict = {
        "game_name": current_game_name,
        "total_characters": total_characters,
        "total_characters_formatted": format_large_number(total_characters),
        "total_sentences": total_sentences,
        "total_time_hours": total_time_hours,
        "total_time_formatted": format_time_human_readable(total_time_hours),
        "reading_speed": reading_speed,
        "reading_speed_formatted": format_large_number(reading_speed),
        "sessions": len(daily_activity),
        "monthly_characters": monthly_characters,
        "monthly_characters_formatted": format_large_number(monthly_characters),
        "current_streak": 0,
        "first_date": first_date,
        "last_date": last_date,
        "daily_activity": dict(daily_activity),
        "progress_percentage": round(progress_percentage, 1),
    }

    if game_metadata:
        result.update(
            {
                "game_id": game_metadata.id or "",
                "title_original": game_metadata.title_original or "",
                "title_romaji": game_metadata.title_romaji or "",
                "title_english": game_metadata.title_english or "",
                "type": game_metadata.type or "",
                "description": game_metadata.description or "",
                "image": game_metadata.image or "",
                "game_character_count": game_metadata.character_count or 0,
                "links": game_metadata.links or [],
                "completed": game_metadata.completed or False,
                "genres": game_metadata.genres or [],
                "tags": game_metadata.tags or [],
            }
        )
    else:
        result.update(
            {
                "game_id": current_game_id,
                "title_original": "",
                "title_romaji": "",
                "title_english": "",
                "type": "",
                "description": "",
                "image": "",
                "game_character_count": 0,
                "links": [],
                "completed": False,
                "genres": [],
                "tags": [],
            }
        )

    return result


def _build_current_game_stats_from_lines(
    current_game_name: str,
    start_timestamp: float | None,
    end_timestamp: float | None,
    today_start_ts: float | None = None,
) -> dict:
    """Fallback path for unlinked games that still need raw line queries."""
    if today_start_ts is not None:
        if start_timestamp and end_timestamp:
            historical_lines = query_stats_lines(
                where_clause="game_name=? AND timestamp >= ? AND timestamp < ?",
                params=(current_game_name, start_timestamp, today_start_ts),
                include_media_fields=False,
                parse_note_ids=False,
            )
        else:
            historical_lines = query_stats_lines(
                where_clause="game_name=? AND timestamp < ?",
                params=(current_game_name, today_start_ts),
                include_media_fields=False,
                parse_note_ids=False,
            )
        return historical_lines

    if start_timestamp and end_timestamp:
        return query_stats_lines(
            where_clause="game_name=? AND timestamp >= ? AND timestamp <= ?",
            params=(current_game_name, start_timestamp, end_timestamp),
            include_media_fields=False,
            parse_note_ids=False,
        )

    return query_stats_lines(
        where_clause="game_name=?",
        params=(current_game_name,),
        include_media_fields=False,
        parse_note_ids=False,
    )


def build_current_game_stats(
    today_lines: list,
    start_timestamp: float | None,
    end_timestamp: float | None,
    rollups: list | None = None,
) -> dict:
    """Find current game and compute its stats in the active time window."""
    today = datetime.date.today()
    rollups = rollups or []

    if today_lines:
        current_game_line = max(today_lines, key=lambda line: float(line.timestamp))
        current_game_name = current_game_line.game_name or "Unknown Game"
        current_game_id = getattr(current_game_line, "game_id", "") or ""

        if current_game_id:
            rollup_backed_stats = _build_current_game_stats_from_rollups(
                current_game_line=current_game_line,
                current_game_name=current_game_name,
                current_game_id=current_game_id,
                today_lines=today_lines,
                rollups=rollups,
            )
            if rollup_backed_stats is not None:
                return rollup_backed_stats

        current_game_lines = [
            line
            for line in today_lines
            if (line.game_name or "Unknown Game") == current_game_name
        ]

        today_start_ts = datetime.datetime.combine(
            today, datetime.time.min
        ).timestamp()

        current_game_lines.extend(
            _build_current_game_stats_from_lines(
                current_game_name=current_game_name,
                start_timestamp=start_timestamp,
                end_timestamp=end_timestamp,
                today_start_ts=today_start_ts,
            )
        )
        return calculate_current_game_stats(current_game_lines)

    most_recent_lines = query_stats_lines(
        where_clause="1=1",
        params=(),
        order_clause="timestamp DESC",
        limit_clause="LIMIT 1",
        include_media_fields=False,
        parse_note_ids=False,
    )
    if not most_recent_lines:
        return {}

    current_game_line = most_recent_lines[0]
    current_game_name = current_game_line.game_name or "Unknown Game"
    current_game_id = getattr(current_game_line, "game_id", "") or ""

    if current_game_id:
        rollup_backed_stats = _build_current_game_stats_from_rollups(
            current_game_line=current_game_line,
            current_game_name=current_game_name,
            current_game_id=current_game_id,
            today_lines=today_lines,
            rollups=rollups,
        )
        if rollup_backed_stats is not None:
            return rollup_backed_stats

    current_game_lines = _build_current_game_stats_from_lines(
        current_game_name=current_game_name,
        start_timestamp=start_timestamp,
        end_timestamp=end_timestamp,
    )
    return calculate_current_game_stats(current_game_lines)
