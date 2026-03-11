"""
Statistics API Endpoints

This module contains the /api/stats endpoint and related statistics API routes.
Separated from database_api.py to improve code organization and maintainability.
"""

from __future__ import annotations

import datetime
import json
import time
from collections import defaultdict
from typing import Dict, List, Optional, Tuple

from flask import request, jsonify
from pathlib import Path

from GameSentenceMiner.util.config.configuration import logger, get_stats_config
from GameSentenceMiner.util.database.db import GameLinesTable
from GameSentenceMiner.util.database.games_table import GamesTable
from GameSentenceMiner.util.database.stats_rollup_table import StatsRollupTable
from GameSentenceMiner.web.rollup_stats import (
    aggregate_rollup_data,
    calculate_live_stats_for_today,
    combine_rollup_and_live_stats,
    calculate_day_of_week_averages_from_rollup,
    calculate_difficulty_speed_from_rollup,
    calculate_genre_tag_stats_from_rollup,
    get_third_party_stats_by_date,
    enrich_aggregated_stats,
)
from GameSentenceMiner.util.stats.stats_util import (
    count_cards_from_line,
    count_cards_from_lines,
)
from GameSentenceMiner.web.stats import (
    calculate_actual_reading_time,
    calculate_heatmap_data,
    calculate_mining_heatmap_data,
    calculate_reading_speed_heatmap_data,
    calculate_current_game_stats,
    calculate_game_milestones,
    get_gradient_color,
    format_large_number,
    format_time_human_readable,
)


# ---------------------------------------------------------------------------
# Module-level helpers (extracted from inline definitions in route handlers)
# ---------------------------------------------------------------------------

def build_game_mappings_from_games_table() -> Tuple[
    Dict[str, str], Dict[str, str], Dict[str, str]
]:
    """Build game_id and game_name mappings from GamesTable.

    Much faster than scanning all game lines.

    Returns:
        (game_id_to_game_name, game_name_to_title, game_id_to_title)
    """
    all_games = GamesTable.all()

    game_id_to_game_name: Dict[str, str] = {}
    game_name_to_title: Dict[str, str] = {}
    game_id_to_title: Dict[str, str] = {}

    for game in all_games:
        if game.id and game.obs_scene_name:
            game_id_to_game_name[game.id] = game.obs_scene_name
        if game.id and game.title_original:
            game_id_to_title[game.id] = game.title_original
        if game.obs_scene_name and game.title_original:
            game_name_to_title[game.obs_scene_name] = game.title_original
        elif game.obs_scene_name:
            game_name_to_title[game.obs_scene_name] = game.obs_scene_name

    return game_id_to_game_name, game_name_to_title, game_id_to_title


def _get_date_range_params(
    start_timestamp: float | None,
    end_timestamp: float | None,
    today: datetime.date,
) -> Tuple[str, str]:
    """Determine start/end date strings from optional timestamps.

    Returns:
        (start_date_str, end_date_str) in YYYY-MM-DD format.
    """
    today_str = today.strftime("%Y-%m-%d")

    if start_timestamp and end_timestamp:
        start_date_str = datetime.date.fromtimestamp(start_timestamp).strftime(
            "%Y-%m-%d"
        )
        end_date_str = datetime.date.fromtimestamp(end_timestamp).strftime("%Y-%m-%d")
    else:
        first_rollup_date = StatsRollupTable.get_first_date()
        start_date_str = first_rollup_date if first_rollup_date else today_str
        end_date_str = today_str

    return start_date_str, end_date_str


def _fetch_rollups_for_range(
    start_date_str: str,
    yesterday_str: str,
) -> List:
    """Fetch rollup records for a historical date range (up to yesterday).

    Returns an empty list if the range is invalid.
    """
    if start_date_str <= yesterday_str:
        return StatsRollupTable.get_date_range(start_date_str, yesterday_str)
    return []


def _fetch_today_lines(today: datetime.date) -> List:
    """Fetch today's game lines (for live stats calculation)."""
    today_start = datetime.datetime.combine(today, datetime.time.min).timestamp()
    today_end = datetime.datetime.combine(today, datetime.time.max).timestamp()
    return GameLinesTable.get_lines_filtered_by_timestamp(
        start=today_start, end=today_end, for_stats=True
    )


def _build_kanji_grid_data(combined_stats: Dict) -> Dict:
    """Build kanji grid data from combined stats."""
    kanji_freq_dict = combined_stats.get("kanji_frequency_data", {})
    if not kanji_freq_dict:
        return {"kanji_data": [], "unique_count": 0, "max_frequency": 0}

    max_frequency = max(kanji_freq_dict.values())
    sorted_kanji = sorted(kanji_freq_dict.items(), key=lambda x: x[1], reverse=True)

    kanji_data = []
    for kanji, count in sorted_kanji:
        color = get_gradient_color(count, max_frequency)
        kanji_data.append({"kanji": kanji, "frequency": count, "color": color})

    return {
        "kanji_data": kanji_data,
        "unique_count": len(sorted_kanji),
        "max_frequency": max_frequency,
    }


def _accumulate_rollup_metrics(
    rollups: list,
    filter_year: str | None,
    game_id_to_title: dict[str, str],
    third_party_by_date: dict | None,
) -> dict:
    """Single-pass iteration over rollups to accumulate all chart metrics.

    Replaces the 6-8 separate get_date_range() calls and iteration loops
    that previously existed in the api_stats handler (sections 5, 7, 9, 11, 12, 17).

    Returns a dict with keys:
        - heatmap_data: dict[year, dict[date, chars]]
        - reading_speed_heatmap_data: dict[year, dict[date, speed]]
        - max_reading_speed: int
        - peak_daily_stats: dict with max_daily_chars, max_daily_hours
        - day_of_week_totals: dict with chars[7], hours[7], counts[7]
        - all_lines_data: list[dict] with per-day summaries
        - cards_mined_data: dict with labels[], totals[]
        - mining_heatmap_data: dict[year, dict[date, cards_created]]
        - daily_data: dict[date, dict[game, {lines, chars}]]
    """
    heatmap_data: dict = {}
    reading_speed_heatmap_data: dict = {}
    max_reading_speed = 0
    max_daily_chars = 0
    max_daily_hours = 0.0
    day_of_week_totals = {
        "chars": [0] * 7,
        "hours": [0.0] * 7,
        "counts": [0] * 7,
    }
    all_lines_data: list[dict] = []
    cards_mined_data: dict = {"labels": [], "totals": []}
    mining_heatmap_data: dict = {}
    daily_data: dict = defaultdict(lambda: defaultdict(lambda: {"lines": 0, "chars": 0}))

    for rollup in rollups:
        date_str = rollup.date
        year = date_str.split("-")[0]

        # --- heatmap_data (characters per day, grouped by year) ---
        if not filter_year or year == filter_year:
            if year not in heatmap_data:
                heatmap_data[year] = {}
            heatmap_data[year][date_str] = rollup.total_characters

        # --- reading_speed_heatmap_data ---
        if rollup.total_reading_time_seconds > 0 and rollup.total_characters > 0:
            reading_time_hours = rollup.total_reading_time_seconds / 3600
            speed = int(rollup.total_characters / reading_time_hours)
            if year not in reading_speed_heatmap_data:
                reading_speed_heatmap_data[year] = {}
            reading_speed_heatmap_data[year][date_str] = speed
            if speed > max_reading_speed:
                max_reading_speed = speed

        # --- peak_daily_stats ---
        if rollup.total_characters > max_daily_chars:
            max_daily_chars = rollup.total_characters
        daily_hours = rollup.total_reading_time_seconds / 3600
        if daily_hours > max_daily_hours:
            max_daily_hours = daily_hours

        # --- day_of_week_totals ---
        try:
            date_obj = datetime.datetime.strptime(date_str, "%Y-%m-%d")
            dow = date_obj.weekday()  # 0=Monday, 6=Sunday
            day_of_week_totals["chars"][dow] += rollup.total_characters
            day_of_week_totals["hours"][dow] += rollup.total_reading_time_seconds / 3600
            day_of_week_totals["counts"][dow] += 1
        except (ValueError, AttributeError):
            pass

        # --- all_lines_data ---
        try:
            date_obj_ts = datetime.datetime.strptime(date_str, "%Y-%m-%d")
            all_lines_data.append({
                "timestamp": date_obj_ts.timestamp(),
                "date": date_str,
                "reading_time_seconds": rollup.total_reading_time_seconds,
                "characters": rollup.total_characters,
            })
        except ValueError:
            pass

        # --- cards_mined_data ---
        cards_mined_data["labels"].append(date_str)
        cards_mined_data["totals"].append(rollup.anki_cards_created)

        # --- mining_heatmap_data (anki cards created per day, grouped by year) ---
        if rollup.anki_cards_created > 0:
            if year not in mining_heatmap_data:
                mining_heatmap_data[year] = {}
            mining_heatmap_data[year][date_str] = rollup.anki_cards_created

        # --- daily_data (per-game breakdown from game_activity_data JSON) ---
        if rollup.game_activity_data:
            try:
                if isinstance(rollup.game_activity_data, str):
                    game_data = json.loads(rollup.game_activity_data)
                else:
                    game_data = rollup.game_activity_data

                for game_id, activity in game_data.items():
                    display_name = activity.get("title", f"Game {game_id[:8]}")
                    daily_data[date_str][display_name]["lines"] = activity.get("lines", 0)
                    daily_data[date_str][display_name]["chars"] = activity.get("chars", 0)
            except (json.JSONDecodeError, KeyError, TypeError) as e:
                logger.warning(f"Error parsing rollup game_activity_data for {date_str}: {e}")

    # --- Merge third-party stats ---
    if third_party_by_date:
        rollup_dates = {r.date for r in rollups}
        for date_str, tp_data in third_party_by_date.items():
            tp_year = date_str.split("-")[0]

            # heatmap_data
            if not filter_year or tp_year == filter_year:
                if tp_year not in heatmap_data:
                    heatmap_data[tp_year] = {}
                heatmap_data[tp_year][date_str] = (
                    heatmap_data.get(tp_year, {}).get(date_str, 0) + tp_data["characters"]
                )

            # day_of_week_totals
            try:
                tp_date_obj = datetime.datetime.strptime(date_str, "%Y-%m-%d")
                tp_dow = tp_date_obj.weekday()
                day_of_week_totals["chars"][tp_dow] += tp_data["characters"]
                day_of_week_totals["hours"][tp_dow] += tp_data["time_seconds"] / 3600
                if date_str not in rollup_dates:
                    day_of_week_totals["counts"][tp_dow] += 1
            except (ValueError, AttributeError):
                pass

            # all_lines_data
            existing_dates = {item["date"] for item in all_lines_data}
            if date_str in existing_dates:
                for item in all_lines_data:
                    if item["date"] == date_str:
                        item["reading_time_seconds"] = (
                            item.get("reading_time_seconds", 0) + tp_data["time_seconds"]
                        )
                        item["characters"] = (
                            item.get("characters", 0) + tp_data["characters"]
                        )
                        break
            else:
                try:
                    tp_ts = datetime.datetime.strptime(date_str, "%Y-%m-%d").timestamp()
                    all_lines_data.append({
                        "timestamp": tp_ts,
                        "date": date_str,
                        "reading_time_seconds": tp_data["time_seconds"],
                        "characters": tp_data["characters"],
                    })
                except ValueError:
                    pass

            # daily_data
            if tp_data["characters"] > 0:
                daily_data[date_str]["3rd Party Reading"]["chars"] += tp_data["characters"]

    return {
        "heatmap_data": heatmap_data,
        "reading_speed_heatmap_data": reading_speed_heatmap_data,
        "max_reading_speed": max_reading_speed,
        "peak_daily_stats": {"max_daily_chars": max_daily_chars, "max_daily_hours": max_daily_hours},
        "day_of_week_totals": day_of_week_totals,
        "all_lines_data": all_lines_data,
        "cards_mined_data": cards_mined_data,
        "mining_heatmap_data": mining_heatmap_data,
        "daily_data": daily_data,
    }

