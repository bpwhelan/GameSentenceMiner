"""
Goals API Endpoints

This module contains API endpoints specifically for custom goals functionality.
Provides data for calculating progress on user-defined goals with date ranges.
"""

import datetime
import json
import pytz
import time
from flask import request, jsonify

from GameSentenceMiner.util.config.configuration import logger
from GameSentenceMiner.util.database.db import GameLinesTable, GoalsTable
from GameSentenceMiner.util.database.games_table import GamesTable
from GameSentenceMiner.util.database.stats_rollup_table import StatsRollupTable
from GameSentenceMiner.web.rollup_stats import (
    calculate_live_stats_for_today,
    aggregate_rollup_data,
    combine_rollup_and_live_stats,
)


# Helper Functions

def get_user_timezone():
    """
    Extract user's timezone from request headers or fallback to UTC.
    Returns pytz timezone object.
    
    The frontend should send timezone via X-Timezone header using:
    Intl.DateTimeFormat().resolvedOptions().timeZone
    """
    tz_str = request.headers.get('X-Timezone', 'UTC')
    try:
        return pytz.timezone(tz_str)
    except pytz.exceptions.UnknownTimeZoneError:
        logger.warning(f"Unknown timezone: {tz_str}, falling back to UTC")
        return pytz.UTC


