"""
Rollup Statistics Module

This module handles all rollup-based statistics calculations for optimal performance.
It aggregates pre-calculated daily rollup data instead of processing individual lines.

Key Performance Strategy:
- Use StatsRollupTable for historical data (fast aggregation)
- Calculate only today's data live from GameLinesTable
- Combine rollup + live data for complete statistics
"""

import datetime
import json
from collections import defaultdict
from typing import Dict, List, Optional

from GameSentenceMiner.util.stats_rollup_table import StatsRollupTable
from GameSentenceMiner.util.db import GameLinesTable
from GameSentenceMiner.util.configuration import logger


def aggregate_rollup_data(rollups: List) -> Dict:
    """
    Aggregate multiple daily rollup records into a single statistics object.

    Args:
        rollups: List of StatsRollupTable records

    Returns:
        Dictionary with aggregated statistics matching the stats API format
    """
    if not rollups:
        return {
            "total_lines": 0,
            "total_characters": 0,
            "total_sessions": 0,
            "unique_games_played": 0,
            "total_reading_time_seconds": 0.0,
            "total_active_time_seconds": 0.0,
            "average_reading_speed_chars_per_hour": 0.0,
            "peak_reading_speed_chars_per_hour": 0.0,
            "longest_session_seconds": 0.0,
            "shortest_session_seconds": 0.0,
            "average_session_seconds": 0.0,
            "max_chars_in_session": 0,
            "max_time_in_session_seconds": 0.0,
            "games_completed": 0,
            "games_started": 0,
            "anki_cards_created": 0,
            "lines_with_screenshots": 0,
            "lines_with_audio": 0,
            "lines_with_translations": 0,
            "unique_kanji_seen": 0,
            "kanji_frequency_data": {},
            "hourly_activity_data": {},
            "hourly_reading_speed_data": {},
            "game_activity_data": {},
            "games_played_ids": [],
        }

    # ADDITIVE fields - sum across all days
    total_lines = sum(r.total_lines for r in rollups)
    total_characters = sum(r.total_characters for r in rollups)
    total_sessions = sum(r.total_sessions for r in rollups)
    total_reading_time = sum(r.total_reading_time_seconds for r in rollups)
    total_active_time = sum(r.total_active_time_seconds for r in rollups)
    anki_cards_created = sum(r.anki_cards_created for r in rollups)
    lines_with_screenshots = sum(r.lines_with_screenshots for r in rollups)
    lines_with_audio = sum(r.lines_with_audio for r in rollups)
    lines_with_translations = sum(r.lines_with_translations for r in rollups)
    games_completed = sum(r.games_completed for r in rollups)

    # MAXIMUM fields - take highest value across all days
    peak_reading_speed = max(
        (r.peak_reading_speed_chars_per_hour for r in rollups), default=0.0
    )
    longest_session = max((r.longest_session_seconds for r in rollups), default=0.0)
    max_chars_in_session = max((r.max_chars_in_session for r in rollups), default=0)
    max_time_in_session = max(
        (r.max_time_in_session_seconds for r in rollups), default=0.0
    )

    # MINIMUM field - take smallest non-zero value
    shortest_session_values = [
        r.shortest_session_seconds for r in rollups if r.shortest_session_seconds > 0
    ]
    shortest_session = min(shortest_session_values) if shortest_session_values else 0.0

    # WEIGHTED AVERAGE - average reading speed weighted by active time
    if total_active_time > 0:
        weighted_speed_sum = sum(
            r.average_reading_speed_chars_per_hour * r.total_active_time_seconds
            for r in rollups
            if r.total_active_time_seconds > 0
        )
        avg_reading_speed = weighted_speed_sum / total_active_time
    else:
        avg_reading_speed = 0.0

    # WEIGHTED AVERAGE - average session duration weighted by number of sessions
    if total_sessions > 0:
        weighted_session_sum = sum(
            r.average_session_seconds * r.total_sessions
            for r in rollups
            if r.total_sessions > 0
        )
        avg_session_seconds = weighted_session_sum / total_sessions
    else:
        avg_session_seconds = 0.0

    # MERGE - Combine game IDs (union)
    all_games_played = set()
    for rollup in rollups:
        if rollup.games_played_ids:
            try:
                games_ids = (
                    json.loads(rollup.games_played_ids)
                    if isinstance(rollup.games_played_ids, str)
                    else rollup.games_played_ids
                )
                all_games_played.update(games_ids)
            except (json.JSONDecodeError, TypeError):
                logger.warning(
                    f"Failed to parse games_played_ids for rollup date {rollup.date}"
                )

    # MERGE - Combine game activity data (sum chars/time/lines per game)
    combined_game_activity = {}
    for rollup in rollups:
        if rollup.game_activity_data:
            try:
                game_data = (
                    json.loads(rollup.game_activity_data)
                    if isinstance(rollup.game_activity_data, str)
                    else rollup.game_activity_data
                )
                for game_id, activity in game_data.items():
                    if game_id in combined_game_activity:
                        combined_game_activity[game_id]["chars"] += activity.get(
                            "chars", 0
                        )
                        combined_game_activity[game_id]["time"] += activity.get(
                            "time", 0
                        )
                        combined_game_activity[game_id]["lines"] += activity.get(
                            "lines", 0
                        )
                    else:
                        combined_game_activity[game_id] = {
                            "title": activity.get("title", f"Game {game_id}"),
                            "chars": activity.get("chars", 0),
                            "time": activity.get("time", 0),
                            "lines": activity.get("lines", 0),
                        }
            except (json.JSONDecodeError, TypeError):
                logger.warning(
                    f"Failed to parse game_activity_data for rollup date {rollup.date}"
                )

    # MERGE - Combine kanji frequency data (sum frequencies)
    combined_kanji_frequency = {}
    for rollup in rollups:
        if rollup.kanji_frequency_data:
            try:
                kanji_data = (
                    json.loads(rollup.kanji_frequency_data)
                    if isinstance(rollup.kanji_frequency_data, str)
                    else rollup.kanji_frequency_data
                )
                for kanji, count in kanji_data.items():
                    combined_kanji_frequency[kanji] = (
                        combined_kanji_frequency.get(kanji, 0) + count
                    )
            except (json.JSONDecodeError, TypeError):
                logger.warning(
                    f"Failed to parse kanji_frequency_data for rollup date {rollup.date}"
                )

    # MERGE - Combine hourly activity data (sum characters per hour)
    combined_hourly_activity = {}
    for rollup in rollups:
        if rollup.hourly_activity_data:
            try:
                hourly_data = (
                    json.loads(rollup.hourly_activity_data)
                    if isinstance(rollup.hourly_activity_data, str)
                    else rollup.hourly_activity_data
                )
                for hour, chars in hourly_data.items():
                    combined_hourly_activity[hour] = (
                        combined_hourly_activity.get(hour, 0) + chars
                    )
            except (json.JSONDecodeError, TypeError):
                logger.warning(
                    f"Failed to parse hourly_activity_data for rollup date {rollup.date}"
                )

    # MERGE - Combine hourly reading speeds (average across days for each hour)
    hourly_speed_lists = defaultdict(list)
    for rollup in rollups:
        if rollup.hourly_reading_speed_data:
            try:
                speed_data = (
                    json.loads(rollup.hourly_reading_speed_data)
                    if isinstance(rollup.hourly_reading_speed_data, str)
                    else rollup.hourly_reading_speed_data
                )
                for hour, speed in speed_data.items():
                    if speed > 0:
                        hourly_speed_lists[hour].append(speed)
            except (json.JSONDecodeError, TypeError):
                logger.warning(
                    f"Failed to parse hourly_reading_speed_data for rollup date {rollup.date}"
                )

    # Average the speeds for each hour
    combined_hourly_speeds = {}
    for hour, speeds in hourly_speed_lists.items():
        combined_hourly_speeds[hour] = sum(speeds) / len(speeds) if speeds else 0

    return {
        "total_lines": total_lines,
        "total_characters": total_characters,
        "total_sessions": total_sessions,
        "unique_games_played": len(all_games_played),
        "total_reading_time_seconds": total_reading_time,
        "total_active_time_seconds": total_active_time,
        "average_reading_speed_chars_per_hour": avg_reading_speed,
        "peak_reading_speed_chars_per_hour": peak_reading_speed,
        "longest_session_seconds": longest_session,
        "shortest_session_seconds": shortest_session,
        "average_session_seconds": avg_session_seconds,
        "max_chars_in_session": max_chars_in_session,
        "max_time_in_session_seconds": max_time_in_session,
        "games_completed": games_completed,
        "games_started": len(all_games_played),
        "anki_cards_created": anki_cards_created,
        "lines_with_screenshots": lines_with_screenshots,
        "lines_with_audio": lines_with_audio,
        "lines_with_translations": lines_with_translations,
        "unique_kanji_seen": len(combined_kanji_frequency),
        "kanji_frequency_data": combined_kanji_frequency,
        "hourly_activity_data": combined_hourly_activity,
        "hourly_reading_speed_data": combined_hourly_speeds,
        "game_activity_data": combined_game_activity,
        "games_played_ids": list(all_games_played),
    }


