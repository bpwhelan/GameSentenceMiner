from __future__ import annotations

import datetime

from GameSentenceMiner.web.rollup_stats import (
    aggregate_rollup_data,
    calculate_live_stats_for_today,
    combine_rollup_and_live_stats,
    get_third_party_stats_by_date,
    enrich_aggregated_stats,
)
from GameSentenceMiner.web.stats import calculate_current_game_stats
from GameSentenceMiner.web.stats_repository import (
    fetch_today_lines,
    get_date_range_params,
    query_stats_lines,
)


def build_combined_stats(
    start_timestamp: float | None,
    end_timestamp: float | None,
) -> tuple[dict, dict | None, dict | None, list, list, str, str, dict[str, dict]]:
    """Fetch rollups + today's live data and return combined stats payload."""
    today = datetime.date.today()
    today_str = today.strftime("%Y-%m-%d")

    start_date_str, end_date_str = get_date_range_params(
        start_timestamp, end_timestamp, today
    )

    today_in_range = (not end_date_str) or (end_date_str >= today_str)

    rollup_stats = None
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
            if rollups:
                rollup_stats = aggregate_rollup_data(rollups)

    live_stats = None
    today_lines: list = []
    if today_in_range:
        today_lines = fetch_today_lines(today)
        if today_lines:
            live_stats = calculate_live_stats_for_today(today_lines)

    combined_stats = combine_rollup_and_live_stats(rollup_stats, live_stats)

    third_party_by_date = get_third_party_stats_by_date(start_date_str, end_date_str)
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


def build_current_game_stats(
    today_lines: list,
    start_timestamp: float | None,
    end_timestamp: float | None,
) -> dict:
    """Find current game and compute its stats in the active time window."""
    today = datetime.date.today()

    if today_lines:
        current_game_line = max(today_lines, key=lambda line: float(line.timestamp))
        current_game_name = current_game_line.game_name or "Unknown Game"

        current_game_lines = [
            line
            for line in today_lines
            if (line.game_name or "Unknown Game") == current_game_name
        ]

        today_start_ts = datetime.datetime.combine(
            today, datetime.time.min
        ).timestamp()

        if start_timestamp and end_timestamp:
            historical_lines = query_stats_lines(
                where_clause="game_name=? AND timestamp >= ? AND timestamp < ?",
                params=(current_game_name, start_timestamp, today_start_ts),
            )
        else:
            historical_lines = query_stats_lines(
                where_clause="game_name=? AND timestamp < ?",
                params=(current_game_name, today_start_ts),
            )

        current_game_lines.extend(historical_lines)
        return calculate_current_game_stats(current_game_lines)

    most_recent_lines = query_stats_lines(
        where_clause="1=1",
        params=(),
        order_clause="timestamp DESC",
        limit_clause="LIMIT 1",
    )
    if not most_recent_lines:
        return {}

    current_game_name = most_recent_lines[0].game_name or "Unknown Game"

    if start_timestamp and end_timestamp:
        current_game_lines = query_stats_lines(
            where_clause="game_name=? AND timestamp >= ? AND timestamp <= ?",
            params=(current_game_name, start_timestamp, end_timestamp),
        )
    else:
        current_game_lines = query_stats_lines(
            where_clause="game_name=?",
            params=(current_game_name,),
        )

    return calculate_current_game_stats(current_game_lines)
