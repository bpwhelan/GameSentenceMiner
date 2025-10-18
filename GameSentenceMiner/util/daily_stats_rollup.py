#!/usr/bin/env python3
"""
Daily Statistics Rollup Implementation

This module implements the enhanced daily statistics rollup system for GameSentenceMiner.
It provides functionality to:
1. Create the new daily_stats_rollup table
2. Calculate comprehensive daily statistics
3. Backfill historical data
4. Maintain rollup data going forward

Usage:
    python -m GameSentenceMiner.util.daily_stats_rollup --backfill
    python -m GameSentenceMiner.util.daily_stats_rollup --date 2024-01-15
"""

import json
import time
import regex
import argparse
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Tuple, Any
from collections import defaultdict

from GameSentenceMiner.util.db import SQLiteDBTable, GameLinesTable, gsm_db
from GameSentenceMiner.util.games_table import GamesTable
from GameSentenceMiner.util.configuration import logger, get_stats_config


class DailyStatsRollupTable(SQLiteDBTable):
    """Enhanced daily statistics rollup table."""
    
    _table = 'daily_stats_rollup'
    _fields = [
        'date', 'total_lines', 'total_characters', 'total_sessions', 'unique_games_played',
        'total_reading_time_seconds', 'total_active_time_seconds',
        'longest_session_seconds', 'shortest_session_seconds', 'average_session_seconds',
        'average_reading_speed_chars_per_hour', 'peak_reading_speed_chars_per_hour',
        'games_completed', 'games_started', 'anki_cards_created',
        'lines_with_screenshots', 'lines_with_audio', 'lines_with_translations',
        'unique_kanji_seen', 'kanji_frequency_data',
        'hourly_activity_data', 'hourly_reading_speed_data', 'game_activity_data',
        'games_played_ids', 'max_chars_in_session', 'max_time_in_session_seconds',
        'created_at', 'updated_at'
    ]
    _types = [
        int,    # id (primary key)
        str,    # date
        int, int, int, int,  # basic counts
        float, float,  # time tracking
        float, float, float,  # session stats
        float, float,  # reading performance
        int, int, int,  # game progress
        int, int, int,  # anki integration
        int, str,  # kanji stats
        str, str, str,  # JSON data fields
        str,  # games_played_ids
        int, float,  # peak performance
        float, float  # metadata
    ]
    _pk = 'id'
    _auto_increment = True

    def __init__(self, id: Optional[int] = None, date: Optional[str] = None, **kwargs):
        self.id = id
        self.date = date if date is not None else datetime.now().strftime("%Y-%m-%d")
        
        # Initialize all fields with defaults
        self.total_lines = kwargs.get('total_lines', 0)
        self.total_characters = kwargs.get('total_characters', 0)
        self.total_sessions = kwargs.get('total_sessions', 0)
        self.unique_games_played = kwargs.get('unique_games_played', 0)
        self.total_reading_time_seconds = kwargs.get('total_reading_time_seconds', 0.0)
        self.total_active_time_seconds = kwargs.get('total_active_time_seconds', 0.0)
        self.longest_session_seconds = kwargs.get('longest_session_seconds', 0.0)
        self.shortest_session_seconds = kwargs.get('shortest_session_seconds', 0.0)
        self.average_session_seconds = kwargs.get('average_session_seconds', 0.0)
        self.average_reading_speed_chars_per_hour = kwargs.get('average_reading_speed_chars_per_hour', 0.0)
        self.peak_reading_speed_chars_per_hour = kwargs.get('peak_reading_speed_chars_per_hour', 0.0)
        self.games_completed = kwargs.get('games_completed', 0)
        self.games_started = kwargs.get('games_started', 0)
        self.anki_cards_created = kwargs.get('anki_cards_created', 0)
        self.lines_with_screenshots = kwargs.get('lines_with_screenshots', 0)
        self.lines_with_audio = kwargs.get('lines_with_audio', 0)
        self.lines_with_translations = kwargs.get('lines_with_translations', 0)
        self.unique_kanji_seen = kwargs.get('unique_kanji_seen', 0)
        self.kanji_frequency_data = kwargs.get('kanji_frequency_data', '{}')
        self.hourly_activity_data = kwargs.get('hourly_activity_data', '{}')
        self.hourly_reading_speed_data = kwargs.get('hourly_reading_speed_data', '{}')
        self.game_activity_data = kwargs.get('game_activity_data', '{}')
        self.games_played_ids = kwargs.get('games_played_ids', '[]')
        self.max_chars_in_session = kwargs.get('max_chars_in_session', 0)
        self.max_time_in_session_seconds = kwargs.get('max_time_in_session_seconds', 0.0)
        self.created_at = kwargs.get('created_at', time.time())
        self.updated_at = kwargs.get('updated_at', time.time())

    @classmethod
    def get_by_date(cls, date_str: str) -> Optional['DailyStatsRollupTable']:
        """Get rollup data for a specific date."""
        row = cls._db.fetchone(
            f"SELECT * FROM {cls._table} WHERE date=?", (date_str,))
        return cls.from_row(row) if row else None

    @classmethod
    def get_date_range(cls, start_date: str, end_date: str) -> List['DailyStatsRollupTable']:
        """Get rollup data for a date range."""
        rows = cls._db.fetchall(
            f"SELECT * FROM {cls._table} WHERE date >= ? AND date <= ? ORDER BY date",
            (start_date, end_date))
        return [cls.from_row(row) for row in rows]

    @classmethod
    def date_exists(cls, date_str: str) -> bool:
        """Check if rollup data exists for a specific date."""
        result = cls._db.fetchone(
            f"SELECT 1 FROM {cls._table} WHERE date=? LIMIT 1", (date_str,))
        return result is not None