def get_today_in_timezone(tz=None):
    """
    Get today's date in the specified timezone.
    
    Args:
        tz: pytz timezone object. If None, uses UTC.
        
    Returns:
        date object representing today in the specified timezone
    """
    if tz is None:
        tz = pytz.UTC
    return datetime.datetime.now(tz).date()

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
        allowed_types: List of allowed types (defaults to standard metrics + static)
        
    Returns:
        bool: True if valid
        
    Raises:
        ValueError: If metric_type is not in allowed_types
    """
    if allowed_types is None:
        allowed_types = [
            "hours", "characters", "games", "cards", "mature_cards",
            "hours_static", "characters_static", "cards_static",
            "anki_backlog"
        ]
    
    if metric_type not in allowed_types:
        raise ValueError(f"Invalid metric_type. Must be one of: {', '.join(allowed_types)}")
    
    return True


def get_todays_live_data(today, user_tz=None):
    """
    Fetch today's game lines and calculate live statistics.
    
    Args:
        today: date object for today
        user_tz: Optional pytz timezone object. If provided, timestamps will be created
                 in this timezone. If None, uses naive datetime (system timezone).
        
    Returns:
        tuple: (today_lines, live_stats) where live_stats may be None
    """
    if user_tz:
        # Create timezone-aware datetimes to get correct timestamps
        today_start = user_tz.localize(datetime.datetime.combine(today, datetime.time.min)).timestamp()
        today_end = user_tz.localize(datetime.datetime.combine(today, datetime.time.max)).timestamp()
    else:
        # Fallback to naive datetime (for backward compatibility)
        today_start = datetime.datetime.combine(today, datetime.time.min).timestamp()
        today_end = datetime.datetime.combine(today, datetime.time.max).timestamp()
    today_lines = GameLinesTable.get_lines_filtered_by_timestamp(
        start=today_start, end=today_end, for_stats=True
    )
    
    live_stats = None
    if today_lines:
        live_stats = calculate_live_stats_for_today(today_lines)
    
    return today_lines, live_stats


# Import helper function from stats_util
from GameSentenceMiner.util.stats.stats_util import count_cards_from_lines, count_cards_from_line, has_cards


def filter_stats_by_media_type(combined_stats, media_type):
    """
    Filter combined stats by media type.
    
    Args:
        combined_stats: Combined rollup and live stats dictionary
        media_type: Media type string ("Anime", "Visual Novel", "ALL", etc.)
        
    Returns:
        dict: Filtered stats containing only data for specified media type
    """
    if not media_type or media_type == "ALL":
        # Return all stats unchanged
        return combined_stats
    
    # Get type_activity_data from combined_stats
    type_activity = combined_stats.get("type_activity_data", {})
    
    if media_type not in type_activity:
        # Media type not found, return zero stats
        return {
            "total_characters": 0,
            "total_reading_time_seconds": 0,
            "total_lines": 0,
            "unique_games_played": 0
        }
    
    # Return stats for specific media type
    type_stats = type_activity[media_type]
    return {
        "total_characters": type_stats.get("chars", 0),
        "total_reading_time_seconds": type_stats.get("time", 0),
        "total_lines": type_stats.get("lines", 0),
        "unique_games_played": 0  # Not tracked per type
    }


def count_cards_from_lines_by_type(lines, media_type):
    """
    Count cards from lines, filtered by media type.
    Requires joining with GamesTable to get type information.
    Uses note_ids if available, otherwise falls back to checking audio_in_anki OR screenshot_in_anki.
    """
    if not lines or not media_type or media_type == "ALL":
        return count_cards_from_lines(lines)
    
    card_count = 0
    for line in lines:
        # Check if line has card
        if not has_cards(line):
            continue
        
        # Get game metadata to check type
        game = GamesTable.get_by_game_line(line)
        if game and game.type == media_type:
            # Count actual number of cards
            card_count += count_cards_from_line(line)
    
    return card_count


def sum_rollup_cards_by_type(start_date, end_date, media_type):
    """
    Sum cards from rollup data, filtered by media type.
    Uses type_activity_data from rollups.
    """
    if not media_type or media_type == "ALL":
        rollups = StatsRollupTable.get_date_range(
            start_date.strftime("%Y-%m-%d"),
            end_date.strftime("%Y-%m-%d")
        )
        return sum(rollup.anki_cards_created or 0 for rollup in rollups)
    
    # Get rollups and extract type-specific card counts
    rollups = StatsRollupTable.get_date_range(
        start_date.strftime("%Y-%m-%d"),
        end_date.strftime("%Y-%m-%d")
    )
    
    total_cards = 0
    for rollup in rollups:
        if rollup.type_activity_data:
            try:
                type_data = json.loads(rollup.type_activity_data) if isinstance(rollup.type_activity_data, str) else rollup.type_activity_data
                if media_type in type_data:
                    total_cards += type_data[media_type].get('cards', 0)
            except (json.JSONDecodeError, TypeError):
                continue
    
    return total_cards


def query_anki_connect_mature_cards(deck_name=None, start_date=None, for_today=False):
    """
    Query AnkiConnect for mature cards (interval > 21 days).
    Optionally filters by cards added since a specific start date.
    
    Args:
        deck_name: Optional deck name to filter by. If None or empty, searches all decks.
        start_date: Optional start date (date object) to filter cards added since that date.
        for_today: If True, queries for cards that matured today (rated=0 ivl>=21)
        
    Returns:
        tuple: (card_count, error_message) where error_message is None on success
    """
    import urllib.error
    
    try:
        # Build the query string
        query_parts = []
        
        # Add deck filter
        if deck_name and deck_name.strip():
            query_parts.append(f'deck:"{deck_name}"')
        else:
            query_parts.append('deck:"*"')
        
        if for_today:
            # Query for cards that matured today (became mature today)
            # rated=0 means reviewed today, ivl>=21 means interval is at least 21 days
            query_parts.append('prop:rated=0')
            query_parts.append('prop:ivl>=21')
        else:
            # Query for all mature cards (interval > 21 days)
            query_parts.append('prop:ivl>21')
            
            # Add date filter if start_date is provided
            if start_date:
                # Calculate days ago from start_date to today
                today = datetime.date.today()
                days_ago = (today - start_date).days
                
                # Use added:X to filter cards added within the past X days
                # This ensures we only count cards that were added since the goal started
                if days_ago >= 0:
                    query_parts.append(f'added:{days_ago + 1}')  # +1 to include start_date itself
        
        query = ' '.join(query_parts)
        logger.debug(f"AnkiConnect query: {query}")
        
        # Prepare AnkiConnect request
        request_data = {
            "action": "findCards",
            "version": 6,
            "params": {
                "query": query
            }
        }
        
        request_json = json.dumps(request_data).encode('utf-8')
        
        # Make request to AnkiConnect (with timeout)
        req = urllib.request.Request(
            'http://127.0.0.1:8765',
            data=request_json,
            headers={'Content-Type': 'application/json'}
        )
        
        with urllib.request.urlopen(req, timeout=5) as response:
            response_data = json.loads(response.read().decode('utf-8'))
            
            # Check for AnkiConnect errors
            if response_data.get('error') is not None:
                error_msg = response_data.get('error', 'Unknown AnkiConnect error')
                logger.warning(f"AnkiConnect error: {error_msg}")
                return (0, f"AnkiConnect error: {error_msg}")
            
            # Get the result (list of card IDs)
            card_ids = response_data.get('result', [])
            return (len(card_ids), None)
            
    except urllib.error.URLError as e:
        error_msg = "AnkiConnect not available. Please ensure Anki is running with AnkiConnect installed."
        logger.warning(f"AnkiConnect connection error: {e}")
        return (0, error_msg)
    except Exception as e:
        error_msg = f"Error querying AnkiConnect: {str(e)}"
        logger.exception(f"AnkiConnect query error: {e}")
        return (0, error_msg)


def query_anki_connect_new_cards(deck_name=None):
    """
    Query AnkiConnect for new cards (cards that haven't been studied yet).
    
    Args:
        deck_name: Optional deck name to filter by. If None or empty, searches all decks.
        
    Returns:
        tuple: (card_count, error_message) where error_message is None on success
    """
    import urllib.error
    
    try:
        # Build the query string
        query_parts = []
        
        # Add deck filter
        if deck_name and deck_name.strip():
            query_parts.append(f'deck:"{deck_name}"')
        else:
            query_parts.append('deck:"*"')
        
        # Query for new cards
        query_parts.append('is:new')
        
        query = ' '.join(query_parts)
        logger.debug(f"AnkiConnect new cards query: {query}")
        
        # Prepare AnkiConnect request
        request_data = {
            "action": "findCards",
            "version": 6,
            "params": {
                "query": query
            }
        }
        
        request_json = json.dumps(request_data).encode('utf-8')
        
        # Make request to AnkiConnect (with timeout)
        req = urllib.request.Request(
            'http://127.0.0.1:8765',
            data=request_json,
            headers={'Content-Type': 'application/json'}
        )
        
        with urllib.request.urlopen(req, timeout=5) as response:
            response_data = json.loads(response.read().decode('utf-8'))
            
            # Check for AnkiConnect errors
            if response_data.get('error') is not None:
                error_msg = response_data.get('error', 'Unknown AnkiConnect error')
                logger.warning(f"AnkiConnect error: {error_msg}")
                return (0, f"AnkiConnect error: {error_msg}")
            
            # Get the result (list of card IDs)
            card_ids = response_data.get('result', [])
            return (len(card_ids), None)
            
    except urllib.error.URLError as e:
        error_msg = "AnkiConnect not available. Please ensure Anki is running with AnkiConnect installed."
        logger.warning(f"AnkiConnect connection error: {e}")
        return (0, error_msg)
    except Exception as e:
        error_msg = f"Error querying AnkiConnect: {str(e)}"
        logger.exception(f"AnkiConnect query error: {e}")
        return (0, error_msg)


def query_anki_connect_new_cards_cleared_on_day(deck_name=None, days_ago=0):
    """
    Query AnkiConnect for cards that were cleared from new status on a specific day.
    Uses rated=X to find cards reviewed X days ago that are no longer new.
    
    Args:
        deck_name: Optional deck name to filter by. If None or empty, searches all decks.
        days_ago: Number of days ago to check (0 = today, 7 = 7 days ago, etc.)
        
    Returns:
        tuple: (card_count, error_message) where error_message is None on success
    """
    import urllib.error
    
    try:
        # Build the query string
        query_parts = []
        
        # Add deck filter
        if deck_name and deck_name.strip():
            query_parts.append(f'deck:"{deck_name}"')
        else:
            query_parts.append('deck:"*"')
        
        # Query for cards that were reviewed X days ago and are NOT new anymore
        # Anki uses negative numbers for past days: rated:-7 means 7 days ago
        query_parts.append(f'prop:rated=-{days_ago}')
        query_parts.append('-is:new')
        
        query = ' '.join(query_parts)
        logger.debug(f"AnkiConnect new cards cleared query for {days_ago} days ago: {query}")
        
        # Prepare AnkiConnect request
        request_data = {
            "action": "findCards",
            "version": 6,
            "params": {
                "query": query
            }
        }
        
        request_json = json.dumps(request_data).encode('utf-8')
        
        # Make request to AnkiConnect (with timeout)
        req = urllib.request.Request(
            'http://127.0.0.1:8765',
            data=request_json,
            headers={'Content-Type': 'application/json'}
        )
        
        with urllib.request.urlopen(req, timeout=5) as response:
            response_data = json.loads(response.read().decode('utf-8'))
            
            # Check for AnkiConnect errors
            if response_data.get('error') is not None:
                error_msg = response_data.get('error', 'Unknown AnkiConnect error')
                logger.warning(f"AnkiConnect error: {error_msg}")
                return (0, f"AnkiConnect error: {error_msg}")
            
            # Get the result (list of card IDs)
            card_ids = response_data.get('result', [])
            return (len(card_ids), None)
            
    except urllib.error.URLError as e:
        error_msg = "AnkiConnect not available. Please ensure Anki is running with AnkiConnect installed."
        logger.warning(f"AnkiConnect connection error: {e}")
        return (0, error_msg)
    except Exception as e:
        error_msg = f"Error querying AnkiConnect: {str(e)}"
        logger.exception(f"AnkiConnect query error: {e}")
        return (0, error_msg)


def query_anki_connect_mature_cards_on_day(deck_name=None, days_ago=0):
    """
    Query AnkiConnect for cards that matured on a specific day.
    Uses rated=X to find cards reviewed X days ago with interval >= 21 days.
    
    Args:
        deck_name: Optional deck name to filter by. If None or empty, searches all decks.
        days_ago: Number of days ago to check (0 = today, 7 = 7 days ago, etc.)
        
    Returns:
        tuple: (card_count, error_message) where error_message is None on success
    """
    import urllib.error
    
    try:
        # Build the query string
        query_parts = []
        
        # Add deck filter
        if deck_name and deck_name.strip():
            query_parts.append(f'deck:"{deck_name}"')
        else:
            query_parts.append('deck:"*"')
        
        # Query for cards that matured on this specific day
        # Anki uses negative numbers for past days: rated:-7 means 7 days ago
        # rated=-X means reviewed X days ago, ivl>=21 means interval is at least 21 days
        query_parts.append(f'prop:rated=-{days_ago}')
        query_parts.append('prop:ivl>=21')
        
        query = ' '.join(query_parts)
        logger.debug(f"AnkiConnect mature cards query for {days_ago} days ago: {query}")
        
        # Prepare AnkiConnect request
        request_data = {
            "action": "findCards",
            "version": 6,
            "params": {
                "query": query
            }
        }
        
        request_json = json.dumps(request_data).encode('utf-8')
        
        # Make request to AnkiConnect (with timeout)
        req = urllib.request.Request(
            'http://127.0.0.1:8765',
            data=request_json,
            headers={'Content-Type': 'application/json'}
        )
        
        with urllib.request.urlopen(req, timeout=5) as response:
            response_data = json.loads(response.read().decode('utf-8'))
            
            # Check for AnkiConnect errors
            if response_data.get('error') is not None:
                error_msg = response_data.get('error', 'Unknown AnkiConnect error')
                logger.warning(f"AnkiConnect error: {error_msg}")
                return (0, f"AnkiConnect error: {error_msg}")
            
            # Get the result (list of card IDs)
            card_ids = response_data.get('result', [])
            return (len(card_ids), None)
            
    except urllib.error.URLError as e:
        error_msg = "AnkiConnect not available. Please ensure Anki is running with AnkiConnect installed."
        logger.warning(f"AnkiConnect connection error: {e}")
        return (0, error_msg)
    except Exception as e:
        error_msg = f"Error querying AnkiConnect: {str(e)}"
        logger.exception(f"AnkiConnect query error: {e}")
        return (0, error_msg)


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


def extract_metric_value(combined_stats, metric_type, today_lines=None, rollup_stats=None, start_date=None, yesterday=None, goals_settings=None, for_today_only=False, media_type=None):
    """
    Extract progress value from combined stats based on metric type.
    Static types (hours_static, characters_static, cards_static) behave like their non-static counterparts.
    For 'cards' metric, requires additional parameters to calculate from rollups and lines.
    For 'mature_cards' metric, queries AnkiConnect directly.
    Filters by media_type if specified.
    
    Args:
        combined_stats: Combined rollup and live stats dictionary
        metric_type: Type of metric ("hours", "characters", "games", "cards", "mature_cards", or static variants)
        today_lines: Today's game lines (required for cards)
        rollup_stats: Rollup stats (used to check if we need to query for cards)
        start_date: Start date for card calculation
        yesterday: Yesterday's date for card calculation
        goals_settings: Goals settings dict (required for mature_cards to get deck name)
        for_today_only: If True, for mature_cards returns cards that matured today
        media_type: Optional media type filter ("Anime", "Visual Novel", "ALL", etc.)
        
    Returns:
        float or int: The metric value
    """
    # Filter stats by media type before processing
    if media_type and media_type != "ALL":
        filtered_stats = filter_stats_by_media_type(combined_stats, media_type)
    else:
        filtered_stats = combined_stats
    
    # Map static types to their base types for calculation
    base_metric_type = metric_type.replace('_static', '') if metric_type.endswith('_static') else metric_type
    
    if base_metric_type == "hours":
        return filtered_stats.get("total_reading_time_seconds", 0) / 3600
    elif base_metric_type == "characters":
        return filtered_stats.get("total_characters", 0)
    elif base_metric_type == "games":
        # Games metric doesn't support type filtering (can't filter unique games by type easily)
        return combined_stats.get("unique_games_played", 0)
    elif base_metric_type == "cards":
        # Cards require special handling - sum from rollups + today's lines
        # For cards, need special handling with type filtering
        if media_type and media_type != "ALL":
            # Filter today's lines by media type
            filtered_cards = count_cards_from_lines_by_type(today_lines, media_type) if today_lines else 0
            
            # Filter rollup cards by type
            rollup_cards = sum_rollup_cards_by_type(start_date, yesterday, media_type) if start_date and yesterday else 0
            
            return rollup_cards + filtered_cards
        else:
            # Existing logic for ALL types
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
    elif base_metric_type == "mature_cards":
        # Query AnkiConnect for mature cards
        deck_name = None
        if goals_settings:
            anki_settings = goals_settings.get('ankiConnect', {})
            deck_name = anki_settings.get('deckName', '')
        
        # If for_today_only, query for cards that matured today
        # Otherwise, query for all mature cards added since start_date
        card_count, error = query_anki_connect_mature_cards(
            deck_name,
            start_date if not for_today_only else None,
            for_today=for_today_only
        )
        if error:
            logger.warning(f"Mature cards query failed: {error}")
        return card_count
    elif base_metric_type == "anki_backlog":
        # Query AnkiConnect for new cards (backlog)
        deck_name = None
        if goals_settings:
            anki_settings = goals_settings.get('ankiConnect', {})
            deck_name = anki_settings.get('deckName', '')
        
        # Query for current new cards count
        card_count, error = query_anki_connect_new_cards(deck_name)
        if error:
            logger.warning(f"New cards query failed: {error}")
        return card_count
    
    return 0


def calculate_balanced_easy_day_multiplier(date, goals_settings):
    """
    Calculate a balanced multiplier that distributes work across the week
    based on all easy days settings.
    
    This ensures that if some days are set to lower percentages (easy days),
    the remaining days automatically pick up the slack proportionally,
    maintaining the same weekly total workload.
    
    Formula:
    - Weekly capacity = sum of all 7 day percentages
    - Balance factor = 700 (ideal) / weekly capacity
    - Day multiplier = (day percentage / 100) * balance factor
    
    Example: If Friday is 0% and other days are 100%:
    - Weekly capacity = 600%
    - Balance factor = 700/600 = 1.1667
    - Mon-Thu, Sat-Sun: 100% * 1.1667 = 116.67%
    - Friday: 0% * 1.1667 = 0%

    If Monday-Thursday, Saturday-Sunday are 100% and Friday is 50%, then balance_factor = 700/650 = 1.077
    
    Args:
        date: date object
        goals_settings: Dictionary containing easyDays settings
        
    Returns:
        float: Balanced multiplier (can be > 1.0 to compensate for easy days)
    """
    day_names = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
    
    # Get easy days settings, default to 100% if not provided
    easy_days = goals_settings.get('easyDays', {}) if goals_settings else {}
    
    # Calculate total weekly capacity (sum of all percentages)
    total_weekly_capacity = 0
    for day_name in day_names:
        day_percentage = easy_days.get(day_name, 100)
        total_weekly_capacity += day_percentage
    
    # Edge case: If all days are 0%, return 0 to avoid division by zero
    if total_weekly_capacity == 0:
        return 0.0
    
    # Calculate balance factor to redistribute work
    ideal_weekly_capacity = 700  # 7 days × 100%
    balance_factor = ideal_weekly_capacity / total_weekly_capacity
    
    # Get today's percentage
    day_index = date.weekday()  # 0=Monday, 6=Sunday
    day_name = day_names[day_index]
    today_percentage = easy_days.get(day_name, 100)
    
    # Calculate balanced multiplier for today
    balanced_multiplier = (today_percentage / 100.0) * balance_factor
    
    return balanced_multiplier


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
    # Strip _static suffix to get base type for formatting
    base_metric_type = metric_type.replace('_static', '') if metric_type.endswith('_static') else metric_type
    
    if base_metric_type == "hours":
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
    # Strip _static suffix to get base type for formatting
    base_metric_type = metric_type.replace('_static', '') if metric_type.endswith('_static') else metric_type
    
    if base_metric_type == "hours":
        hours = int(value)
        minutes = int(round((value - hours) * 60))
        if hours > 0:
            return f"{hours}h" + (f" {minutes}m" if minutes > 0 else "")
        else:
            return f"{minutes}m"
    elif base_metric_type == "characters":
        int_value = int(value)
        if int_value >= 1000000:
            return f"{int_value / 1000000:.1f}M"
        elif int_value >= 1000:
            return f"{int_value / 1000:.1f}K"
        else:
            return str(int_value)
    else:
        return str(int(value))


def get_todays_goals(user_tz=None):
    """
    Get all goals for today with their current progress and required amounts.
    Returns a consolidated list of all active goals for today.
    
    This is a standalone function that can be called directly without Flask context.
    
    Args:
        user_tz: Optional pytz timezone object. If None, uses UTC.
        
    Returns:
        dict: {
            "date": "2025-01-14",
            "goals": [
                {
                    "goal_name": "Read for 6 hours in October",
                    "progress_today": 2.5,
                    "progress_needed": 1.8,
                    "metric_type": "hours",
                    "goal_icon": "⏱️"
                },
                ...
            ]
        }
    
    Example:
        from GameSentenceMiner.web.goals_api import get_todays_goals
        import pytz
        
        # Get today's goals
        data = get_todays_goals()
        
        # Or with specific timezone
        data = get_todays_goals(user_tz=pytz.timezone('Asia/Tokyo'))
        
        for g in data.get("goals", []):
            name = g.get("goal_name")
            today = g.get("progress_today")
            needed = g.get("progress_needed")
            icon = g.get("goal_icon", "🎯")
            print(f"{icon} {name}: {today}/{needed}")
    """
    logger.info("Getting today's goals")
    try:
        # Get user's timezone and today's date
        if user_tz is None:
            user_tz = pytz.UTC
        today = get_today_in_timezone(user_tz)
        today_str = today.strftime("%Y-%m-%d")
        logger.info(f"Today is {today_str}")
        
        # Get current goals and settings
        logger.info("Fetching current goals from database")
        current_entry = GoalsTable.get_by_date('current')
        
        if not current_entry:
            logger.info("No current goals found, returning empty list")
            return {
                "date": today_str,
                "goals": []
            }
        
        # Parse current goals
        logger.info("Parsing current goals")
        if isinstance(current_entry.current_goals, str):
            try:
                current_goals = json.loads(current_entry.current_goals)
            except json.JSONDecodeError:
                current_goals = []
        else:
            current_goals = current_entry.current_goals if current_entry.current_goals else []
        
        logger.info(f"Found {len(current_goals)} goals to process")
        
        # Parse goals settings
        if isinstance(current_entry.goals_settings, str):
            try:
                goals_settings = json.loads(current_entry.goals_settings) if current_entry.goals_settings else {}
            except json.JSONDecodeError:
                goals_settings = {}
        else:
            goals_settings = current_entry.goals_settings if current_entry.goals_settings else {}
        
        today_goals = []
        
        # Fetch today's live data once for all goals (optimization)
        logger.info("Fetching today's live data")
        today_lines, live_stats = get_todays_live_data(today, user_tz)
        logger.info(f"Found {len(today_lines) if today_lines else 0} lines for today")
        
        yesterday = today - datetime.timedelta(days=1)
        
        # Cache for rollup stats to avoid repeated database queries
        rollup_cache = {}
        
        # Process each goal
        for i, goal in enumerate(current_goals):
            logger.info(f"Processing goal {i+1}/{len(current_goals)}")
            goal_name = goal.get('name', 'Unknown Goal')
            metric_type = goal.get('metricType')
            target_value = goal.get('targetValue')
            start_date_str = goal.get('startDate')
            end_date_str = goal.get('endDate')
            goal_icon = goal.get('icon', '🎯')
            media_type = goal.get('mediaType', 'ALL')  # Extract media type from goal
            
            logger.info(f"Goal: {goal_name}, metric: {metric_type}, media_type: {media_type}")
            
            # Skip custom goals (they don't have numeric progress)
            if metric_type == 'custom':
                logger.info("Skipping custom goal")
                continue
            
            # Check if this is a static goal
            is_static = metric_type.endswith('_static') if metric_type else False
            
            # Validate required fields (static goals don't need dates)
            if is_static:
                if not all([metric_type, target_value]):
                    logger.warning(f"Static goal missing required fields: {goal_name}")
                    continue
            else:
                if not all([metric_type, target_value, start_date_str, end_date_str]):
                    logger.warning(f"Regular goal missing required fields: {goal_name}")
                    continue
            
            # Get today's progress for this goal
            try:
                # Calculate today's progress
                today_progress = 0
                if live_stats:
                    today_stats_only = combine_rollup_and_live_stats(None, live_stats)
                    # For static goals, map to base metric type
                    progress_metric_type = metric_type.replace('_static', '') if is_static else metric_type
                    today_progress = extract_metric_value(
                        today_stats_only, progress_metric_type,
                        today_lines=today_lines,
                        start_date=None,
                        yesterday=None,
                        goals_settings=goals_settings,
                        for_today_only=True,
                        media_type=media_type
                    )
                
                # For static goals, required = target value
                if is_static:
                    formatted_progress = format_metric_value(today_progress, metric_type)
                    formatted_required = format_metric_value(target_value, metric_type)
                    
                    today_goals.append({
                        "goal_name": goal_name,
                        "progress_today": formatted_progress,
                        "progress_needed": formatted_required,
                        "metric_type": metric_type,
                        "goal_icon": goal_icon
                    })
                    continue
                
                # For regular goals, parse dates and check if active
                try:
                    start_date, end_date = parse_and_validate_dates(start_date_str, end_date_str)
                except ValueError:
                    logger.warning(f"Invalid dates for goal '{goal_name}'")
                    continue
                
                # Check if goal is active today
                if today < start_date or today > end_date:
                    logger.info(f"Goal '{goal_name}' not active today")
                    continue
                
                # Calculate today's required amount
                # Get balanced easy day multiplier for today
                easy_day_multiplier = calculate_balanced_easy_day_multiplier(today, goals_settings)
                
                # Calculate total progress from start_date to yesterday
                # Use cache to avoid repeated database queries for the same date range
                rollup_stats = None
                if start_date <= yesterday:
                    cache_key = (start_date.strftime("%Y-%m-%d"), yesterday.strftime("%Y-%m-%d"))
                    if cache_key not in rollup_cache:
                        rollup_cache[cache_key] = get_rollup_stats_for_range(start_date, yesterday)
                    rollup_stats = rollup_cache[cache_key]
                
                # Combine stats for total progress
                combined_stats = combine_rollup_and_live_stats(rollup_stats, live_stats)
                
                # Extract total progress
                total_progress = extract_metric_value(
                    combined_stats, metric_type,
                    today_lines=today_lines,
                    start_date=start_date if start_date <= yesterday else None,
                    yesterday=yesterday if start_date <= yesterday else None,
                    goals_settings=goals_settings,
                    media_type=media_type
                )
                
                # Calculate days remaining (including today)
                days_remaining = (end_date - today).days + 1
                
                # Calculate daily requirement
                remaining_work = max(0, target_value - total_progress)
                daily_required = remaining_work / days_remaining if days_remaining > 0 else 0
                
                # Apply easy day multiplier to reduce today's requirement
                daily_required_adjusted = daily_required * easy_day_multiplier
                
                # Format values
                formatted_progress = format_metric_value(today_progress, metric_type)
                formatted_required = format_metric_value(daily_required_adjusted, metric_type)
                
                today_goals.append({
                    "goal_name": goal_name,
                    "progress_today": formatted_progress,
                    "progress_needed": formatted_required,
                    "metric_type": metric_type,
                    "goal_icon": goal_icon
                })
                
            except Exception as e:
                logger.warning(f"Error calculating progress for goal '{goal_name}': {e}")
                continue
        
        logger.info(f"Successfully processed {len(today_goals)} active goals for today")
        return {
            "date": today_str,
            "goals": today_goals
        }
        
    except Exception as e:
        logger.exception(f"Error getting today's goals: {e}")
        raise


def register_goals_api_routes(app):
    """Register goals API routes with the Flask app."""

    @app.route("/api/goals/progress", methods=["POST"])
    def api_goals_progress():
        """
        Calculate progress for a custom goal within a specific date range.
        
        Request body:
        {
            "metric_type": "hours" | "characters" | "games" | "cards" | "mature_cards",
            "start_date": "YYYY-MM-DD",
            "end_date": "YYYY-MM-DD",
            "goals_settings": {...}  # Optional: required for mature_cards
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
            goals_settings = data.get("goals_settings", {})
            media_type = data.get("media_type", "ALL")
            
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
            user_tz = get_user_timezone()
            today = get_today_in_timezone(user_tz)
            
            # If goal hasn't started yet, return 0 progress
            if today < start_date:
                return jsonify({
                    "progress": 0,
                    "daily_average": 0,
                    "days_in_range": max(1, (end_date - start_date).days + 1)
                }), 200
            
            # Determine if we need to include today's live data
            include_today = end_date >= today
            
            # Get rollup data for the date range (up to yesterday if today is included)
            if include_today:
                yesterday = today - datetime.timedelta(days=1)
                rollup_end_date = min(end_date, yesterday)
            else:
                rollup_end_date = end_date
            
            # Only query rollups if we have historical dates and valid date range
            rollup_stats = None
            if start_date <= rollup_end_date:
                rollup_stats = get_rollup_stats_for_range(start_date, rollup_end_date)
            
            # Get today's live data if needed
            today_lines = None
            live_stats = None
            if include_today:
                today_lines, live_stats = get_todays_live_data(today, user_tz)
            
            # Combine rollup and live stats
            combined_stats = combine_rollup_and_live_stats(rollup_stats, live_stats)
            
            # Extract progress based on metric type
            progress = extract_metric_value(
                combined_stats, metric_type,
                today_lines=today_lines if include_today else None,
                start_date=start_date if start_date <= rollup_end_date else None,
                yesterday=rollup_end_date if start_date <= rollup_end_date else None,
                goals_settings=goals_settings,
                media_type=media_type
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
            logger.exception(f"Error calculating goal progress: {e}")
            return jsonify({"error": "Failed to calculate goal progress"}), 500
    
    @app.route("/api/goals/today-progress", methods=["POST"])
    def api_goals_today_progress():
        """
        Calculate today's required progress for a custom goal.
        For static goals, always returns the target value as required.
        Shows what needs to be accomplished today to stay on track.
        Applies easy days percentage reduction based on current day of week.
        
        Request body:
        {
            "goal_id": "goal_xxx",
            "metric_type": "hours" | "characters" | "games" | "hours_static" | "characters_static" | "cards_static",
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
            media_type = data.get("media_type", "ALL")
            
            # Check if this is a static goal
            is_static = metric_type.endswith('_static')
            
            # Validate required fields (static goals don't need dates)
            if not is_static and not all([goal_id, metric_type, target_value, start_date_str, end_date_str]):
                return jsonify({"error": "Missing required fields"}), 400
            elif is_static and not all([goal_id, metric_type, target_value]):
                return jsonify({"error": "Missing required fields"}), 400
            
            # Validate metric type
            try:
                validate_metric_type(metric_type)
            except ValueError as e:
                return jsonify({"error": str(e)}), 400
            
            # Get user timezone and today
            user_tz = get_user_timezone()
            today = get_today_in_timezone(user_tz)
            
            # Handle static goals separately
            if is_static:
                # For static goals: required = target_value (fixed daily), progress = today only
                # Get today's live data
                today_lines, live_stats = get_todays_live_data(today, user_tz)
                
                # Extract today's progress (map static type to base type)
                base_metric_type = metric_type.replace('_static', '')
                today_progress = 0
                if live_stats:
                    today_stats_only = combine_rollup_and_live_stats(None, live_stats)
                    today_progress = extract_metric_value(
                        today_stats_only, base_metric_type,
                        today_lines=today_lines,
                        start_date=None,
                        yesterday=None,
                        goals_settings=goals_settings,
                        for_today_only=True,
                        media_type=media_type
                    )
                
                return jsonify({
                    "required": format_metric_value(target_value, metric_type),
                    "progress": format_metric_value(today_progress, metric_type),
                    "has_target": True,
                    "days_remaining": None,  # Static goals have no end date
                    "total_progress": None,  # Not relevant for daily view
                    "easy_day_percentage": 100,  # Static goals don't use easy days
                    "is_static": True
                }), 200
            
            # Parse dates for regular goals
            try:
                start_date, end_date = parse_and_validate_dates(start_date_str, end_date_str)
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
            
            # Get balanced easy day multiplier for today
            easy_day_multiplier = calculate_balanced_easy_day_multiplier(today, goals_settings)
            easy_day_percentage = int(easy_day_multiplier * 100)
            
            # Calculate total progress from start_date to yesterday
            yesterday = today - datetime.timedelta(days=1)
            
            rollup_stats = None
            if start_date <= yesterday:
                rollup_stats = get_rollup_stats_for_range(start_date, yesterday)
            
            # Get today's live data
            today_lines, live_stats = get_todays_live_data(today, user_tz)
            
            # Combine stats for total progress
            combined_stats = combine_rollup_and_live_stats(rollup_stats, live_stats)
            
            # Extract total progress
            total_progress = extract_metric_value(
                combined_stats, metric_type,
                today_lines=today_lines,
                start_date=start_date if start_date <= yesterday else None,
                yesterday=yesterday if start_date <= yesterday else None,
                goals_settings=goals_settings,
                media_type=media_type
            )
            
            # Extract today's progress
            today_progress = 0
            if live_stats:
                today_stats_only = combine_rollup_and_live_stats(None, live_stats)
                today_progress = extract_metric_value(
                    today_stats_only, metric_type,
                    today_lines=today_lines,
                    start_date=None,
                    yesterday=None,
                    goals_settings=goals_settings,
                    for_today_only=True,  # For mature_cards, get cards that matured today
                    media_type=media_type
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
            logger.exception(f"Error calculating today's goal progress: {e}")
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
            media_type = data.get("media_type", "ALL")
            
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
                user_tz = get_user_timezone()
                today = get_today_in_timezone(user_tz)
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
            today_lines, live_stats_today = get_todays_live_data(today, user_tz)
            
            # Calculate 30-day average based on metric type
            if metric_type == "cards":
                # For cards, count from rollups + today
                if media_type and media_type != "ALL":
                    # Filter by media type
                    total_cards = sum_rollup_cards_by_type(thirty_days_ago, yesterday, media_type)
                    total_cards += count_cards_from_lines_by_type(today_lines, media_type)
                else:
                    total_cards = sum(r.anki_cards_created or 0 for r in rollups_30d)
                    total_cards += count_cards_from_lines(today_lines)
                avg_daily = total_cards / 30
            elif metric_type == "mature_cards":
                # For mature_cards, calculate daily growth by sampling cards that matured on specific days
                # Query for cards that matured: today, 7 days ago, 14 days ago, 21 days ago
                deck_name = None
                goals_settings_param = data.get("goals_settings", {})
                if goals_settings_param:
                    anki_settings = goals_settings_param.get('ankiConnect', {})
                    deck_name = anki_settings.get('deckName', '')
                
                sample_days = [0, 7, 14, 21]  # Days ago to sample
                mature_counts = []
                
                for days_ago in sample_days:
                    # Query for cards that matured on this specific day
                    # rated=X means reviewed X days ago, ivl>=21 means interval is at least 21 days
                    card_count, error = query_anki_connect_mature_cards_on_day(deck_name, days_ago)
                    if error:
                        logger.warning(f"Mature cards query for {days_ago} days ago failed: {error}")
                    else:
                        mature_counts.append(card_count)
                
                # Calculate average daily mature card growth
                if mature_counts:
                    avg_daily = sum(mature_counts) / len(mature_counts)
                else:
                    avg_daily = 0
            elif metric_type == "anki_backlog":
                # For anki_backlog, calculate daily clearance rate by sampling cards cleared on specific days
                # Query for cards cleared: today, 7 days ago, 14 days ago, 21 days ago
                deck_name = None
                goals_settings_param = data.get("goals_settings", {})
                if goals_settings_param:
                    anki_settings = goals_settings_param.get('ankiConnect', {})
                    deck_name = anki_settings.get('deckName', '')
                
                sample_days = [0, 7, 14, 21]  # Days ago to sample
                cleared_counts = []
                
                for days_ago in sample_days:
                    # Query for cards that were cleared from new status on this specific day
                    card_count, error = query_anki_connect_new_cards_cleared_on_day(deck_name, days_ago)
                    if error:
                        logger.warning(f"New cards cleared query for {days_ago} days ago failed: {error}")
                    else:
                        cleared_counts.append(card_count)
                
                # Calculate average daily clearance rate
                if cleared_counts:
                    avg_daily = sum(cleared_counts) / len(cleared_counts)
                else:
                    avg_daily = 0
            else:
                # For hours, characters, games - use existing rollup aggregation
                if media_type and media_type != "ALL":
                    # Filter by media type for hours/characters
                    rollup_stats_30d = aggregate_rollup_data(rollups_30d) if rollups_30d else None
                    combined_stats_30d = combine_rollup_and_live_stats(rollup_stats_30d, live_stats_today)
                    filtered_stats_30d = filter_stats_by_media_type(combined_stats_30d, media_type)
                    
                    if metric_type == "hours":
                        total_value = filtered_stats_30d.get("total_reading_time_seconds", 0) / 3600
                    elif metric_type == "characters":
                        total_value = filtered_stats_30d.get("total_characters", 0)
                    elif metric_type == "games":
                        # Games metric doesn't support type filtering
                        total_value = combined_stats_30d.get("unique_games_played", 0)
                    
                    avg_daily = total_value / 30
                else:
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
            
            # Get current total (from goal start_date, or all-time for future goals)
            # For active/past goals, only count progress from start_date
            effective_start_date = start_date if today >= start_date else None
            
            if not effective_start_date:
                current_total = 0
            else:
                effective_start_str = effective_start_date.strftime("%Y-%m-%d")
                all_rollups = StatsRollupTable.get_date_range(effective_start_str, yesterday_str)
                rollup_stats_all = aggregate_rollup_data(all_rollups) if all_rollups else None
                combined_stats_all = combine_rollup_and_live_stats(rollup_stats_all, live_stats_today)
                
                # For mature_cards and anki_backlog, we want the total current count, not filtered by start_date
                if metric_type == "mature_cards":
                    deck_name = None
                    goals_settings_param = data.get("goals_settings", {})
                    if goals_settings_param:
                        anki_settings = goals_settings_param.get('ankiConnect', {})
                        deck_name = anki_settings.get('deckName', '')
                    
                    # Query for all current mature cards (no start_date filter)
                    current_total, error = query_anki_connect_mature_cards(deck_name, start_date=None, for_today=False)
                    if error:
                        logger.warning(f"Mature cards query failed: {error}")
                elif metric_type == "anki_backlog":
                    deck_name = None
                    goals_settings_param = data.get("goals_settings", {})
                    if goals_settings_param:
                        anki_settings = goals_settings_param.get('ankiConnect', {})
                        deck_name = anki_settings.get('deckName', '')
                    
                    # Query for all current new cards (backlog)
                    current_total, error = query_anki_connect_new_cards(deck_name)
                    if error:
                        logger.warning(f"New cards query failed: {error}")
                else:
                    current_total = extract_metric_value(
                        combined_stats_all, metric_type,
                        today_lines=today_lines,
                        start_date=effective_start_date,
                        yesterday=yesterday,
                        goals_settings=data.get("goals_settings", {}),
                        media_type=media_type
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
                # For anki_backlog, projection decreases (backlog - clearance rate)
                if metric_type == "anki_backlog":
                    projected_value = max(0, current_total - (avg_daily * days_until_target))
                else:
                    projected_value = current_total + (avg_daily * days_until_target)
            
            # Calculate percentage difference
            # For anki_backlog, we want to show progress toward 0, so invert the calculation
            if metric_type == "anki_backlog":
                # For backlog: lower projection is better (closer to target of 0)
                # If projected_value < target, that's good (ahead of pace)
                # If projected_value > target, that's bad (behind pace)
                if target_value > 0:
                    percent_diff = ((target_value - projected_value) / target_value) * 100
                else:
                    # Target is 0, so calculate based on how much we'll clear
                    if current_total > 0:
                        percent_diff = ((current_total - projected_value) / current_total) * 100
                    else:
                        percent_diff = 0
            elif target_value > 0:
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
            logger.exception(f"Error calculating goal projection: {e}")
            return jsonify({"error": "Failed to calculate projection"}), 500
    
    @app.route("/api/goals/complete_todays_dailies", methods=["POST"])
    def api_complete_todays_dailies():
        """
        Complete today's dailies and update streak.
        Reads from 'current' entry and creates a historical snapshot for today.
        
        Returns:
        {
            "success": true,
            "date": "2025-01-14",
            "streak": 5,
            "longest_streak": 10,
            "message": "Dailies completed! Current streak: 5 days"
        }
        """
        try:
            # Get today's date in YYYY-MM-DD format (using user's timezone)
            user_tz = get_user_timezone()
            today = get_today_in_timezone(user_tz)
            today_str = today.strftime("%Y-%m-%d")
            
            # Check if entry already exists for today
            existing_entry = GoalsTable.get_by_date(today_str)
            if existing_entry:
                return jsonify({
                    "success": False,
                    "error": "Dailies already completed for today",
                    "date": today_str
                }), 400
            
            # Get current (live) goals and settings
            current_entry = GoalsTable.get_by_date('current')
            
            if not current_entry:
                return jsonify({
                    "success": False,
                    "error": "No current goals found. Please set up your goals first."
                }), 400
            
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
            
            # Calculate streak for today (returns tuple of current_streak, longest_streak)
            current_streak, longest_streak = GoalsTable.calculate_streak(today_str, str(user_tz))
            
            # Add/update longest_streak in goals_settings
            goals_settings['longestStreak'] = longest_streak
            
            # Convert to JSON strings for historical snapshot
            current_goals_json = json.dumps(current_goals)
            goals_settings_json = json.dumps(goals_settings)
            
            # Create historical snapshot for today (no version tracking needed)
            new_entry = GoalsTable.create_entry(
                date_str=today_str,
                current_goals_json=current_goals_json,
                goals_settings_json=goals_settings_json,
                last_updated=time.time(),
                goals_version=None  # No version tracking
            )
            
            # Update the 'current' entry with new longest streak (save() will handle JSON encoding)
            current_entry.goals_settings = goals_settings
            current_entry.last_updated = time.time()
            current_entry.save()
            
            logger.info(f"Dailies completed for {today_str} with streak: {current_streak}, longest: {longest_streak}")
            
            return jsonify({
                "success": True,
                "date": today_str,
                "streak": current_streak,
                "longest_streak": longest_streak,
                "message": f"Dailies completed! Current streak: {current_streak} days"
            }), 200
            
        except Exception as e:
            logger.exception(f"Error completing today's dailies: {e}")
            return jsonify({"success": False, "error": "Failed to complete dailies"}), 500
    
    @app.route("/api/goals/current_streak", methods=["GET"])
    def api_get_current_streak():
        """
        Get the current streak and longest streak from the latest goals entry.
        
        Returns:
        {
            "streak": 5,
            "longest_streak": 10,
            "last_completion_date": "2025-01-14"
        }
        """
        try:
            # Get latest historical entry (excludes "current")
            latest_entry = GoalsTable.get_latest()
            
            if not latest_entry:
                return jsonify({
                    "streak": 0,
                    "longest_streak": 0,
                    "last_completion_date": None
                }), 200
            
            # Calculate current streak using the calculate_streak method
            user_tz = get_user_timezone()
            today = get_today_in_timezone(user_tz)
            today_str = today.strftime('%Y-%m-%d')
            
            # Use calculate_streak to get accurate streak count
            current_streak, longest_from_calculation = GoalsTable.calculate_streak(today_str, str(user_tz))
            
            # Get longest streak from goals_settings JSON (always preserved even if current streak is broken)
            longest_streak = 0
            try:
                if latest_entry.goals_settings:
                    settings = json.loads(latest_entry.goals_settings) if isinstance(latest_entry.goals_settings, str) else latest_entry.goals_settings
                    longest_streak = settings.get('longestStreak', 0)
            except (json.JSONDecodeError, AttributeError):
                longest_streak = 0
            
            # Use the higher of the two (from calculation or from stored settings)
            longest_streak = max(longest_streak, longest_from_calculation)
            
            return jsonify({
                "streak": current_streak,
                "longest_streak": longest_streak,
                "last_completion_date": latest_entry.date
            }), 200
            
        except Exception as e:
            logger.exception(f"Error getting current streak: {e}")
            return jsonify({"error": "Failed to get current streak"}), 500
    
    @app.route("/api/goals/latest_goals", methods=["GET"])
    def api_get_latest_goals():
        """
        Get the latest goals entry with date, streak, current_goals, goals_settings, and versions.
        
        Returns:
        {
            "date": "2025-01-14",
            "current_goals": [...],  # Parsed JSON array
            "goals_settings": {...},  # Parsed JSON object
            "versions": {"goals": 1, "easyDays": 1, "ankiConnect": 1}
        }
        """
        try:
            latest_entry = GoalsTable.get_latest()
            
            if not latest_entry:
                return jsonify({
                    "date": None,
                    "current_goals": [],
                    "goals_settings": {},
                    "versions": {"goals": 0, "easyDays": 0, "ankiConnect": 0}
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
            
            # Parse versions - default to 1 for each if not present (backward compatibility)
            versions = {"goals": 1, "easyDays": 1, "ankiConnect": 1}
            if hasattr(latest_entry, 'goals_version') and latest_entry.goals_version:
                if isinstance(latest_entry.goals_version, str):
                    try:
                        versions = json.loads(latest_entry.goals_version)
                    except json.JSONDecodeError:
                        pass
                elif isinstance(latest_entry.goals_version, dict):
                    versions = latest_entry.goals_version
            
            return jsonify({
                "date": latest_entry.date,
                "current_goals": current_goals,
                "goals_settings": goals_settings,
                "versions": versions
            }), 200
            
        except Exception as e:
            logger.exception(f"Error getting latest goals: {e}")
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
            
            # Get tomorrow's date (using user's timezone)
            user_tz = get_user_timezone()
            today = get_today_in_timezone(user_tz)
            tomorrow = today + datetime.timedelta(days=1)
            tomorrow_str = tomorrow.strftime("%Y-%m-%d")
            
            # Get balanced easy day multiplier for tomorrow
            tomorrow_multiplier = calculate_balanced_easy_day_multiplier(tomorrow, goals_settings)
            
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
                is_static = metric_type.endswith('_static')
                
                # For static goals, requirement is always the target value
                if is_static:
                    formatted = format_requirement_display(target_value, metric_type)
                    requirements.append({
                        "goal_name": goal_name,
                        "goal_icon": goal_icon,
                        "metric_type": metric_type,
                        "required_tomorrow": format_metric_value(target_value, metric_type),
                        "formatted_required": formatted
                    })
                    continue
                
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
                today_lines, live_stats = get_todays_live_data(today, user_tz)
                
                # Combine stats for total progress
                combined_stats = combine_rollup_and_live_stats(rollup_stats, live_stats)
                
                # Extract total progress (with media type filtering if specified)
                media_type = goal.get('mediaType', 'ALL')
                total_progress = extract_metric_value(
                    combined_stats, metric_type,
                    today_lines=today_lines,
                    start_date=start_date if start_date <= yesterday else None,
                    yesterday=yesterday if start_date <= yesterday else None,
                    goals_settings=goals_settings,
                    media_type=media_type
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
            logger.exception(f"Error calculating tomorrow's requirements: {e}")
            return jsonify({"error": "Failed to calculate tomorrow's requirements"}), 500
        
    @app.route("/api/goals/reading-pace", methods=["GET"])
    def api_reading_pace():
        """
        Calculate average reading pace for the last 30 days.
        Returns characters per hour (CPH).
        
        Returns:
        {
            "pace_cph": <number>,      # Characters per hour
            "total_characters": <number>,
            "total_hours": <number>,
            "days_analyzed": 30,
            "average_characters_per_day": <number>,
            "average_hours_per_day": <number>
        }
        """
        try:
            # 1. Determine Date Range
            user_tz = get_user_timezone()
            today = get_today_in_timezone(user_tz)
            
            # Start 30 days ago
            start_date = today - datetime.timedelta(days=30)
            # End yesterday (for rollups)
            yesterday = today - datetime.timedelta(days=1)
            
            start_date_str = start_date.strftime("%Y-%m-%d")
            yesterday_str = yesterday.strftime("%Y-%m-%d")

            # 2. Get Historical Data (Rollups)
            # We fetch data from 30 days ago up to yesterday
            rollup_stats = None
            if start_date <= yesterday:
                rollup_stats = get_rollup_stats_for_range(start_date_str, yesterday_str)
            
            # 3. Get Live Data (Today)
            today_lines, live_stats = get_todays_live_data(today, user_tz)
            
            # 4. Combine Data
            # This sums up characters and seconds from both sources
            combined_stats = combine_rollup_and_live_stats(rollup_stats, live_stats)
            
            # 5. Extract Totals
            total_characters = combined_stats.get("total_characters", 0)
            total_seconds = combined_stats.get("total_reading_time_seconds", 0)
            
            # 6. Calculate Pace
            # Avoid division by zero
            if total_seconds > 0:
                # (Chars / Seconds) * 3600 = Chars / Hour
                pace_cph = (total_characters / total_seconds) * 3600
            else:
                pace_cph = 0
                
            total_hours = total_seconds / 3600

            return jsonify({
                "pace_cph": int(pace_cph),
                "total_characters": int(total_characters),
                "total_hours": round(total_hours, 2),
                "days_analyzed": 30,
                "average_characters_per_day": int(total_characters / 30 if total_characters > 0 else 0),
                "average_hours_per_day": round(total_hours / 30 if total_hours > 0 else 0, 2)
            }), 200

        except Exception as e:
            logger.exception(f"Error calculating reading pace: {e}")
            return jsonify({"error": "Failed to calculate reading pace"}), 500
    
    @app.route("/api/goals/current", methods=["GET"])
    def api_get_current_goals():
        """
        Get current (live) goals and settings from database.
        Returns the latest entry marked with date='current' or creates a default one.
        
        Returns:
        {
            "current_goals": [...],
            "goals_settings": {
                "easyDays": {"monday": 100, ...},
                "ankiConnect": {"deckName": "..."},
                "customCheckboxes": {...}
            },
            "last_updated": <timestamp>
        }

        Example:
            import requests

            url = "http://localhost:5050/api/goals/current"

            try:
                response = requests.get(url)
                response.raise_for_status()  # raise error for non-200

                data = response.json()
                print("Current goals:", data.get("current_goals"))
                print("Settings:", data.get("goals_settings"))
                print("Last updated:", data.get("last_updated"))

            except requests.exceptions.RequestException as e:
                print("Request failed:", e)

        """
        try:
            # Try to get the 'current' entry (date='current')
            current_entry = GoalsTable.get_by_date('current')
            
            if not current_entry:
                # Create default current entry
                default_settings = {
                    "easyDays": {
                        "monday": 100,
                        "tuesday": 100,
                        "wednesday": 100,
                        "thursday": 100,
                        "friday": 100,
                        "saturday": 100,
                        "sunday": 100
                    },
                    "ankiConnect": {
                        "deckName": ""
                    },
                    "customCheckboxes": {}
                }
                
                current_entry = GoalsTable.create_entry(
                    date_str='current',
                    current_goals_json=json.dumps([]),
                    goals_settings_json=json.dumps(default_settings),
                    last_updated=time.time(),
                    goals_version=None  # No versioning needed
                )
                
                logger.info("Created default 'current' goals entry")
            
            # Parse current_goals
            if isinstance(current_entry.current_goals, str):
                try:
                    current_goals = json.loads(current_entry.current_goals)
                except json.JSONDecodeError:
                    current_goals = []
            else:
                current_goals = current_entry.current_goals if current_entry.current_goals else []
            
            # Parse goals_settings
            if isinstance(current_entry.goals_settings, str):
                try:
                    goals_settings = json.loads(current_entry.goals_settings) if current_entry.goals_settings else {}
                except json.JSONDecodeError:
                    goals_settings = {}
            else:
                goals_settings = current_entry.goals_settings if current_entry.goals_settings else {}
            
            # Ensure default structure
            if 'easyDays' not in goals_settings:
                goals_settings['easyDays'] = {
                    "monday": 100, "tuesday": 100, "wednesday": 100, "thursday": 100,
                    "friday": 100, "saturday": 100, "sunday": 100
                }
            if 'ankiConnect' not in goals_settings:
                goals_settings['ankiConnect'] = {"deckName": ""}
            if 'customCheckboxes' not in goals_settings:
                goals_settings['customCheckboxes'] = {}
            
            return jsonify({
                "current_goals": current_goals,
                "goals_settings": goals_settings,
                "last_updated": current_entry.last_updated if hasattr(current_entry, 'last_updated') else time.time()
            }), 200
            
        except Exception as e:
            logger.exception(f"Error getting current goals: {e}")
            return jsonify({"error": "Failed to get current goals"}), 500
    
    @app.route("/api/goals/update", methods=["POST"])
    def api_update_current_goals():
        """
        Update current (live) goals and/or settings in database.
        
        Request body:
        {
            "current_goals": [...],      // Optional - only if goals changed
            "goals_settings": {...},     // Optional - only if settings changed
            "partial_settings": {...}    // Optional - partial settings update (merged with existing)
        }
        
        Returns:
        {
            "success": true,
            "last_updated": <timestamp>
        }
        """
        try:
            data = request.get_json()
            
            if not data:
                return jsonify({"error": "No data provided"}), 400
            
            # Get current entry
            current_entry = GoalsTable.get_by_date('current')
            
            if not current_entry:
                # Create if doesn't exist
                default_settings = {
                    "easyDays": {
                        "monday": 100, "tuesday": 100, "wednesday": 100, "thursday": 100,
                        "friday": 100, "saturday": 100, "sunday": 100
                    },
                    "ankiConnect": {"deckName": ""},
                    "customCheckboxes": {}
                }
                current_entry = GoalsTable.create_entry(
                    date_str='current',
                    current_goals_json=json.dumps([]),
                    goals_settings_json=json.dumps(default_settings),
                    last_updated=time.time(),
                    goals_version=None
                )
            
            # Parse existing data
            if isinstance(current_entry.current_goals, str):
                try:
                    existing_goals = json.loads(current_entry.current_goals)
                except json.JSONDecodeError:
                    existing_goals = []
            else:
                existing_goals = current_entry.current_goals if current_entry.current_goals else []
            
            if isinstance(current_entry.goals_settings, str):
                try:
                    existing_settings = json.loads(current_entry.goals_settings) if current_entry.goals_settings else {}
                except json.JSONDecodeError:
                    existing_settings = {}
            else:
                existing_settings = current_entry.goals_settings if current_entry.goals_settings else {}
            
            # Update goals if provided
            if 'current_goals' in data:
                existing_goals = data['current_goals']
            
            # Update settings if provided
            if 'goals_settings' in data:
                existing_settings = data['goals_settings']
            elif 'partial_settings' in data:
                # Merge partial settings
                partial = data['partial_settings']
                for key, value in partial.items():
                    if isinstance(value, dict) and key in existing_settings and isinstance(existing_settings[key], dict):
                        # Deep merge for nested dicts
                        existing_settings[key].update(value)
                    else:
                        existing_settings[key] = value
            
            # Update the database entry (save() will handle JSON encoding)
            current_entry.current_goals = existing_goals
            current_entry.goals_settings = existing_settings
            current_entry.last_updated = time.time()
            current_entry.save()
            
            logger.info("Updated current goals/settings in database")
            
            return jsonify({
                "success": True,
                "last_updated": current_entry.last_updated
            }), 200
            
        except Exception as e:
            logger.exception(f"Error updating current goals: {e}")
            return jsonify({"error": "Failed to update goals"}), 500
    
    @app.route("/api/goals/today", methods=["GET"])
    def api_get_todays_goals():
        """
        Get all goals for today with their current progress and required amounts.
        Returns a consolidated list of all active goals for today.
        
        Returns:
        {
            "date": "2025-01-14",
            "goals": [
                {
                    "goal_name": "Read for 6 hours in October",
                    "progress_today": 2.5,
                    "progress_needed": 1.8,
                    "metric_type": "hours",
                    "goal_icon": "⏱️"
                },
                ...
            ]
        }

        Example:
            import requests

            def fetch_todays_goals():
                try:
                    data = requests.get("http://localhost:5050/api/goals/today").json()
                    print(f"📅 {data.get('date')}")

                    for g in data.get("goals", []):
                        name = g.get("goal_name")
                        today = g.get("progress_today")
                        needed = g.get("progress_needed")
                        icon = g.get("goal_icon", "🎯")

                        print(f"{icon} {name}: {today}/{needed}")

                except Exception as e:
                    print("Error:", e)

            fetch_todays_goals()

        """
        logger.info("API /api/goals/today called")
        try:
            # Get user's timezone from request headers
            user_tz = get_user_timezone()
            
            # Call the standalone function
            response_data = get_todays_goals(user_tz)
            
            # Return JSON response with headers
            result = jsonify(response_data)
            result.headers['Connection'] = 'keep-alive'
            result.headers['Content-Type'] = 'application/json'
            logger.info("Returning response with keep-alive headers")
            return result, 200
            
        except Exception as e:
            logger.exception(f"Error getting today's goals: {e}")
            return jsonify({"error": "Failed to get today's goals"}), 500