def calculate_live_stats_for_today(today_lines: List) -> Dict:
    """
    Calculate live statistics for today using existing stats.py functions.

    Args:
        today_lines: List of GameLinesTable records for today

    Returns:
        Dictionary with today's statistics in rollup format
    """
    if not today_lines:
        return aggregate_rollup_data([])  # Return empty stats

    # Import here to avoid circular dependency
    from GameSentenceMiner.util.cron.daily_rollup import (
        analyze_sessions,
        analyze_hourly_data,
        analyze_game_activity,
        analyze_kanji_data,
    )

    # Calculate basic stats
    total_lines = len(today_lines)
    total_characters = sum(
        len(line.line_text) if line.line_text else 0 for line in today_lines
    )

    # Calculate Anki integration stats
    lines_with_screenshots = sum(
        1
        for line in today_lines
        if line.screenshot_in_anki and line.screenshot_in_anki.strip()
    )
    lines_with_audio = sum(
        1 for line in today_lines if line.audio_in_anki and line.audio_in_anki.strip()
    )
    lines_with_translations = sum(
        1 for line in today_lines if line.translation and line.translation.strip()
    )
    anki_cards = sum(
        1
        for line in today_lines
        if (line.screenshot_in_anki and line.screenshot_in_anki.strip())
        or (line.audio_in_anki and line.audio_in_anki.strip())
    )

    # Analyze sessions
    session_stats = analyze_sessions(today_lines)

    # Calculate reading speeds
    total_time_seconds = session_stats["total_time"]
    total_time_hours = total_time_seconds / 3600 if total_time_seconds > 0 else 0
    average_speed = (
        (total_characters / total_time_hours) if total_time_hours > 0 else 0.0
    )

    # Calculate peak speed (best hourly speed)
    hourly_data = analyze_hourly_data(today_lines)
    peak_speed = (
        max(hourly_data["hourly_speeds"].values())
        if hourly_data["hourly_speeds"]
        else 0.0
    )

    # Analyze game activity
    today_str = datetime.date.today().strftime("%Y-%m-%d")
    game_activity = analyze_game_activity(today_lines, today_str)

    # Analyze kanji
    kanji_data = analyze_kanji_data(today_lines)

    return {
        "total_lines": total_lines,
        "total_characters": total_characters,
        "total_sessions": session_stats["count"],
        "unique_games_played": len(game_activity["game_ids"]),
        "total_reading_time_seconds": total_time_seconds,
        "total_active_time_seconds": session_stats["active_time"],
        "average_reading_speed_chars_per_hour": average_speed,
        "peak_reading_speed_chars_per_hour": peak_speed,
        "longest_session_seconds": session_stats["longest"],
        "shortest_session_seconds": session_stats["shortest"],
        "average_session_seconds": session_stats["average"],
        "max_chars_in_session": session_stats["max_chars"],
        "max_time_in_session_seconds": session_stats["max_time"],
        "games_completed": game_activity["completed"],
        "games_started": game_activity["started"],
        "anki_cards_created": anki_cards,
        "lines_with_screenshots": lines_with_screenshots,
        "lines_with_audio": lines_with_audio,
        "lines_with_translations": lines_with_translations,
        "unique_kanji_seen": kanji_data["unique_count"],
        "kanji_frequency_data": kanji_data["frequencies"],
        "hourly_activity_data": hourly_data["hourly_activity"],
        "hourly_reading_speed_data": hourly_data["hourly_speeds"],
        "game_activity_data": game_activity["details"],
        "games_played_ids": game_activity["game_ids"],
    }


