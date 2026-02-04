"""
Daily Goals Auto-Completion Cron Job for GameSentenceMiner

This module provides a cron job that runs hourly to check if all daily goals
are completed, and if so, automatically creates the historical snapshot and
updates the streak.

This is designed to be called by the cron system via run_crons.py.

Usage:
    from GameSentenceMiner.util.cron.daily_goals_completion import run_daily_goals_completion

    # Run the daily goals completion check
    result = run_daily_goals_completion()
    print(f"Action: {result['action']}, Success: {result['success']}")
"""

import datetime
import json
import time
from typing import Dict, Optional, Tuple

import pytz

from GameSentenceMiner.util.configuration import logger
from GameSentenceMiner.util.db import GoalsTable


def get_user_timezone_from_settings() -> pytz.BaseTzInfo:
    """
    Get the user's timezone from goals_settings in the database.

    Fallback chain:
    1. goals_settings.timezone from database
    2. System local timezone
    3. UTC

    Returns:
        pytz timezone object
    """
    try:
        # Get current goals entry
        current_entry = GoalsTable.get_by_date('current')

        if current_entry and current_entry.goals_settings:
            # Parse goals_settings
            if isinstance(current_entry.goals_settings, str):
                try:
                    goals_settings = json.loads(current_entry.goals_settings)
                except json.JSONDecodeError:
                    goals_settings = {}
            else:
                goals_settings = current_entry.goals_settings if current_entry.goals_settings else {}

            # Check for timezone in settings
            tz_str = goals_settings.get('timezone')
            if tz_str:
                try:
                    return pytz.timezone(tz_str)
                except pytz.exceptions.UnknownTimeZoneError:
                    logger.warning(f"Unknown timezone in goals_settings: {tz_str}")
    except Exception as e:
        logger.warning(f"Error reading timezone from goals_settings: {e}")

    # Fallback to system timezone
    try:
        import tzlocal
        local_tz = tzlocal.get_localzone()
        if local_tz:
            return local_tz
    except Exception as e:
        logger.debug(f"Could not get system timezone: {e}")

    # Final fallback to UTC
    logger.debug("Using UTC as fallback timezone")
    return pytz.UTC


def get_today_in_timezone(tz: pytz.BaseTzInfo) -> datetime.date:
    """
    Get today's date in the specified timezone.

    Args:
        tz: pytz timezone object

    Returns:
        date object representing today in the specified timezone
    """
    return datetime.datetime.now(tz).date()


def check_all_goals_completed(user_tz: pytz.BaseTzInfo) -> Tuple[bool, str]:
    """
    Check if all numeric goals for today are completed.

    Uses get_todays_goals() to fetch current progress and checks if
    progress_today >= progress_needed for all numeric goals.

    Args:
        user_tz: pytz timezone object for the user

    Returns:
        Tuple of (all_completed: bool, reason: str)
        - all_completed: True if all goals are met
        - reason: Human-readable explanation of the result
    """
    try:
        # Import here to avoid circular imports
        from GameSentenceMiner.web.goals_api import get_todays_goals

        # Get today's goals
        goals_data = get_todays_goals(user_tz=user_tz)

        if not goals_data:
            return True, "No goals data found (empty day)"

        goals = goals_data.get('goals', [])

        if not goals:
            return True, "No active goals for today"

        # Check each goal
        incomplete_goals = []
        for goal in goals:
            goal_name = goal.get('goal_name', 'Unknown')
            progress_today = goal.get('progress_today', 0)
            progress_needed = goal.get('progress_needed', 0)
            metric_type = goal.get('metric_type', 'unknown')

            # Skip custom goals (checkbox-based, handled separately)
            if metric_type == 'custom':
                continue

            # Convert to float for comparison (handles both int and float)
            try:
                progress_value = float(progress_today) if progress_today is not None else 0
                required_value = float(progress_needed) if progress_needed is not None else 0
            except (ValueError, TypeError):
                logger.warning(f"Could not parse progress values for goal '{goal_name}'")
                incomplete_goals.append(goal_name)
                continue

            # Check if goal is complete
            if progress_value < required_value:
                incomplete_goals.append(f"{goal_name} ({progress_value:.2f}/{required_value:.2f})")

        if incomplete_goals:
            return False, f"Incomplete goals: {', '.join(incomplete_goals)}"

        return True, "All goals completed"

    except Exception as e:
        logger.exception(f"Error checking goal completion: {e}")
        return False, f"Error checking goals: {str(e)}"