# Kanji detection regex - matches CJK Unified Ideographs
KANJI_REGEX = regex.compile(r'[\p{Script=Han}]')


def extract_kanji_frequency(text: str) -> Dict[str, int]:
    """Extract kanji characters and count their frequency."""
    if not text:
        return {}
    
    kanji_chars = KANJI_REGEX.findall(text)
    frequency = defaultdict(int)
    for kanji in kanji_chars:
        frequency[kanji] += 1
    
    return dict(frequency)


def analyze_sessions(lines: List[GameLinesTable], session_gap_seconds: int = 3600) -> Dict[str, Any]:
    """
    Analyze reading sessions from game lines.
    
    Args:
        lines: List of game lines sorted by timestamp
        session_gap_seconds: Gap in seconds that defines a new session (default: 1 hour)
        
    Returns:
        Dictionary with session statistics
    """
    if not lines:
        return {
            'count': 0, 'total_time': 0.0, 'active_time': 0.0,
            'longest': 0.0, 'shortest': 0.0, 'average': 0.0,
            'max_chars': 0, 'max_time': 0.0
        }
    
    # Sort lines by timestamp
    sorted_lines = sorted(lines, key=lambda x: x.timestamp)
    
    sessions = []
    current_session = [sorted_lines[0]]
    
    # Group lines into sessions based on time gaps
    for i in range(1, len(sorted_lines)):
        time_gap = sorted_lines[i].timestamp - sorted_lines[i-1].timestamp
        
        if time_gap > session_gap_seconds:
            # Start new session
            sessions.append(current_session)
            current_session = [sorted_lines[i]]
        else:
            # Continue current session
            current_session.append(sorted_lines[i])
    
    # Add the last session
    if current_session:
        sessions.append(current_session)
    
    # Calculate session statistics
    session_durations = []
    session_char_counts = []
    total_active_time = 0.0
    
    for session in sessions:
        if len(session) == 1:
            # Single line session - estimate 1 minute duration
            duration = 60.0
        else:
            duration = session[-1].timestamp - session[0].timestamp
        
        char_count = sum(len(line.line_text) for line in session)
        
        session_durations.append(duration)
        session_char_counts.append(char_count)
        total_active_time += duration
    
    # Calculate total reading time (first line to last line)
    total_reading_time = sorted_lines[-1].timestamp - sorted_lines[0].timestamp
    
    return {
        'count': len(sessions),
        'total_time': total_reading_time,
        'active_time': total_active_time,
        'longest': max(session_durations) if session_durations else 0.0,
        'shortest': min(session_durations) if session_durations else 0.0,
        'average': sum(session_durations) / len(session_durations) if session_durations else 0.0,
        'max_chars': max(session_char_counts) if session_char_counts else 0,
        'max_time': max(session_durations) if session_durations else 0.0
    }


