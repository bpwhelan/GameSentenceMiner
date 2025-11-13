"""
Goals API Endpoints

This module contains API endpoints specifically for custom goals functionality.
Provides data for calculating progress on user-defined goals with date ranges.
"""

import datetime
import json
from flask import request, jsonify

from GameSentenceMiner.util.stats_rollup_table import StatsRollupTable
from GameSentenceMiner.util.db import GameLinesTable
from GameSentenceMiner.util.games_table import GamesTable
from GameSentenceMiner.util.configuration import logger
from GameSentenceMiner.web.rollup_stats import (
    calculate_live_stats_for_today,
    aggregate_rollup_data,
    combine_rollup_and_live_stats,
)


def register_goals_api_routes(app):
    """Register goals API routes with the Flask app."""

    @app.route("/api/goals/progress", methods=["POST"])
    def api_goals_progress():
        """
        Calculate progress for a custom goal within a specific date range.
        
        Request body:
        {
            "metric_type": "hours" | "characters" | "games",
            "start_date": "YYYY-MM-DD",
            "end_date": "YYYY-MM-DD"
        }
        
        Returns:
        {
            "progress": <number>,
            "daily_average": <number>,
            "days_in_range": <number>
        }
        """
        try:
            data = request.get_json()
            
            if not data:
                return jsonify({"error": "No data provided"}), 400
            
            metric_type = data.get("metric_type")
            start_date_str = data.get("start_date")
            end_date_str = data.get("end_date")
            
            # Validate required fields
            if not metric_type or not start_date_str or not end_date_str:
                return jsonify({"error": "Missing required fields: metric_type, start_date, end_date"}), 400
            
            if metric_type not in ["hours", "characters", "games"]:
                return jsonify({"error": "Invalid metric_type. Must be 'hours', 'characters', or 'games'"}), 400
            
            # Parse dates
            try:
                start_date = datetime.datetime.strptime(start_date_str, "%Y-%m-%d").date()
                end_date = datetime.datetime.strptime(end_date_str, "%Y-%m-%d").date()
            except ValueError as e:
                return jsonify({"error": f"Invalid date format: {str(e)}"}), 400
            
            if start_date > end_date:
                return jsonify({"error": "start_date must be before or equal to end_date"}), 400
            
            # Calculate progress based on metric type
            today = datetime.date.today()
            
            # Determine if we need to include today's live data
            include_today = end_date >= today
            
            # Get rollup data for the date range (up to yesterday if today is included)
            if include_today:
                yesterday = today - datetime.timedelta(days=1)
                rollup_end_date = min(end_date, yesterday)
            else:
                rollup_end_date = end_date
            
            # Only query rollups if we have historical dates
            rollup_stats = None
            if start_date <= rollup_end_date:
                rollups = StatsRollupTable.get_date_range(
                    start_date.strftime("%Y-%m-%d"),
                    rollup_end_date.strftime("%Y-%m-%d")
                )
                
                if rollups:
                    rollup_stats = aggregate_rollup_data(rollups)
            
            # Get today's live data if needed
            live_stats = None
            if include_today:
                today_start = datetime.datetime.combine(today, datetime.time.min).timestamp()
                today_end = datetime.datetime.combine(today, datetime.time.max).timestamp()
                today_lines = GameLinesTable.get_lines_filtered_by_timestamp(
                    start=today_start, end=today_end, for_stats=True
                )
                
                if today_lines:
                    live_stats = calculate_live_stats_for_today(today_lines)
            
            # Combine rollup and live stats
            combined_stats = combine_rollup_and_live_stats(rollup_stats, live_stats)
            
            # Extract progress based on metric type
            progress = 0
            if metric_type == "hours":
                progress = combined_stats.get("total_reading_time_seconds", 0) / 3600
            elif metric_type == "characters":
                progress = combined_stats.get("total_characters", 0)
            elif metric_type == "games":
                progress = combined_stats.get("unique_games_played", 0)
            
            # Calculate days in range
            days_in_range = (end_date - start_date).days + 1
            
            # Calculate daily average
            daily_average = progress / days_in_range if days_in_range > 0 else 0
            
            return jsonify({
                "progress": round(progress, 2) if metric_type == "hours" else int(progress),
                "daily_average": round(daily_average, 2) if metric_type == "hours" else int(daily_average),
                "days_in_range": days_in_range
            }), 200
            
        except Exception as e:
            logger.error(f"Error calculating goal progress: {e}", exc_info=True)
            return jsonify({"error": "Failed to calculate goal progress"}), 500
    
    @app.route("/api/goals/today-progress", methods=["POST"])
    def api_goals_today_progress():
        """
        Calculate today's required progress for a custom goal.
        Shows what needs to be accomplished today to stay on track.
        
        Request body:
        {
            "goal_id": "goal_xxx",
            "metric_type": "hours" | "characters" | "games",
            "target_value": <number>,
            "start_date": "YYYY-MM-DD",
            "end_date": "YYYY-MM-DD"
        }
        
        Returns:
        {
            "required": <number>,  # What needs to be done today
            "progress": <number>,  # What has been done today
            "has_target": true,
            "days_remaining": <number>,
            "total_progress": <number>  # Total progress from start to now
        }
        """
        try:
            data = request.get_json()
            
            if not data:
                return jsonify({"error": "No data provided"}), 400
            
            goal_id = data.get("goal_id")
            metric_type = data.get("metric_type")
            target_value = data.get("target_value")
            start_date_str = data.get("start_date")
            end_date_str = data.get("end_date")
            
            # Validate required fields
            if not all([goal_id, metric_type, target_value, start_date_str, end_date_str]):
                return jsonify({"error": "Missing required fields"}), 400
            
            if metric_type not in ["hours", "characters", "games"]:
                return jsonify({"error": "Invalid metric_type"}), 400
            
            # Parse dates
            try:
                start_date = datetime.datetime.strptime(start_date_str, "%Y-%m-%d").date()
                end_date = datetime.datetime.strptime(end_date_str, "%Y-%m-%d").date()
                today = datetime.date.today()
            except ValueError as e:
                return jsonify({"error": f"Invalid date format: {str(e)}"}), 400
            
            # Check if goal is currently active
            if today < start_date or today > end_date:
                return jsonify({
                    "required": 0,
                    "progress": 0,
                    "has_target": False,
                    "expired": today > end_date,
                    "not_started": today < start_date
                }), 200
            
            # Calculate total progress from start_date to yesterday
            yesterday = today - datetime.timedelta(days=1)
            
            rollup_stats = None
            if start_date <= yesterday:
                rollups = StatsRollupTable.get_date_range(
                    start_date.strftime("%Y-%m-%d"),
                    yesterday.strftime("%Y-%m-%d")
                )
                if rollups:
                    rollup_stats = aggregate_rollup_data(rollups)
            
            # Get today's live data
            today_start = datetime.datetime.combine(today, datetime.time.min).timestamp()
            today_end = datetime.datetime.combine(today, datetime.time.max).timestamp()
            today_lines = GameLinesTable.get_lines_filtered_by_timestamp(
                start=today_start, end=today_end, for_stats=True
            )
            
            live_stats = None
            if today_lines:
                live_stats = calculate_live_stats_for_today(today_lines)
            
            # Combine stats for total progress
            combined_stats = combine_rollup_and_live_stats(rollup_stats, live_stats)
            
            # Extract total progress
            total_progress = 0
            if metric_type == "hours":
                total_progress = combined_stats.get("total_reading_time_seconds", 0) / 3600
            elif metric_type == "characters":
                total_progress = combined_stats.get("total_characters", 0)
            elif metric_type == "games":
                total_progress = combined_stats.get("unique_games_played", 0)
            
            # Extract today's progress
            today_progress = 0
            if live_stats:
                if metric_type == "hours":
                    today_progress = live_stats.get("total_reading_time_seconds", 0) / 3600
                elif metric_type == "characters":
                    today_progress = live_stats.get("total_characters", 0)
                elif metric_type == "games":
                    today_progress = live_stats.get("unique_games_played", 0)
            
            # Calculate days remaining (including today)
            days_remaining = (end_date - today).days + 1
            
            # Calculate daily requirement
            remaining_work = max(0, target_value - total_progress)
            daily_required = remaining_work / days_remaining if days_remaining > 0 else 0
            
            return jsonify({
                "required": round(daily_required, 2) if metric_type == "hours" else int(daily_required),
                "progress": round(today_progress, 2) if metric_type == "hours" else int(today_progress),
                "has_target": True,
                "days_remaining": days_remaining,
                "total_progress": round(total_progress, 2) if metric_type == "hours" else int(total_progress)
            }), 200
            
        except Exception as e:
            logger.error(f"Error calculating today's goal progress: {e}", exc_info=True)
            return jsonify({"error": "Failed to calculate today's progress"}), 500
    
    @app.route("/api/goals/projection", methods=["POST"])
    def api_custom_goal_projection():
        """
        Calculate projection for a custom goal by its end date using 30-day average.
        Shows what the user will have achieved by the goal's end date at current pace.
        
        Request body:
        {
            "goal_id": "goal_xxx",
            "metric_type": "hours" | "characters" | "games" | "cards",
            "target_value": <number>,
            "end_date": "YYYY-MM-DD"
        }
        
        Returns:
        {
            "projection": <number>,
            "target": <number>,
            "current": <number>,
            "daily_average": <number>,
            "end_date": "YYYY-MM-DD",
            "days_until_target": <number>,
            "percent_difference": <number>
        }
        """
        try:
            data = request.get_json()
            
            if not data:
                return jsonify({"error": "No data provided"}), 400
            
            goal_id = data.get("goal_id")
            metric_type = data.get("metric_type")
            target_value = data.get("target_value")
            end_date_str = data.get("end_date")
            
            # Validate required fields
            if not all([goal_id, metric_type, target_value, end_date_str]):
                return jsonify({"error": "Missing required fields"}), 400
            
            # Validate metric type - only allow the 4 core metrics
            if metric_type not in ["hours", "characters", "games", "cards"]:
                return jsonify({"error": "Invalid metric_type. Must be hours, characters, games, or cards"}), 400
            
            # Parse end date
            try:
                end_date = datetime.datetime.strptime(end_date_str, "%Y-%m-%d").date()
                today = datetime.date.today()
            except ValueError as e:
                return jsonify({"error": f"Invalid date format: {str(e)}"}), 400
            
            # Calculate 30-day average (same as built-in goals)
            thirty_days_ago = today - datetime.timedelta(days=30)
            thirty_days_ago_str = thirty_days_ago.strftime("%Y-%m-%d")
            yesterday = today - datetime.timedelta(days=1)
            yesterday_str = yesterday.strftime("%Y-%m-%d")
            
            # Get rollup data for last 30 days
            rollups_30d = StatsRollupTable.get_date_range(thirty_days_ago_str, yesterday_str)
            
            # Get today's live data
            today_start = datetime.datetime.combine(today, datetime.time.min).timestamp()
            today_end = datetime.datetime.combine(today, datetime.time.max).timestamp()
            today_lines = GameLinesTable.get_lines_filtered_by_timestamp(
                start=today_start, end=today_end, for_stats=True
            )
            
            live_stats_today = None
            if today_lines:
                live_stats_today = calculate_live_stats_for_today(today_lines)
            
            # Calculate 30-day average based on metric type
            if metric_type == "cards":
                # For cards, count lines with audio_in_anki OR screenshot_in_anki
                total_cards = 0
                for rollup in rollups_30d:
                    total_cards += rollup.anki_cards_created or 0
                
                # Add today's cards
                if today_lines:
                    for line in today_lines:
                        if (line.audio_in_anki and line.audio_in_anki.strip()) or \
                           (line.screenshot_in_anki and line.screenshot_in_anki.strip()):
                            total_cards += 1
                
                avg_daily = total_cards / 30
                
            else:
                # For hours, characters, games - use existing rollup aggregation
                total_value = 0
                
                for rollup in rollups_30d:
                    if metric_type == "hours":
                        total_value += rollup.total_reading_time_seconds / 3600
                    elif metric_type == "characters":
                        total_value += rollup.total_characters
                    elif metric_type == "games":
                        if rollup.games_played_ids:
                            try:
                                games_ids = (
                                    json.loads(rollup.games_played_ids)
                                    if isinstance(rollup.games_played_ids, str)
                                    else rollup.games_played_ids
                                )
                                # Count unique games for this day
                                total_value += len(set(games_ids))
                            except (json.JSONDecodeError, TypeError):
                                pass
                
                # Add today's value
                if live_stats_today:
                    if metric_type == "hours":
                        total_value += live_stats_today.get("total_reading_time_seconds", 0) / 3600
                    elif metric_type == "characters":
                        total_value += live_stats_today.get("total_characters", 0)
                    elif metric_type == "games":
                        total_value += len(live_stats_today.get("games_played_ids", []))
                
                avg_daily = total_value / 30
            
            # Get current total (all-time)
            first_rollup_date = StatsRollupTable.get_first_date()
            if not first_rollup_date:
                current_total = 0
            else:
                all_rollups = StatsRollupTable.get_date_range(first_rollup_date, yesterday_str)
                rollup_stats_all = aggregate_rollup_data(all_rollups) if all_rollups else None
                combined_stats_all = combine_rollup_and_live_stats(rollup_stats_all, live_stats_today)
                
                if metric_type == "hours":
                    current_total = combined_stats_all.get("total_reading_time_seconds", 0) / 3600
                elif metric_type == "characters":
                    current_total = combined_stats_all.get("total_characters", 0)
                elif metric_type == "games":
                    current_total = combined_stats_all.get("unique_games_played", 0)
                elif metric_type == "cards":
                    # Calculate total cards from all rollups + today
                    total_cards_all = sum(r.anki_cards_created or 0 for r in all_rollups)
                    if today_lines:
                        for line in today_lines:
                            if (line.audio_in_anki and line.audio_in_anki.strip()) or \
                               (line.screenshot_in_anki and line.screenshot_in_anki.strip()):
                                total_cards_all += 1
                    current_total = total_cards_all
            
            # Calculate projection
            days_until_target = (end_date - today).days
            projected_value = current_total + (avg_daily * days_until_target)
            
            # Calculate percentage difference
            if target_value > 0:
                percent_diff = ((projected_value - target_value) / target_value) * 100
            else:
                percent_diff = 0
            
            return jsonify({
                "projection": round(projected_value, 2) if metric_type == "hours" else int(projected_value),
                "target": target_value,
                "current": round(current_total, 2) if metric_type == "hours" else int(current_total),
                "daily_average": round(avg_daily, 2) if metric_type == "hours" else int(avg_daily),
                "end_date": end_date_str,
                "days_until_target": days_until_target,
                "percent_difference": round(percent_diff, 2)
            }), 200
            
        except Exception as e:
            logger.error(f"Error calculating goal projection: {e}", exc_info=True)
            return jsonify({"error": "Failed to calculate projection"}), 500