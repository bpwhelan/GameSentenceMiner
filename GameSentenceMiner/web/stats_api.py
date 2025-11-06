"""
Statistics API Endpoints

This module contains the /api/stats endpoint and related statistics API routes.
Separated from database_api.py to improve code organization and maintainability.
"""

import csv
import datetime
import io
import json
import time
from collections import defaultdict
from pathlib import Path

from flask import request, jsonify

from GameSentenceMiner.util.db import GameLinesTable
from GameSentenceMiner.util.stats_rollup_table import StatsRollupTable
from GameSentenceMiner.util.games_table import GamesTable
from GameSentenceMiner.util.configuration import logger, get_stats_config
from GameSentenceMiner.util.text_log import GameLine
from GameSentenceMiner.util.cron.daily_rollup import run_daily_rollup
from GameSentenceMiner.web.stats import (
    calculate_kanji_frequency,
    calculate_mining_heatmap_data,
    calculate_reading_speed_heatmap_data,
    calculate_total_chars_per_game,
    calculate_reading_time_per_game,
    calculate_reading_speed_per_game,
    calculate_current_game_stats,
    calculate_all_games_stats,
    calculate_daily_reading_time,
    calculate_time_based_streak,
    calculate_actual_reading_time,
    calculate_hourly_activity,
    calculate_hourly_reading_speed,
    calculate_peak_daily_stats,
    calculate_peak_session_stats,
    calculate_game_milestones,
    build_game_display_name_mapping,
    format_large_number,
    format_time_human_readable,
)
from GameSentenceMiner.web.rollup_stats import (
    aggregate_rollup_data,
    calculate_live_stats_for_today,
    combine_rollup_and_live_stats,
    build_heatmap_from_rollup,
    build_daily_chart_data_from_rollup,
    calculate_day_of_week_averages_from_rollup,
    calculate_difficulty_speed_from_rollup,
)