def calculate_reading_speeds(lines: List[GameLinesTable]) -> Dict[str, Any]:
    """Calculate reading speed statistics."""
    if not lines:
        return {
            'average': 0.0, 'peak': 0.0,
            'hourly_activity': {}, 'hourly_speeds': {}
        }
    
    # Group lines by hour
    hourly_data = defaultdict(list)
    for line in lines:
        hour = datetime.fromtimestamp(line.timestamp).strftime('%H')
        hourly_data[hour].append(line)
    
    hourly_activity = {}
    hourly_speeds = {}
    all_speeds = []
    
    for hour, hour_lines in hourly_data.items():
        if not hour_lines:
            continue
            
        # Sort by timestamp
        hour_lines.sort(key=lambda x: x.timestamp)
        
        # Calculate characters in this hour
        total_chars = sum(len(line.line_text) for line in hour_lines)
        hourly_activity[hour] = total_chars
        
        # Calculate reading speed for this hour
        if len(hour_lines) > 1:
            time_span = hour_lines[-1].timestamp - hour_lines[0].timestamp
            if time_span > 0:
                chars_per_hour = (total_chars * 3600.0) / time_span
                hourly_speeds[hour] = chars_per_hour
                all_speeds.append(chars_per_hour)
            else:
                hourly_speeds[hour] = 0.0
        else:
            # Single line - estimate based on character count (assume 1000 chars/hour baseline)
            hourly_speeds[hour] = min(total_chars * 60, 10000)  # Cap at reasonable speed
    
    return {
        'average': sum(all_speeds) / len(all_speeds) if all_speeds else 0.0,
        'peak': max(all_speeds) if all_speeds else 0.0,
        'hourly_activity': hourly_activity,
        'hourly_speeds': hourly_speeds
    }


def analyze_game_activity(lines: List[GameLinesTable], date_str: str) -> Dict[str, Any]:
    """Analyze per-game activity for the day."""
    if not lines:
        return {'completed': 0, 'started': 0, 'details': {}}
    
    # Group lines by game_id
    game_data = defaultdict(list)
    for line in lines:
        if line.game_id:
            game_data[line.game_id].append(line)
    
    game_details = {}
    unique_games = set()
    
    for game_id, game_lines in game_data.items():
        if not game_lines:
            continue
            
        unique_games.add(game_id)
        
        # Get game info
        game = GamesTable.get(game_id)
        game_title = game.title_original if game else f"Unknown Game ({game_id})"
        
        # Calculate stats for this game
        total_chars = sum(len(line.line_text) for line in game_lines)
        total_lines = len(game_lines)
        
        # Calculate time spent (first to last line)
        game_lines.sort(key=lambda x: x.timestamp)
        if len(game_lines) > 1:
            time_spent = game_lines[-1].timestamp - game_lines[0].timestamp
        else:
            time_spent = 60.0  # Estimate 1 minute for single line
        
        game_details[game_id] = {
            'title': game_title,
            'chars': total_chars,
            'time': time_spent,
            'lines': total_lines
        }
    
    # Count completed games (games marked as completed that had activity today)
    completed_games = 0
    for game_id in unique_games:
        game = GamesTable.get(game_id)
        if game and game.completed:
            completed_games += 1
    
    return {
        'completed': completed_games,
        'started': len(unique_games),
        'details': game_details
    }


def calculate_anki_stats(lines: List[GameLinesTable]) -> Dict[str, int]:
    """Calculate Anki integration statistics."""
    if not lines:
        return {
            'cards_created': 0, 'screenshots': 0,
            'audio': 0, 'translations': 0
        }
    
    screenshots = sum(1 for line in lines if line.screenshot_in_anki and line.screenshot_in_anki.strip())
    audio = sum(1 for line in lines if line.audio_in_anki and line.audio_in_anki.strip())
    translations = sum(1 for line in lines if line.translation and line.translation.strip())
    
    # Cards created = lines with either screenshot or audio
    cards_created = sum(1 for line in lines 
                       if (line.screenshot_in_anki and line.screenshot_in_anki.strip()) or 
                          (line.audio_in_anki and line.audio_in_anki.strip()))
    
    return {
        'cards_created': cards_created,
        'screenshots': screenshots,
        'audio': audio,
        'translations': translations
    }


