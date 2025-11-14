"""
Daily Statistics Rollup Cron Job for GameSentenceMiner

This module provides a cron job that runs once a day to roll up all statistics
from all previous dates up to but not including today (so up to yesterday).

This is designed to be called by the cron system via run_crons.py.

Usage:
    from GameSentenceMiner.util.cron.daily_rollup import run_daily_rollup
    
    # Run the daily rollup
    result = run_daily_rollup()
    print(f"Processed {result['processed']} dates")
"""

import time
from collections import defaultdict
from datetime import datetime, timedelta
from typing import Dict, List, Optional

from GameSentenceMiner.util.configuration import get_stats_config, logger
from GameSentenceMiner.util.db import GameLinesTable
from GameSentenceMiner.util.games_table import GamesTable
from GameSentenceMiner.util.stats_rollup_table import StatsRollupTable
from GameSentenceMiner.web.stats import (
    calculate_actual_reading_time,
    calculate_hourly_activity,
    calculate_hourly_reading_speed,
    calculate_kanji_frequency,
)


def get_first_data_date() -> Optional[str]:
    """Get the first date where user has data in GSM."""
    result = GameLinesTable._db.fetchone(
        f"SELECT DATE(datetime(MIN(timestamp), 'unixepoch', 'localtime')) FROM {GameLinesTable._table}"
    )
    return result[0] if result and result[0] else None


def get_all_data_dates() -> List[str]:
    """Get all dates that have data in GSM."""
    rows = GameLinesTable._db.fetchall(
        f"SELECT DISTINCT DATE(datetime(timestamp, 'unixepoch', 'localtime')) as date "
        f"FROM {GameLinesTable._table} ORDER BY date"
    )
    return [row[0] for row in rows if row[0]]


def analyze_sessions(lines: List) -> Dict:
    """
    Analyze sessions from lines using session gap logic.
    
    Args:
        lines: List of GameLinesTable records
        
    Returns:
        Dictionary with session statistics
    """
    if not lines or len(lines) < 2:
        return {
            'count': 1 if lines else 0,
            'total_time': 0.0,
            'active_time': 0.0,
            'longest': 0.0,
            'shortest': 0.0,
            'average': 0.0,
            'max_chars': sum(len(line.line_text) if line.line_text else 0 for line in lines),
            'max_time': 0.0
        }
    
    # Sort lines by timestamp
    sorted_lines = sorted(lines, key=lambda line: float(line.timestamp))
    session_gap = get_stats_config().session_gap_seconds
    
    # Group lines into sessions
    sessions = []
    current_session = [sorted_lines[0]]
    
    for line in sorted_lines[1:]:
        time_gap = float(line.timestamp) - float(current_session[-1].timestamp)
        if time_gap <= session_gap:
            current_session.append(line)
        else:
            sessions.append(current_session)
            current_session = [line]
    
    # Don't forget the last session
    if current_session:
        sessions.append(current_session)
    
    # Calculate session statistics
    session_durations = []
    session_char_counts = []
    total_active_time = 0.0
    
    for session in sessions:
        if len(session) >= 2:
            timestamps = [float(line.timestamp) for line in session]
            duration = calculate_actual_reading_time(timestamps)
            session_durations.append(duration)
            total_active_time += duration
        else:
            session_durations.append(0.0)
        
        chars = sum(len(line.line_text) if line.line_text else 0 for line in session)
        session_char_counts.append(chars)
    
    # Calculate total reading time (including gaps up to session_gap)
    timestamps = [float(line.timestamp) for line in sorted_lines]
    total_reading_time = calculate_actual_reading_time(timestamps)
    
    return {
        'count': len(sessions),
        'total_time': total_reading_time,
        'active_time': total_active_time,
        'longest': max(session_durations) if session_durations else 0.0,
        'shortest': min(d for d in session_durations if d > 0) if any(d > 0 for d in session_durations) else 0.0,
        'average': sum(session_durations) / len(session_durations) if session_durations else 0.0,
        'max_chars': max(session_char_counts) if session_char_counts else 0,
        'max_time': max(session_durations) if session_durations else 0.0
    }


def analyze_hourly_data(lines: List) -> Dict:
    """
    Analyze hourly activity and reading speed patterns.
    
    Args:
        lines: List of GameLinesTable records
        
    Returns:
        Dictionary with hourly activity and speed data
    """
    if not lines:
        return {
            'hourly_activity': {},
            'hourly_speeds': {}
        }
    
    # Use existing functions from stats.py
    hourly_chars = calculate_hourly_activity(lines)
    hourly_speeds = calculate_hourly_reading_speed(lines)
    
    # Convert to dictionaries (hour -> value)
    hourly_activity_dict = {str(hour): chars for hour, chars in enumerate(hourly_chars) if chars > 0}
    hourly_speed_dict = {str(hour): speed for hour, speed in enumerate(hourly_speeds) if speed > 0}
    
    return {
        'hourly_activity': hourly_activity_dict,
        'hourly_speeds': hourly_speed_dict
    }