def _build_combined_stats(
    start_timestamp: float | None,
    end_timestamp: float | None,
) -> tuple[dict, dict | None, dict | None, list, list, str, str]:
    """Fetch rollups, compute today's live stats, combine them.

    Encapsulates the "determine date range → query rollups → fetch today's
    lines → aggregate → combine → enrich with third-party" logic that is
    shared between the main stats handler and lazy-load endpoints.

    Returns:
        (combined_stats, rollup_stats, live_stats, rollups, today_lines,
         start_date_str, end_date_str)
    """
    today = datetime.date.today()
    today_str = today.strftime("%Y-%m-%d")

    # Determine date range
    start_date_str, end_date_str = _get_date_range_params(
        start_timestamp, end_timestamp, today
    )

    # Check if today is in the date range
    today_in_range = (not end_date_str) or (end_date_str >= today_str)

    # Query rollup data for historical dates (up to yesterday)
    rollup_stats = None
    rollups: list = []
    if start_date_str:
        yesterday = today - datetime.timedelta(days=1)
        yesterday_str = yesterday.strftime("%Y-%m-%d")

        if start_date_str <= yesterday_str:
            rollup_end = (
                min(end_date_str, yesterday_str) if end_date_str else yesterday_str
            )
            rollups = StatsRollupTable.get_date_range(start_date_str, rollup_end)

            if rollups:
                rollup_stats = aggregate_rollup_data(rollups)

    # Calculate today's stats live if needed
    live_stats = None
    today_lines: list = []
    if today_in_range:
        today_lines = _fetch_today_lines(today)
        if today_lines:
            live_stats = calculate_live_stats_for_today(today_lines)

    # Combine rollup and live stats
    combined_stats = combine_rollup_and_live_stats(rollup_stats, live_stats)

    # Fetch and merge third-party stats (Mokuro, manual, etc.)
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
    )




def _build_chart_datasets(
    daily_data: dict,
    display_names: list[str],
) -> tuple[list[str], list[dict]]:
    """Build cumulative Chart.js datasets from per-day per-game data.

    Sections 3-4 of the old inline api_stats() logic: accumulates running
    totals per game and formats them into Chart.js dataset dicts.

    Args:
        daily_data: ``{date_str: {display_name: {lines: int, chars: int}}}``
        display_names: Sorted list of game display names.

    Returns:
        (sorted_days, datasets) where *sorted_days* is the list of date
        labels and *datasets* is a list of Chart.js-compatible dataset dicts.
    """
    sorted_days = sorted(daily_data.keys())

    # Running totals per game
    cumulative_totals: dict[str, dict[str, int]] = defaultdict(
        lambda: {"lines": 0, "chars": 0}
    )

    # final_data[display_name][metric] = [day1_val, day2_val, ...]
    final_data: dict[str, dict[str, list[int]]] = defaultdict(
        lambda: defaultdict(list)
    )

    for day in sorted_days:
        for name in display_names:
            cumulative_totals[name]["lines"] += daily_data[day][name]["lines"]
            cumulative_totals[name]["chars"] += daily_data[day][name]["chars"]

            final_data[name]["lines"].append(cumulative_totals[name]["lines"])
            final_data[name]["chars"].append(cumulative_totals[name]["chars"])

    # Format into Chart.js dataset structure
    colors = [
        "#3498db",
        "#e74c3c",
        "#2ecc71",
        "#f1c40f",
        "#9b59b6",
        "#1abc9c",
        "#e67e22",
    ]

    datasets: list[dict] = []
    for i, name in enumerate(display_names):
        color = colors[i % len(colors)]

        datasets.append(
            {
                "label": f"{name}",
                "data": final_data[name]["lines"],
                "borderColor": color,
                "backgroundColor": f"{color}33",
                "fill": False,
                "tension": 0.1,
                "for": "Lines Received",
            }
        )
        datasets.append(
            {
                "label": f"{name}",
                "data": final_data[name]["chars"],
                "borderColor": color,
                "backgroundColor": f"{color}33",
                "fill": False,
                "tension": 0.1,
                "hidden": True,
                "for": "Characters Read",
            }
        )

    return sorted_days, datasets

def _build_per_game_stats(
    rollup_stats: dict | None,
    game_id_to_title: dict[str, str],
) -> tuple[dict, dict, dict]:
    """Extract per-game totals from rollup game_activity_data.

    Args:
        rollup_stats: Aggregated rollup stats dict (may be ``None``).
        game_id_to_title: Mapping of game ID → display title.

    Returns:
        (total_chars_data, reading_time_data, reading_speed_per_game_data)
        Each is a ``{"labels": [...], "totals": [...]}`` dict.
    """
    game_activity_data = (
        rollup_stats.get("game_activity_data", {}) if rollup_stats else {}
    )

    game_list = []
    for game_id, activity in game_activity_data.items():
        title = activity.get("title", f"Game {game_id}")
        if game_id in game_id_to_title:
            title = game_id_to_title[game_id]

        game_list.append(
            {
                "game_id": game_id,
                "title": title,
                "chars": activity.get("chars", 0),
                "time": activity.get("time", 0),
                "lines": activity.get("lines", 0),
            }
        )

    total_chars_data = {
        "labels": [g["title"] for g in game_list if g["chars"] > 0],
        "totals": [g["chars"] for g in game_list if g["chars"] > 0],
    }

    reading_time_data = {
        "labels": [g["title"] for g in game_list if g["time"] > 0],
        "totals": [
            round(g["time"] / 3600, 2) for g in game_list if g["time"] > 0
        ],
    }

    reading_speed_per_game_data: dict = {"labels": [], "totals": []}
    for g in game_list:
        if g["time"] > 0 and g["chars"] > 0:
            hours = g["time"] / 3600
            speed = round(g["chars"] / hours, 0)
            reading_speed_per_game_data["labels"].append(g["title"])
            reading_speed_per_game_data["totals"].append(speed)

    return total_chars_data, reading_time_data, reading_speed_per_game_data

