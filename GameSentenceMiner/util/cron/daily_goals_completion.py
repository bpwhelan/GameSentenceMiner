"""
Daily Goals Auto-Completion Cron Job for GameSentenceMiner

This module provides a cron job that runs hourly to check goal completion and
auto-complete historical missed dates where goals are valid and completed.

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

from GameSentenceMiner.util.config.configuration import logger
from GameSentenceMiner.util.database.db import GoalsTable


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
        current_entry = GoalsTable.get_by_date("current")

        if current_entry and current_entry.goals_settings:
            # Parse goals_settings
            if isinstance(current_entry.goals_settings, str):
                try:
                    goals_settings = json.loads(current_entry.goals_settings)
                except json.JSONDecodeError:
                    goals_settings = {}
            else:
                goals_settings = (
                    current_entry.goals_settings if current_entry.goals_settings else {}
                )

            # Check for timezone in settings
            tz_str = goals_settings.get("timezone")
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


def _parse_current_goals_and_settings(current_entry) -> Tuple[list, dict]:
    """Parse `current_goals` and `goals_settings` from the goals `current` row."""
    if isinstance(current_entry.current_goals, str):
        try:
            current_goals = json.loads(current_entry.current_goals)
        except json.JSONDecodeError:
            current_goals = []
    else:
        current_goals = (
            current_entry.current_goals if current_entry.current_goals else []
        )

    if isinstance(current_entry.goals_settings, str):
        try:
            goals_settings = (
                json.loads(current_entry.goals_settings)
                if current_entry.goals_settings
                else {}
            )
        except json.JSONDecodeError:
            goals_settings = {}
    else:
        goals_settings = (
            current_entry.goals_settings if current_entry.goals_settings else {}
        )

    return current_goals, goals_settings


def _get_current_entry_payload() -> Tuple[Optional[GoalsTable], list, dict]:
    """Return `(current_entry, current_goals, goals_settings)`."""
    current_entry = GoalsTable.get_by_date("current")
    if not current_entry:
        return None, [], {}

    current_goals, goals_settings = _parse_current_goals_and_settings(current_entry)
    return current_entry, current_goals, goals_settings


def _coerce_date(date_str: str) -> Optional[datetime.date]:
    """Parse `YYYY-MM-DD` date strings safely."""
    if not date_str:
        return None
    try:
        return datetime.datetime.strptime(date_str, "%Y-%m-%d").date()
    except (ValueError, TypeError):
        return None


def _get_first_data_date(user_tz: pytz.BaseTzInfo) -> Optional[datetime.date]:
    """
    Determine the first known activity date across rollups, third-party stats,
    and raw game lines.
    """
    from GameSentenceMiner.util.database.db import GameLinesTable
    from GameSentenceMiner.util.database.stats_rollup_table import StatsRollupTable
    from GameSentenceMiner.util.database.third_party_stats_table import (
        ThirdPartyStatsTable,
    )

    candidates: list[datetime.date] = []

    try:
        first_rollup = StatsRollupTable.get_first_date()
        parsed = _coerce_date(first_rollup) if first_rollup else None
        if parsed:
            candidates.append(parsed)
    except Exception as e:
        logger.debug(f"Could not read first rollup date: {e}")

    try:
        if ThirdPartyStatsTable._db is not None:
            row = ThirdPartyStatsTable._db.fetchone(
                f"SELECT MIN(date) FROM {ThirdPartyStatsTable._table}"
            )
            parsed = _coerce_date(row[0]) if row and row[0] else None
            if parsed:
                candidates.append(parsed)
    except Exception as e:
        logger.debug(f"Could not read first third-party stats date: {e}")

    try:
        if GameLinesTable._db is not None:
            row = GameLinesTable._db.fetchone(
                f"SELECT MIN(timestamp) FROM {GameLinesTable._table}"
            )
            if row and row[0] is not None:
                first_line_date = datetime.datetime.fromtimestamp(
                    float(row[0]), tz=user_tz
                ).date()
                candidates.append(first_line_date)
    except Exception as e:
        logger.debug(f"Could not read first game line date: {e}")

    if not candidates:
        return None
    return min(candidates)


def _build_candidate_dates(
    current_goals: list,
    today: datetime.date,
    static_first_data_date: Optional[datetime.date],
) -> list[datetime.date]:
    """
    Build all historical candidate dates up to `today` where at least one goal
    is valid based on current goal definitions.
    """
    candidate_dates: set[datetime.date] = set()

    for goal in current_goals:
        metric_type = goal.get("metricType")
        if not metric_type or metric_type == "custom":
            continue

        target_value = goal.get("targetValue")
        is_static = metric_type.endswith("_static")

        if target_value is None:
            continue

        if is_static:
            if static_first_data_date is None:
                continue
            start_date = static_first_data_date
            end_date = today
        else:
            start_date = _coerce_date(goal.get("startDate"))
            end_date = _coerce_date(goal.get("endDate"))
            if not start_date or not end_date:
                continue
            if start_date > today:
                continue
            if end_date > today:
                end_date = today

        if start_date > end_date:
            continue

        current_date = start_date
        while current_date <= end_date:
            candidate_dates.add(current_date)
            current_date += datetime.timedelta(days=1)

    return sorted(candidate_dates)


def check_all_goals_completed_for_date(
    target_date: datetime.date,
    user_tz: pytz.BaseTzInfo,
    current_goals: Optional[list] = None,
    goals_settings: Optional[dict] = None,
) -> Tuple[bool, str]:
    """
    Check if all numeric goals for a target date are completed.

    Uses get_goals_for_date() to fetch current progress and checks if
    progress_today >= progress_needed for all numeric goals.

    Args:
        target_date: Date to evaluate.
        user_tz: pytz timezone object for the user
        current_goals: Optional pre-parsed goals payload.
        goals_settings: Optional pre-parsed goals settings payload.

    Returns:
        Tuple of (all_completed: bool, reason: str)
        - all_completed: True if all goals are met
        - reason: Human-readable explanation of the result
    """
    try:
        # Import here to avoid circular imports
        from GameSentenceMiner.web.goals_api import get_goals_for_date

        goals_data = get_goals_for_date(
            target_date=target_date,
            user_tz=user_tz,
            current_goals=current_goals,
            goals_settings=goals_settings,
        )

        if not goals_data:
            return False, "No goals data found"

        goals = goals_data.get("goals", [])

        if not goals:
            return False, "No active goals for date"

        # Check each goal
        incomplete_goals = []
        for goal in goals:
            goal_name = goal.get("goal_name", "Unknown")
            progress_today = goal.get("progress_today", 0)
            progress_needed = goal.get("progress_needed", 0)
            metric_type = goal.get("metric_type", "unknown")

            # Custom goals remain checkbox-driven and are not evaluated here.
            if metric_type == "custom":
                continue

            # Convert to float for comparison (handles both int and float)
            try:
                progress_value = (
                    float(progress_today) if progress_today is not None else 0
                )
                required_value = (
                    float(progress_needed) if progress_needed is not None else 0
                )
            except (ValueError, TypeError):
                logger.warning(
                    f"Could not parse progress values for goal '{goal_name}'"
                )
                incomplete_goals.append(goal_name)
                continue

            # Check if goal is complete
            if progress_value < required_value:
                incomplete_goals.append(
                    f"{goal_name} ({progress_value:.2f}/{required_value:.2f})"
                )

        if incomplete_goals:
            return False, f"Incomplete goals: {', '.join(incomplete_goals)}"

        return True, "All goals completed"

    except Exception as e:
        logger.exception(f"Error checking goal completion: {e}")
        return False, f"Error checking goals: {str(e)}"


def check_all_goals_completed(user_tz: pytz.BaseTzInfo) -> Tuple[bool, str]:
    """Backward-compatible helper that evaluates only today."""
    today = get_today_in_timezone(user_tz)
    return check_all_goals_completed_for_date(today, user_tz)


def complete_daily_goals_for_date(
    target_date: datetime.date,
    user_tz: pytz.BaseTzInfo,
    current_entry: Optional[GoalsTable] = None,
    current_goals: Optional[list] = None,
    goals_settings: Optional[dict] = None,
) -> Dict:
    """
    Complete goals for a specific date and update streak metadata.

    Args:
        target_date: Date to snapshot.
        user_tz: User timezone.
        current_entry: Optional preloaded "current" goals row.
        current_goals: Optional parsed current goals payload.
        goals_settings: Optional parsed goals settings payload.
    """
    try:
        target_date_str = target_date.strftime("%Y-%m-%d")

        existing_entry = GoalsTable.get_by_date(target_date_str)
        if existing_entry:
            return {
                "success": False,
                "action": "already_completed",
                "error": "Dailies already completed for date",
                "date": target_date_str,
            }

        if current_entry is None or current_goals is None or goals_settings is None:
            current_entry, parsed_goals, parsed_settings = _get_current_entry_payload()
            if current_goals is None:
                current_goals = parsed_goals
            if goals_settings is None:
                goals_settings = parsed_settings

        if not current_entry:
            return {
                "success": False,
                "action": "no_goals",
                "error": "No current goals found",
                "date": target_date_str,
            }

        # Calculate streak anchored to the completion date.
        current_streak, longest_streak = GoalsTable.calculate_streak(
            target_date_str, str(user_tz)
        )

        # Add/update longest_streak in goals_settings
        goals_settings["longestStreak"] = longest_streak

        # Convert to JSON strings for historical snapshot
        current_goals_json = json.dumps(current_goals)
        goals_settings_json = json.dumps(goals_settings)

        # Create historical snapshot for target date.
        GoalsTable.create_entry(
            date_str=target_date_str,
            current_goals_json=current_goals_json,
            goals_settings_json=goals_settings_json,
            last_updated=time.time(),
            goals_version=None,
        )

        # Update the 'current' entry with new longest streak
        current_entry.goals_settings = goals_settings
        current_entry.last_updated = time.time()
        current_entry.save()

        logger.info(
            f"Auto-completed dailies for {target_date_str} with streak: {current_streak}, longest: {longest_streak}"
        )

        return {
            "success": True,
            "action": "completed",
            "date": target_date_str,
            "streak": current_streak,
            "longest_streak": longest_streak,
            "message": f"Dailies auto-completed! Current streak: {current_streak} days",
        }

    except Exception as e:
        logger.exception(f"Error completing daily goals: {e}")
        return {"success": False, "action": "error", "error": str(e)}


def complete_daily_goals(user_tz: pytz.BaseTzInfo) -> Dict:
    """Backward-compatible helper that completes only today."""
    today = get_today_in_timezone(user_tz)
    return complete_daily_goals_for_date(today, user_tz)


def run_daily_goals_completion() -> Dict:
    """
    Main entry point for the daily goals completion cron job.

    This function:
    1. Gets the user's timezone from goals_settings
    2. Builds historical candidate dates where goals are valid
    3. Evaluates completion for each uncompleted candidate date
    4. Creates snapshots for all dates that are completed

    Returns:
        Dictionary with result information:
        {
            'success': bool,
            'action': str,  # 'completed', 'already_completed', 'incomplete', 'error'
            'date': str,
            'streak': int,  # Only if action == 'completed'
            'longest_streak': int,  # Only if action == 'completed'
            'completed_count': int,
            'completed_dates': list[str],
            'checked_count': int,
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

        current_entry, current_goals, goals_settings = _get_current_entry_payload()
        if not current_entry:
            return {
                "success": False,
                "action": "no_goals",
                "date": today_str,
                "reason": "No current goals found",
                "completed_count": 0,
                "completed_dates": [],
                "checked_count": 0,
            }

        static_first_data_date = _get_first_data_date(user_tz)
        candidate_dates = _build_candidate_dates(
            current_goals=current_goals,
            today=today,
            static_first_data_date=static_first_data_date,
        )

        if not candidate_dates:
            return {
                "success": True,
                "action": "already_completed",
                "date": today_str,
                "reason": "No valid goal dates found to evaluate",
                "completed_count": 0,
                "completed_dates": [],
                "checked_count": 0,
            }

        completed_dates: list[str] = []
        checked_count = 0
        incomplete_reasons: list[str] = []
        completion_errors: list[str] = []
        last_completion: Optional[Dict] = None

        for candidate_date in candidate_dates:
            candidate_date_str = candidate_date.strftime("%Y-%m-%d")

            if GoalsTable.get_by_date(candidate_date_str):
                continue

            checked_count += 1

            all_completed, reason = check_all_goals_completed_for_date(
                candidate_date,
                user_tz,
                current_goals=current_goals,
                goals_settings=goals_settings,
            )

            if not all_completed:
                incomplete_reasons.append(f"{candidate_date_str}: {reason}")
                continue

            completion_result = complete_daily_goals_for_date(
                candidate_date,
                user_tz,
                current_entry=current_entry,
                current_goals=current_goals,
                goals_settings=goals_settings,
            )

            if (
                completion_result.get("success")
                and completion_result.get("action") == "completed"
            ):
                completed_dates.append(candidate_date_str)
                last_completion = completion_result
            else:
                completion_errors.append(
                    f"{candidate_date_str}: {completion_result.get('error', 'unknown completion error')}"
                )

        if completed_dates:
            result = {
                "success": True,
                "action": "completed",
                "date": today_str,
                "reason": f"Auto-completed {len(completed_dates)} date(s)",
                "completed_count": len(completed_dates),
                "completed_dates": completed_dates,
                "checked_count": checked_count,
            }
            if last_completion:
                result["streak"] = last_completion.get("streak")
                result["longest_streak"] = last_completion.get("longest_streak")
            if completion_errors:
                result["warnings"] = completion_errors
            return result

        if completion_errors:
            return {
                "success": False,
                "action": "error",
                "date": today_str,
                "reason": completion_errors[0],
                "error": "; ".join(completion_errors),
                "completed_count": 0,
                "completed_dates": [],
                "checked_count": checked_count,
            }

        if checked_count == 0:
            return {
                "success": True,
                "action": "already_completed",
                "date": today_str,
                "reason": "All eligible dates are already completed",
                "completed_count": 0,
                "completed_dates": [],
                "checked_count": 0,
            }

        default_reason = (
            incomplete_reasons[0]
            if incomplete_reasons
            else "No eligible dates met completion criteria"
        )
        return {
            "success": True,
            "action": "incomplete",
            "date": today_str,
            "reason": default_reason,
            "completed_count": 0,
            "completed_dates": [],
            "checked_count": checked_count,
        }

    except Exception as e:
        logger.exception(f"Error in daily goals completion cron: {e}")
        return {
            "success": False,
            "action": "error",
            "date": None,
            "error": str(e),
            "reason": f"Unexpected error: {str(e)}",
            "completed_count": 0,
            "completed_dates": [],
            "checked_count": 0,
        }


# Example usage for testing
if __name__ == "__main__":
    result = run_daily_goals_completion()

    print("\n" + "=" * 60)
    print("DAILY GOALS COMPLETION CHECK")
    print("=" * 60)
    print(f"Success: {result.get('success')}")
    print(f"Action: {result.get('action')}")
    print(f"Date: {result.get('date', 'N/A')}")
    if result.get("streak"):
        print(f"Streak: {result.get('streak')}")
        print(f"Longest Streak: {result.get('longest_streak')}")
    print(
        f"Reason: {result.get('reason', result.get('message', result.get('error', 'N/A')))}"
    )
    print("=" * 60)