def combine_rollup_and_live_stats(rollup_stats: Dict, live_stats: Dict) -> Dict:
    """
    Combine rollup statistics with live statistics for today.

    Args:
        rollup_stats: Aggregated rollup statistics (can be None)
        live_stats: Live calculated statistics for today (can be None)

    Returns:
        Combined statistics dictionary
    """
    if not rollup_stats and not live_stats:
        return aggregate_rollup_data([])  # Return empty stats
    elif not rollup_stats:
        return live_stats
    elif not live_stats:
        return rollup_stats

    # Combine both datasets
    combined = {}

    # ADDITIVE fields - sum rollup + live
    additive_fields = [
        "total_lines",
        "total_characters",
        "total_sessions",
        "total_reading_time_seconds",
        "total_active_time_seconds",
        "games_completed",
        "anki_cards_created",
        "lines_with_screenshots",
        "lines_with_audio",
        "lines_with_translations",
    ]

    for field in additive_fields:
        combined[field] = rollup_stats.get(field, 0) + live_stats.get(field, 0)

    # MAXIMUM fields - take highest value
    max_fields = [
        "peak_reading_speed_chars_per_hour",
        "longest_session_seconds",
        "max_chars_in_session",
        "max_time_in_session_seconds",
    ]

    for field in max_fields:
        combined[field] = max(rollup_stats.get(field, 0), live_stats.get(field, 0))

    # MINIMUM field - take smallest non-zero value
    rollup_shortest = rollup_stats.get("shortest_session_seconds", 0)
    live_shortest = live_stats.get("shortest_session_seconds", 0)
    if rollup_shortest > 0 and live_shortest > 0:
        combined["shortest_session_seconds"] = min(rollup_shortest, live_shortest)
    elif rollup_shortest > 0:
        combined["shortest_session_seconds"] = rollup_shortest
    elif live_shortest > 0:
        combined["shortest_session_seconds"] = live_shortest
    else:
        combined["shortest_session_seconds"] = 0.0

    # WEIGHTED AVERAGE - average reading speed weighted by active time
    rollup_time = rollup_stats.get("total_active_time_seconds", 0)
    live_time = live_stats.get("total_active_time_seconds", 0)
    total_time = rollup_time + live_time

    if total_time > 0:
        combined["average_reading_speed_chars_per_hour"] = (
            rollup_stats.get("average_reading_speed_chars_per_hour", 0) * rollup_time
            + live_stats.get("average_reading_speed_chars_per_hour", 0) * live_time
        ) / total_time
    else:
        combined["average_reading_speed_chars_per_hour"] = 0.0

    # WEIGHTED AVERAGE - average session duration weighted by session count
    rollup_sessions = rollup_stats.get("total_sessions", 0)
    live_sessions = live_stats.get("total_sessions", 0)
    total_sessions = rollup_sessions + live_sessions

    if total_sessions > 0:
        combined["average_session_seconds"] = (
            rollup_stats.get("average_session_seconds", 0) * rollup_sessions
            + live_stats.get("average_session_seconds", 0) * live_sessions
        ) / total_sessions
    else:
        combined["average_session_seconds"] = 0.0

    # MERGE - Combine unique games (union)
    rollup_games = set(rollup_stats.get("games_played_ids", []))
    live_games = set(live_stats.get("games_played_ids", []))
    all_games = rollup_games.union(live_games)
    combined["unique_games_played"] = len(all_games)
    combined["games_played_ids"] = list(all_games)
    combined["games_started"] = len(all_games)

    # MERGE - Combine kanji frequency data (sum frequencies)
    rollup_kanji = rollup_stats.get("kanji_frequency_data", {})
    live_kanji = live_stats.get("kanji_frequency_data", {})
    combined_kanji = {}

    for kanji, count in rollup_kanji.items():
        combined_kanji[kanji] = count
    for kanji, count in live_kanji.items():
        combined_kanji[kanji] = combined_kanji.get(kanji, 0) + count

    combined["kanji_frequency_data"] = combined_kanji
    combined["unique_kanji_seen"] = len(combined_kanji)

    # MERGE - Combine hourly activity data (sum characters per hour)
    rollup_hourly = rollup_stats.get("hourly_activity_data", {})
    live_hourly = live_stats.get("hourly_activity_data", {})
    combined_hourly = {}

    for hour in set(list(rollup_hourly.keys()) + list(live_hourly.keys())):
        combined_hourly[hour] = rollup_hourly.get(hour, 0) + live_hourly.get(hour, 0)

    combined["hourly_activity_data"] = combined_hourly

    # MERGE - Combine hourly reading speed data (average)
    rollup_speeds = rollup_stats.get("hourly_reading_speed_data", {})
    live_speeds = live_stats.get("hourly_reading_speed_data", {})
    combined_speeds = {}

    for hour in set(list(rollup_speeds.keys()) + list(live_speeds.keys())):
        speeds = []
        if hour in rollup_speeds and rollup_speeds[hour] > 0:
            speeds.append(rollup_speeds[hour])
        if hour in live_speeds and live_speeds[hour] > 0:
            speeds.append(live_speeds[hour])
        combined_speeds[hour] = sum(speeds) / len(speeds) if speeds else 0

    combined["hourly_reading_speed_data"] = combined_speeds

    # MERGE - Combine game activity data (sum chars/time/lines per game)
    rollup_games_activity = rollup_stats.get("game_activity_data", {})
    live_games_activity = live_stats.get("game_activity_data", {})
    combined_games_activity = {}

    for game_id in set(
        list(rollup_games_activity.keys()) + list(live_games_activity.keys())
    ):
        rollup_activity = rollup_games_activity.get(
            game_id, {"chars": 0, "time": 0, "lines": 0}
        )
        live_activity = live_games_activity.get(
            game_id, {"chars": 0, "time": 0, "lines": 0}
        )

        combined_games_activity[game_id] = {
            "title": rollup_activity.get("title")
            or live_activity.get("title", f"Game {game_id}"),
            "chars": rollup_activity.get("chars", 0) + live_activity.get("chars", 0),
            "time": rollup_activity.get("time", 0) + live_activity.get("time", 0),
            "lines": rollup_activity.get("lines", 0) + live_activity.get("lines", 0),
        }

    combined["game_activity_data"] = combined_games_activity

    return combined