def analyze_game_activity(lines: List, date_str: str) -> Dict:
    """
    Analyze per-game activity for the day.
    
    Args:
        lines: List of GameLinesTable records
        date_str: Date in YYYY-MM-DD format
        
    Returns:
        Dictionary with game activity data
    """
    if not lines:
        return {
            'completed': 0,
            'started': 0,
            'details': {},
            'game_ids': []
        }
    
    game_data = defaultdict(lambda: {'chars': 0, 'lines': 0, 'timestamps': [], 'game_name': None})
    game_ids = set()
        
    lines_without_game_id = []
    for line in lines:
        if line.game_id and line.game_id.strip():
            game_id = str(line.game_id)
            game_ids.add(game_id)
            
            chars = len(line.line_text) if line.line_text else 0
            game_data[game_id]['chars'] += chars
            game_data[game_id]['lines'] += 1
            game_data[game_id]['timestamps'].append(float(line.timestamp))
            
            # Store game_name as fallback for title lookup
            if hasattr(line, 'game_name') and line.game_name and not game_data[game_id]['game_name']:
                game_data[game_id]['game_name'] = line.game_name
        else:
            # DEBUG: Log lines without game_id
            if hasattr(line, 'game_name') and line.game_name:
                lines_without_game_id.append(line)
    
    if lines_without_game_id:
        logger.debug(f"[ROLLUP_GAME_ACTIVITY] {len(lines_without_game_id)} lines without game_id on {date_str}")
        for line in lines_without_game_id[:5]:  # Log up to first 5 lines
            logger.debug(f"  Line ID {line.id} with game_name '{getattr(line, 'game_name', 'N/A')}'")    
            
    # Calculate time spent per game and get game titles
    game_details = {}
    for game_id, data in game_data.items():
        time_spent = calculate_actual_reading_time(data['timestamps']) if len(data['timestamps']) >= 2 else 0.0
        
        # Title resolution with proper fallback chain:
        # 1. games_table.title_original (best - linked game with metadata)
        # 2. game_name (OBS scene name - good fallback)
        # 3. Shortened UUID (last resort - better than "Unknown Game")
        try:
            game = GamesTable.get(game_id)  # game_id is already a UUID string
            if game and game.title_original:
                # Best case: we have the game in the database with a proper title
                title = game.title_original
                logger.debug(f"[ROLLUP_TITLE] Using games_table title for {game_id[:8]}...: '{title}'")
            elif data['game_name']:
                # Good fallback: use OBS scene name
                title = data['game_name']
                logger.debug(f"[ROLLUP_TITLE] Using OBS scene name for {game_id[:8]}...: '{title}'")
            else:
                # Last resort: shortened UUID (better than "Unknown Game" for debugging)
                title = f"Game {game_id[:8]}"
                logger.warning(f"[ROLLUP_TITLE] No title or game_name for {game_id[:8]}..., using shortened UUID")
        except Exception as e:
            # Exception during lookup - use fallback chain
            if data['game_name']:
                title = data['game_name']
                logger.info(f"[ROLLUP_TITLE] Exception during lookup, using game_name '{title}' for {game_id[:8]}...: {e}")
            else:
                title = f"Game {game_id[:8]}"
                logger.warning(f"[ROLLUP_TITLE] Exception and no game_name for {game_id[:8]}..., using shortened UUID: {e}")
        
        game_details[game_id] = {
            'title': title,
            'chars': data['chars'],
            'time': time_spent,
            'lines': data['lines']
        }
    
    # For basic version: games_started = unique games played, games_completed = 0
    # (Can be enhanced later to track actual state changes)
    return {
        'completed': 0,  # Basic version: not tracking completion state changes
        'started': len(game_ids),  # Basic version: count unique games played
        'details': game_details,
        'game_ids': list(game_ids)
    }


def analyze_kanji_data(lines: List) -> Dict:
    """
    Analyze kanji frequency for the day.
    
    Args:
        lines: List of GameLinesTable records
        
    Returns:
        Dictionary with kanji frequency data
    """
    if not lines:
        return {
            'unique_count': 0,
            'frequencies': {}
        }
    
    # Use existing function from stats.py
    kanji_result = calculate_kanji_frequency(lines)
    
    # Convert to simple frequency dictionary
    frequencies = {}
    for item in kanji_result.get('kanji_data', []):
        frequencies[item['kanji']] = item['frequency']
    
    return {
        'unique_count': kanji_result.get('unique_count', 0),
        'frequencies': frequencies
    }


