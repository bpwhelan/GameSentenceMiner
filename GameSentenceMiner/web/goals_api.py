"""
Goals API Endpoints

This module contains API endpoints specifically for custom goals functionality.
Provides data for calculating progress on user-defined goals with date ranges.
"""

import datetime
import json
import time
from flask import request, jsonify

from GameSentenceMiner.util.stats_rollup_table import StatsRollupTable
from GameSentenceMiner.util.db import GameLinesTable, GoalsTable
from GameSentenceMiner.util.games_table import GamesTable
from GameSentenceMiner.util.configuration import logger
from GameSentenceMiner.web.rollup_stats import (
    calculate_live_stats_for_today,
    aggregate_rollup_data,
    combine_rollup_and_live_stats,
)


# Helper Functions

def parse_and_validate_dates(start_date_str, end_date_str):
    """
    Parse and validate date strings in YYYY-MM-DD format.
    
    Args:
        start_date_str: Start date string
        end_date_str: End date string
        
    Returns:
        tuple: (start_date, end_date) as date objects
        
    Raises:
        ValueError: If date format is invalid
    """
    try:
        start_date = datetime.datetime.strptime(start_date_str, "%Y-%m-%d").date()
        end_date = datetime.datetime.strptime(end_date_str, "%Y-%m-%d").date()
        return start_date, end_date
    except ValueError as e:
        raise ValueError(f"Invalid date format: {str(e)}")


def validate_metric_type(metric_type, allowed_types=None):
    """
    Validate that metric_type is one of the allowed types.
    
    Args:
        metric_type: The metric type to validate
        allowed_types: List of allowed types (defaults to standard 4 metrics)
        
    Returns:
        bool: True if valid
        
    Raises:
        ValueError: If metric_type is not in allowed_types
    """
    if allowed_types is None:
        allowed_types = ["hours", "characters", "games", "cards"]
    
    if metric_type not in allowed_types:
        raise ValueError(f"Invalid metric_type. Must be one of: {', '.join(allowed_types)}")
    
    return True


def get_todays_live_data(today):
    """
    Fetch today's game lines and calculate live statistics.
    
    Args:
        today: date object for today
        
    Returns:
        tuple: (today_lines, live_stats) where live_stats may be None
    """
    today_start = datetime.datetime.combine(today, datetime.time.min).timestamp()
    today_end = datetime.datetime.combine(today, datetime.time.max).timestamp()
    today_lines = GameLinesTable.get_lines_filtered_by_timestamp(
        start=today_start, end=today_end, for_stats=True
    )
    
    live_stats = None
    if today_lines:
        live_stats = calculate_live_stats_for_today(today_lines)
    
    return today_lines, live_stats


def count_cards_from_lines(lines):
    """
    Count Anki cards from game lines.
    A line counts as a card if it has audio_in_anki OR screenshot_in_anki.
    
    Args:
        lines: List of game line objects
        
    Returns:
        int: Number of cards
    """
    if not lines:
        return 0
    
    count = 0
    for line in lines:
        if (line.audio_in_anki or '').strip() or (line.screenshot_in_anki or '').strip():
            count += 1
    
    return count


def get_rollup_stats_for_range(start_date, end_date):
    """
    Fetch and aggregate rollup statistics for a date range.
    
    Args:
        start_date: Start date (date object or string)
        end_date: End date (date object or string)
        
    Returns:
        dict: Aggregated rollup stats or None if no rollups found
    """
    # Convert to strings if date objects
    if isinstance(start_date, datetime.date):
        start_date = start_date.strftime("%Y-%m-%d")
    if isinstance(end_date, datetime.date):
        end_date = end_date.strftime("%Y-%m-%d")
    
    rollups = StatsRollupTable.get_date_range(start_date, end_date)
    
    if rollups:
        return aggregate_rollup_data(rollups)
    
    return None