def build_heatmap_from_rollup(rollups: List, filter_year: Optional[str] = None) -> Dict:
    """
    Build heatmap data from rollup records instead of individual lines.
    Much faster than processing all lines.

    Args:
        rollups: List of StatsRollupTable records
        filter_year: Optional year filter (e.g., "2024")

    Returns:
        Dictionary mapping year -> date -> character count
    """
    heatmap_data = defaultdict(lambda: defaultdict(int))

    for rollup in rollups:
        date_str = rollup.date  # Already in YYYY-MM-DD format
        year = date_str.split("-")[0]

        # Filter by year if specified
        if filter_year and year != filter_year:
            continue

        # Use total_characters from rollup
        heatmap_data[year][date_str] = rollup.total_characters

    return dict(heatmap_data)


def build_daily_chart_data_from_rollup(rollups: List) -> Dict:
    """
    Build daily chart data structure from rollup records.
    Returns data organized by date and game for chart visualization.

    Args:
        rollups: List of StatsRollupTable records

    Returns:
        Dictionary with daily_data structure for charts
    """
    daily_data = defaultdict(lambda: defaultdict(lambda: {"lines": 0, "chars": 0}))

    for rollup in rollups:
        date_str = rollup.date
        if rollup.game_activity_data:
            try:
                game_data = (
                    json.loads(rollup.game_activity_data)
                    if isinstance(rollup.game_activity_data, str)
                    else rollup.game_activity_data
                )

                for game_id, activity in game_data.items():
                    display_name = activity.get("title", f"Game {game_id}")
                    daily_data[date_str][display_name]["lines"] = activity.get(
                        "lines", 0
                    )
                    daily_data[date_str][display_name]["chars"] = activity.get(
                        "chars", 0
                    )
            except (json.JSONDecodeError, KeyError, TypeError) as e:
                logger.warning(f"Error parsing rollup data for {date_str}: {e}")
                continue

    return daily_data