def calculate_daily_stats(date_str: str) -> Dict:
    """
    Calculate comprehensive daily statistics for a given date using existing functions.
    
    Args:
        date_str: Date in YYYY-MM-DD format
        
    Returns:
        Dictionary with all 27 fields for StatsRollupTable
    """
    logger.info(f"Calculating daily stats for {date_str}")
    
    # Convert date to timestamp range
    date_start = datetime.strptime(date_str, '%Y-%m-%d').timestamp()
    date_end = date_start + 86400  # +24 hours
    
    # Get all lines for this day
    lines = GameLinesTable.get_lines_filtered_by_timestamp(date_start, date_end, for_stats=True)
    
    if not lines:
        logger.info(f"No lines found for {date_str}")
        return {
            'date': date_str,
            'total_lines': 0,
            'total_characters': 0,
            'total_sessions': 0,
            'unique_games_played': 0,
            'total_reading_time_seconds': 0.0,
            'total_active_time_seconds': 0.0,
            'longest_session_seconds': 0.0,
            'shortest_session_seconds': 0.0,
            'average_session_seconds': 0.0,
            'average_reading_speed_chars_per_hour': 0.0,
            'peak_reading_speed_chars_per_hour': 0.0,
            'games_completed': 0,
            'games_started': 0,
            'anki_cards_created': 0,
            'lines_with_screenshots': 0,
            'lines_with_audio': 0,
            'lines_with_translations': 0,
            'unique_kanji_seen': 0,
            'kanji_frequency_data': '{}',
            'hourly_activity_data': '{}',
            'hourly_reading_speed_data': '{}',
            'game_activity_data': '{}',
            'games_played_ids': '[]',
            'max_chars_in_session': 0,
            'max_time_in_session_seconds': 0.0
        }
    
    logger.info(f"Processing {len(lines)} lines for {date_str}")
    
    # Calculate basic stats
    total_lines = len(lines)
    total_characters = sum(len(line.line_text) if line.line_text else 0 for line in lines)
    
    # Calculate Anki integration stats
    lines_with_screenshots = sum(1 for line in lines if line.screenshot_in_anki and line.screenshot_in_anki.strip())
    lines_with_audio = sum(1 for line in lines if line.audio_in_anki and line.audio_in_anki.strip())
    lines_with_translations = sum(1 for line in lines if line.translation and line.translation.strip())
    anki_cards = sum(1 for line in lines
                    if (line.screenshot_in_anki and line.screenshot_in_anki.strip()) or
                       (line.audio_in_anki and line.audio_in_anki.strip()))
    
    # Analyze sessions
    session_stats = analyze_sessions(lines)
    
    # Calculate reading speeds
    timestamps = [float(line.timestamp) for line in lines]
    total_time_seconds = session_stats['total_time']
    total_time_hours = total_time_seconds / 3600 if total_time_seconds > 0 else 0
    
    average_speed = (total_characters / total_time_hours) if total_time_hours > 0 else 0.0
    
    # Calculate peak speed (best hourly speed)
    hourly_data = analyze_hourly_data(lines)
    peak_speed = max(hourly_data['hourly_speeds'].values()) if hourly_data['hourly_speeds'] else 0.0
    
    # Analyze game activity
    game_activity = analyze_game_activity(lines, date_str)
    
    # Analyze kanji
    kanji_data = analyze_kanji_data(lines)
    
    # Import json for serialization
    import json
    
    return {
        'date': date_str,
        'total_lines': total_lines,
        'total_characters': total_characters,
        'total_sessions': session_stats['count'],
        'unique_games_played': len(game_activity['game_ids']),
        'total_reading_time_seconds': total_time_seconds,
        'total_active_time_seconds': session_stats['active_time'],
        'longest_session_seconds': session_stats['longest'],
        'shortest_session_seconds': session_stats['shortest'],
        'average_session_seconds': session_stats['average'],
        'average_reading_speed_chars_per_hour': average_speed,
        'peak_reading_speed_chars_per_hour': peak_speed,
        'games_completed': game_activity['completed'],
        'games_started': game_activity['started'],
        'anki_cards_created': anki_cards,
        'lines_with_screenshots': lines_with_screenshots,
        'lines_with_audio': lines_with_audio,
        'lines_with_translations': lines_with_translations,
        'unique_kanji_seen': kanji_data['unique_count'],
        'kanji_frequency_data': json.dumps(kanji_data['frequencies'], ensure_ascii=False),
        'hourly_activity_data': json.dumps(hourly_data['hourly_activity']),
        'hourly_reading_speed_data': json.dumps(hourly_data['hourly_speeds']),
        'game_activity_data': json.dumps(game_activity['details'], ensure_ascii=False),
        'games_played_ids': json.dumps(game_activity['game_ids']),
        'max_chars_in_session': session_stats['max_chars'],
        'max_time_in_session_seconds': session_stats['max_time']
    }