def extract_metric_value(combined_stats, metric_type, today_lines=None, rollup_stats=None, start_date=None, yesterday=None):
    """
    Extract progress value from combined stats based on metric type.
    For 'cards' metric, requires additional parameters to calculate from rollups and lines.
    
    Args:
        combined_stats: Combined rollup and live stats dictionary
        metric_type: Type of metric ("hours", "characters", "games", "cards")
        today_lines: Today's game lines (required for cards)
        rollup_stats: Rollup stats (used to check if we need to query for cards)
        start_date: Start date for card calculation
        yesterday: Yesterday's date for card calculation
        
    Returns:
        float or int: The metric value
    """
    if metric_type == "hours":
        return combined_stats.get("total_reading_time_seconds", 0) / 3600
    elif metric_type == "characters":
        return combined_stats.get("total_characters", 0)
    elif metric_type == "games":
        return combined_stats.get("unique_games_played", 0)
    elif metric_type == "cards":
        # Cards require special handling - sum from rollups + today's lines
        total_cards = 0
        
        # Sum from rollups if we have the date range
        if start_date and yesterday:
            rollups = StatsRollupTable.get_date_range(
                start_date.strftime("%Y-%m-%d"),
                yesterday.strftime("%Y-%m-%d")
            )
            for rollup in rollups:
                total_cards += rollup.anki_cards_created or 0
        
        # Add today's cards
        if today_lines:
            total_cards += count_cards_from_lines(today_lines)
        
        return total_cards
    
    return 0


def calculate_easy_day_multiplier(date, goals_settings):
    """
    Calculate the easy day multiplier for a given date based on goals settings.
    
    Args:
        date: date object
        goals_settings: Dictionary containing easyDays settings
        
    Returns:
        float: Multiplier between 0.0 and 1.0 (percentage / 100)
    """
    day_names = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
    day_index = date.weekday()  # 0=Monday, 6=Sunday
    day_name = day_names[day_index]
    
    # Get easy days settings, default to 100% if not provided
    easy_days = goals_settings.get('easyDays', {}) if goals_settings else {}
    easy_day_percentage = easy_days.get(day_name, 100)
    
    return easy_day_percentage / 100.0


def format_metric_value(value, metric_type):
    """
    Format a metric value for JSON response based on metric type.
    Hours are rounded to 2 decimal places, others are converted to integers.
    
    Args:
        value: The numeric value to format
        metric_type: Type of metric
        
    Returns:
        float or int: Formatted value
    """
    if metric_type == "hours":
        return round(value, 2)
    else:
        return int(value)


def format_requirement_display(value, metric_type):
    """
    Format a requirement value for human-readable display.
    
    Args:
        value: The numeric value
        metric_type: Type of metric
        
    Returns:
        str: Formatted display string (e.g., "1h 30m", "1.5K", "5")
    """
    if metric_type == "hours":
        hours = int(value)
        minutes = int((value - hours) * 60)
        if hours > 0:
            return f"{hours}h" + (f" {minutes}m" if minutes > 0 else "")
        else:
            return f"{minutes}m"
    elif metric_type == "characters":
        int_value = int(value)
        if int_value >= 1000000:
            return f"{int_value / 1000000:.1f}M"
        elif int_value >= 1000:
            return f"{int_value / 1000:.1f}K"
        else:
            return str(int_value)
    else:
        return str(int(value))