def calculate_day_of_week_averages_from_rollup(rollups: List) -> Dict:
    """
    Pre-compute day of week activity averages from rollup data.
    This is much faster than calculating on every API request.
    
    Args:
        rollups: List of StatsRollupTable records
        
    Returns:
        Dictionary with day of week data including averages:
        {
            "chars": [Mon, Tue, Wed, Thu, Fri, Sat, Sun],
            "hours": [Mon, Tue, Wed, Thu, Fri, Sat, Sun],
            "counts": [Mon, Tue, Wed, Thu, Fri, Sat, Sun],
            "avg_hours": [Mon, Tue, Wed, Thu, Fri, Sat, Sun]
        }
    """
    day_of_week_data = {
        "chars": [0] * 7,
        "hours": [0] * 7,
        "counts": [0] * 7,
        "avg_hours": [0] * 7
    }
    
    for rollup in rollups:
        try:
            date_obj = datetime.datetime.strptime(rollup.date, "%Y-%m-%d")
            day_of_week = date_obj.weekday()  # 0=Monday, 6=Sunday
            day_of_week_data["chars"][day_of_week] += rollup.total_characters
            day_of_week_data["hours"][day_of_week] += rollup.total_reading_time_seconds / 3600
            day_of_week_data["counts"][day_of_week] += 1
        except (ValueError, AttributeError) as e:
            logger.warning(f"Error parsing date for rollup {rollup.date}: {e}")
            continue
    
    # Calculate averages
    for i in range(7):
        if day_of_week_data["counts"][i] > 0:
            day_of_week_data["avg_hours"][i] = round(
                day_of_week_data["hours"][i] / day_of_week_data["counts"][i], 2
            )
    
    return day_of_week_data


