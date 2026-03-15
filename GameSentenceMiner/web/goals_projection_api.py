"""
Goals Projection API Endpoint

This module contains the /api/goals-projection endpoint, extracted from
stats_api.py so that the stats module stays focused on stats.
"""

from __future__ import annotations

import datetime
import json

from flask import jsonify, request

from GameSentenceMiner.util.config.configuration import get_stats_config, logger
from GameSentenceMiner.util.database.db import GameLinesTable
from GameSentenceMiner.util.database.stats_rollup_table import StatsRollupTable
from GameSentenceMiner.web.rollup_stats import (
    aggregate_rollup_data,
    calculate_live_stats_for_today,
    combine_rollup_and_live_stats,
)


def register_goals_projection_api_routes(app):
    """Register goals projection API routes with the Flask app."""

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