def register_goals_api_routes(app):
    """Register goals API routes with the Flask app."""

    @app.route("/api/goals/progress", methods=["POST"])
    def api_goals_progress():
        """
        Calculate progress for a custom goal within a specific date range.
        
        Request body:
        {
            "metric_type": "hours" | "characters" | "games" | "cards",
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
            
            # Validate metric type
            try:
                validate_metric_type(metric_type)
            except ValueError as e:
                return jsonify({"error": str(e)}), 400
            
            # Parse dates
            try:
                start_date, end_date = parse_and_validate_dates(start_date_str, end_date_str)
            except ValueError as e:
                return jsonify({"error": str(e)}), 400
            
            if start_date > end_date:
                return jsonify({"error": "start_date must be before or equal to end_date"}), 400
            
            # Calculate progress based on metric type
            today = datetime.date.today()
            
            # If goal hasn't started yet, return 0 progress
            if today < start_date:
                return jsonify({
                    "progress": 0,
                    "daily_average": 0,
                    "days_in_range": (end_date - start_date).days + 1
                }), 200
            
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
                rollup_stats = get_rollup_stats_for_range(start_date, rollup_end_date)
            
            # Get today's live data if needed
            today_lines = None
            live_stats = None
            if include_today:
                today_lines, live_stats = get_todays_live_data(today)
            
            # Combine rollup and live stats
            combined_stats = combine_rollup_and_live_stats(rollup_stats, live_stats)
            
            # Extract progress based on metric type
            progress = extract_metric_value(
                combined_stats, metric_type,
                today_lines=today_lines if include_today else None,
                start_date=start_date if start_date <= rollup_end_date else None,
                yesterday=rollup_end_date if start_date <= rollup_end_date else None
            )
            
            # Calculate days in range
            days_in_range = (end_date - start_date).days + 1
            
            # Calculate daily average
            daily_average = progress / days_in_range if days_in_range > 0 else 0
            
            return jsonify({
                "progress": format_metric_value(progress, metric_type),
                "daily_average": format_metric_value(daily_average, metric_type),
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
        Applies easy days percentage reduction based on current day of week.
        
        Request body:
        {
            "goal_id": "goal_xxx",
            "metric_type": "hours" | "characters" | "games",
            "target_value": <number>,
            "start_date": "YYYY-MM-DD",
            "end_date": "YYYY-MM-DD",
            "goals_settings": {...}  # Optional: includes easyDays settings
        }
        
        Returns:
        {
            "required": <number>,  # What needs to be done today (adjusted for easy days)
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
            goals_settings = data.get("goals_settings", {})
            
            # Validate required fields
            if not all([goal_id, metric_type, target_value, start_date_str, end_date_str]):
                return jsonify({"error": "Missing required fields"}), 400
            
            # Validate metric type
            try:
                validate_metric_type(metric_type)
            except ValueError as e:
                return jsonify({"error": str(e)}), 400
            
            # Parse dates
            try:
                start_date, end_date = parse_and_validate_dates(start_date_str, end_date_str)
                today = datetime.date.today()
            except ValueError as e:
                return jsonify({"error": str(e)}), 400
            
            # Check if goal is currently active
            if today < start_date or today > end_date:
                return jsonify({
                    "required": 0,
                    "progress": 0,
                    "has_target": False,
                    "expired": today > end_date,
                    "not_started": today < start_date
                }), 200
            
            # Get easy day multiplier for today
            easy_day_multiplier = calculate_easy_day_multiplier(today, goals_settings)
            easy_day_percentage = int(easy_day_multiplier * 100)
            
            # Calculate total progress from start_date to yesterday
            yesterday = today - datetime.timedelta(days=1)
            
            rollup_stats = None
            if start_date <= yesterday:
                rollup_stats = get_rollup_stats_for_range(start_date, yesterday)
            
            # Get today's live data
            today_lines, live_stats = get_todays_live_data(today)
            
            # Combine stats for total progress
            combined_stats = combine_rollup_and_live_stats(rollup_stats, live_stats)
            
            # Extract total progress
            total_progress = extract_metric_value(
                combined_stats, metric_type,
                today_lines=today_lines,
                start_date=start_date if start_date <= yesterday else None,
                yesterday=yesterday if start_date <= yesterday else None
            )
            
            # Extract today's progress
            today_progress = 0
            if live_stats:
                today_stats_only = combine_rollup_and_live_stats(None, live_stats)
                today_progress = extract_metric_value(
                    today_stats_only, metric_type,
                    today_lines=today_lines,
                    start_date=None,
                    yesterday=None
                )
            
            # Calculate days remaining (including today)
            days_remaining = (end_date - today).days + 1
            
            # Calculate daily requirement
            remaining_work = max(0, target_value - total_progress)
            daily_required = remaining_work / days_remaining if days_remaining > 0 else 0
            
            # Apply easy day multiplier to reduce today's requirement
            daily_required_adjusted = daily_required * easy_day_multiplier
            
            return jsonify({
                "required": format_metric_value(daily_required_adjusted, metric_type),
                "progress": format_metric_value(today_progress, metric_type),
                "has_target": True,
                "days_remaining": days_remaining,
                "total_progress": format_metric_value(total_progress, metric_type),
                "easy_day_percentage": easy_day_percentage
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
            "start_date": "YYYY-MM-DD",
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
            start_date_str = data.get("start_date")
            end_date_str = data.get("end_date")
            
            # Validate required fields
            if not all([goal_id, metric_type, target_value, start_date_str, end_date_str]):
                return jsonify({"error": "Missing required fields"}), 400
            
            # Validate metric type
            try:
                validate_metric_type(metric_type)
            except ValueError as e:
                return jsonify({"error": str(e)}), 400
            
            # Parse dates
            try:
                start_date, end_date = parse_and_validate_dates(start_date_str, end_date_str)
                today = datetime.date.today()
            except ValueError as e:
                return jsonify({"error": str(e)}), 400
            
            # Calculate 30-day average (same as built-in goals)
            thirty_days_ago = today - datetime.timedelta(days=30)
            thirty_days_ago_str = thirty_days_ago.strftime("%Y-%m-%d")
            yesterday = today - datetime.timedelta(days=1)
            yesterday_str = yesterday.strftime("%Y-%m-%d")
            
            # Get rollup data for last 30 days
            rollups_30d = StatsRollupTable.get_date_range(thirty_days_ago_str, yesterday_str)
            
            # Get today's live data
            today_lines, live_stats_today = get_todays_live_data(today)
            
            # Calculate 30-day average based on metric type
            if metric_type == "cards":
                # For cards, count from rollups + today
                total_cards = sum(r.anki_cards_created or 0 for r in rollups_30d)
                total_cards += count_cards_from_lines(today_lines)
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
                
                current_total = extract_metric_value(
                    combined_stats_all, metric_type,
                    today_lines=today_lines,
                    start_date=datetime.datetime.strptime(first_rollup_date, "%Y-%m-%d").date(),
                    yesterday=yesterday
                )
            
            # Calculate projection
            # For future goals, calculate from start_date; for active/past goals, from today
            if today < start_date:
                # Goal hasn't started yet - project from start date with 0 current progress
                days_until_target = (end_date - start_date).days + 1
                projected_value = avg_daily * days_until_target
                current_total = 0
            else:
                # Goal is active or in the past - project from today
                days_until_target = (end_date - today).days
                projected_value = current_total + (avg_daily * days_until_target)
            
            # Calculate percentage difference
            if target_value > 0:
                percent_diff = ((projected_value - target_value) / target_value) * 100
            else:
                percent_diff = 0
            
            return jsonify({
                "projection": format_metric_value(projected_value, metric_type),
                "target": target_value,
                "current": format_metric_value(current_total, metric_type),
                "daily_average": format_metric_value(avg_daily, metric_type),
                "end_date": end_date_str,
                "days_until_target": days_until_target,
                "percent_difference": round(percent_diff, 2)
            }), 200
            
        except Exception as e:
            logger.error(f"Error calculating goal projection: {e}", exc_info=True)
            return jsonify({"error": "Failed to calculate projection"}), 500
    
    @app.route("/api/goals/complete_todays_dailies", methods=["POST"])
    def api_complete_todays_dailies():
        """
        Complete today's dailies and update streak.
        Creates a new entry in the goals table for today.
        
        Request body:
        {
            "current_goals": [...],  # Array of goal objects from localStorage
            "goals_settings": {...}  # Settings object including easyDays
        }
        
        Returns:
        {
            "success": true,
            "date": "2025-01-14",
            "streak": 5,
            "message": "Dailies completed! Current streak: 5 days"
        }
        """
        try:
            data = request.get_json()
            
            if not data:
                return jsonify({"success": False, "error": "No data provided"}), 400
            
            current_goals = data.get("current_goals", [])
            goals_settings = data.get("goals_settings", {})
            
            # Get today's date in YYYY-MM-DD format
            today = datetime.date.today()
            today_str = today.strftime("%Y-%m-%d")
            
            # Check if entry already exists for today
            existing_entry = GoalsTable.get_by_date(today_str)
            if existing_entry:
                return jsonify({
                    "success": False,
                    "error": "Dailies already completed for today",
                    "existing_streak": existing_entry.streak,
                    "date": today_str
                }), 400
            
            # Calculate streak for today
            streak = GoalsTable.calculate_streak(today_str)
            
            # Convert current_goals and goals_settings to JSON strings
            current_goals_json = json.dumps(current_goals)
            goals_settings_json = json.dumps(goals_settings)
            
            # Create new entry with current Unix timestamp
            new_entry = GoalsTable.create_entry(
                date_str=today_str,
                streak=streak,
                current_goals_json=current_goals_json,
                goals_settings_json=goals_settings_json,
                last_updated=time.time()
            )
            
            logger.info(f"Dailies completed for {today_str} with streak: {streak}")
            
            return jsonify({
                "success": True,
                "date": today_str,
                "streak": streak,
                "message": f"Dailies completed! Current streak: {streak} days"
            }), 200
            
        except Exception as e:
            logger.error(f"Error completing today's dailies: {e}", exc_info=True)
            return jsonify({"success": False, "error": "Failed to complete dailies"}), 500
    
    @app.route("/api/goals/current_streak", methods=["GET"])
    def api_get_current_streak():
        """
        Get the current streak from the latest goals entry.
        
        Returns:
        {
            "streak": 5,
            "last_completion_date": "2025-01-14"
        }
        """
        try:
            latest_entry = GoalsTable.get_latest()
            
            if not latest_entry:
                return jsonify({
                    "streak": 0,
                    "last_completion_date": None
                }), 200
            
            # Check if streak is still valid (latest entry should be today or yesterday)
            today = datetime.date.today()
            try:
                latest_date = datetime.datetime.strptime(latest_entry.date, '%Y-%m-%d').date()
                yesterday = today - datetime.timedelta(days=1)
                
                # If latest entry is older than yesterday, streak is broken
                if latest_date < yesterday:
                    current_streak = 0
                else:
                    current_streak = latest_entry.streak
                    
            except (ValueError, AttributeError):
                current_streak = 0
            
            return jsonify({
                "streak": current_streak,
                "last_completion_date": latest_entry.date
            }), 200
            
        except Exception as e:
            logger.error(f"Error getting current streak: {e}", exc_info=True)
            return jsonify({"error": "Failed to get current streak"}), 500
    
    @app.route("/api/goals/latest_goals", methods=["GET"])
    def api_get_latest_goals():
        """
        Get the latest goals entry with date, streak, current_goals, and goals_settings.
        
        Returns:
        {
            "date": "2025-01-14",
            "current_goals": [...],  # Parsed JSON array
            "goals_settings": {...},  # Parsed JSON object
            "streak": 5
        }
        """
        try:
            latest_entry = GoalsTable.get_latest()
            
            if not latest_entry:
                return jsonify({
                    "date": None,
                    "current_goals": [],
                    "goals_settings": {},
                    "streak": 0
                }), 200
            
            # Parse current_goals - may already be parsed by database layer
            if isinstance(latest_entry.current_goals, str):
                try:
                    current_goals = json.loads(latest_entry.current_goals)
                except json.JSONDecodeError:
                    current_goals = []
            else:
                current_goals = latest_entry.current_goals if latest_entry.current_goals else []
            
            # Parse goals_settings - may already be parsed by database layer
            if hasattr(latest_entry, 'goals_settings'):
                if isinstance(latest_entry.goals_settings, str):
                    try:
                        goals_settings = json.loads(latest_entry.goals_settings) if latest_entry.goals_settings else {}
                    except json.JSONDecodeError:
                        goals_settings = {}
                else:
                    goals_settings = latest_entry.goals_settings if latest_entry.goals_settings else {}
            else:
                goals_settings = {}
            
            return jsonify({
                "date": latest_entry.date,
                "current_goals": current_goals,
                "goals_settings": goals_settings,
                "streak": latest_entry.streak
            }), 200
            
        except Exception as e:
            logger.error(f"Error getting latest goals: {e}", exc_info=True)
            return jsonify({"error": "Failed to get latest goals"}), 500
    
    @app.route("/api/goals/tomorrow-requirements", methods=["POST"])
    def api_tomorrow_requirements():
        """
        Calculate tomorrow's requirements for all active goals.
        Filters out custom goals and goals with 0 requirement tomorrow.
        
        Request body:
        {
            "current_goals": [...],  # Array of goal objects from localStorage
            "goals_settings": {...}  # Settings object including easyDays
        }
        
        Returns:
        {
            "requirements": [
                {
                    "goal_name": "Read for 6 hours in October",
                    "goal_icon": "⏱️",
                    "metric_type": "hours",
                    "required_tomorrow": 1.5,
                    "formatted_required": "1h 30m"
                }
            ]
        }
        """
        try:
            data = request.get_json()
            
            if not data:
                return jsonify({"error": "No data provided"}), 400
            
            current_goals = data.get("current_goals", [])
            goals_settings = data.get("goals_settings", {})
            
            # Get tomorrow's date
            today = datetime.date.today()
            tomorrow = today + datetime.timedelta(days=1)
            tomorrow_str = tomorrow.strftime("%Y-%m-%d")
            
            # Get easy day multiplier for tomorrow
            tomorrow_multiplier = calculate_easy_day_multiplier(tomorrow, goals_settings)
            
            requirements = []
            
            # Process each goal
            for goal in current_goals:
                # Skip custom goals (they don't have numeric requirements)
                if goal.get('metricType') == 'custom':
                    continue
                
                metric_type = goal.get('metricType')
                target_value = goal.get('targetValue')
                start_date_str = goal.get('startDate')
                end_date_str = goal.get('endDate')
                goal_name = goal.get('name', 'Unknown Goal')
                goal_icon = goal.get('icon', '🎯')
                
                # Validate required fields
                if not all([metric_type, target_value, start_date_str, end_date_str]):
                    continue
                
                # Parse dates
                try:
                    start_date, end_date = parse_and_validate_dates(start_date_str, end_date_str)
                except ValueError:
                    continue
                
                # Check if goal is active tomorrow
                if tomorrow < start_date or tomorrow > end_date:
                    continue
                
                # Calculate total progress up to today
                yesterday = today - datetime.timedelta(days=1)
                
                rollup_stats = None
                if start_date <= yesterday:
                    rollup_stats = get_rollup_stats_for_range(start_date, yesterday)
                
                # Get today's live data
                today_lines, live_stats = get_todays_live_data(today)
                
                # Combine stats for total progress
                combined_stats = combine_rollup_and_live_stats(rollup_stats, live_stats)
                
                # Extract total progress
                total_progress = extract_metric_value(
                    combined_stats, metric_type,
                    today_lines=today_lines,
                    start_date=start_date if start_date <= yesterday else None,
                    yesterday=yesterday if start_date <= yesterday else None
                )
                
                # Calculate days remaining from tomorrow to end date (inclusive)
                days_remaining = (end_date - tomorrow).days + 1
                
                if days_remaining <= 0:
                    continue
                
                # Calculate daily requirement for tomorrow
                remaining_work = max(0, target_value - total_progress)
                daily_required = remaining_work / days_remaining
                
                # Apply easy day multiplier for tomorrow
                daily_required_adjusted = daily_required * tomorrow_multiplier
                
                # Skip if no requirement tomorrow
                if daily_required_adjusted <= 0:
                    continue
                
                # Format the requirement based on metric type
                required_value = format_metric_value(daily_required_adjusted, metric_type)
                formatted = format_requirement_display(daily_required_adjusted, metric_type)
                
                requirements.append({
                    "goal_name": goal_name,
                    "goal_icon": goal_icon,
                    "metric_type": metric_type,
                    "required_tomorrow": required_value,
                    "formatted_required": formatted
                })
            
            return jsonify({
                "requirements": requirements
            }), 200
            
        except Exception as e:
            logger.error(f"Error calculating tomorrow's requirements: {e}", exc_info=True)
            return jsonify({"error": "Failed to calculate tomorrow's requirements"}), 500