def calculate_difficulty_speed_from_rollup(combined_stats: Dict) -> Dict:
    """
    Pre-compute reading speed by difficulty from rollup game activity data.
    This avoids recalculating on every API request.
    
    Args:
        combined_stats: Combined rollup statistics with game_activity_data
        
    Returns:
        Dictionary with difficulty speed data:
        {
            "labels": ["Difficulty 1", "Difficulty 2", ...],
            "speeds": [speed1, speed2, ...]
        }
    """
    from GameSentenceMiner.util.games_table import GamesTable
    
    difficulty_speed_data = {"labels": [], "speeds": []}
    
    try:
        # Get all games with difficulty ratings
        all_games = GamesTable.all()
        difficulty_groups = {}  # difficulty -> {chars: total, time: total}
        
        for game in all_games:
            if game.difficulty is not None:
                difficulty = game.difficulty
                if difficulty not in difficulty_groups:
                    difficulty_groups[difficulty] = {"chars": 0, "time": 0}
                
                # Get stats for this game from game_activity_data
                game_activity = combined_stats.get("game_activity_data", {})
                if game.id in game_activity:
                    activity = game_activity[game.id]
                    difficulty_groups[difficulty]["chars"] += activity.get("chars", 0)
                    difficulty_groups[difficulty]["time"] += activity.get("time", 0)
        
        # Calculate average speed for each difficulty
        for difficulty in sorted(difficulty_groups.keys()):
            data = difficulty_groups[difficulty]
            if data["time"] > 0 and data["chars"] > 0:
                hours = data["time"] / 3600
                speed = int(data["chars"] / hours)
                difficulty_speed_data["labels"].append(f"Difficulty {difficulty}")
                difficulty_speed_data["speeds"].append(speed)
                
    except Exception as e:
        logger.error(f"Error calculating difficulty speed from rollup: {e}")
    
    return difficulty_speed_data