def _build_current_game_stats(
    today_lines: list,
    start_timestamp: float | None,
    end_timestamp: float | None,
) -> dict:
    """Determine the current game and compute its stats.

    Finds the most-recently-played game (from *today_lines* when available,
    otherwise from the DB) and gathers all of its lines — today's live lines
    plus historical rows — then delegates to
    :func:`calculate_current_game_stats`.

    Args:
        today_lines: Lines recorded today (may be empty).
        start_timestamp: Optional lower-bound Unix timestamp for the date range.
        end_timestamp: Optional upper-bound Unix timestamp for the date range.

    Returns:
        A ``current_game_stats`` dict (or ``{}`` on error / no data).
    """
    today = datetime.date.today()

    if today_lines:
        sorted_today = sorted(
            today_lines, key=lambda line: float(line.timestamp)
        )
        current_game_line = sorted_today[-1]
        current_game_name = current_game_line.game_name or "Unknown Game"

        # Fetch only lines for the current game (much faster than all_lines!)
        current_game_lines = [
            line
            for line in today_lines
            if (line.game_name or "Unknown Game") == current_game_name
        ]

        # Fetch historical data for current game (EXCLUDING today to avoid double-counting)
        today_start_ts = datetime.datetime.combine(
            today, datetime.time.min
        ).timestamp()

        if start_timestamp and end_timestamp:
            historical_current_game = GameLinesTable._db.fetchall(
                f"SELECT * FROM {GameLinesTable._table} WHERE game_name=? AND timestamp >= ? AND timestamp < ?",
                (current_game_name, start_timestamp, today_start_ts),
            )
        else:
            historical_current_game = GameLinesTable._db.fetchall(
                f"SELECT * FROM {GameLinesTable._table} WHERE game_name=? AND timestamp < ?",
                (current_game_name, today_start_ts),
            )

        historical_lines = [
            GameLinesTable.from_row(row, clean_columns=["line_text"])
            for row in historical_current_game
        ]

        current_game_lines.extend(historical_lines)

        return calculate_current_game_stats(current_game_lines)

    # No lines today — fetch the most recent game from all data
    most_recent_line = GameLinesTable._db.fetchone(
        f"SELECT * FROM {GameLinesTable._table} ORDER BY timestamp DESC LIMIT 1"
    )

    if not most_recent_line:
        return {}

    most_recent_game_line = GameLinesTable.from_row(
        most_recent_line, clean_columns=["line_text"]
    )
    current_game_name = most_recent_game_line.game_name or "Unknown Game"

    if start_timestamp and end_timestamp:
        current_game_lines_rows = GameLinesTable._db.fetchall(
            f"SELECT * FROM {GameLinesTable._table} WHERE game_name=? AND timestamp >= ? AND timestamp <= ?",
            (current_game_name, start_timestamp, end_timestamp),
        )
    else:
        current_game_lines_rows = GameLinesTable._db.fetchall(
            f"SELECT * FROM {GameLinesTable._table} WHERE game_name=?",
            (current_game_name,),
        )

    current_game_lines = [
        GameLinesTable.from_row(row, clean_columns=["line_text"])
        for row in current_game_lines_rows
    ]
    return calculate_current_game_stats(current_game_lines)

def _build_all_games_stats(
    combined_stats: dict,
    end_timestamp: float | None,
) -> dict:
    """Build the all-games summary statistics.

    Computes aggregate totals (characters, sentences, reading time, speed,
    sessions, completed games) from *combined_stats* and determines the
    first/last dates from the rollup table.

    Args:
        combined_stats: Merged rollup + live statistics dict.
        end_timestamp: Optional upper-bound Unix timestamp for the date range.

    Returns:
        An ``all_games_stats`` dict with formatted totals, or ``{}`` on error.
    """
    completed_games_count = len(GamesTable.get_all_completed())

    all_games_stats: dict = {
        "total_characters": combined_stats.get("total_characters", 0),
        "total_characters_formatted": format_large_number(
            combined_stats.get("total_characters", 0)
        ),
        "total_sentences": combined_stats.get("total_lines", 0),
        "total_time_hours": combined_stats.get(
            "total_reading_time_seconds", 0
        )
        / 3600,
        "total_time_formatted": format_time_human_readable(
            combined_stats.get("total_reading_time_seconds", 0) / 3600
        ),
        "reading_speed": int(
            combined_stats.get("average_reading_speed_chars_per_hour", 0)
        ),
        "reading_speed_formatted": format_large_number(
            int(
                combined_stats.get(
                    "average_reading_speed_chars_per_hour", 0
                )
            )
        ),
        "sessions": combined_stats.get("total_sessions", 0),
        "completed_games": completed_games_count,
        "current_streak": 0,  # TODO: Calculate from rollup data
        "avg_daily_time_hours": 0,  # TODO: Calculate from rollup data
        "avg_daily_time_formatted": "0h",
    }

    first_rollup_date = StatsRollupTable.get_first_date()

    if first_rollup_date:
        all_games_stats["first_date"] = first_rollup_date
    else:
        fallback_date = datetime.date.today().strftime("%Y-%m-%d")
        all_games_stats["first_date"] = fallback_date

    if end_timestamp:
        all_games_stats["last_date"] = datetime.date.fromtimestamp(
            end_timestamp
        ).strftime("%Y-%m-%d")
    else:
        all_games_stats["last_date"] = datetime.date.today().strftime(
            "%Y-%m-%d"
        )

    return all_games_stats

def _build_hourly_data(
    rollup_stats: dict | None,
) -> tuple[list[int], list[int]]:
    """Build hourly activity and hourly reading speed arrays from rollup data.

    Converts the hour-keyed dicts in *rollup_stats* into 24-element lists
    (index 0–23) suitable for the frontend charts.

    Args:
        rollup_stats: Aggregated rollup statistics dict, or ``None``.

    Returns:
        A tuple ``(hourly_activity_data, hourly_reading_speed_data)`` where
        each element is a 24-element list of integers.
    """
    # Hourly activity pattern
    hourly_dict = (
        rollup_stats.get("hourly_activity_data", {}) if rollup_stats else {}
    )
    hourly_activity_data = [0] * 24
    for hour_str, chars in hourly_dict.items():
        try:
            hour_int = int(hour_str)
            if 0 <= hour_int < 24:
                hourly_activity_data[hour_int] = chars
        except (ValueError, TypeError):
            logger.warning(
                f"Invalid hour key in hourly_activity_data: {hour_str}"
            )

    # Hourly reading speed pattern
    speed_dict = (
        rollup_stats.get("hourly_reading_speed_data", {}) if rollup_stats else {}
    )
    hourly_reading_speed_data = [0] * 24
    for hour_str, speed in speed_dict.items():
        try:
            hour_int = int(hour_str)
            if 0 <= hour_int < 24:
                hourly_reading_speed_data[hour_int] = speed
        except (ValueError, TypeError):
            logger.warning(
                f"Invalid hour key in hourly_reading_speed_data: {hour_str}"
            )

    return hourly_activity_data, hourly_reading_speed_data

def _build_peak_stats(
    accumulated: Dict,
    live_stats: Dict | None,
    combined_stats: Dict,
) -> tuple:
    """Build peak daily and peak session statistics.

    Merges the accumulator's historical peak data with today's live stats
    (if they set new records) and extracts session peaks from combined_stats.

    Args:
        accumulated: Output from _accumulate_rollup_metrics().
        live_stats: Today's live stats dict, or None.
        combined_stats: Merged rollup + live statistics.

    Returns:
        (peak_daily_stats, peak_session_stats) tuple of dicts.
    """
    peak_daily_stats = accumulated["peak_daily_stats"]

    # Check today's live data to see if it sets a new record
    if live_stats:
        today_chars = live_stats.get("total_characters", 0)
        today_hours = live_stats.get("total_reading_time_seconds", 0) / 3600

        if today_chars > peak_daily_stats["max_daily_chars"]:
            peak_daily_stats["max_daily_chars"] = today_chars
        if today_hours > peak_daily_stats["max_daily_hours"]:
            peak_daily_stats["max_daily_hours"] = today_hours

    peak_session_stats = {
        "longest_session_hours": combined_stats.get(
            "longest_session_seconds", 0.0
        )
        / 3600,
        "max_session_chars": combined_stats.get("max_chars_in_session", 0),
    }

    return peak_daily_stats, peak_session_stats

def _build_day_of_week_data(accumulated: Dict) -> Dict:
    """Build day-of-week activity data from the single-pass accumulator.

    Computes per-weekday character totals, hour totals, day counts, and
    average hours from the accumulator's ``day_of_week_totals``.

    Args:
        accumulated: Output from _accumulate_rollup_metrics().

    Returns:
        Dict with keys ``chars``, ``hours``, ``counts``, ``avg_hours`` –
        each a list of 7 values (Monday=0 … Sunday=6).
    """
    dow_totals = accumulated["day_of_week_totals"]
    day_of_week_data: Dict = {
        "chars": dow_totals["chars"],
        "hours": dow_totals["hours"],
        "counts": dow_totals["counts"],
        "avg_hours": [0] * 7,
    }
    for i in range(7):
        if day_of_week_data["counts"][i] > 0:
            day_of_week_data["avg_hours"][i] = round(
                day_of_week_data["hours"][i] / day_of_week_data["counts"][i], 2
            )
    return day_of_week_data