def complete_daily_goals(user_tz: pytz.BaseTzInfo) -> Dict:
    """
    Complete today's daily goals and update streak.

    This is the core logic extracted from api_complete_todays_dailies,
    modified to work without Flask request context.

    Args:
        user_tz: pytz timezone object for the user

    Returns:
        Dict with keys: success, date, streak, longest_streak, message
    """
    try:
        # Get today's date in user timezone
        today = get_today_in_timezone(user_tz)
        today_str = today.strftime("%Y-%m-%d")

        # Check if entry already exists for today
        existing_entry = GoalsTable.get_by_date(today_str)
        if existing_entry:
            return {
                "success": False,
                "action": "already_completed",
                "error": "Dailies already completed for today",
                "date": today_str
            }

        # Get current (live) goals and settings
        current_entry = GoalsTable.get_by_date('current')

        if not current_entry:
            return {
                "success": False,
                "action": "no_goals",
                "error": "No current goals found",
                "date": today_str
            }

        # Parse current data
        if isinstance(current_entry.current_goals, str):
            try:
                current_goals = json.loads(current_entry.current_goals)
            except json.JSONDecodeError:
                current_goals = []
        else:
            current_goals = current_entry.current_goals if current_entry.current_goals else []

        if isinstance(current_entry.goals_settings, str):
            try:
                goals_settings = json.loads(current_entry.goals_settings) if current_entry.goals_settings else {}
            except json.JSONDecodeError:
                goals_settings = {}
        else:
            goals_settings = current_entry.goals_settings if current_entry.goals_settings else {}

        # Calculate streak for today
        current_streak, longest_streak = GoalsTable.calculate_streak(today_str, str(user_tz))

        # Add/update longest_streak in goals_settings
        goals_settings['longestStreak'] = longest_streak

        # Convert to JSON strings for historical snapshot
        current_goals_json = json.dumps(current_goals)
        goals_settings_json = json.dumps(goals_settings)

        # Create historical snapshot for today
        GoalsTable.create_entry(
            date_str=today_str,
            current_goals_json=current_goals_json,
            goals_settings_json=goals_settings_json,
            last_updated=time.time(),
            goals_version=None
        )

        # Update the 'current' entry with new longest streak
        current_entry.goals_settings = goals_settings
        current_entry.last_updated = time.time()
        current_entry.save()

        logger.info(f"Auto-completed dailies for {today_str} with streak: {current_streak}, longest: {longest_streak}")

        return {
            "success": True,
            "action": "completed",
            "date": today_str,
            "streak": current_streak,
            "longest_streak": longest_streak,
            "message": f"Dailies auto-completed! Current streak: {current_streak} days"
        }

    except Exception as e:
        logger.exception(f"Error completing daily goals: {e}")
        return {
            "success": False,
            "action": "error",
            "error": str(e)
        }


def run_daily_goals_completion() -> Dict:
    """
    Main entry point for the daily goals completion cron job.

    This function:
    1. Gets the user's timezone from goals_settings
    2. Checks if today's goals have already been completed
    3. Checks if all goals are completed
    4. If all goals are complete, creates the historical snapshot and updates streak

    Returns:
        Dictionary with result information:
        {
            'success': bool,
            'action': str,  # 'completed', 'skipped', 'already_completed', 'incomplete', 'error'
            'date': str,
            'streak': int,  # Only if action == 'completed'
            'longest_streak': int,  # Only if action == 'completed'
            'reason': str,  # Human-readable explanation
        }
    """
    logger.info("Starting daily goals completion check")

    try:
        # Get user timezone
        user_tz = get_user_timezone_from_settings()
        today = get_today_in_timezone(user_tz)
        today_str = today.strftime("%Y-%m-%d")

        logger.debug(f"Checking daily goals for {today_str} (timezone: {user_tz})")

        # Check if already completed today
        existing_entry = GoalsTable.get_by_date(today_str)
        if existing_entry:
            logger.debug(f"Daily goals already completed for {today_str}")
            return {
                'success': True,
                'action': 'already_completed',
                'date': today_str,
                'reason': 'Dailies already completed for today'
            }

        # Check if all goals are completed
        all_completed, reason = check_all_goals_completed(user_tz)

        if not all_completed:
            logger.debug(f"Goals not yet complete: {reason}")
            return {
                'success': True,
                'action': 'incomplete',
                'date': today_str,
                'reason': reason
            }

        # All goals are complete - run the completion logic
        logger.info(f"All goals completed for {today_str}, auto-completing dailies")
        result = complete_daily_goals(user_tz)

        return result

    except Exception as e:
        logger.exception(f"Error in daily goals completion cron: {e}")
        return {
            'success': False,
            'action': 'error',
            'error': str(e),
            'reason': f'Unexpected error: {str(e)}'
        }


# Example usage for testing
if __name__ == '__main__':
    result = run_daily_goals_completion()

    print("\n" + "=" * 60)
    print("DAILY GOALS COMPLETION CHECK")
    print("=" * 60)
    print(f"Success: {result.get('success')}")
    print(f"Action: {result.get('action')}")
    print(f"Date: {result.get('date', 'N/A')}")
    if result.get('streak'):
        print(f"Streak: {result.get('streak')}")
        print(f"Longest Streak: {result.get('longest_streak')}")
    print(f"Reason: {result.get('reason', result.get('message', result.get('error', 'N/A')))}")
    print("=" * 60)