def calculate_daily_rollup(date_str: str) -> DailyStatsRollupTable:
    """
    Calculate comprehensive daily statistics for a given date.
    
    Args:
        date_str: Date in YYYY-MM-DD format
        
    Returns:
        DailyStatsRollupTable: Populated rollup record
    """
    logger.info(f"Calculating daily rollup for {date_str}")
    
    # Convert date to timestamp range
    date_start = datetime.strptime(date_str, '%Y-%m-%d').timestamp()
    date_end = date_start + 86400  # +24 hours
    
    # Get all lines for this day
    lines = GameLinesTable.get_lines_filtered_by_timestamp(date_start, date_end, for_stats=True)
    
    if not lines:
        logger.info(f"No lines found for {date_str}, creating empty rollup")
        return DailyStatsRollupTable(
            date=date_str,
            created_at=time.time(),
            updated_at=time.time()
        )
    
    logger.info(f"Processing {len(lines)} lines for {date_str}")
    
    # Get session gap from config
    stats_config = get_stats_config()
    session_gap = stats_config.get('session_gap_seconds', 3600)
    
    # Basic statistics
    total_lines = len(lines)
    total_characters = sum(len(line.line_text) for line in lines)
    unique_games = len(set(line.game_id for line in lines if line.game_id))
    
    # Get list of unique game IDs played
    games_played_ids = list(set(line.game_id for line in lines if line.game_id))
    
    # Session analysis
    logger.info(f"Analyzing sessions for {date_str}")
    sessions = analyze_sessions(lines, session_gap)
    
    # Reading speed analysis
    logger.info(f"Calculating reading speeds for {date_str}")
    speed_stats = calculate_reading_speeds(lines)
    
    # Game activity
    logger.info(f"Analyzing game activity for {date_str}")
    game_activity = analyze_game_activity(lines, date_str)
    
    # Kanji analysis
    logger.info(f"Analyzing kanji frequency for {date_str}")
    all_text = ''.join(line.line_text for line in lines)
    kanji_frequencies = extract_kanji_frequency(all_text)
    unique_kanji_count = len(kanji_frequencies)
    
    # Anki statistics
    logger.info(f"Calculating Anki stats for {date_str}")
    anki_stats = calculate_anki_stats(lines)
    
    # Create rollup record
    rollup = DailyStatsRollupTable(
        date=date_str,
        total_lines=total_lines,
        total_characters=total_characters,
        total_sessions=sessions['count'],
        unique_games_played=unique_games,
        total_reading_time_seconds=sessions['total_time'],
        total_active_time_seconds=sessions['active_time'],
        longest_session_seconds=sessions['longest'],
        shortest_session_seconds=sessions['shortest'],
        average_session_seconds=sessions['average'],
        average_reading_speed_chars_per_hour=speed_stats['average'],
        peak_reading_speed_chars_per_hour=speed_stats['peak'],
        games_completed=game_activity['completed'],
        games_started=game_activity['started'],
        anki_cards_created=anki_stats['cards_created'],
        lines_with_screenshots=anki_stats['screenshots'],
        lines_with_audio=anki_stats['audio'],
        lines_with_translations=anki_stats['translations'],
        unique_kanji_seen=unique_kanji_count,
        kanji_frequency_data=json.dumps(kanji_frequencies, ensure_ascii=False),
        hourly_activity_data=json.dumps(speed_stats['hourly_activity']),
        hourly_reading_speed_data=json.dumps(speed_stats['hourly_speeds']),
        game_activity_data=json.dumps(game_activity['details'], ensure_ascii=False),
        games_played_ids=json.dumps(games_played_ids),
        max_chars_in_session=sessions['max_chars'],
        max_time_in_session_seconds=sessions['max_time'],
        created_at=time.time(),
        updated_at=time.time()
    )
    
    logger.info(f"Completed rollup calculation for {date_str}: {total_lines} lines, {total_characters} chars, {sessions['count']} sessions")
    return rollup


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