def run_daily_rollup() -> Dict:
    """
    Run the daily statistics rollup for all dates up to yesterday.
    
    This function:
    1. Finds the first date where user has data in GSM
    2. Loops from that date to yesterday (current day minus one day)
    3. Checks if StatsRollupTable.date exists for each date
    4. Precomputes all data and inserts into table if missing
    
    This is the main entry point for the daily rollup cron job.
    
    Returns:
        Dictionary with summary statistics
    """
    logger.info("Starting daily statistics rollup cron job")
    
    start_time = time.time()
    
    try:
        # Get the first date where user has data
        first_date = get_first_data_date()
        
        if first_date is None:
            logger.warning("No data found in GameLinesTable")
            return {
                'success': True,
                'start_date': None,
                'end_date': None,
                'total_dates': 0,
                'processed': 0,
                'overwritten': 0,
                'errors': 0,
                'elapsed_time': time.time() - start_time,
                'error_message': None
            }
        
        # Calculate yesterday (current day minus one day)
        yesterday = datetime.now() - timedelta(days=1)
        end_date = yesterday.strftime('%Y-%m-%d')
        
        logger.info(f"Date range: {first_date} to {end_date}")
        
        # Get all dates that have actual data
        all_data_dates = get_all_data_dates()
        logger.debug(f"Found {len(all_data_dates)} dates with data in total")
        
        # Filter to dates up to yesterday
        start_dt = datetime.strptime(first_date, '%Y-%m-%d')
        end_dt = datetime.strptime(end_date, '%Y-%m-%d')
        
        dates_to_process = [
            date for date in all_data_dates 
            if start_dt <= datetime.strptime(date, '%Y-%m-%d') <= end_dt
        ]
        
        total_dates = len(dates_to_process)
        logger.info(f"Processing {total_dates} dates in range (up to yesterday)")
        
        if total_dates == 0:
            logger.info("No dates to process")
            return {
                'success': True,
                'start_date': first_date,
                'end_date': end_date,
                'total_dates': 0,
                'processed': 0,
                'overwritten': 0,
                'errors': 0,
                'elapsed_time': time.time() - start_time,
                'error_message': None
            }
        
        # Process each date
        processed = 0
        overwritten = 0
        errors = 0
        
        for i, date_str in enumerate(dates_to_process, 1):
            try:
                # Always calculate fresh stats for the date
                logger.info(f"Processing {i}/{total_dates}: {date_str}")
                stats = calculate_daily_stats(date_str)
                
                # Check if rollup already exists
                existing = StatsRollupTable.get_by_date(date_str)
                
                if existing:
                    # Update all fields in existing rollup
                    existing.date = stats['date']
                    existing.total_lines = stats['total_lines']
                    existing.total_characters = stats['total_characters']
                    existing.total_sessions = stats['total_sessions']
                    existing.unique_games_played = stats['unique_games_played']
                    existing.total_reading_time_seconds = stats['total_reading_time_seconds']
                    existing.total_active_time_seconds = stats['total_active_time_seconds']
                    existing.longest_session_seconds = stats['longest_session_seconds']
                    existing.shortest_session_seconds = stats['shortest_session_seconds']
                    existing.average_session_seconds = stats['average_session_seconds']
                    existing.average_reading_speed_chars_per_hour = stats['average_reading_speed_chars_per_hour']
                    existing.peak_reading_speed_chars_per_hour = stats['peak_reading_speed_chars_per_hour']
                    existing.games_completed = stats['games_completed']
                    existing.games_started = stats['games_started']
                    existing.anki_cards_created = stats['anki_cards_created']
                    existing.lines_with_screenshots = stats['lines_with_screenshots']
                    existing.lines_with_audio = stats['lines_with_audio']
                    existing.lines_with_translations = stats['lines_with_translations']
                    existing.unique_kanji_seen = stats['unique_kanji_seen']
                    existing.kanji_frequency_data = stats['kanji_frequency_data']
                    existing.hourly_activity_data = stats['hourly_activity_data']
                    existing.hourly_reading_speed_data = stats['hourly_reading_speed_data']
                    existing.game_activity_data = stats['game_activity_data']
                    existing.games_played_ids = stats['games_played_ids']
                    existing.max_chars_in_session = stats['max_chars_in_session']
                    existing.max_time_in_session_seconds = stats['max_time_in_session_seconds']
                    existing.updated_at = time.time()
                    existing.save()
                    
                    overwritten += 1
                    logger.debug(f"Overwritten rollup for {date_str}")
                else:
                    # Create and save new rollup entry with all 27 fields
                    rollup = StatsRollupTable(
                        date=stats['date'],
                        total_lines=stats['total_lines'],
                        total_characters=stats['total_characters'],
                        total_sessions=stats['total_sessions'],
                        unique_games_played=stats['unique_games_played'],
                        total_reading_time_seconds=stats['total_reading_time_seconds'],
                        total_active_time_seconds=stats['total_active_time_seconds'],
                        longest_session_seconds=stats['longest_session_seconds'],
                        shortest_session_seconds=stats['shortest_session_seconds'],
                        average_session_seconds=stats['average_session_seconds'],
                        average_reading_speed_chars_per_hour=stats['average_reading_speed_chars_per_hour'],
                        peak_reading_speed_chars_per_hour=stats['peak_reading_speed_chars_per_hour'],
                        games_completed=stats['games_completed'],
                        games_started=stats['games_started'],
                        anki_cards_created=stats['anki_cards_created'],
                        lines_with_screenshots=stats['lines_with_screenshots'],
                        lines_with_audio=stats['lines_with_audio'],
                        lines_with_translations=stats['lines_with_translations'],
                        unique_kanji_seen=stats['unique_kanji_seen'],
                        kanji_frequency_data=stats['kanji_frequency_data'],
                        hourly_activity_data=stats['hourly_activity_data'],
                        hourly_reading_speed_data=stats['hourly_reading_speed_data'],
                        game_activity_data=stats['game_activity_data'],
                        games_played_ids=stats['games_played_ids'],
                        max_chars_in_session=stats['max_chars_in_session'],
                        max_time_in_session_seconds=stats['max_time_in_session_seconds'],
                        created_at=time.time(),
                        updated_at=time.time()
                    )
                    rollup.save()
                    
                    processed += 1
                    logger.debug(f"Created rollup for {date_str}")
                
                # Progress update every 10 dates
                if processed % 10 == 0:
                    logger.info(f"Progress: {processed}/{total_dates} dates processed")
                    
            except Exception as e:
                logger.error(f"Error processing {date_str}: {e}", exc_info=True)
                errors += 1
                continue
        
        elapsed_time = time.time() - start_time
        
        # Log summary
        logger.info("Daily rollup cron job completed")
        logger.info(f"Date range: {first_date} to {end_date}, Total dates: {total_dates}, Processed: {processed}, Overwritten: {overwritten}, Errors: {errors}, Time: {elapsed_time:.2f}s")
        
        return {
            'success': True,
            'start_date': first_date,
            'end_date': end_date,
            'total_dates': total_dates,
            'processed': processed,
            'overwritten': overwritten,
            'errors': errors,
            'elapsed_time': elapsed_time,
            'error_message': None
        }
        
    except Exception as e:
        elapsed_time = time.time() - start_time
        error_msg = str(e)
        logger.error(f"Fatal error in daily rollup cron job: {error_msg}", exc_info=True)
        
        return {
            'success': False,
            'start_date': None,
            'end_date': None,
            'total_dates': 0,
            'processed': 0,
            'overwritten': 0,
            'errors': 1,
            'elapsed_time': elapsed_time,
            'error_message': error_msg
        }


# Example usage for testing
if __name__ == '__main__':
    # Run the daily rollup
    result = run_daily_rollup()
    
    # Print summary
    print("\n" + "=" * 80)
    print("DAILY ROLLUP SUMMARY")
    print("=" * 80)
    print(f"Success: {'Yes' if result['success'] else 'No'}")
    if result['start_date']:
        print(f"Date range: {result['start_date']} to {result['end_date']}")
    print(f"Total dates with data: {result['total_dates']}")
    print(f"Successfully processed: {result['processed']}")
    print(f"Overwritten: {result['overwritten']}")
    print(f"Errors: {result['errors']}")
    print(f"Time elapsed: {result['elapsed_time']:.2f} seconds")
    if result['error_message']:
        print(f"Error: {result['error_message']}")
    print("=" * 80)