def _build_genre_type_stats(
    rollup_stats: Dict | None,
    combined_stats: Dict,
) -> Tuple[Dict, Dict, Dict, Dict, Dict]:
    """Build genre and type statistics from rollup and combined stats.

    Computes difficulty-based reading speed, game type distribution,
    genre/tag stats, and per-genre / per-type activity breakdowns.

    Args:
        rollup_stats: Aggregated rollup data (may be ``None``).
        combined_stats: Merged rollup + live stats dictionary.

    Returns:
        Tuple of (difficulty_speed_data, game_type_data, genre_tag_data,
        genre_stats, type_stats).
    """
    safe_rollup = rollup_stats if rollup_stats else {}

    # 13. Reading speed by difficulty (ROLLUP ONLY)
    difficulty_speed_data = calculate_difficulty_speed_from_rollup(safe_rollup)

    # 14. Game type distribution (only for games the user has played)
    game_type_data: Dict = {"labels": [], "counts": []}
    game_activity_data = safe_rollup.get("game_activity_data", {})
    played_game_ids = set(game_activity_data.keys())

    type_counts: Dict[str, int] = {}
    for game_id in played_game_ids:
        game = GamesTable.get(game_id)
        if game and game.type:
            type_counts[game.type] = type_counts.get(game.type, 0) + 1

    for game_type, count in sorted(type_counts.items(), key=lambda x: x[1], reverse=True):
        game_type_data["labels"].append(game_type)
        game_type_data["counts"].append(count)

    # 15. Genre and tag statistics (ROLLUP ONLY)
    genre_tag_data = calculate_genre_tag_stats_from_rollup(safe_rollup)

    # 16. Genre and type activity breakdowns from combined stats
    genre_activity_data = combined_stats.get("genre_activity_data", {})
    genre_stats: Dict = {
        "labels": [],
        "chars_data": [],
        "time_data": [],
        "speed_data": [],
        "cards_data": [],
    }

    for genre in sorted(genre_activity_data.keys()):
        stats = genre_activity_data[genre]
        chars = stats.get("chars", 0)
        time_sec = stats.get("time", 0)
        cards = stats.get("cards", 0)

        genre_stats["labels"].append(genre)
        genre_stats["chars_data"].append(chars)
        genre_stats["time_data"].append(round(time_sec / 3600, 2))
        genre_stats["cards_data"].append(cards)

        if time_sec > 0 and chars > 0:
            genre_stats["speed_data"].append(int(chars / (time_sec / 3600)))
        else:
            genre_stats["speed_data"].append(0)

    type_activity_data = combined_stats.get("type_activity_data", {})
    type_stats: Dict = {
        "labels": [],
        "chars_data": [],
        "time_data": [],
        "speed_data": [],
        "cards_data": [],
    }

    for media_type in sorted(type_activity_data.keys()):
        stats = type_activity_data[media_type]
        chars = stats.get("chars", 0)
        time_sec = stats.get("time", 0)
        cards = stats.get("cards", 0)

        type_stats["labels"].append(media_type)
        type_stats["chars_data"].append(chars)
        type_stats["time_data"].append(round(time_sec / 3600, 2))
        type_stats["cards_data"].append(cards)

        if time_sec > 0 and chars > 0:
            type_stats["speed_data"].append(int(chars / (time_sec / 3600)))
        else:
            type_stats["speed_data"].append(0)

    return difficulty_speed_data, game_type_data, genre_tag_data, genre_stats, type_stats


def _build_time_period_averages(
    accumulated: Dict,
    live_stats: Dict | None,
    start_date_str: str,
    end_date_str: str | None,
) -> Dict:
    """Build time-period averages from the accumulator and today's live stats.

    Computes average hours/chars/speed per day and period totals from the
    accumulator's ``all_lines_data`` plus today's live stats (when today
    falls within the requested date range).

    Args:
        accumulated: Output from _accumulate_rollup_metrics().
        live_stats: Today's live stats dict, or None.
        start_date_str: Start date as "YYYY-MM-DD".
        end_date_str: End date as "YYYY-MM-DD", or None for open-ended.

    Returns:
        Dict with keys ``avgHoursPerDay``, ``avgCharsPerDay``,
        ``avgSpeedPerDay``, ``totalHours``, ``totalChars``.
    """
    today_str = datetime.date.today().strftime("%Y-%m-%d")
    today_in_range = (not end_date_str) or (end_date_str >= today_str)

    acc_lines = accumulated["all_lines_data"]

    total_hours_period = 0.0
    total_chars_period = 0
    total_speed_sum = 0.0
    speed_count = 0

    for item in acc_lines:
        rt = item.get("reading_time_seconds", 0)
        ch = item.get("characters", 0)
        total_hours_period += rt / 3600
        total_chars_period += ch
        if rt > 0 and ch > 0:
            total_speed_sum += ch / (rt / 3600)
            speed_count += 1

    # Add today's live data if in range
    if today_in_range and live_stats:
        total_hours_period += live_stats.get("total_reading_time_seconds", 0) / 3600
        total_chars_period += live_stats.get("total_characters", 0)
        today_hours = live_stats.get("total_reading_time_seconds", 0) / 3600
        today_chars = live_stats.get("total_characters", 0)
        if today_hours > 0 and today_chars > 0:
            total_speed_sum += today_chars / today_hours
            speed_count += 1

    avg_hours_per_day = 0.0
    avg_chars_per_day = 0.0
    avg_speed_per_day = 0.0

    if total_hours_period > 0 or total_chars_period > 0:
        start_date_obj = datetime.datetime.strptime(
            start_date_str, "%Y-%m-%d"
        ).date()
        end_date_obj = datetime.datetime.strptime(
            end_date_str if end_date_str else today_str, "%Y-%m-%d"
        ).date()
        num_days = (end_date_obj - start_date_obj).days + 1

        if num_days > 0:
            avg_hours_per_day = total_hours_period / num_days
            avg_chars_per_day = total_chars_period / num_days
        if speed_count > 0:
            avg_speed_per_day = total_speed_sum / speed_count

    return {
        "avgHoursPerDay": round(avg_hours_per_day, 2),
        "avgCharsPerDay": int(avg_chars_per_day),
        "avgSpeedPerDay": int(avg_speed_per_day),
        "totalHours": round(total_hours_period, 2),
        "totalChars": int(total_chars_period),
    }


def _merge_today_into_heatmap(
    heatmap: Dict, today_heatmap: Dict
) -> None:
    """Merge today's live heatmap entries into the accumulated heatmap (in-place)."""
    for year, dates in today_heatmap.items():
        if year not in heatmap:
            heatmap[year] = {}
        for date, value in dates.items():
            heatmap[year][date] = heatmap[year].get(date, 0) + value


def _add_today_lines_to_daily_data(
    daily_data: Dict, today_lines: list, game_name_to_display: Dict
) -> None:
    """Merge today's live lines into the accumulated daily_data (in-place)."""
    for line in today_lines:
        day_str = datetime.date.fromtimestamp(float(line.timestamp)).strftime("%Y-%m-%d")
        game_name = line.game_name or "Unknown Game"
        display_name = game_name_to_display.get(game_name, game_name)
        daily_data[day_str][display_name]["lines"] += 1
        daily_data[day_str][display_name]["chars"] += len(line.line_text) if line.line_text else 0