def backfill_historical_data(start_date: Optional[str] = None, end_date: Optional[str] = None, 
                           force_recalculate: bool = False) -> None:
    """
    Backfill historical rollup data.
    
    Args:
        start_date: Start date (YYYY-MM-DD). If None, uses first data date.
        end_date: End date (YYYY-MM-DD). If None, uses yesterday.
        force_recalculate: If True, recalculate even if rollup already exists.
    """
    logger.info("Starting historical data backfill")
    
    # Determine date range
    if start_date is None:
        start_date = get_first_data_date()
        if start_date is None:
            logger.warning("No data found in GameLinesTable")
            return
    
    if end_date is None:
        # Use yesterday to avoid incomplete data for today
        yesterday = datetime.now() - timedelta(days=1)
        end_date = yesterday.strftime('%Y-%m-%d')
    
    logger.info(f"Backfilling data from {start_date} to {end_date}")
    
    # Get all dates that have actual data
    data_dates = get_all_data_dates()
    logger.info(f"Found {len(data_dates)} dates with data")
    
    # Filter to our date range
    start_dt = datetime.strptime(start_date, '%Y-%m-%d')
    end_dt = datetime.strptime(end_date, '%Y-%m-%d')
    
    dates_to_process = [
        date for date in data_dates 
        if start_dt <= datetime.strptime(date, '%Y-%m-%d') <= end_dt
    ]
    
    logger.info(f"Processing {len(dates_to_process)} dates in range")
    
    processed = 0
    skipped = 0
    errors = 0
    
    for date_str in dates_to_process:
        try:
            # Check if rollup already exists
            if not force_recalculate and DailyStatsRollupTable.date_exists(date_str):
                logger.debug(f"Rollup already exists for {date_str}, skipping")
                skipped += 1
                continue
            
            # Calculate rollup
            rollup = calculate_daily_rollup(date_str)
            
            # Save to database
            if force_recalculate and DailyStatsRollupTable.date_exists(date_str):
                # Update existing record
                existing = DailyStatsRollupTable.get_by_date(date_str)
                if existing:
                    # Copy calculated values to existing record
                    for field in DailyStatsRollupTable._fields:
                        if field not in ['created_at']:  # Preserve original created_at
                            setattr(existing, field, getattr(rollup, field))
                    existing.updated_at = time.time()
                    existing.save()
                    logger.info(f"Updated rollup for {date_str}")
                else:
                    rollup.save()
                    logger.info(f"Created rollup for {date_str}")
            else:
                rollup.save()
                logger.info(f"Created rollup for {date_str}")
            
            processed += 1
            
            # Progress update every 10 dates
            if processed % 10 == 0:
                logger.info(f"Progress: {processed}/{len(dates_to_process)} dates processed")
                
        except Exception as e:
            logger.error(f"Error processing {date_str}: {e}")
            errors += 1
            continue
    
    logger.info(f"Backfill complete: {processed} processed, {skipped} skipped, {errors} errors")


def main():
    """Main entry point for the script."""
    parser = argparse.ArgumentParser(description='Daily Statistics Rollup Management')
    parser.add_argument('--backfill', action='store_true', 
                       help='Backfill all historical data')
    parser.add_argument('--date', type=str, 
                       help='Calculate rollup for specific date (YYYY-MM-DD)')
    parser.add_argument('--start-date', type=str, 
                       help='Start date for backfill (YYYY-MM-DD)')
    parser.add_argument('--end-date', type=str, 
                       help='End date for backfill (YYYY-MM-DD)')
    parser.add_argument('--force', action='store_true', 
                       help='Force recalculation of existing rollups')
    parser.add_argument('--create-table', action='store_true', 
                       help='Create the rollup table (run this first)')
    
    args = parser.parse_args()
    
    # Set up the database table
    DailyStatsRollupTable.set_db(gsm_db)
    
    if args.create_table:
        logger.info("Creating daily_stats_rollup table")
        # The table will be created automatically by set_db if it doesn't exist
        logger.info("Table created successfully")
        return
    
    if args.backfill:
        backfill_historical_data(
            start_date=args.start_date,
            end_date=args.end_date,
            force_recalculate=args.force
        )
    elif args.date:
        logger.info(f"Calculating rollup for {args.date}")
        rollup = calculate_daily_rollup(args.date)
        
        if args.force and DailyStatsRollupTable.date_exists(args.date):
            existing = DailyStatsRollupTable.get_by_date(args.date)
            if existing:
                for field in DailyStatsRollupTable._fields:
                    if field not in ['created_at']:
                        setattr(existing, field, getattr(rollup, field))
                existing.updated_at = time.time()
                existing.save()
                logger.info(f"Updated rollup for {args.date}")
            else:
                rollup.save()
                logger.info(f"Created rollup for {args.date}")
        else:
            rollup.save()
            logger.info(f"Created rollup for {args.date}")
    else:
        parser.print_help()


if __name__ == '__main__':
    main()