def register_stats_api_routes(app):
    """Register statistics API routes with the Flask app."""

    @app.route("/api/stats")
    def api_stats():
        """
        Provides aggregated, cumulative stats for charting.
        Accepts optional 'year' parameter to filter heatmap data.
        Uses hybrid rollup + live approach for performance.
        """
        try:
            # Performance timing
            request_start_time = time.time()

            # Get optional year filter parameter
            filter_year = request.args.get("year", None)

            # Get Start and End time as unix timestamp
            start_timestamp = request.args.get("start", None)
            end_timestamp = request.args.get("end", None)

            # Convert timestamps to float if provided
            start_timestamp = float(start_timestamp) if start_timestamp else None
            end_timestamp = float(end_timestamp) if end_timestamp else None

            # === HYBRID ROLLUP + LIVE APPROACH ===
            # Convert timestamps to date strings for rollup queries
            today = datetime.date.today()
            today_str = today.strftime("%Y-%m-%d")

            # Determine date range
            if start_timestamp and end_timestamp:
                start_date = datetime.date.fromtimestamp(start_timestamp)
                end_date = datetime.date.fromtimestamp(end_timestamp)
                start_date_str = start_date.strftime("%Y-%m-%d")
                end_date_str = end_date.strftime("%Y-%m-%d")
            else:
                # Default: all history - get first date from rollup table
                first_rollup_date = StatsRollupTable.get_first_date()

                start_date_str = first_rollup_date if first_rollup_date else today_str
                end_date_str = today_str

            # Check if today is in the date range
            today_in_range = (not end_date_str) or (end_date_str >= today_str)

            # Query rollup data for historical dates (up to yesterday)
            rollup_query_start = time.time()
            rollup_stats = None
            if start_date_str:
                # Calculate yesterday
                yesterday = today - datetime.timedelta(days=1)
                yesterday_str = yesterday.strftime("%Y-%m-%d")

                # Only query rollup if we have historical dates
                if start_date_str <= yesterday_str:
                    rollup_end = (
                        min(end_date_str, yesterday_str)
                        if end_date_str
                        else yesterday_str
                    )

                    rollups = StatsRollupTable.get_date_range(
                        start_date_str, rollup_end
                    )

                    if rollups:
                        rollup_stats = aggregate_rollup_data(rollups)

            # Calculate today's stats live if needed
            live_stats_start = time.time()
            live_stats = None
            if today_in_range:
                today_start = datetime.datetime.combine(
                    today, datetime.time.min
                ).timestamp()
                today_end = datetime.datetime.combine(
                    today, datetime.time.max
                ).timestamp()
                today_lines = GameLinesTable.get_lines_filtered_by_timestamp(
                    start=today_start, end=today_end, for_stats=True
                )

                if today_lines:
                    live_stats = calculate_live_stats_for_today(today_lines)
            # Combine rollup and live stats
            combined_stats = combine_rollup_and_live_stats(rollup_stats, live_stats)

            # Build game mappings from GamesTable
            # This replaces the expensive all_lines fetch that was used just for mapping
            def build_game_mappings_from_games_table():
                """
                Build game_id and game_name mappings from GamesTable.
                Much faster than scanning all game lines.

                Returns:
                    tuple: (game_id_to_game_name, game_name_to_title, game_id_to_title)
                """
                all_games = GamesTable.all()

                game_id_to_game_name = {}
                game_name_to_title = {}
                game_id_to_title = {}

                for game in all_games:
                    # game_id -> obs_scene_name (game_name)
                    if game.id and game.obs_scene_name:
                        game_id_to_game_name[game.id] = game.obs_scene_name

                    # game_id -> title_original
                    if game.id and game.title_original:
                        game_id_to_title[game.id] = game.title_original

                    # game_name -> title_original (for display)
                    if game.obs_scene_name and game.title_original:
                        game_name_to_title[game.obs_scene_name] = game.title_original
                    elif game.obs_scene_name:
                        # Fallback: use obs_scene_name as title
                        game_name_to_title[game.obs_scene_name] = game.obs_scene_name

                return game_id_to_game_name, game_name_to_title, game_id_to_title

            # Build all mappings from GamesTable (FAST!)
            game_id_to_game_name, game_name_to_display, game_id_to_title = (
                build_game_mappings_from_games_table()
            )

            # Also extract titles from rollup data as fallback for games not in GamesTable
            game_activity = combined_stats.get("game_activity_data", {})
            for game_id, activity in game_activity.items():
                title = activity.get("title", f"Game {game_id}")
                if game_id not in game_id_to_title:
                    game_id_to_title[game_id] = title
                    logger.debug(
                        f"[TITLE_DEBUG] Using rollup title for game_id={game_id[:8]}..., title='{title}'"
                    )

            # === PERFORMANCE OPTIMIZATION: Only fetch today's lines for live calculations ===
            today_lines_for_charts = []
            if today_in_range:
                today_start = datetime.datetime.combine(
                    today, datetime.time.min
                ).timestamp()
                today_end = datetime.datetime.combine(
                    today, datetime.time.max
                ).timestamp()
                # IMPORTANT: Do NOT use for_stats=True here to ensure consistent character counting
                # for_stats=True removes punctuation which causes discrepancies with SQL LENGTH()
                today_lines_for_charts = GameLinesTable.get_lines_filtered_by_timestamp(
                    start=today_start, end=today_end, for_stats=True
                )

            cards_mined_last_30_days = {"labels": [], "totals": []}

            last_rollup_date_str = StatsRollupTable.get_last_date()
            if last_rollup_date_str:
                cards_range_end = datetime.datetime.strptime(
                    last_rollup_date_str, "%Y-%m-%d"
                ).date()

                if end_date_str:
                    requested_end_date = datetime.datetime.strptime(
                        end_date_str, "%Y-%m-%d"
                    ).date()
                    if requested_end_date < cards_range_end:
                        cards_range_end = requested_end_date

                requested_start_date = None
                if start_date_str:
                    requested_start_date = datetime.datetime.strptime(
                        start_date_str, "%Y-%m-%d"
                    ).date()
                    if requested_start_date > cards_range_end:
                        cards_range_end = None

                if cards_range_end:
                    cards_range_start = cards_range_end - datetime.timedelta(days=29)
                    if requested_start_date and cards_range_start < requested_start_date:
                        cards_range_start = requested_start_date

                    if cards_range_start <= cards_range_end:
                        cards_rollups = StatsRollupTable.get_date_range(
                            cards_range_start.strftime("%Y-%m-%d"),
                            cards_range_end.strftime("%Y-%m-%d"),
                        )
                        if cards_rollups:
                            cards_mined_last_30_days["labels"] = [
                                rollup.date for rollup in cards_rollups
                            ]
                            cards_mined_last_30_days["totals"] = [
                                rollup.anki_cards_created for rollup in cards_rollups
                            ]

            # 2. Build daily_data from rollup records (FAST) + today's lines (SMALL)
            # Structure: daily_data[date_str][display_name] = {'lines': N, 'chars': N}
            daily_data = defaultdict(
                lambda: defaultdict(lambda: {"lines": 0, "chars": 0})
            )

            # Process rollup data into daily_data (FAST - no database queries!)
            if start_date_str:
                yesterday = today - datetime.timedelta(days=1)
                yesterday_str = yesterday.strftime("%Y-%m-%d")

                if start_date_str <= yesterday_str:
                    rollup_end = (
                        min(end_date_str, yesterday_str)
                        if end_date_str
                        else yesterday_str
                    )

                    # Get rollup records for the date range
                    rollups = StatsRollupTable.get_date_range(
                        start_date_str, rollup_end
                    )

                    # Build daily_data directly from rollup records
                    for rollup in rollups:
                        date_str = rollup.date
                        if rollup.game_activity_data:
                            try:
                                # game_activity_data might already be a dict or a JSON string
                                if isinstance(rollup.game_activity_data, str):
                                    game_data = json.loads(rollup.game_activity_data)
                                else:
                                    game_data = rollup.game_activity_data

                                for game_id, activity in game_data.items():
                                    # Trust the title from rollup data - it's already been resolved properly
                                    # during the daily rollup process with proper fallback chain:
                                    # 1. games_table.title_original
                                    # 2. game_name (OBS scene name)
                                    # 3. Shortened UUID as last resort
                                    display_name = activity.get(
                                        "title", f"Game {game_id[:8]}"
                                    )

                                    daily_data[date_str][display_name]["lines"] = (
                                        activity.get("lines", 0)
                                    )
                                    daily_data[date_str][display_name]["chars"] = (
                                        activity.get("chars", 0)
                                    )
                            except (json.JSONDecodeError, KeyError, TypeError) as e:
                                logger.warning(
                                    f"Error parsing rollup data for {date_str}: {e}"
                                )
                                continue

            # Add today's lines to daily_data using our pre-built mapping
            for line in today_lines_for_charts:
                day_str = datetime.date.fromtimestamp(float(line.timestamp)).strftime(
                    "%Y-%m-%d"
                )
                game_name = line.game_name or "Unknown Game"
                # Use pre-built mapping instead of querying GamesTable for each line
                display_name = game_name_to_display.get(game_name, game_name)
                daily_data[day_str][display_name]["lines"] += 1
                daily_data[day_str][display_name]["chars"] += (
                    len(line.line_text) if line.line_text else 0
                )

            # GRACEFUL FALLBACK: If no daily_data from rollup, calculate from game_lines directly
            if not daily_data:
                logger.warning(f"No daily_data from rollup! Falling back to live calculation from game_lines table.")
                logger.info("This usually happens after a version upgrade. The rollup table will be populated automatically.")
                
                # Fetch all lines for the date range and calculate stats directly
                if start_timestamp and end_timestamp:
                    fallback_lines = GameLinesTable.get_lines_filtered_by_timestamp(
                        start=start_timestamp, end=end_timestamp, for_stats=True
                    )
                    
                    if fallback_lines:
                        logger.info(f"Fallback: Processing {len(fallback_lines)} lines directly from game_lines table")
                        for line in fallback_lines:
                            day_str = datetime.date.fromtimestamp(float(line.timestamp)).strftime("%Y-%m-%d")
                            game_name = line.game_name or "Unknown Game"
                            display_name = game_name_to_display.get(game_name, game_name)
                            daily_data[day_str][display_name]["lines"] += 1
                            daily_data[day_str][display_name]["chars"] += (
                                len(line.line_text) if line.line_text else 0
                            )
                
                # If still no data after fallback, return empty response
                if not daily_data:
                    logger.warning(f"No data found even after fallback. Date range: {start_date_str} to {end_date_str}")
                    return jsonify({"labels": [], "datasets": []})

            # 3. Create cumulative datasets for Chart.js
            sorted_days = sorted(daily_data.keys())
            # Get all unique display names from daily_data
            all_display_names = set()
            for day_data in daily_data.values():
                all_display_names.update(day_data.keys())
            display_names = sorted(all_display_names)

            # Keep track of the running total for each metric for each game
            cumulative_totals = defaultdict(lambda: {"lines": 0, "chars": 0})

            # Structure for final data: final_data[display_name][metric] = [day1_val, day2_val, ...]
            final_data = defaultdict(lambda: defaultdict(list))

            for day in sorted_days:
                for display_name in display_names:
                    # Add the day's total to the cumulative total
                    cumulative_totals[display_name]["lines"] += daily_data[day][
                        display_name
                    ]["lines"]
                    cumulative_totals[display_name]["chars"] += daily_data[day][
                        display_name
                    ]["chars"]

                    # Append the new cumulative total to the list for that day
                    final_data[display_name]["lines"].append(
                        cumulative_totals[display_name]["lines"]
                    )
                    final_data[display_name]["chars"].append(
                        cumulative_totals[display_name]["chars"]
                    )

            # 4. Format into Chart.js dataset structure
            try:
                datasets = []
                # A simple color palette for the chart lines
                colors = [
                    "#3498db",
                    "#e74c3c",
                    "#2ecc71",
                    "#f1c40f",
                    "#9b59b6",
                    "#1abc9c",
                    "#e67e22",
                ]

                for i, display_name in enumerate(display_names):
                    color = colors[i % len(colors)]

                    datasets.append(
                        {
                            "label": f"{display_name}",
                            "data": final_data[display_name]["lines"],
                            "borderColor": color,
                            "backgroundColor": f"{color}33",  # Semi-transparent for fill
                            "fill": False,
                            "tension": 0.1,
                            "for": "Lines Received",
                        }
                    )
                    datasets.append(
                        {
                            "label": f"{display_name}",
                            "data": final_data[display_name]["chars"],
                            "borderColor": color,
                            "backgroundColor": f"{color}33",
                            "fill": False,
                            "tension": 0.1,
                            "hidden": True,  # Hide by default to not clutter the chart
                            "for": "Characters Read",
                        }
                    )
            except Exception as e:
                logger.error(f"Error formatting Chart.js datasets: {e}")
                return jsonify({"error": "Failed to format chart data"}), 500

            # ========================================================================
            # CHART DATA CALCULATION STRATEGY
            # ========================================================================
            # This section calculates data for various charts. Charts are categorized by
            # whether they need today's live data or only historical rollup data:
            #
            # CHARTS USING LIVE DATA (combined_stats includes today):
            # - Lines/Characters Over Time (cumulative charts)
            # - Peak Statistics (if today sets new records)
            # - Heatmaps (to show today's activity)
            # - Kanji Grid (to include today's kanji)
            # - Current Game Stats
            # - Top 5 charts (if today qualifies for top rankings)
            #
            # CHARTS USING HISTORICAL DATA ONLY (rollup_stats, excludes today):
            # - Per-Game Totals (chars, time, speed per game)
            # - Day of Week Activity (pure historical patterns)
            # - Average Hours by Day (pure historical averages)
            # - Hourly Activity Pattern (historical average by hour)
            # - Hourly Reading Speed (historical average by hour)
            # - Reading Speed by Difficulty (historical averages)
            # - Game Type Distribution (based on GamesTable, not activity)
            #
            # Rationale: Average/pattern charts should show stable historical trends
            # without being skewed by today's incomplete data. Cumulative charts need
            # today's data to show current progress. Per-game charts update only after
            # the daily rollup runs, providing consistent snapshots of game progress.
            # ========================================================================

            # 5. Calculate additional chart data from combined_stats (no all_lines needed!)
            try:
                # Use kanji data from combined stats (already aggregated from rollup + today)
                kanji_freq_dict = combined_stats.get("kanji_frequency_data", {})
                if kanji_freq_dict:
                    # Convert to the format expected by frontend (with colors)
                    from GameSentenceMiner.web.stats import get_gradient_color

                    max_frequency = (
                        max(kanji_freq_dict.values()) if kanji_freq_dict else 0
                    )

                    # Sort kanji by frequency (most frequent first)
                    sorted_kanji = sorted(
                        kanji_freq_dict.items(), key=lambda x: x[1], reverse=True
                    )

                    kanji_data = []
                    for kanji, count in sorted_kanji:
                        color = get_gradient_color(count, max_frequency)
                        kanji_data.append(
                            {"kanji": kanji, "frequency": count, "color": color}
                        )

                    kanji_grid_data = {
                        "kanji_data": kanji_data,
                        "unique_count": len(sorted_kanji),
                        "max_frequency": max_frequency,
                    }
                else:
                    # No kanji data available
                    kanji_grid_data = {
                        "kanji_data": [],
                        "unique_count": 0,
                        "max_frequency": 0,
                    }
            except Exception as e:
                logger.error(f"Error calculating kanji frequency: {e}")
                kanji_grid_data = {
                    "kanji_data": [],
                    "unique_count": 0,
                    "max_frequency": 0,
                }

            try:
                # Use rollup-based heatmap for historical data (FAST!)
                if start_date_str:
                    yesterday = today - datetime.timedelta(days=1)
                    yesterday_str = yesterday.strftime("%Y-%m-%d")

                    if start_date_str <= yesterday_str:
                        rollup_end = (
                            min(end_date_str, yesterday_str)
                            if end_date_str
                            else yesterday_str
                        )
                        rollups_for_heatmap = StatsRollupTable.get_date_range(
                            start_date_str, rollup_end
                        )
                        heatmap_data = build_heatmap_from_rollup(
                            rollups_for_heatmap, filter_year
                        )

                        # Add today's data to heatmap if needed
                        if today_in_range and today_lines_for_charts:
                            from GameSentenceMiner.web.stats import (
                                calculate_heatmap_data,
                            )

                            today_heatmap = calculate_heatmap_data(
                                today_lines_for_charts, filter_year
                            )
                            # Merge today's data into heatmap
                            for year, dates in today_heatmap.items():
                                if year not in heatmap_data:
                                    heatmap_data[year] = {}
                                for date, chars in dates.items():
                                    heatmap_data[year][date] = (
                                        heatmap_data[year].get(date, 0) + chars
                                    )
                    else:
                        # Only today's data
                        from GameSentenceMiner.web.stats import calculate_heatmap_data

                        heatmap_data = calculate_heatmap_data(
                            today_lines_for_charts, filter_year
                        )
                else:
                    # No date range specified, use today only
                    from GameSentenceMiner.web.stats import calculate_heatmap_data

                    heatmap_data = calculate_heatmap_data(
                        today_lines_for_charts, filter_year
                    )
            except Exception as e:
                logger.error(f"Error calculating heatmap data: {e}")
                heatmap_data = {}

            # Extract per-game stats from ROLLUP ONLY (no live data)
            try:
                # Build per-game stats from rollup game_activity_data only
                game_activity_data = rollup_stats.get("game_activity_data", {}) if rollup_stats else {}

                # Sort games by first appearance (use game_id order from rollup)
                game_list = []
                for game_id, activity in game_activity_data.items():
                    title = activity.get("title", f"Game {game_id}")
                    # Use title from our mapping if available
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

                # Total chars per game
                total_chars_data = {
                    "labels": [g["title"] for g in game_list if g["chars"] > 0],
                    "totals": [g["chars"] for g in game_list if g["chars"] > 0],
                }

                # Reading time per game (convert seconds to hours)
                reading_time_data = {
                    "labels": [g["title"] for g in game_list if g["time"] > 0],
                    "totals": [
                        round(g["time"] / 3600, 2) for g in game_list if g["time"] > 0
                    ],
                }

                # Reading speed per game (chars/hour)
                reading_speed_per_game_data = {"labels": [], "totals": []}
                for g in game_list:
                    if g["time"] > 0 and g["chars"] > 0:
                        hours = g["time"] / 3600
                        speed = round(g["chars"] / hours, 0)
                        reading_speed_per_game_data["labels"].append(g["title"])
                        reading_speed_per_game_data["totals"].append(speed)

            except Exception as e:
                logger.error(
                    f"Error extracting per-game stats from rollup_stats: {e}"
                )
                total_chars_data = {"labels": [], "totals": []}
                reading_time_data = {"labels": [], "totals": []}
                reading_speed_per_game_data = {"labels": [], "totals": []}

            # 6. Calculate dashboard statistics
            try:
                # For current game stats, we need to fetch only the current game's lines
                # First, get the most recent line to determine current game
                if today_lines_for_charts:
                    sorted_today = sorted(
                        today_lines_for_charts, key=lambda line: float(line.timestamp)
                    )
                    current_game_line = sorted_today[-1]
                    current_game_name = current_game_line.game_name or "Unknown Game"

                    # Fetch only lines for the current game (much faster than all_lines!)
                    current_game_lines = [
                        line
                        for line in today_lines_for_charts
                        if (line.game_name or "Unknown Game") == current_game_name
                    ]

                    # Fetch historical data for current game (EXCLUDING today to avoid double-counting)
                    # Calculate today's start timestamp to use as upper bound
                    today_start_ts = datetime.datetime.combine(
                        today, datetime.time.min
                    ).timestamp()
                    
                    if start_timestamp and end_timestamp:
                        # If timestamps provided, filter by date range but exclude today
                        historical_current_game = GameLinesTable._db.fetchall(
                            f"SELECT * FROM {GameLinesTable._table} WHERE game_name=? AND timestamp >= ? AND timestamp < ?",
                            (current_game_name, start_timestamp, today_start_ts),
                        )
                    else:
                        # If no timestamps provided, fetch all historical data BEFORE today
                        historical_current_game = GameLinesTable._db.fetchall(
                            f"SELECT * FROM {GameLinesTable._table} WHERE game_name=? AND timestamp < ?",
                            (current_game_name, today_start_ts),
                        )
                    
                    # Convert historical rows to GameLinesTable objects (without for_stats cleaning)
                    historical_lines = [
                        GameLinesTable.from_row(row, clean_columns=['line_text'])
                        for row in historical_current_game
                    ]
                    
                    current_game_lines.extend(historical_lines)

                    current_game_stats = calculate_current_game_stats(
                        current_game_lines
                    )
                else:
                    # No lines today - fetch the most recent game from all data

                    most_recent_line = GameLinesTable._db.fetchone(
                        f"SELECT * FROM {GameLinesTable._table} ORDER BY timestamp DESC LIMIT 1"
                    )

                    if most_recent_line:
                        most_recent_game_line = GameLinesTable.from_row(
                            most_recent_line
                        )
                        current_game_name = (
                            most_recent_game_line.game_name or "Unknown Game"
                        )

                        # Fetch all lines for this game
                        if start_timestamp and end_timestamp:
                            # If timestamps provided, filter by date range
                            current_game_lines_rows = GameLinesTable._db.fetchall(
                                f"SELECT * FROM {GameLinesTable._table} WHERE game_name=? AND timestamp >= ? AND timestamp <= ?",
                                (current_game_name, start_timestamp, end_timestamp),
                            )
                        else:
                            # If no timestamps provided, fetch all data
                            current_game_lines_rows = GameLinesTable._db.fetchall(
                                f"SELECT * FROM {GameLinesTable._table} WHERE game_name=?",
                                (current_game_name,),
                            )

                        current_game_lines = [
                            GameLinesTable.from_row(row)
                            for row in current_game_lines_rows
                        ]
                        current_game_stats = calculate_current_game_stats(
                            current_game_lines
                        )
                    else:
                        current_game_stats = {}
            except Exception as e:
                logger.error(f"Error calculating current game stats: {e}")
                current_game_stats = {}

            try:
                # Count completed games from GamesTable (using completed boolean)
                completed_games_count = len(GamesTable.get_all_completed())

                # Build all_games_stats from combined_stats (no all_lines needed!)
                all_games_stats = {
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

                # Get first_date from rollup table
                first_rollup_date = StatsRollupTable.get_first_date()
                
                if first_rollup_date:
                    all_games_stats["first_date"] = first_rollup_date
                else:
                    # Fallback to today if no rollup data
                    fallback_date = datetime.date.today().strftime("%Y-%m-%d")
                    all_games_stats["first_date"] = fallback_date

                # Get last_date from today or end_timestamp
                if end_timestamp:
                    all_games_stats["last_date"] = datetime.date.fromtimestamp(
                        end_timestamp
                    ).strftime("%Y-%m-%d")
                else:
                    all_games_stats["last_date"] = datetime.date.today().strftime(
                        "%Y-%m-%d"
                    )

            except Exception as e:
                logger.error(f"Error calculating all games stats: {e}")
                all_games_stats = {}

            # 7. Build lightweight allLinesData from rollup records for heatmap "Avg Daily Time" calculation
            # Frontend needs reading time data per day to calculate average daily reading time
            all_lines_data = []
            if start_date_str:
                yesterday = today - datetime.timedelta(days=1)
                yesterday_str = yesterday.strftime("%Y-%m-%d")
                if start_date_str <= yesterday_str:
                    rollup_end = (
                        min(end_date_str, yesterday_str)
                        if end_date_str
                        else yesterday_str
                    )
                    rollups_for_lines = StatsRollupTable.get_date_range(
                        start_date_str, rollup_end
                    )
                    for rollup in rollups_for_lines:
                        # Convert date string to timestamp for frontend compatibility
                        date_obj = datetime.datetime.strptime(rollup.date, "%Y-%m-%d")
                        all_lines_data.append(
                            {
                                "timestamp": date_obj.timestamp(),
                                "date": rollup.date,
                                "reading_time_seconds": rollup.total_reading_time_seconds,  # Add actual reading time
                            }
                        )

            # Add today's lines if in range
            if today_in_range and today_lines_for_charts:
                for line in today_lines_for_charts:
                    all_lines_data.append(
                        {
                            "timestamp": float(line.timestamp),
                            "date": datetime.date.fromtimestamp(
                                float(line.timestamp)
                            ).strftime("%Y-%m-%d"),
                        }
                    )

            # 8. Get hourly activity pattern from ROLLUP ONLY (no live data)
            try:
                # Convert dict to list format expected by frontend
                hourly_dict = rollup_stats.get("hourly_activity_data", {}) if rollup_stats else {}
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
            except Exception as e:
                logger.error(f"Error processing hourly activity: {e}")
                hourly_activity_data = [0] * 24

            # 8.5. Get hourly reading speed pattern from ROLLUP ONLY (no live data)
            try:
                # Convert dict to list format expected by frontend
                speed_dict = rollup_stats.get("hourly_reading_speed_data", {}) if rollup_stats else {}
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
            except Exception as e:
                logger.error(f"Error processing hourly reading speed: {e}")
                hourly_reading_speed_data = [0] * 24

            # 9. Calculate peak statistics from rollup data (actual daily peaks)
            try:
                # Calculate true daily peaks by finding max values across all rollup records
                max_daily_chars = 0
                max_daily_hours = 0.0
                
                # Check rollup data for historical peaks
                if rollup_stats and start_date_str:
                    yesterday = today - datetime.timedelta(days=1)
                    yesterday_str = yesterday.strftime("%Y-%m-%d")
                    
                    if start_date_str <= yesterday_str:
                        rollup_end = (
                            min(end_date_str, yesterday_str)
                            if end_date_str
                            else yesterday_str
                        )
                        rollups_for_peaks = StatsRollupTable.get_date_range(
                            start_date_str, rollup_end
                        )
                        
                        # Find maximum daily values across all rollup records
                        for rollup in rollups_for_peaks:
                            if rollup.total_characters > max_daily_chars:
                                max_daily_chars = rollup.total_characters
                            
                            daily_hours = rollup.total_reading_time_seconds / 3600
                            if daily_hours > max_daily_hours:
                                max_daily_hours = daily_hours
                
                # Check today's live data to see if it sets a new record
                if live_stats:
                    today_chars = live_stats.get("total_characters", 0)
                    today_hours = live_stats.get("total_reading_time_seconds", 0) / 3600
                    
                    if today_chars > max_daily_chars:
                        max_daily_chars = today_chars
                    if today_hours > max_daily_hours:
                        max_daily_hours = today_hours
                
                peak_daily_stats = {
                    "max_daily_chars": max_daily_chars,
                    "max_daily_hours": max_daily_hours,
                }

            except Exception as e:
                logger.error(f"Error calculating peak daily stats: {e}")
                peak_daily_stats = {"max_daily_chars": 0, "max_daily_hours": 0.0}

            try:
                peak_session_stats = {
                    "longest_session_hours": combined_stats.get(
                        "longest_session_seconds", 0.0
                    )
                    / 3600,
                    "max_session_chars": combined_stats.get("max_chars_in_session", 0),
                }
            except Exception as e:
                logger.error(f"Error calculating peak session stats: {e}")
                peak_session_stats = {
                    "longest_session_hours": 0.0,
                    "max_session_chars": 0,
                }

            # 10. Calculate game milestones (already optimized - uses GamesTable, not all_lines)
            try:
                game_milestones = (
                    calculate_game_milestones()
                )  # No all_lines parameter needed
            except Exception as e:
                logger.error(f"Error calculating game milestones: {e}")
                game_milestones = None

            # 11. Calculate reading speed heatmap data
            try:
                # Use rollup-based approach similar to regular heatmap
                reading_speed_heatmap_data = {}
                max_reading_speed = 0
                
                if start_date_str:
                    yesterday = today - datetime.timedelta(days=1)
                    yesterday_str = yesterday.strftime("%Y-%m-%d")

                    if start_date_str <= yesterday_str:
                        rollup_end = (
                            min(end_date_str, yesterday_str)
                            if end_date_str
                            else yesterday_str
                        )
                        rollups_for_speed = StatsRollupTable.get_date_range(
                            start_date_str, rollup_end
                        )
                        
                        # Build reading speed heatmap from rollup data
                        for rollup in rollups_for_speed:
                            if rollup.total_reading_time_seconds > 0 and rollup.total_characters > 0:
                                reading_time_hours = rollup.total_reading_time_seconds / 3600
                                speed = int(rollup.total_characters / reading_time_hours)
                                
                                year = rollup.date.split("-")[0]
                                if year not in reading_speed_heatmap_data:
                                    reading_speed_heatmap_data[year] = {}
                                reading_speed_heatmap_data[year][rollup.date] = speed
                                max_reading_speed = max(max_reading_speed, speed)

                        # Add today's data to reading speed heatmap if needed
                        if today_in_range and today_lines_for_charts:
                            today_speed_data, today_max_speed = calculate_reading_speed_heatmap_data(
                                today_lines_for_charts, filter_year
                            )
                            # Merge today's data
                            for year, dates in today_speed_data.items():
                                if year not in reading_speed_heatmap_data:
                                    reading_speed_heatmap_data[year] = {}
                                for date, speed in dates.items():
                                    reading_speed_heatmap_data[year][date] = speed
                                    max_reading_speed = max(max_reading_speed, speed)
                    else:
                        # Only today's data
                        reading_speed_heatmap_data, max_reading_speed = calculate_reading_speed_heatmap_data(
                            today_lines_for_charts, filter_year
                        )
                else:
                    # No date range specified, use today only
                    reading_speed_heatmap_data, max_reading_speed = calculate_reading_speed_heatmap_data(
                        today_lines_for_charts, filter_year
                    )
            except Exception as e:
                logger.error(f"Error calculating reading speed heatmap data: {e}")
                reading_speed_heatmap_data = {}
                max_reading_speed = 0

            # 12. Calculate day of week activity data (HISTORICAL AVERAGES ONLY)
            # NOTE: This chart shows pure historical patterns and should NOT include today's incomplete data.
            # Today's data is already included in cumulative charts (Lines/Chars Over Time, Heatmaps, etc.)
            try:
                # Use pre-computed function from rollup_stats for historical averages
                if start_date_str:
                    yesterday = today - datetime.timedelta(days=1)
                    yesterday_str = yesterday.strftime("%Y-%m-%d")
                    
                    if start_date_str <= yesterday_str:
                        rollup_end = (
                            min(end_date_str, yesterday_str)
                            if end_date_str
                            else yesterday_str
                        )
                        rollups_for_dow = StatsRollupTable.get_date_range(
                            start_date_str, rollup_end
                        )
                        
                        # PRE-COMPUTE from rollup data (historical averages only)
                        day_of_week_data = calculate_day_of_week_averages_from_rollup(rollups_for_dow)
                    else:
                        # Only today's data requested - return empty for historical averages
                        day_of_week_data = {
                            "chars": [0] * 7,
                            "hours": [0] * 7,
                            "counts": [0] * 7,
                            "avg_hours": [0] * 7
                        }
                else:
                    day_of_week_data = {
                        "chars": [0] * 7,
                        "hours": [0] * 7,
                        "counts": [0] * 7,
                        "avg_hours": [0] * 7
                    }
                
                # REMOVED: Do NOT add today's data to historical averages
                # Today's incomplete data would skew the historical patterns shown in:
                # - Day of Week Activity chart
                # - Average Hours by Day chart
                        
            except Exception as e:
                logger.error(f"Error calculating day of week activity: {e}")
                day_of_week_data = {"chars": [0] * 7, "hours": [0] * 7, "counts": [0] * 7, "avg_hours": [0] * 7}

            # 13. Calculate reading speed by difficulty data (ROLLUP ONLY - no live data)
            try:
                # Use pre-computed function from rollup_stats with rollup data only
                difficulty_speed_data = calculate_difficulty_speed_from_rollup(rollup_stats if rollup_stats else {})
            except Exception as e:
                logger.error(f"Error calculating reading speed by difficulty: {e}")
                difficulty_speed_data = {"labels": [], "speeds": []}

            # 14. Calculate game type distribution data (only for games the user has played)
            try:
                game_type_data = {"labels": [], "counts": []}
                
                # Get game IDs that have been played (from rollup stats)
                game_activity_data = rollup_stats.get("game_activity_data", {}) if rollup_stats else {}
                played_game_ids = set(game_activity_data.keys())
                
                # Count types only for games that have been played
                type_counts = {}
                
                for game_id in played_game_ids:
                    game = GamesTable.get(game_id)
                    if game and game.type:
                        game_type = game.type
                        type_counts[game_type] = type_counts.get(game_type, 0) + 1
                
                # Sort by count descending
                sorted_types = sorted(type_counts.items(), key=lambda x: x[1], reverse=True)
                
                for game_type, count in sorted_types:
                    game_type_data["labels"].append(game_type)
                    game_type_data["counts"].append(count)
                    
            except Exception as e:
                logger.error(f"Error calculating game type distribution: {e}")
                game_type_data = {"labels": [], "counts": []}


            # Log total request time
            total_time = time.time() - request_start_time

            return jsonify(
                {
                    "labels": sorted_days,
                    "datasets": datasets,
                    "cardsMinedLast30Days": cards_mined_last_30_days,
                    "kanjiGridData": kanji_grid_data,
                    "heatmapData": heatmap_data,
                    "totalCharsPerGame": total_chars_data,
                    "readingTimePerGame": reading_time_data,
                    "readingSpeedPerGame": reading_speed_per_game_data,
                    "currentGameStats": current_game_stats,
                    "allGamesStats": all_games_stats,
                    "allLinesData": all_lines_data,
                    "hourlyActivityData": hourly_activity_data,
                    "hourlyReadingSpeedData": hourly_reading_speed_data,
                    "peakDailyStats": peak_daily_stats,
                    "peakSessionStats": peak_session_stats,
                    "gameMilestones": game_milestones,
                    "readingSpeedHeatmapData": reading_speed_heatmap_data,
                    "maxReadingSpeed": max_reading_speed,
                    "dayOfWeekData": day_of_week_data,
                    "difficultySpeedData": difficulty_speed_data,
                    "gameTypeData": game_type_data,
                }
            )

        except Exception as e:
            logger.error(f"Unexpected error in api_stats: {e}", exc_info=True)
            return jsonify({"error": "Failed to generate statistics"}), 500

    @app.route("/api/mining_heatmap")
    def api_mining_heatmap():
        """
        Provides mining heatmap data showing daily mining activity.
        Counts lines where screenshot_in_anki OR audio_in_anki is not empty.
        Accepts optional 'start' and 'end' timestamp parameters for filtering.
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
                start=start_timestamp, end=end_timestamp
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
            logger.error(f"Unexpected error in api_mining_heatmap: {e}", exc_info=True)
            return jsonify({"error": "Failed to generate mining heatmap"}), 500

    @app.route("/api/goals-today", methods=["GET"])
    def api_goals_today():
        """
        Calculate daily requirements and current progress for today based on goal target dates.
        Returns what needs to be accomplished today to stay on track.
        Uses hybrid rollup + live approach for performance.
        """
        try:
            config = get_stats_config()
            today = datetime.date.today()
            today_str = today.strftime("%Y-%m-%d")

            # === HYBRID ROLLUP + LIVE APPROACH ===
            # Get rollup data up to yesterday
            yesterday = today - datetime.timedelta(days=1)
            yesterday_str = yesterday.strftime("%Y-%m-%d")

            # Get first date from rollup table
            first_rollup_date = StatsRollupTable.get_first_date()
            if not first_rollup_date:
                # No rollup data, return empty response
                return jsonify(
                    {
                        "hours": {"required": 0, "progress": 0, "has_target": False},
                        "characters": {
                            "required": 0,
                            "progress": 0,
                            "has_target": False,
                        },
                        "games": {"required": 0, "progress": 0, "has_target": False},
                    }
                ), 200

            # Query rollup data for all historical dates
            rollups = StatsRollupTable.get_date_range(first_rollup_date, yesterday_str)
            rollup_stats = aggregate_rollup_data(rollups) if rollups else None

            # Get today's lines for live calculation
            today_start = datetime.datetime.combine(
                today, datetime.time.min
            ).timestamp()
            today_end = datetime.datetime.combine(today, datetime.time.max).timestamp()
            today_lines = GameLinesTable.get_lines_filtered_by_timestamp(
                start=today_start, end=today_end, for_stats=True
            )

            # Calculate today's live stats
            live_stats = None
            if today_lines:
                live_stats = calculate_live_stats_for_today(today_lines)

            # Combine rollup and live stats for total progress
            combined_stats = combine_rollup_and_live_stats(rollup_stats, live_stats)

            # Extract totals from combined stats
            total_hours = combined_stats.get("total_reading_time_seconds", 0) / 3600
            total_characters = combined_stats.get("total_characters", 0)
            total_games = combined_stats.get("unique_games_played", 0)

            # Calculate today's progress from live stats
            if live_stats:
                today_time_seconds = live_stats.get("total_reading_time_seconds", 0)
                today_hours = today_time_seconds / 3600
                today_characters = live_stats.get("total_characters", 0)
            else:
                today_hours = 0
                today_characters = 0

            # Calculate today's cards mined (lines with audio_in_anki OR screenshot_in_anki)
            today_cards_mined = 0
            if today_lines:
                for line in today_lines:
                    # Count if either audio_in_anki or screenshot_in_anki is not empty
                    if (line.audio_in_anki and line.audio_in_anki.strip()) or \
                       (line.screenshot_in_anki and line.screenshot_in_anki.strip()):
                        today_cards_mined += 1

            result = {}

            # Calculate hours requirement
            if config.reading_hours_target_date:
                try:
                    target_date = datetime.datetime.strptime(
                        config.reading_hours_target_date, "%Y-%m-%d"
                    ).date()
                    days_remaining = (
                        target_date - today
                    ).days + 1  # +1 to include today
                    if days_remaining > 0:
                        hours_needed = max(0, config.reading_hours_target - total_hours)
                        daily_hours_required = hours_needed / days_remaining
                        result["hours"] = {
                            "required": round(daily_hours_required, 2),
                            "progress": round(today_hours, 2),
                            "has_target": True,
                            "target_date": config.reading_hours_target_date,
                            "days_remaining": days_remaining,
                        }
                    else:
                        result["hours"] = {
                            "required": 0,
                            "progress": round(today_hours, 2),
                            "has_target": True,
                            "expired": True,
                        }
                except ValueError:
                    result["hours"] = {
                        "required": 0,
                        "progress": round(today_hours, 2),
                        "has_target": False,
                    }
            else:
                result["hours"] = {
                    "required": 0,
                    "progress": round(today_hours, 2),
                    "has_target": False,
                }

            # Calculate characters requirement
            if config.character_count_target_date:
                try:
                    target_date = datetime.datetime.strptime(
                        config.character_count_target_date, "%Y-%m-%d"
                    ).date()
                    days_remaining = (target_date - today).days + 1
                    if days_remaining > 0:
                        chars_needed = max(
                            0, config.character_count_target - total_characters
                        )
                        daily_chars_required = int(chars_needed / days_remaining)
                        result["characters"] = {
                            "required": daily_chars_required,
                            "progress": today_characters,
                            "has_target": True,
                            "target_date": config.character_count_target_date,
                            "days_remaining": days_remaining,
                        }
                    else:
                        result["characters"] = {
                            "required": 0,
                            "progress": today_characters,
                            "has_target": True,
                            "expired": True,
                        }
                except ValueError:
                    result["characters"] = {
                        "required": 0,
                        "progress": today_characters,
                        "has_target": False,
                    }
            else:
                result["characters"] = {
                    "required": 0,
                    "progress": today_characters,
                    "has_target": False,
                }

            # Calculate games requirement
            if config.games_target_date:
                try:
                    target_date = datetime.datetime.strptime(
                        config.games_target_date, "%Y-%m-%d"
                    ).date()
                    days_remaining = (target_date - today).days + 1
                    if days_remaining > 0:
                        games_needed = max(0, config.games_target - total_games)
                        daily_games_required = games_needed / days_remaining
                        result["games"] = {
                            "required": round(daily_games_required, 2),
                            "progress": total_games,
                            "has_target": True,
                            "target_date": config.games_target_date,
                            "days_remaining": days_remaining,
                        }
                    else:
                        result["games"] = {
                            "required": 0,
                            "progress": total_games,
                            "has_target": True,
                            "expired": True,
                        }
                except ValueError:
                    result["games"] = {
                        "required": 0,
                        "progress": total_games,
                        "has_target": False,
                    }
            else:
                result["games"] = {
                    "required": 0,
                    "progress": total_games,
                    "has_target": False,
                }

            # Calculate cards mined requirement (daily goal)
            cards_daily_target = getattr(config, 'cards_mined_daily_target', 10)
            if cards_daily_target > 0:
                result["cards"] = {
                    "required": cards_daily_target,
                    "progress": today_cards_mined,
                    "has_target": True,
                }
            else:
                result["cards"] = {
                    "required": 0,
                    "progress": today_cards_mined,
                    "has_target": False,
                }

            return jsonify(result), 200

        except Exception as e:
            logger.error(f"Error calculating goals today: {e}")
            return jsonify({"error": "Failed to calculate daily goals"}), 500

    @app.route("/api/goals-projection", methods=["GET"])
    def api_goals_projection():
        """
        Calculate projections based on 30-day rolling average.
        Returns projected stats by target dates.
        Uses hybrid rollup + live approach for performance.
        """
        try:
            config = get_stats_config()
            today = datetime.date.today()
            today_str = today.strftime("%Y-%m-%d")
            thirty_days_ago = today - datetime.timedelta(days=30)
            thirty_days_ago_str = thirty_days_ago.strftime("%Y-%m-%d")

            # === HYBRID ROLLUP + LIVE APPROACH ===
            # Get rollup data for last 30 days (up to yesterday)
            yesterday = today - datetime.timedelta(days=1)
            yesterday_str = yesterday.strftime("%Y-%m-%d")

            # Query rollup data for last 30 days
            rollups_30d = StatsRollupTable.get_date_range(
                thirty_days_ago_str, yesterday_str
            )

            # Get today's lines for live calculation
            today_start = datetime.datetime.combine(
                today, datetime.time.min
            ).timestamp()
            today_end = datetime.datetime.combine(today, datetime.time.max).timestamp()
            today_lines = GameLinesTable.get_lines_filtered_by_timestamp(
                start=today_start, end=today_end, for_stats=True
            )

            # Calculate today's live stats
            live_stats_today = None
            if today_lines:
                live_stats_today = calculate_live_stats_for_today(today_lines)

            # Calculate 30-day averages from rollup data
            if rollups_30d or live_stats_today:
                total_hours = 0
                total_chars = 0
                all_games = set()

                # Sum up rollup data
                for rollup in rollups_30d:
                    total_hours += rollup.total_reading_time_seconds / 3600
                    total_chars += rollup.total_characters
                    # Extract games from rollup
                    if rollup.games_played_ids:
                        try:
                            games_ids = (
                                json.loads(rollup.games_played_ids)
                                if isinstance(rollup.games_played_ids, str)
                                else rollup.games_played_ids
                            )
                            all_games.update(games_ids)
                        except (json.JSONDecodeError, TypeError):
                            pass

                # Add today's stats
                if live_stats_today:
                    total_hours += (
                        live_stats_today.get("total_reading_time_seconds", 0) / 3600
                    )
                    total_chars += live_stats_today.get("total_characters", 0)
                    today_games = live_stats_today.get("games_played_ids", [])
                    all_games.update(today_games)

                # Average over ALL 30 days (including days with 0 activity)
                avg_daily_hours = total_hours / 30
                avg_daily_chars = total_chars / 30

                # Calculate average daily unique games
                # Count unique games per day from rollup data
                daily_game_counts = []
                for rollup in rollups_30d:
                    if rollup.games_played_ids:
                        try:
                            games_ids = (
                                json.loads(rollup.games_played_ids)
                                if isinstance(rollup.games_played_ids, str)
                                else rollup.games_played_ids
                            )
                            daily_game_counts.append(len(games_ids))
                        except (json.JSONDecodeError, TypeError):
                            daily_game_counts.append(0)
                    else:
                        daily_game_counts.append(0)

                # Add today's unique games count
                if live_stats_today:
                    today_games_count = len(
                        live_stats_today.get("games_played_ids", [])
                    )
                    daily_game_counts.append(today_games_count)

                # Pad with zeros for days without data (to get exactly 30 days)
                while len(daily_game_counts) < 30:
                    daily_game_counts.append(0)

                avg_daily_games = sum(daily_game_counts[:30]) / 30
            else:
                avg_daily_hours = 0
                avg_daily_chars = 0
                avg_daily_games = 0

            # Calculate current totals from all rollup data + today
            first_rollup_date = StatsRollupTable.get_first_date()
            if not first_rollup_date:
                return jsonify(
                    {
                        "hours": {"projection": 0, "daily_average": 0},
                        "characters": {"projection": 0, "daily_average": 0},
                        "games": {"projection": 0, "daily_average": 0},
                    }
                ), 200

            # Get all rollup data for current totals
            all_rollups = StatsRollupTable.get_date_range(
                first_rollup_date, yesterday_str
            )
            rollup_stats_all = (
                aggregate_rollup_data(all_rollups) if all_rollups else None
            )

            # Combine with today's live stats
            combined_stats_all = combine_rollup_and_live_stats(
                rollup_stats_all, live_stats_today
            )

            # Extract current totals
            current_hours = (
                combined_stats_all.get("total_reading_time_seconds", 0) / 3600
            )
            current_chars = combined_stats_all.get("total_characters", 0)
            current_games = combined_stats_all.get("unique_games_played", 0)

            result = {}

            # Project hours by target date
            if config.reading_hours_target_date:
                try:
                    target_date = datetime.datetime.strptime(
                        config.reading_hours_target_date, "%Y-%m-%d"
                    ).date()
                    days_until_target = (target_date - today).days
                    projected_hours = current_hours + (
                        avg_daily_hours * days_until_target
                    )
                    result["hours"] = {
                        "projection": round(projected_hours, 2),
                        "daily_average": round(avg_daily_hours, 2),
                        "target_date": config.reading_hours_target_date,
                        "target": config.reading_hours_target,
                        "current": round(current_hours, 2),
                    }
                except ValueError:
                    result["hours"] = {
                        "projection": 0,
                        "daily_average": round(avg_daily_hours, 2),
                    }
            else:
                result["hours"] = {
                    "projection": 0,
                    "daily_average": round(avg_daily_hours, 2),
                }

            # Project characters by target date
            if config.character_count_target_date:
                try:
                    target_date = datetime.datetime.strptime(
                        config.character_count_target_date, "%Y-%m-%d"
                    ).date()
                    days_until_target = (target_date - today).days
                    projected_chars = int(
                        current_chars + (avg_daily_chars * days_until_target)
                    )
                    result["characters"] = {
                        "projection": projected_chars,
                        "daily_average": int(avg_daily_chars),
                        "target_date": config.character_count_target_date,
                        "target": config.character_count_target,
                        "current": current_chars,
                    }
                except ValueError:
                    result["characters"] = {
                        "projection": 0,
                        "daily_average": int(avg_daily_chars),
                    }
            else:
                result["characters"] = {
                    "projection": 0,
                    "daily_average": int(avg_daily_chars),
                }

            # Project games by target date
            if config.games_target_date:
                try:
                    target_date = datetime.datetime.strptime(
                        config.games_target_date, "%Y-%m-%d"
                    ).date()
                    days_until_target = (target_date - today).days
                    projected_games = int(
                        current_games + (avg_daily_games * days_until_target)
                    )
                    result["games"] = {
                        "projection": projected_games,
                        "daily_average": round(avg_daily_games, 2),
                        "target_date": config.games_target_date,
                        "target": config.games_target,
                        "current": current_games,
                    }
                except ValueError:
                    result["games"] = {
                        "projection": 0,
                        "daily_average": round(avg_daily_games, 2),
                    }
            else:
                result["games"] = {
                    "projection": 0,
                    "daily_average": round(avg_daily_games, 2),
                }

            return jsonify(result), 200

        except Exception as e:
            logger.error(f"Error calculating goal projections: {e}")
            return jsonify({"error": "Failed to calculate projections"}), 500

    @app.route("/api/import-exstatic", methods=["POST"])
    def api_import_exstatic():
        """
        Import ExStatic CSV data into GSM database.
        Expected CSV format: uuid,given_identifier,name,line,time
        """
        try:
            # Check if file is provided
            if "file" not in request.files:
                return jsonify({"error": "No file provided"}), 400

            file = request.files["file"]
            if file.filename == "":
                return jsonify({"error": "No file selected"}), 400

            # Validate file type
            if not file.filename.lower().endswith(".csv"):
                return jsonify({"error": "File must be a CSV file"}), 400

            # Read and parse CSV
            try:
                # Read file content as text with proper encoding handling
                file_content = file.read().decode("utf-8-sig")  # Handle BOM if present

                # First, get the header line manually to avoid issues with multi-line content
                lines = file_content.split("\n")
                if len(lines) == 1 and not lines[0].strip():
                    return jsonify({"error": "Empty CSV file"}), 400

                header_line = lines[0].strip()

                # Parse headers manually
                header_reader = csv.reader([header_line])
                try:
                    headers = next(header_reader)
                    headers = [h.strip() for h in headers]  # Clean whitespace

                except StopIteration:
                    return jsonify({"error": "Could not parse CSV headers"}), 400

                # Validate headers
                expected_headers = {"uuid", "given_identifier", "name", "line", "time"}
                actual_headers = set(headers)

                if not expected_headers.issubset(actual_headers):
                    missing_headers = expected_headers - actual_headers
                    # Check if this looks like a stats CSV instead of lines CSV
                    if "client" in actual_headers and "chars_read" in actual_headers:
                        return jsonify(
                            {
                                "error": "This appears to be an ExStatic stats CSV. Please upload the ExStatic lines CSV file instead. The lines CSV should contain columns: uuid, given_identifier, name, line, time"
                            }
                        ), 400
                    else:
                        return jsonify(
                            {
                                "error": f"Invalid CSV format. Missing required columns: {', '.join(missing_headers)}. Expected format: uuid, given_identifier, name, line, time. Found headers: {', '.join(actual_headers)}"
                            }
                        ), 400

                # Now parse the full CSV with proper handling for multi-line fields
                file_io = io.StringIO(file_content)
                csv_reader = csv.DictReader(
                    file_io, quoting=csv.QUOTE_MINIMAL, skipinitialspace=True
                )

                # Process CSV rows
                games_set = set()
                errors = []

                all_lines = GameLinesTable.all()
                existing_uuids = {line.id for line in all_lines}
                batch_size = 1000  # For logging progress
                batch_insert = []
                imported_count = 0

                def get_line_hash(uuid: str, line_text: str) -> str:
                    return uuid + "|" + line_text.strip()

                for row_num, row in enumerate(csv_reader):
                    try:
                        # Extract and validate required fields
                        game_uuid = row.get("uuid", "").strip()
                        game_name = row.get("name", "").strip()
                        line = row.get("line", "").strip()
                        time_str = row.get("time", "").strip()

                        # Validate required fields
                        if not game_uuid:
                            errors.append(f"Row {row_num}: Missing UUID")
                            continue
                        if not game_name:
                            errors.append(f"Row {row_num}: Missing name")
                            continue
                        if not line:
                            errors.append(f"Row {row_num}: Missing line text")
                            continue
                        if not time_str:
                            errors.append(f"Row {row_num}: Missing time")
                            continue

                        line_hash = get_line_hash(game_uuid, line)

                        # Check if this line already exists in database
                        if line_hash in existing_uuids:
                            continue

                        # Convert time to timestamp
                        try:
                            timestamp = float(time_str)
                        except ValueError:
                            errors.append(
                                f"Row {row_num}: Invalid time format: {time_str}"
                            )
                            continue

                        # Clean up line text (remove extra whitespace and newlines)
                        line_text = line.strip()

                        # Create GameLinesTable entry
                        # Convert timestamp float to datetime object
                        dt = datetime.datetime.fromtimestamp(timestamp)
                        batch_insert.append(
                            GameLine(
                                id=line_hash,
                                text=line_text,
                                scene=game_name,
                                time=dt,
                                prev=None,
                                next=None,
                                index=0,
                            )
                        )

                        existing_uuids.add(
                            line_hash
                        )  # Add to existing to prevent duplicates in same import

                        if len(batch_insert) >= batch_size:
                            GameLinesTable.add_lines(batch_insert)
                            imported_count += len(batch_insert)
                            batch_insert = []
                        games_set.add(game_name)

                    except Exception as e:
                        logger.error(f"Error processing row {row_num}: {e}")
                        errors.append(f"Row {row_num}: Error processing row - {str(e)}")
                        continue

                # Insert the rest of the batch
                if batch_insert:
                    GameLinesTable.add_lines(batch_insert)
                    imported_count += len(batch_insert)
                    batch_insert = []

                # # Import lines into database
                # imported_count = 0
                # for game_line in imported_lines:
                #     try:
                #         game_line.add()
                #         imported_count += 1
                #     except Exception as e:
                #         logger.error(f"Failed to import line {game_line.id}: {e}")
                #         errors.append(f"Failed to import line {game_line.id}: {str(e)}")

                # Run daily rollup to update statistics with newly imported data
                logger.info("Running daily rollup after ExStatic import to update statistics...")
                try:
                    rollup_result = run_daily_rollup()
                    logger.info(f"Daily rollup completed: processed {rollup_result.get('processed', 0)} dates, overwritten {rollup_result.get('overwritten', 0)} dates")
                except Exception as rollup_error:
                    logger.error(f"Error running daily rollup after import: {rollup_error}")
                    # Don't fail the import if rollup fails - just log it

                # Prepare response
                response_data = {
                    "message": f"Successfully imported {imported_count} lines from {len(games_set)} games",
                    "imported_count": imported_count,
                    "games_count": len(games_set),
                    "games": list(games_set),
                }

                if errors:
                    response_data["warnings"] = errors
                    response_data["warning_count"] = len(errors)

                return jsonify(response_data), 200

            except csv.Error as e:
                return jsonify({"error": f"CSV parsing error: {str(e)}"}), 400
            except UnicodeDecodeError:
                return jsonify(
                    {
                        "error": "File encoding error. Please ensure the CSV is UTF-8 encoded."
                    }
                ), 400

        except Exception as e:
            logger.error(f"Error in ExStatic import: {e}")
            return jsonify({"error": f"Import failed: {str(e)}"}), 500

    @app.route("/api/kanji-sorting-configs", methods=["GET"])
    def api_kanji_sorting_configs():
        """
        List available kanji sorting configuration JSON files.
        Returns metadata for each available sorting option.
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
        Returns the full JSON configuration.
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
        Get daily activity data (time and characters) for the last 4 weeks or all time.
        Returns data from the rollup table ONLY (no live data).
        Uses historical data up to today (inclusive).
        
        Query Parameters:
        - all_time: If 'true', returns all available data from first rollup date to today
        """
        try:
            # Check if all-time data is requested
            use_all_time = request.args.get('all_time', 'false').lower() == 'true'
            
            today = datetime.date.today()
            
            if use_all_time:
                # Get all data from first rollup date to today
                first_rollup_date = StatsRollupTable.get_first_date()
                if not first_rollup_date:
                    return jsonify({
                        "labels": [],
                        "timeData": [],
                        "charsData": [],
                        "speedData": []
                    }), 200
                
                start_date = datetime.datetime.strptime(first_rollup_date, "%Y-%m-%d").date()
            else:
                # Get date range for last 4 weeks (28 days) - INCLUDING today
                start_date = today - datetime.timedelta(days=27)  # 28 days of data
            
            # Get rollup data for the date range (up to today, inclusive)
            rollups = StatsRollupTable.get_date_range(
                start_date.strftime("%Y-%m-%d"),
                today.strftime("%Y-%m-%d")
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
                    if rollup.total_reading_time_seconds > 0 and rollup.total_characters > 0:
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
            
            return jsonify({
                "labels": labels,
                "timeData": time_data,
                "charsData": chars_data,
                "speedData": speed_data
            }), 200
            
        except Exception as e:
            logger.error(f"Error fetching daily activity: {e}", exc_info=True)
            return jsonify({"error": "Failed to fetch daily activity"}), 500

    @app.route("/api/today-stats", methods=["GET"])
    def api_today_stats():
        """
        Calculate and return today's statistics including sessions.
        Returns total characters, chars/hour for today, and all sessions with their stats.
        """
        try:
            # Get configuration
            config = get_stats_config()
            afk_timer_seconds = config.afk_timer_seconds
            session_gap_seconds = config.session_gap_seconds
            minimum_session_length = 0  # 5 minutes

            # Get today's date range
            today = datetime.date.today()
            today_start = datetime.datetime.combine(
                today, datetime.time.min
            ).timestamp()
            today_end = datetime.datetime.combine(today, datetime.time.max).timestamp()
    
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
                            game_name_to_title[line.game_name] = game_metadata.title_original
                        else:
                            game_name_to_title[line.game_name] = line.game_name
                        
                        # Store full metadata for this game
                        game_name_to_metadata[line.game_name] = {
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
                    }
                else:
                    # Continue current session
                    current_session["endTime"] = ts
                    current_session["totalChars"] += chars
                    if last_timestamp is not None:
                        gap = ts - last_timestamp
                        current_session["totalSeconds"] += min(gap, afk_timer_seconds)

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
            logger.error(f"Error calculating today's stats: {e}", exc_info=True)
            return jsonify({"error": "Failed to calculate today's statistics"}), 500