def register_stats_api_routes(app):
    """Register statistics API routes with the Flask app."""

    @app.route("/api/stats")
    def api_stats():
        """
        Get aggregated statistics for charts and analytics
        ---
        tags:
          - Statistics
        parameters:
          - name: year
            in: query
            type: string
            required: false
            description: Filter heatmap data by year
          - name: start
            in: query
            type: number
            required: false
            description: Start timestamp (Unix timestamp)
          - name: end
            in: query
            type: number
            required: false
            description: End timestamp (Unix timestamp)
        responses:
          200:
            description: Statistics data for charts
            schema:
              type: object
              properties:
                labels:
                  type: array
                  items:
                    type: string
                  description: Date labels for chart
                datasets:
                  type: array
                  items:
                    type: object
                  description: Chart.js compatible datasets
                heatmapData:
                  type: object
                  description: Activity heatmap data
                currentGameStats:
                  type: object
                  description: Current game statistics
                allGamesStats:
                  type: object
                  description: Overall statistics
          500:
            description: Failed to generate statistics
        """
        try:
            # --- Parse request parameters ---
            filter_year = request.args.get("year", None)
            start_timestamp = request.args.get("start", None)
            end_timestamp = request.args.get("end", None)
            start_timestamp = float(start_timestamp) if start_timestamp else None
            end_timestamp = float(end_timestamp) if end_timestamp else None

            # --- Fetch combined rollup + live stats ---
            (
                combined_stats, rollup_stats, live_stats,
                rollups, today_lines, start_date_str, end_date_str,
            ) = _build_combined_stats(start_timestamp, end_timestamp)

            today_str = datetime.date.today().strftime("%Y-%m-%d")
            today_in_range = (not end_date_str) or (end_date_str >= today_str)

            # --- Build game-title mappings ---
            third_party_by_date = get_third_party_stats_by_date(start_date_str, end_date_str)
            _game_id_to_name, game_name_to_display, game_id_to_title = build_game_mappings_from_games_table()

            # Fallback titles from rollup data for games not in GamesTable
            for game_id, activity in combined_stats.get("game_activity_data", {}).items():
                if game_id not in game_id_to_title:
                    game_id_to_title[game_id] = activity.get("title", f"Game {game_id}")

            # --- Single-pass accumulator over rollups ---
            accumulated = _accumulate_rollup_metrics(rollups, filter_year, game_id_to_title, third_party_by_date)
            daily_data = accumulated["daily_data"]

            # Merge today's lines into daily_data
            _add_today_lines_to_daily_data(daily_data, today_lines, game_name_to_display)

            # Graceful fallback: if no rollup data, calculate from game_lines directly
            if not daily_data:
                logger.warning("No daily_data from rollup! Falling back to live calculation from game_lines table.")
                if start_timestamp and end_timestamp:
                    fallback_lines = GameLinesTable.get_lines_filtered_by_timestamp(
                        start=start_timestamp, end=end_timestamp, for_stats=True
                    )
                    if fallback_lines:
                        logger.info(f"Fallback: Processing {len(fallback_lines)} lines from game_lines table")
                        _add_today_lines_to_daily_data(daily_data, fallback_lines, game_name_to_display)
                if not daily_data:
                    return jsonify({"labels": [], "datasets": []})

            # --- Chart.js datasets ---
            display_names = sorted({name for day in daily_data.values() for name in day})
            try:
                sorted_days, datasets = _build_chart_datasets(daily_data, display_names)
            except Exception as e:
                logger.error(f"Error formatting Chart.js datasets: {e}")
                return jsonify({"error": "Failed to format chart data"}), 500

            # --- Heatmap (accumulator + today's live merge) ---
            try:
                heatmap_data = accumulated["heatmap_data"]
                if today_in_range and today_lines:
                    _merge_today_into_heatmap(heatmap_data, calculate_heatmap_data(today_lines, filter_year))
            except Exception as e:
                logger.error(f"Error calculating heatmap data: {e}")
                heatmap_data = {}

            # --- Per-game stats (rollup only) ---
            try:
                total_chars_data, reading_time_data, reading_speed_per_game_data = (
                    _build_per_game_stats(rollup_stats, game_id_to_title)
                )
            except Exception as e:
                logger.error(f"Error extracting per-game stats: {e}")
                total_chars_data = {"labels": [], "totals": []}
                reading_time_data = {"labels": [], "totals": []}
                reading_speed_per_game_data = {"labels": [], "totals": []}

            # --- Current game stats ---
            try:
                current_game_stats = _build_current_game_stats(today_lines, start_timestamp, end_timestamp)
            except Exception as e:
                logger.error(f"Error calculating current game stats: {e}")
                current_game_stats = {}

            # --- All games summary ---
            try:
                all_games_stats = _build_all_games_stats(combined_stats, end_timestamp)
            except Exception as e:
                logger.error(f"Error calculating all games stats: {e}")
                all_games_stats = {}

            # --- Hourly data (rollup only) ---
            try:
                hourly_activity_data, hourly_reading_speed_data = _build_hourly_data(rollup_stats)
            except Exception as e:
                logger.error(f"Error processing hourly data: {e}")
                hourly_activity_data = [0] * 24
                hourly_reading_speed_data = [0] * 24

            # --- Peak statistics ---
            try:
                peak_daily_stats, peak_session_stats = _build_peak_stats(accumulated, live_stats, combined_stats)
            except Exception as e:
                logger.error(f"Error calculating peak stats: {e}")
                peak_daily_stats = {"max_daily_chars": 0, "max_daily_hours": 0.0}
                peak_session_stats = {"longest_session_hours": 0.0, "max_session_chars": 0}

            # --- Reading speed heatmap (accumulator + today's live merge) ---
            try:
                reading_speed_heatmap_data = accumulated["reading_speed_heatmap_data"]
                max_reading_speed = accumulated["max_reading_speed"]
                if today_in_range and today_lines:
                    today_speed_data, _ = calculate_reading_speed_heatmap_data(today_lines, filter_year)
                    for year, dates in today_speed_data.items():
                        if year not in reading_speed_heatmap_data:
                            reading_speed_heatmap_data[year] = {}
                        for date, speed in dates.items():
                            reading_speed_heatmap_data[year][date] = speed
                            max_reading_speed = max(max_reading_speed, speed)
            except Exception as e:
                logger.error(f"Error calculating reading speed heatmap: {e}")
                reading_speed_heatmap_data = {}
                max_reading_speed = 0

            # --- Day of week ---
            try:
                day_of_week_data = _build_day_of_week_data(accumulated)
            except Exception as e:
                logger.error(f"Error calculating day of week activity: {e}")
                day_of_week_data = {"chars": [0] * 7, "hours": [0] * 7, "counts": [0] * 7, "avg_hours": [0] * 7}

            # --- Genre / type stats ---
            try:
                difficulty_speed_data, game_type_data, genre_tag_data, genre_stats, type_stats = (
                    _build_genre_type_stats(rollup_stats, combined_stats)
                )
            except Exception as e:
                logger.error(f"Error calculating genre/type statistics: {e}")
                _empty_label = {"labels": [], "speeds": []}
                difficulty_speed_data = _empty_label
                game_type_data = {"labels": [], "counts": []}
                genre_tag_data = {
                    "genres": {"top_speed": {"labels": [], "speeds": []}, "top_chars": {"labels": [], "chars": []}},
                    "tags": {"top_speed": {"labels": [], "speeds": []}, "top_chars": {"labels": [], "chars": []}},
                }
                _empty_breakdown = {"labels": [], "chars_data": [], "time_data": [], "speed_data": [], "cards_data": []}
                genre_stats = {**_empty_breakdown}
                type_stats = {**_empty_breakdown}

            # --- Time period averages ---
            try:
                time_period_averages = _build_time_period_averages(accumulated, live_stats, start_date_str, end_date_str)
            except Exception as e:
                logger.error(f"Error calculating time period averages: {e}")
                time_period_averages = {"avgHoursPerDay": 0.0, "avgCharsPerDay": 0, "avgSpeedPerDay": 0}

            # --- Cards mined last 30 days (slice from accumulator) ---
            cards_mined_data = accumulated["cards_mined_data"]
            cards_mined_last_30_days = {"labels": [], "totals": []}
            if cards_mined_data["labels"]:
                sl = max(0, len(cards_mined_data["labels"]) - 30)
                cards_mined_last_30_days["labels"] = cards_mined_data["labels"][sl:]
                cards_mined_last_30_days["totals"] = cards_mined_data["totals"][sl:]

            # --- Mining heatmap (accumulator + today's live merge) ---
            mining_heatmap_data = accumulated["mining_heatmap_data"]
            if today_in_range and today_lines:
                _merge_today_into_heatmap(mining_heatmap_data, calculate_mining_heatmap_data(today_lines))

            # --- Assemble response ---
            return jsonify({
                "labels": sorted_days,
                "datasets": datasets,
                "cardsMinedLast30Days": cards_mined_last_30_days,
                "heatmapData": heatmap_data,
                "totalCharsPerGame": total_chars_data,
                "readingTimePerGame": reading_time_data,
                "readingSpeedPerGame": reading_speed_per_game_data,
                "currentGameStats": current_game_stats,
                "allGamesStats": all_games_stats,
                "hourlyActivityData": hourly_activity_data,
                "hourlyReadingSpeedData": hourly_reading_speed_data,
                "peakDailyStats": peak_daily_stats,
                "peakSessionStats": peak_session_stats,
                "readingSpeedHeatmapData": reading_speed_heatmap_data,
                "maxReadingSpeed": max_reading_speed,
                "dayOfWeekData": day_of_week_data,
                "difficultySpeedData": difficulty_speed_data,
                "gameTypeData": game_type_data,
                "genreTagData": genre_tag_data,
                "genreStats": genre_stats,
                "typeStats": type_stats,
                "timePeriodAverages": time_period_averages,
                "miningHeatmapData": mining_heatmap_data,
            })

        except Exception as e:
            logger.exception(f"Unexpected error in api_stats: {e}")
            return jsonify({"error": "Failed to generate statistics"}), 500

    @app.route("/api/stats/kanji-grid")
    def api_stats_kanji_grid():
        """
        Get kanji frequency grid data for the kanji grid visualization.
        ---
        tags:
          - Statistics
        parameters:
          - name: start
            in: query
            type: number
            required: false
            description: Start timestamp (Unix timestamp)
          - name: end
            in: query
            type: number
            required: false
            description: End timestamp (Unix timestamp)
        responses:
          200:
            description: Kanji grid data
            schema:
              type: object
              properties:
                kanji_data:
                  type: array
                  items:
                    type: object
                unique_count:
                  type: integer
                max_frequency:
                  type: integer
        """
        try:
            start_timestamp = request.args.get("start", None)
            end_timestamp = request.args.get("end", None)
            start_timestamp = float(start_timestamp) if start_timestamp else None
            end_timestamp = float(end_timestamp) if end_timestamp else None

            combined_stats, *_ = _build_combined_stats(start_timestamp, end_timestamp)
            return jsonify(_build_kanji_grid_data(combined_stats))
        except Exception as e:
            logger.error(f"Error in kanji grid endpoint: {e}")
            return jsonify({"kanji_data": [], "unique_count": 0, "max_frequency": 0})

    @app.route("/api/stats/game-milestones")
    def api_stats_game_milestones():
        """
        Get game milestone data (oldest and newest games by release year).
        ---
        tags:
          - Statistics
        responses:
          200:
            description: Game milestones data or null
            schema:
              type: object
              properties:
                oldest_game:
                  type: object
                newest_game:
                  type: object
        """
        try:
            return jsonify(calculate_game_milestones())
        except Exception as e:
            logger.error(f"Error in game milestones endpoint: {e}")
            return jsonify(None)

    @app.route("/api/stats/all-lines-data")
    def api_stats_all_lines_data():
        """
        Get per-day line data for overview/heatmap streak calculations.
        ---
        tags:
          - Statistics
        parameters:
          - name: start
            in: query
            type: number
            required: false
            description: Start timestamp (Unix timestamp)
          - name: end
            in: query
            type: number
            required: false
            description: End timestamp (Unix timestamp)
        responses:
          200:
            description: Array of per-day line summaries
            schema:
              type: array
              items:
                type: object
                properties:
                  timestamp:
                    type: number
                  date:
                    type: string
                  characters:
                    type: integer
                  reading_time_seconds:
                    type: integer
        """
        try:
            start_timestamp = request.args.get("start", None)
            end_timestamp = request.args.get("end", None)
            start_timestamp = float(start_timestamp) if start_timestamp else None
            end_timestamp = float(end_timestamp) if end_timestamp else None

            (
                combined_stats, rollup_stats, live_stats,
                rollups, today_lines, start_date_str, end_date_str,
            ) = _build_combined_stats(start_timestamp, end_timestamp)

            today_str = datetime.date.today().strftime("%Y-%m-%d")
            today_in_range = (not end_date_str) or (end_date_str >= today_str)

            # Build game mappings and third-party data for the accumulator
            third_party_by_date = get_third_party_stats_by_date(start_date_str, end_date_str)
            _game_id_to_name, game_name_to_display, game_id_to_title = build_game_mappings_from_games_table()

            # Run the accumulator to get all_lines_data from rollups
            accumulated = _accumulate_rollup_metrics(rollups, None, game_id_to_title, third_party_by_date)
            all_lines_data = accumulated["all_lines_data"]

            # Append today's live lines
            if today_in_range and today_lines:
                for line in today_lines:
                    all_lines_data.append({
                        "timestamp": float(line.timestamp),
                        "date": datetime.date.fromtimestamp(float(line.timestamp)).strftime("%Y-%m-%d"),
                        "characters": len(line.line_text) if line.line_text else 0,
                        "reading_time_seconds": 0,
                    })

            return jsonify(all_lines_data)
        except Exception as e:
            logger.error(f"Error in all-lines-data endpoint: {e}")
            return jsonify([])

    @app.route("/api/mining_heatmap")
    def api_mining_heatmap():
        """
        Provides mining heatmap data showing daily mining activity.
        ---
        tags:
          - Mining
        parameters:
          - name: start
            in: query
            type: number
            required: false
            description: Start timestamp (Unix epoch) for filtering data
          - name: end
            in: query
            type: number
            required: false
            description: End timestamp (Unix epoch) for filtering data
        responses:
          200:
            description: Mining heatmap data with daily counts
            schema:
              type: object
              properties:
                year:
                  type: object
                  additionalProperties:
                    type: object
                    additionalProperties:
                      type: integer
          500:
            description: Failed to generate heatmap data
        """
        try:
            # Get optional timestamp filter parameters
            start_timestamp = request.args.get("start", None)
            end_timestamp = request.args.get("end", None)

            # Convert timestamps to float if provided
            start_timestamp = float(start_timestamp) if start_timestamp else None
            end_timestamp = float(end_timestamp) if end_timestamp else None

            # Fetch lines filtered by timestamp
            all_lines = GameLinesTable.get_lines_filtered_by_timestamp(
                start=start_timestamp, end=end_timestamp, for_stats=True
            )

            if not all_lines:
                return jsonify({}), 200

            # Calculate mining heatmap data
            try:
                heatmap_data = calculate_mining_heatmap_data(all_lines)
            except Exception as e:
                logger.error(f"Error calculating mining heatmap data: {e}")
                return jsonify({"error": "Failed to calculate mining heatmap"}), 500

            return jsonify(heatmap_data), 200

        except Exception as e:
            logger.exception(f"Unexpected error in api_mining_heatmap: {e}")
            return jsonify({"error": "Failed to generate mining heatmap"}), 500

    @app.route("/api/kanji-sorting-configs", methods=["GET"])
    def api_kanji_sorting_configs():
        """
        List available kanji sorting configuration JSON files.
        ---
        tags:
          - Kanji
        responses:
          200:
            description: List of available sorting configurations
            schema:
              type: object
              properties:
                configs:
                  type: array
                  items:
                    type: object
                    properties:
                      filename: {type: string}
                      name: {type: string}
                      version: {type: integer}
                      lang: {type: string}
                      source: {type: string}
                      group_count: {type: integer}
          500:
            description: Failed to fetch configurations
        """
        try:
            # Get the kanji_grid directory path
            template_dir = (
                Path(__file__).parent / "templates" / "components" / "kanji_grid"
            )

            if not template_dir.exists():
                logger.warning(f"Kanji grid directory does not exist: {template_dir}")
                return jsonify({"configs": []}), 200

            configs = []

            # Scan for JSON files in the directory
            for json_file in template_dir.glob("*.json"):
                try:
                    with open(json_file, "r", encoding="utf-8") as f:
                        data = json.load(f)

                        # Extract metadata from JSON
                        configs.append(
                            {
                                "filename": json_file.name,
                                "name": data.get("name", json_file.stem),
                                "version": data.get("version", 1),
                                "lang": data.get("lang", "ja"),
                                "source": data.get("source", ""),
                                "group_count": len(data.get("groups", [])),
                            }
                        )
                except json.JSONDecodeError as e:
                    logger.warning(f"Failed to parse {json_file.name}: {e}")
                    continue
                except Exception as e:
                    logger.warning(f"Error reading {json_file.name}: {e}")
                    continue

            # Sort by name for consistency
            configs.sort(key=lambda x: x["name"])

            return jsonify({"configs": configs}), 200

        except Exception as e:
            logger.error(f"Error fetching kanji sorting configs: {e}")
            return jsonify({"error": "Failed to fetch sorting configurations"}), 500

    @app.route("/api/kanji-sorting-config/<filename>", methods=["GET"])
    def api_kanji_sorting_config(filename):
        """
        Get a specific kanji sorting configuration file.
        ---
        tags:
          - Kanji
        parameters:
          - name: filename
            in: path
            type: string
            required: true
            description: Name of the configuration JSON file
        responses:
          200:
            description: Kanji sorting configuration data
          400:
            description: Invalid filename format
          404:
            description: Configuration file not found
          500:
            description: Failed to load configuration
        """
        try:
            # Sanitize filename to prevent path traversal
            if ".." in filename or "/" in filename or "\\" in filename:
                return jsonify({"error": "Invalid filename"}), 400

            if not filename.endswith(".json"):
                filename += ".json"

            # Get the kanji_grid directory path
            template_dir = (
                Path(__file__).parent / "templates" / "components" / "kanji_grid"
            )
            config_file = template_dir / filename

            if not config_file.exists() or not config_file.is_file():
                return jsonify({"error": "Configuration file not found"}), 404

            # Read and return the JSON configuration
            with open(config_file, "r", encoding="utf-8") as f:
                config_data = json.load(f)

            return jsonify(config_data), 200

        except json.JSONDecodeError as e:
            logger.error(f"Failed to parse {filename}: {e}")
            return jsonify({"error": "Invalid JSON configuration"}), 500
        except Exception as e:
            logger.error(f"Error fetching config {filename}: {e}")
            return jsonify({"error": "Failed to fetch configuration"}), 500

    @app.route("/api/daily-activity", methods=["GET"])
    def api_daily_activity():
        """
        Get daily activity data
        ---
        tags:
          - Statistics
        parameters:
          - name: all_time
            in: query
            type: boolean
            required: false
            description: If true, returns all available data instead of last 4 weeks
            default: false
        responses:
          200:
            description: Daily activity statistics
            schema:
              type: object
              properties:
                labels:
                  type: array
                  items:
                    type: string
                  description: Date labels
                timeData:
                  type: array
                  items:
                    type: number
                  description: Reading time in hours per day
                charsData:
                  type: array
                  items:
                    type: integer
                  description: Characters read per day
                speedData:
                  type: array
                  items:
                    type: integer
                  description: Reading speed (chars/hour) per day
          500:
            description: Failed to fetch daily activity
        """
        try:
            # Check if all-time data is requested
            use_all_time = request.args.get("all_time", "false").lower() == "true"

            today = datetime.date.today()

            if use_all_time:
                # Get all data from first rollup date to today
                first_rollup_date = StatsRollupTable.get_first_date()
                if not first_rollup_date:
                    return jsonify(
                        {"labels": [], "timeData": [], "charsData": [], "speedData": []}
                    ), 200

                start_date = datetime.datetime.strptime(
                    first_rollup_date, "%Y-%m-%d"
                ).date()
            else:
                # Get date range for last 4 weeks (28 days) - INCLUDING today
                start_date = today - datetime.timedelta(days=27)  # 28 days of data

            # Get rollup data for the date range (up to today, inclusive)
            rollups = StatsRollupTable.get_date_range(
                start_date.strftime("%Y-%m-%d"), today.strftime("%Y-%m-%d")
            )

            # Build response data
            labels = []
            time_data = []
            chars_data = []
            speed_data = []

            # Create a map of existing rollup data
            rollup_map = {rollup.date: rollup for rollup in rollups}

            # Fill in all dates in the range (including days with no data)
            current_date = start_date
            while current_date <= today:
                date_str = current_date.strftime("%Y-%m-%d")
                labels.append(date_str)

                if date_str in rollup_map:
                    rollup = rollup_map[date_str]
                    # Convert seconds to hours
                    time_hours = rollup.total_reading_time_seconds / 3600
                    time_data.append(round(time_hours, 2))
                    chars_data.append(rollup.total_characters)

                    # Calculate reading speed (chars/hour)
                    if (
                        rollup.total_reading_time_seconds > 0
                        and rollup.total_characters > 0
                    ):
                        speed = int(rollup.total_characters / time_hours)
                        speed_data.append(speed)
                    else:
                        speed_data.append(0)
                else:
                    # No data for this day
                    time_data.append(0)
                    chars_data.append(0)
                    speed_data.append(0)

                current_date += datetime.timedelta(days=1)

            return jsonify(
                {
                    "labels": labels,
                    "timeData": time_data,
                    "charsData": chars_data,
                    "speedData": speed_data,
                }
            ), 200

        except Exception as e:
            logger.exception(f"Error fetching daily activity: {e}")
            return jsonify({"error": "Failed to fetch daily activity"}), 500

    @app.route("/api/today-stats", methods=["GET"])
    def api_today_stats():
        """
        Calculate and return today's statistics including sessions.
        ---
        tags:
          - Statistics
        responses:
          200:
            description: Today's reading statistics with session details
            schema:
              type: object
              properties:
                todayTotalChars: {type: integer}
                todayCharsPerHour: {type: integer}
                todayTotalHours: {type: number}
                todaySessions: {type: integer}
                sessions:
                  type: array
                  items:
                    type: object
                    properties:
                      startTime: {type: number}
                      endTime: {type: number}
                      gameName: {type: string}
                      totalChars: {type: integer}
                      totalSeconds: {type: number}
                      charsPerHour: {type: integer}
                      gameMetadata: {type: object}
                      lines: {type: array, items: {type: string}}
          500:
            description: Failed to calculate statistics
        """
        try:
            # Get configuration
            config = get_stats_config()
            afk_timer_seconds = config.afk_timer_seconds
            session_gap_seconds = config.session_gap_seconds
            minimum_session_length = 0  # 5 minutes

            # Get today's date range (with cheeky 4AM logic)
            now = datetime.datetime.now()
            today = datetime.date.today()

            if now.hour < 4:
                # If before 4AM, we want to show "Yesterday + Today's early hours"
                # So we fetch from Yesterday 04:00 to Today 04:00
                yesterday = today - datetime.timedelta(days=1, hours=4)
                today_start = datetime.datetime.combine(
                    yesterday, datetime.time(4, 0)
                ).timestamp()
                today_end = datetime.datetime.combine(
                    today, datetime.time(4, 0)
                ).timestamp()
            else:
                # Normal behavior: Today 04:00 to Today 23:59:59
                today_start = datetime.datetime.combine(
                    today, datetime.time(4, 0)
                ).timestamp()
                today_end = datetime.datetime.combine(
                    today, datetime.time.max
                ).timestamp()

            # Query all game lines for today
            today_lines = GameLinesTable.get_lines_filtered_by_timestamp(
                start=today_start, end=today_end, for_stats=True
            )

            # If no lines today, return empty stats
            if not today_lines:
                return jsonify(
                    {
                        "todayTotalChars": 0,
                        "todayCharsPerHour": 0,
                        "todayTotalHours": 0,
                        "todaySessions": 0,
                        "sessions": [],
                    }
                ), 200

            # Sort lines by timestamp
            sorted_lines = sorted(today_lines, key=lambda line: float(line.timestamp))

            # Calculate total characters
            total_chars = sum(
                len(line.line_text) if line.line_text else 0 for line in sorted_lines
            )

            # Calculate total reading time using AFK timer logic
            total_seconds = 0
            timestamps = [float(line.timestamp) for line in sorted_lines]

            if len(timestamps) >= 2:
                for i in range(1, len(timestamps)):
                    gap = timestamps[i] - timestamps[i - 1]
                    total_seconds += min(gap, afk_timer_seconds)
            elif len(timestamps) == 1:
                total_seconds = 1  # Minimal activity

            total_hours = total_seconds / 3600

            # Calculate chars/hour for today
            chars_per_hour = 0
            if total_chars > 0 and total_hours > 0:
                chars_per_hour = round(total_chars / total_hours)

            # Detect sessions
            sessions = []
            current_session = None
            last_timestamp = None
            last_game_name = None

            # Build a cache of game_name -> title_original and full metadata mappings for efficiency
            game_name_to_title = {}
            game_name_to_metadata = {}
            for line in sorted_lines:
                if line.game_name and line.game_name not in game_name_to_title:
                    game_metadata = GamesTable.get_by_game_line(line)
                    if game_metadata:
                        if game_metadata.title_original:
                            game_name_to_title[line.game_name] = (
                                game_metadata.title_original
                            )
                        else:
                            game_name_to_title[line.game_name] = line.game_name

                        # Store full metadata for this game
                        game_name_to_metadata[line.game_name] = {
                            "game_id": game_metadata.id or "",
                            "title_original": game_metadata.title_original or "",
                            "title_romaji": game_metadata.title_romaji or "",
                            "title_english": game_metadata.title_english or "",
                            "type": game_metadata.type or "",
                            "description": game_metadata.description or "",
                            "image": game_metadata.image or "",
                            "character_count": game_metadata.character_count or 0,
                            "difficulty": game_metadata.difficulty,
                            "links": game_metadata.links or [],
                            "completed": game_metadata.completed or False,
                            "genres": game_metadata.genres or [],
                            "tags": game_metadata.tags or [],
                        }
                    else:
                        game_name_to_title[line.game_name] = line.game_name
                        game_name_to_metadata[line.game_name] = None

            for line in sorted_lines:
                ts = float(line.timestamp)
                # Use title_original from games table instead of game_name from game_lines
                raw_game_name = line.game_name or "Unknown Game"
                game_name = game_name_to_title.get(raw_game_name, raw_game_name)
                chars = len(line.line_text) if line.line_text else 0

                # Determine if new session: gap > session_gap OR game changed
                is_new_session = (
                    last_timestamp is not None
                    and ts - last_timestamp > session_gap_seconds
                ) or (last_game_name is not None and game_name != last_game_name)

                if not current_session or is_new_session:
                    # Finish previous session
                    if current_session:
                        # Calculate read speed for session
                        if current_session["totalSeconds"] > 0:
                            session_hours = current_session["totalSeconds"] / 3600
                            current_session["charsPerHour"] = round(
                                current_session["totalChars"] / session_hours
                            )
                        else:
                            current_session["charsPerHour"] = 0

                        # Only add session if it meets minimum length requirement
                        if current_session["totalSeconds"] >= minimum_session_length:
                            sessions.append(current_session)

                    # Start new session with full game metadata
                    game_metadata = game_name_to_metadata.get(raw_game_name)
                    current_session = {
                        "startTime": ts,
                        "endTime": ts,
                        "gameName": game_name,
                        "totalChars": chars,
                        "totalSeconds": 0,
                        "charsPerHour": 0,
                        "gameMetadata": game_metadata,  # Add full game metadata
                        "lines": [line.id],
                    }
                else:
                    # Continue current session
                    current_session["endTime"] = ts
                    current_session["totalChars"] += chars
                    if last_timestamp is not None:
                        gap = ts - last_timestamp
                        current_session["totalSeconds"] += min(gap, afk_timer_seconds)
                    current_session["lines"].append(line.id)

                last_timestamp = ts
                last_game_name = game_name

            # Add the last session
            if current_session:
                if current_session["totalSeconds"] > 0:
                    session_hours = current_session["totalSeconds"] / 3600
                    current_session["charsPerHour"] = round(
                        current_session["totalChars"] / session_hours
                    )
                else:
                    current_session["charsPerHour"] = 0

                # Only add if meets minimum length
                if current_session["totalSeconds"] >= minimum_session_length:
                    sessions.append(current_session)

            # Return response
            return jsonify(
                {
                    "todayTotalChars": total_chars,
                    "todayCharsPerHour": chars_per_hour,
                    "todayTotalHours": round(total_hours, 2),
                    "todaySessions": len(sessions),
                    "sessions": sessions,
                }
            ), 200

        except Exception as e:
            logger.exception(f"Error calculating today's stats: {e}")
            return jsonify({"error": "Failed to calculate today's statistics"}), 500

    @app.route("/api/kanji-frequency")
    def api_kanji_frequency():
        """
        Get total occurrences of a kanji character from rolled up stats.
        ---
        tags:
          - Kanji
        parameters:
          - name: kanji
            in: query
            type: string
            required: true
            description: Single kanji character to look up
        responses:
          200:
            description: Kanji occurrence count
            schema:
              type: object
              properties:
                kanji:
                  type: string
                  description: The kanji character queried
                count:
                  type: integer
                  description: Total number of occurrences
          400:
            description: Invalid kanji parameter
          500:
            description: Failed to calculate kanji frequency
        """
        try:
            kanji = request.args.get("kanji")
            if not kanji or len(kanji) != 1:
                return jsonify({"error": "Invalid kanji parameter"}), 400

            total = 0
            first_date = StatsRollupTable.get_first_date()

            if first_date:
                rollups = StatsRollupTable.get_date_range(
                    first_date, datetime.date.today().strftime("%Y-%m-%d")
                )
                for rollup in rollups:
                    kanji_data = rollup.kanji_frequency_data
                    if isinstance(kanji_data, str):
                        try:
                            kanji_data = json.loads(kanji_data)
                        except json.JSONDecodeError:
                            continue
                    total += kanji_data.get(kanji, 0) if kanji_data else 0

            return jsonify({"kanji": kanji, "count": total})

        except Exception as e:
            logger.exception(f"Error in api_kanji_frequency: {e}")
            return jsonify({"error": "Failed to calculate kanji frequency"}), 500

    @app.route("/api/game/<game_id>/stats")
    def api_game_stats(game_id):
        """
        Get statistics for a specific game.
        ---
        tags:
          - Statistics
        parameters:
          - name: game_id
            in: path
            type: string
            required: true
            description: UUID of the game
        responses:
          200:
            description: Game statistics
          404:
            description: Game not found
          500:
            description: Server error
        """
        try:
            # Look up the game
            game = GamesTable.get(game_id)
            if not game:
                return jsonify({"error": "Game not found"}), 404

            # Get all lines for this game
            game_lines = GameLinesTable.get_all_by_game_id(game_id, for_stats=True)

            if not game_lines:
                # Game exists but has no lines yet
                return jsonify(
                    {
                        "game": {
                            "id": game.id,
                            "title_original": game.title_original or "",
                            "title_romaji": game.title_romaji or "",
                            "title_english": game.title_english or "",
                            "type": game.type or "",
                            "description": game.description or "",
                            "image": game.image or "",
                            "genres": game.genres or [],
                            "tags": game.tags or [],
                            "links": game.links or [],
                            "completed": game.completed or False,
                            "character_count": game.character_count or 0,
                        },
                        "stats": {
                            "total_characters": 0,
                            "total_characters_formatted": "0",
                            "total_time_formatted": "0m",
                            "total_time_hours": 0,
                            "total_cards_mined": 0,
                            "total_sentences": 0,
                            "reading_speed": 0,
                            "reading_speed_formatted": "0",
                            "first_date": "",
                            "last_date": "",
                        },
                        "dailySpeed": {
                            "labels": [],
                            "speedData": [],
                            "charsData": [],
                            "timeData": [],
                            "cardsData": [],
                        },
                        "heatmapData": {},
                    }
                ), 200

            # Compute overview stats from lines
            total_characters = sum(
                len(line.line_text) if line.line_text else 0 for line in game_lines
            )
            total_sentences = len(game_lines)
            total_cards_mined = count_cards_from_lines(game_lines)

            timestamps = [float(line.timestamp) for line in game_lines]
            line_texts = [line.line_text or "" for line in game_lines]
            total_time_seconds = calculate_actual_reading_time(
                timestamps, line_texts=line_texts
            )
            total_time_hours = total_time_seconds / 3600

            reading_speed = (
                int(total_characters / total_time_hours) if total_time_hours > 0 else 0
            )

            first_date = datetime.date.fromtimestamp(min(timestamps)).strftime(
                "%Y-%m-%d"
            )
            last_date = datetime.date.fromtimestamp(max(timestamps)).strftime(
                "%Y-%m-%d"
            )

            # Build daily reading speed time series from rollup data
            today_str = datetime.date.today().strftime("%Y-%m-%d")
            rollups = StatsRollupTable.get_date_range(first_date, today_str)

            daily_labels = []
            daily_speed = []
            daily_chars = []
            daily_time = []

            for rollup in rollups:
                game_activity_raw = rollup.game_activity_data
                if isinstance(game_activity_raw, str):
                    try:
                        game_activity = json.loads(game_activity_raw)
                    except (json.JSONDecodeError, TypeError):
                        game_activity = {}
                elif isinstance(game_activity_raw, dict):
                    game_activity = game_activity_raw
                else:
                    game_activity = {}

                if game_id in game_activity:
                    activity = game_activity[game_id]
                    day_chars = activity.get("chars", 0)
                    day_time_seconds = activity.get("time", 0)
                    day_time_hours = (
                        day_time_seconds / 3600 if day_time_seconds > 0 else 0
                    )
                    day_speed = (
                        int(day_chars / day_time_hours) if day_time_hours > 0 else 0
                    )

                    daily_labels.append(rollup.date)
                    daily_speed.append(day_speed)
                    daily_chars.append(day_chars)
                    daily_time.append(round(day_time_hours, 2))

            # Add today's live data (lines from today that haven't been rolled up)
            today_lines = [
                line
                for line in game_lines
                if datetime.date.fromtimestamp(float(line.timestamp)).strftime(
                    "%Y-%m-%d"
                )
                == today_str
            ]
            # Only add if today is not already in the rollup data
            if today_lines and (not daily_labels or daily_labels[-1] != today_str):
                today_chars = sum(
                    len(line.line_text) if line.line_text else 0 for line in today_lines
                )
                today_timestamps = [float(line.timestamp) for line in today_lines]
                today_time_seconds = calculate_actual_reading_time(today_timestamps)
                today_time_hours = (
                    today_time_seconds / 3600 if today_time_seconds > 0 else 0
                )
                today_speed = (
                    int(today_chars / today_time_hours) if today_time_hours > 0 else 0
                )

                daily_labels.append(today_str)
                daily_speed.append(today_speed)
                daily_chars.append(today_chars)
                daily_time.append(round(today_time_hours, 2))

            # Build daily cards mined from game_lines grouped by date
            daily_cards = []
            cards_by_date = {}
            for line in game_lines:
                line_date = datetime.date.fromtimestamp(
                    float(line.timestamp)
                ).strftime("%Y-%m-%d")
                cards_by_date.setdefault(line_date, 0)
                cards_by_date[line_date] += count_cards_from_line(line)
            for label in daily_labels:
                daily_cards.append(cards_by_date.get(label, 0))

            # Build heatmap data (year -> date -> speed) for reading speed heatmap
            heatmap_data = {}
            for i, label in enumerate(daily_labels):
                year = label[:4]
                heatmap_data.setdefault(year, {})
                heatmap_data[year][label] = daily_speed[i]

            return jsonify(
                {
                    "game": {
                        "id": game.id,
                        "title_original": game.title_original or "",
                        "title_romaji": game.title_romaji or "",
                        "title_english": game.title_english or "",
                        "type": game.type or "",
                        "description": game.description or "",
                        "image": game.image or "",
                        "genres": game.genres or [],
                        "tags": game.tags or [],
                        "links": game.links or [],
                        "completed": game.completed or False,
                        "character_count": game.character_count or 0,
                    },
                    "stats": {
                        "total_characters": total_characters,
                        "total_characters_formatted": format_large_number(
                            total_characters
                        ),
                        "total_time_formatted": format_time_human_readable(
                            total_time_hours
                        ),
                        "total_time_hours": round(total_time_hours, 2),
                        "total_cards_mined": total_cards_mined,
                        "total_sentences": total_sentences,
                        "reading_speed": reading_speed,
                        "reading_speed_formatted": format_large_number(reading_speed),
                        "first_date": first_date,
                        "last_date": last_date,
                    },
                    "dailySpeed": {
                        "labels": daily_labels,
                        "speedData": daily_speed,
                        "charsData": daily_chars,
                        "timeData": daily_time,
                        "cardsData": daily_cards,
                    },
                    "heatmapData": heatmap_data,
                }
            ), 200

        except Exception as e:
            logger.exception(f"Error calculating game stats for {game_id}: {e}")
            return jsonify({"error": "Failed to calculate game statistics"}), 500
