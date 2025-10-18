"""
Statistics API Endpoints

This module contains the /api/stats endpoint and related statistics API routes.
Separated from database_api.py to improve code organization and maintainability.
"""

import datetime
import json
import time
from collections import defaultdict
from pathlib import Path

from flask import request, jsonify

from GameSentenceMiner.util.db import GameLinesTable
from GameSentenceMiner.util.stats_rollup_table import StatsRollupTable
from GameSentenceMiner.util.configuration import logger
from GameSentenceMiner.web.stats import (
    calculate_kanji_frequency, calculate_mining_heatmap_data,
    calculate_total_chars_per_game, calculate_reading_time_per_game, calculate_reading_speed_per_game,
    calculate_current_game_stats, calculate_all_games_stats, calculate_daily_reading_time,
    calculate_time_based_streak, calculate_actual_reading_time, calculate_hourly_activity,
    calculate_hourly_reading_speed, calculate_peak_daily_stats, calculate_peak_session_stats,
    calculate_game_milestones, build_game_display_name_mapping
)
from GameSentenceMiner.web.rollup_stats import (
    aggregate_rollup_data, calculate_live_stats_for_today, combine_rollup_and_live_stats,
    build_heatmap_from_rollup, build_daily_chart_data_from_rollup
)


def register_stats_api_routes(app):
    """Register statistics API routes with the Flask app."""
    
    @app.route('/api/stats')
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
            filter_year = request.args.get('year', None)

            # Get Start and End time as unix timestamp
            start_timestamp = request.args.get('start', None)
            end_timestamp = request.args.get('end', None)
            
            logger.info(f"🔍 DEBUG: Request params - start={start_timestamp}, end={end_timestamp}")
            
            # Convert timestamps to float if provided
            start_timestamp = float(start_timestamp) if start_timestamp else None
            end_timestamp = float(end_timestamp) if end_timestamp else None

            # === HYBRID ROLLUP + LIVE APPROACH ===
            # Convert timestamps to date strings for rollup queries
            today = datetime.date.today()
            today_str = today.strftime('%Y-%m-%d')
            
            # Determine date range
            logger.info(f"🔍 DEBUG: Checking date range - start_timestamp={start_timestamp}, end_timestamp={end_timestamp}")
            if start_timestamp and end_timestamp:
                logger.info(f"🔍 DEBUG: Taking IF branch (timestamps provided)")
                start_date = datetime.date.fromtimestamp(start_timestamp)
                end_date = datetime.date.fromtimestamp(end_timestamp)
                start_date_str = start_date.strftime('%Y-%m-%d')
                end_date_str = end_date.strftime('%Y-%m-%d')
            else:
                logger.info(f"🔍 DEBUG: Taking ELSE branch (no timestamps)")
                # Default: all history - get first date from rollup table
                first_rollup_date = StatsRollupTable.get_first_date()
                logger.info(f"🔍 DEBUG: get_first_date() returned: {first_rollup_date} (type: {type(first_rollup_date)})")
                start_date_str = first_rollup_date if first_rollup_date else today_str
                end_date_str = today_str
                logger.info(f"🔍 DEBUG: No date filter - start_date_str={start_date_str}, end_date_str={end_date_str}, today_str={today_str}")
            
            # Check if today is in the date range
            today_in_range = (not end_date_str) or (end_date_str >= today_str)
            
            # Query rollup data for historical dates (up to yesterday)
            rollup_query_start = time.time()
            rollup_stats = None
            if start_date_str:
                # Calculate yesterday
                yesterday = today - datetime.timedelta(days=1)
                yesterday_str = yesterday.strftime('%Y-%m-%d')
                logger.info(f"🔍 DEBUG: Checking rollup condition - start_date_str={start_date_str}, yesterday_str={yesterday_str}, condition={start_date_str <= yesterday_str}")
                
                # Only query rollup if we have historical dates
                if start_date_str <= yesterday_str:
                    rollup_end = min(end_date_str, yesterday_str) if end_date_str else yesterday_str
                    
                    logger.info(f"Querying rollup data from {start_date_str} to {rollup_end}")
                    rollups = StatsRollupTable.get_date_range(start_date_str, rollup_end)
                    
                    if rollups:
                        rollup_stats = aggregate_rollup_data(rollups)
                        logger.info(f"Aggregated {len(rollups)} rollup records in {time.time() - rollup_query_start:.3f}s")
            
            # Calculate today's stats live if needed
            live_stats_start = time.time()
            live_stats = None
            if today_in_range:
                logger.info("Calculating today's stats live")
                today_start = datetime.datetime.combine(today, datetime.time.min).timestamp()
                today_end = datetime.datetime.combine(today, datetime.time.max).timestamp()
                today_lines = GameLinesTable.get_lines_filtered_by_timestamp(start=today_start, end=today_end, for_stats=True)
                
                if today_lines:
                    live_stats = calculate_live_stats_for_today(today_lines)
                    logger.info(f"Calculated live stats from {len(today_lines)} lines in {time.time() - live_stats_start:.3f}s")
            
            # Combine rollup and live stats
            combined_stats = combine_rollup_and_live_stats(rollup_stats, live_stats)
            logger.info(f"Combined stats: {len(combined_stats)} fields")
            
            # === PERFORMANCE OPTIMIZATION: Build chart data from rollup instead of fetching all lines ===
            # Only fetch today's lines for live calculations
            today_lines_for_charts = []
            if today_in_range:
                today_start = datetime.datetime.combine(today, datetime.time.min).timestamp()
                today_end = datetime.datetime.combine(today, datetime.time.max).timestamp()
                today_lines_for_charts = GameLinesTable.get_lines_filtered_by_timestamp(start=today_start, end=today_end, for_stats=True)
                logger.info(f"Fetched {len(today_lines_for_charts)} lines for today's charts")
            
            # 2. Build daily_data from rollup records (FAST) + today's lines (SMALL)
            # Structure: daily_data[date_str][display_name] = {'lines': N, 'chars': N}
            daily_data = defaultdict(lambda: defaultdict(lambda: {'lines': 0, 'chars': 0}))
            
            # Process rollup data into daily_data (FAST - no database queries!)
            if start_date_str:
                yesterday = today - datetime.timedelta(days=1)
                yesterday_str = yesterday.strftime('%Y-%m-%d')
                
                if start_date_str <= yesterday_str:
                    rollup_end = min(end_date_str, yesterday_str) if end_date_str else yesterday_str
                    logger.info(f"Building daily_data from rollup records: {start_date_str} to {rollup_end}")
                    
                    # Get rollup records for the date range
                    rollups = StatsRollupTable.get_date_range(start_date_str, rollup_end)
                    logger.info(f"Processing {len(rollups)} rollup records for chart data")
                    
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
                                    display_name = activity.get('title', f'Game {game_id}')
                                    daily_data[date_str][display_name]['lines'] = activity.get('lines', 0)
                                    daily_data[date_str][display_name]['chars'] = activity.get('chars', 0)
                            except (json.JSONDecodeError, KeyError, TypeError) as e:
                                logger.warning(f"Error parsing rollup data for {date_str}: {e}")
                                continue
            
            # Add today's lines to daily_data
            for line in today_lines_for_charts:
                day_str = datetime.date.fromtimestamp(float(line.timestamp)).strftime('%Y-%m-%d')
                game_name = line.game_name or "Unknown Game"
                # Get display name from games table for this line
                from GameSentenceMiner.util.games_table import GamesTable
                game_metadata = GamesTable.get_by_game_line(line)
                display_name = game_metadata.title_original if (game_metadata and game_metadata.title_original) else game_name
                daily_data[day_str][display_name]['lines'] += 1
                daily_data[day_str][display_name]['chars'] += len(line.line_text) if line.line_text else 0
            
            # Fetch ALL lines for chart calculations (needed for build_game_display_name_mapping)
            # The rollup optimization is for daily_data building, but chart functions still need all lines
            all_lines = GameLinesTable.get_lines_filtered_by_timestamp(start=start_timestamp, end=end_timestamp, for_stats=True)
            logger.info(f"Fetched {len(all_lines)} lines for chart calculations")
            
            if not all_lines and not daily_data:
                return jsonify({"labels": [], "datasets": []})

            # 3. Create cumulative datasets for Chart.js
            sorted_days = sorted(daily_data.keys())
            # Get all unique display names from daily_data
            all_display_names = set()
            for day_data in daily_data.values():
                all_display_names.update(day_data.keys())
            display_names = sorted(all_display_names)
            
            # Keep track of the running total for each metric for each game
            cumulative_totals = defaultdict(lambda: {'lines': 0, 'chars': 0})
            
            # Structure for final data: final_data[display_name][metric] = [day1_val, day2_val, ...]
            final_data = defaultdict(lambda: defaultdict(list))

            for day in sorted_days:
                for display_name in display_names:
                    # Add the day's total to the cumulative total
                    cumulative_totals[display_name]['lines'] += daily_data[day][display_name]['lines']
                    cumulative_totals[display_name]['chars'] += daily_data[day][display_name]['chars']
                    
                    # Append the new cumulative total to the list for that day
                    final_data[display_name]['lines'].append(cumulative_totals[display_name]['lines'])
                    final_data[display_name]['chars'].append(cumulative_totals[display_name]['chars'])
            
            # 4. Format into Chart.js dataset structure
            try:
                datasets = []
                # A simple color palette for the chart lines
                colors = ['#3498db', '#e74c3c', '#2ecc71', '#f1c40f', '#9b59b6', '#1abc9c', '#e67e22']
                
                for i, display_name in enumerate(display_names):
                    color = colors[i % len(colors)]
                    
                    datasets.append({
                        "label": f"{display_name}",
                        "data": final_data[display_name]['lines'],
                        "borderColor": color,
                        "backgroundColor": f"{color}33", # Semi-transparent for fill
                        "fill": False,
                        "tension": 0.1,
                        "for": "Lines Received"
                    })
                    datasets.append({
                        "label": f"{display_name}",
                        "data": final_data[display_name]['chars'],
                        "borderColor": color,
                        "backgroundColor": f"{color}33",
                        "fill": False,
                        "tension": 0.1,
                        "hidden": True, # Hide by default to not clutter the chart
                        "for": "Characters Read"
                    })
            except Exception as e:
                logger.error(f"Error formatting Chart.js datasets: {e}")
                return jsonify({'error': 'Failed to format chart data'}), 500

            # 5. Calculate additional chart data
            try:
                # Use kanji data from combined stats if available
                kanji_freq_dict = combined_stats.get('kanji_frequency_data', {})
                if kanji_freq_dict:
                    # Convert to the format expected by frontend (with colors)
                    from GameSentenceMiner.web.stats import get_gradient_color
                    max_frequency = max(kanji_freq_dict.values()) if kanji_freq_dict else 0
                    
                    # Sort kanji by frequency (most frequent first)
                    sorted_kanji = sorted(kanji_freq_dict.items(), key=lambda x: x[1], reverse=True)
                    
                    kanji_data = []
                    for kanji, count in sorted_kanji:
                        color = get_gradient_color(count, max_frequency)
                        kanji_data.append({
                            "kanji": kanji,
                            "frequency": count,
                            "color": color
                        })
                    
                    kanji_grid_data = {
                        "kanji_data": kanji_data,
                        "unique_count": len(sorted_kanji),
                        "max_frequency": max_frequency
                    }
                else:
                    # Fallback to calculating from all_lines if no rollup data
                    kanji_grid_data = calculate_kanji_frequency(all_lines)
            except Exception as e:
                logger.error(f"Error calculating kanji frequency: {e}")
                kanji_grid_data = []
                
            try:
                # Use rollup-based heatmap for historical data (FAST!)
                if start_date_str:
                    yesterday = today - datetime.timedelta(days=1)
                    yesterday_str = yesterday.strftime('%Y-%m-%d')
                    
                    if start_date_str <= yesterday_str:
                        rollup_end = min(end_date_str, yesterday_str) if end_date_str else yesterday_str
                        rollups_for_heatmap = StatsRollupTable.get_date_range(start_date_str, rollup_end)
                        heatmap_data = build_heatmap_from_rollup(rollups_for_heatmap, filter_year)
                        
                        # Add today's data to heatmap if needed
                        if today_in_range and today_lines_for_charts:
                            from GameSentenceMiner.web.stats import calculate_heatmap_data
                            today_heatmap = calculate_heatmap_data(today_lines_for_charts, filter_year)
                            # Merge today's data into heatmap
                            for year, dates in today_heatmap.items():
                                if year not in heatmap_data:
                                    heatmap_data[year] = {}
                                for date, chars in dates.items():
                                    heatmap_data[year][date] = heatmap_data[year].get(date, 0) + chars
                    else:
                        # Only today's data
                        from GameSentenceMiner.web.stats import calculate_heatmap_data
                        heatmap_data = calculate_heatmap_data(today_lines_for_charts, filter_year)
                else:
                    # No date range specified, use today only
                    from GameSentenceMiner.web.stats import calculate_heatmap_data
                    heatmap_data = calculate_heatmap_data(today_lines_for_charts, filter_year)
            except Exception as e:
                logger.error(f"Error calculating heatmap data: {e}")
                heatmap_data = {}
                
            try:
                total_chars_data = calculate_total_chars_per_game(all_lines)
            except Exception as e:
                logger.error(f"Error calculating total chars per game: {e}")
                total_chars_data = {}
                
            try:
                reading_time_data = calculate_reading_time_per_game(all_lines)
            except Exception as e:
                logger.error(f"Error calculating reading time per game: {e}")
                reading_time_data = {}
                
            try:
                reading_speed_per_game_data = calculate_reading_speed_per_game(all_lines)
            except Exception as e:
                logger.error(f"Error calculating reading speed per game: {e}")
                reading_speed_per_game_data = {}
            
            # 6. Calculate dashboard statistics
            try:
                current_game_stats = calculate_current_game_stats(all_lines)
            except Exception as e:
                logger.error(f"Error calculating current game stats: {e}")
                current_game_stats = {}
                
            try:
                # Calculate all_games_stats from combined rollup + live data
                # Use combined_stats for accurate first_date instead of just today's lines
                all_games_stats = calculate_all_games_stats(all_lines)
                
                # ALWAYS override first_date with actual first date from rollup table
                # This ensures frontend gets the correct historical start date
                first_rollup_date = StatsRollupTable.get_first_date()
                if first_rollup_date and all_games_stats:
                    all_games_stats['first_date'] = first_rollup_date
                    logger.info(f"🔍 DEBUG: Overriding first_date with rollup first date: {first_rollup_date}")
                elif all_games_stats:
                    logger.info(f"🔍 DEBUG: No rollup data, using calculated first_date: {all_games_stats.get('first_date', 'N/A')}")
            except Exception as e:
                logger.error(f"Error calculating all games stats: {e}")
                all_games_stats = {}

            # 7. Prepare allLinesData for frontend calculations (needed for average daily time)
            try:
                all_lines_data = []
                for line in all_lines:
                    all_lines_data.append({
                        'timestamp': float(line.timestamp),
                        'game_name': line.game_name or 'Unknown Game',
                        'characters': len(line.line_text) if line.line_text else 0,
                        'id': line.id
                    })
            except Exception as e:
                logger.error(f"Error preparing all lines data: {e}")
                all_lines_data = []

            # 8. Get hourly activity pattern from combined stats
            try:
                # Convert dict to list format expected by frontend
                hourly_dict = combined_stats.get('hourly_activity_data', {})
                hourly_activity_data = [0] * 24
                for hour_str, chars in hourly_dict.items():
                    try:
                        hour_int = int(hour_str)
                        if 0 <= hour_int < 24:
                            hourly_activity_data[hour_int] = chars
                    except (ValueError, TypeError):
                        logger.warning(f"Invalid hour key in hourly_activity_data: {hour_str}")
            except Exception as e:
                logger.error(f"Error processing hourly activity: {e}")
                hourly_activity_data = [0] * 24

            # 8.5. Get hourly reading speed pattern from combined stats
            try:
                # Convert dict to list format expected by frontend
                speed_dict = combined_stats.get('hourly_reading_speed_data', {})
                hourly_reading_speed_data = [0] * 24
                for hour_str, speed in speed_dict.items():
                    try:
                        hour_int = int(hour_str)
                        if 0 <= hour_int < 24:
                            hourly_reading_speed_data[hour_int] = speed
                    except (ValueError, TypeError):
                        logger.warning(f"Invalid hour key in hourly_reading_speed_data: {hour_str}")
            except Exception as e:
                logger.error(f"Error processing hourly reading speed: {e}")
                hourly_reading_speed_data = [0] * 24

            # 9. Calculate peak statistics from combined stats
            try:
                # Convert from rollup format to API format
                peak_daily_stats = {
                    'max_daily_chars': combined_stats.get('max_chars_in_session', 0),
                    'max_daily_hours': combined_stats.get('max_time_in_session_seconds', 0.0) / 3600
                }
                # Note: For true daily peaks, we'd need to track them separately in rollup
                # For now, using session peaks as approximation
                # TODO: Add max_daily_chars and max_daily_hours to rollup table
                if all_lines:
                    actual_peak_daily = calculate_peak_daily_stats(all_lines)
                    peak_daily_stats = actual_peak_daily
            except Exception as e:
                logger.error(f"Error calculating peak daily stats: {e}")
                peak_daily_stats = {'max_daily_chars': 0, 'max_daily_hours': 0.0}
                
            try:
                peak_session_stats = {
                    'longest_session_hours': combined_stats.get('longest_session_seconds', 0.0) / 3600,
                    'max_session_chars': combined_stats.get('max_chars_in_session', 0)
                }
            except Exception as e:
                logger.error(f"Error calculating peak session stats: {e}")
                peak_session_stats = {'longest_session_hours': 0.0, 'max_session_chars': 0}

            # 10. Calculate game milestones (oldest/newest by release year)
            try:
                game_milestones = calculate_game_milestones(all_lines)
            except Exception as e:
                logger.error(f"Error calculating game milestones: {e}")
                game_milestones = None

            # Log total request time
            total_time = time.time() - request_start_time
            logger.info(f"✅ /api/stats completed in {total_time:.3f}s (target: <1.0s)")
            
            return jsonify({
                "labels": sorted_days,
                "datasets": datasets,
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
                "gameMilestones": game_milestones
            })
            
        except Exception as e:
            logger.error(f"Unexpected error in api_stats: {e}", exc_info=True)
            return jsonify({'error': 'Failed to generate statistics'}), 500

    @app.route('/api/mining_heatmap')
    def api_mining_heatmap():
        """
        Provides mining heatmap data showing daily mining activity.
        Counts lines where screenshot_in_anki OR audio_in_anki is not empty.
        Accepts optional 'start' and 'end' timestamp parameters for filtering.
        """
        try:
            # Get optional timestamp filter parameters
            start_timestamp = request.args.get('start', None)
            end_timestamp = request.args.get('end', None)
            
            # Convert timestamps to float if provided
            start_timestamp = float(start_timestamp) if start_timestamp else None
            end_timestamp = float(end_timestamp) if end_timestamp else None
            
            # Fetch lines filtered by timestamp
            all_lines = GameLinesTable.get_lines_filtered_by_timestamp(start=start_timestamp, end=end_timestamp)
            
            if not all_lines:
                return jsonify({}), 200
            
            # Calculate mining heatmap data
            try:
                heatmap_data = calculate_mining_heatmap_data(all_lines)
            except Exception as e:
                logger.error(f"Error calculating mining heatmap data: {e}")
                return jsonify({'error': 'Failed to calculate mining heatmap'}), 500
            
            return jsonify(heatmap_data), 200
            
        except Exception as e:
            logger.error(f"Unexpected error in api_mining_heatmap: {e}", exc_info=True)
            return jsonify({'error': 'Failed to generate mining heatmap'}), 500

    @app.route('/api/goals-today', methods=['GET'])
    def api_goals_today():
        """
        Calculate daily requirements and current progress for today based on goal target dates.
        Returns what needs to be accomplished today to stay on track.
        """
        try:
            config = get_stats_config()
            today = datetime.date.today()
            
            # Get all lines for overall progress
            all_lines = GameLinesTable.all(for_stats=True)
            if not all_lines:
                return jsonify({
                    'hours': {'required': 0, 'progress': 0, 'has_target': False},
                    'characters': {'required': 0, 'progress': 0, 'has_target': False},
                    'games': {'required': 0, 'progress': 0, 'has_target': False}
                }), 200
            
            # Calculate overall current progress
            timestamps = [float(line.timestamp) for line in all_lines]
            total_time_seconds = calculate_actual_reading_time(timestamps)
            total_hours = total_time_seconds / 3600
            total_characters = sum(len(line.line_text) if line.line_text else 0 for line in all_lines)
            total_games = len(set(line.game_name or "Unknown Game" for line in all_lines))
            
            # Get today's lines for progress
            today_lines = [line for line in all_lines 
                          if datetime.date.fromtimestamp(float(line.timestamp)) == today]
            
            today_timestamps = [float(line.timestamp) for line in today_lines]
            today_time_seconds = calculate_actual_reading_time(today_timestamps) if len(today_timestamps) >= 2 else 0
            today_hours = today_time_seconds / 3600
            today_characters = sum(len(line.line_text) if line.line_text else 0 for line in today_lines)
            
            result = {}
            
            # Calculate hours requirement
            if config.reading_hours_target_date:
                try:
                    target_date = datetime.datetime.strptime(config.reading_hours_target_date, '%Y-%m-%d').date()
                    days_remaining = (target_date - today).days + 1  # +1 to include today
                    if days_remaining > 0:
                        hours_needed = max(0, config.reading_hours_target - total_hours)
                        daily_hours_required = hours_needed / days_remaining
                        result['hours'] = {
                            'required': round(daily_hours_required, 2),
                            'progress': round(today_hours, 2),
                            'has_target': True,
                            'target_date': config.reading_hours_target_date,
                            'days_remaining': days_remaining
                        }
                    else:
                        result['hours'] = {'required': 0, 'progress': round(today_hours, 2), 'has_target': True, 'expired': True}
                except ValueError:
                    result['hours'] = {'required': 0, 'progress': round(today_hours, 2), 'has_target': False}
            else:
                result['hours'] = {'required': 0, 'progress': round(today_hours, 2), 'has_target': False}
            
            # Calculate characters requirement
            if config.character_count_target_date:
                try:
                    target_date = datetime.datetime.strptime(config.character_count_target_date, '%Y-%m-%d').date()
                    days_remaining = (target_date - today).days + 1
                    if days_remaining > 0:
                        chars_needed = max(0, config.character_count_target - total_characters)
                        daily_chars_required = int(chars_needed / days_remaining)
                        result['characters'] = {
                            'required': daily_chars_required,
                            'progress': today_characters,
                            'has_target': True,
                            'target_date': config.character_count_target_date,
                            'days_remaining': days_remaining
                        }
                    else:
                        result['characters'] = {'required': 0, 'progress': today_characters, 'has_target': True, 'expired': True}
                except ValueError:
                    result['characters'] = {'required': 0, 'progress': today_characters, 'has_target': False}
            else:
                result['characters'] = {'required': 0, 'progress': today_characters, 'has_target': False}
            
            # Calculate games requirement
            if config.games_target_date:
                try:
                    target_date = datetime.datetime.strptime(config.games_target_date, '%Y-%m-%d').date()
                    days_remaining = (target_date - today).days + 1
                    if days_remaining > 0:
                        games_needed = max(0, config.games_target - total_games)
                        daily_games_required = games_needed / days_remaining
                        result['games'] = {
                            'required': round(daily_games_required, 2),
                            'progress': total_games,
                            'has_target': True,
                            'target_date': config.games_target_date,
                            'days_remaining': days_remaining
                        }
                    else:
                        result['games'] = {'required': 0, 'progress': total_games, 'has_target': True, 'expired': True}
                except ValueError:
                    result['games'] = {'required': 0, 'progress': total_games, 'has_target': False}
            else:
                result['games'] = {'required': 0, 'progress': total_games, 'has_target': False}
            
            return jsonify(result), 200
            
        except Exception as e:
            logger.error(f"Error calculating goals today: {e}")
            return jsonify({'error': 'Failed to calculate daily goals'}), 500

    @app.route('/api/goals-projection', methods=['GET'])
    def api_goals_projection():
        """
        Calculate projections based on 30-day rolling average.
        Returns projected stats by target dates.
        """
        try:
            config = get_stats_config()
            today = datetime.date.today()
            thirty_days_ago = today - datetime.timedelta(days=30)
            
            # Get all lines
            all_lines = GameLinesTable.all(for_stats=True)
            if not all_lines:
                return jsonify({
                    'hours': {'projection': 0, 'daily_average': 0},
                    'characters': {'projection': 0, 'daily_average': 0},
                    'games': {'projection': 0, 'daily_average': 0}
                }), 200
            
            # Get last 30 days of lines
            recent_lines = [line for line in all_lines 
                           if datetime.date.fromtimestamp(float(line.timestamp)) >= thirty_days_ago]
            
            # Calculate 30-day averages
            if recent_lines:
                # Group by day for accurate averaging
                daily_data = defaultdict(lambda: {'timestamps': [], 'characters': 0, 'games': set()})
                for line in recent_lines:
                    day_str = datetime.date.fromtimestamp(float(line.timestamp)).strftime('%Y-%m-%d')
                    daily_data[day_str]['timestamps'].append(float(line.timestamp))
                    daily_data[day_str]['characters'] += len(line.line_text) if line.line_text else 0
                    daily_data[day_str]['games'].add(line.game_name or "Unknown Game")
                
                # Calculate daily averages
                total_hours = 0
                total_chars = 0
                total_unique_games = set()
                
                for day_data in daily_data.values():
                    if len(day_data['timestamps']) >= 2:
                        day_seconds = calculate_actual_reading_time(day_data['timestamps'])
                        total_hours += day_seconds / 3600
                    total_chars += day_data['characters']
                    total_unique_games.update(day_data['games'])
                
                # Average over ALL 30 days (including days with 0 activity)
                avg_daily_hours = total_hours / 30
                avg_daily_chars = total_chars / 30
                # Calculate average daily unique games correctly
                today = datetime.date.today()
                daily_unique_games_counts = []
                for i in range(30):
                    day = (today - datetime.timedelta(days=i)).strftime('%Y-%m-%d')
                    daily_unique_games_counts.append(len(daily_data[day]['games']) if day in daily_data else 0)
                avg_daily_games = sum(daily_unique_games_counts) / 30
            else:
                avg_daily_hours = 0
                avg_daily_chars = 0
                avg_daily_games = 0
            
            # Calculate current totals
            timestamps = [float(line.timestamp) for line in all_lines]
            current_hours = calculate_actual_reading_time(timestamps) / 3600
            current_chars = sum(len(line.line_text) if line.line_text else 0 for line in all_lines)
            current_games = len(set(line.game_name or "Unknown Game" for line in all_lines))
            
            result = {}
            
            # Project hours by target date
            if config.reading_hours_target_date:
                try:
                    target_date = datetime.datetime.strptime(config.reading_hours_target_date, '%Y-%m-%d').date()
                    days_until_target = (target_date - today).days
                    projected_hours = current_hours + (avg_daily_hours * days_until_target)
                    result['hours'] = {
                        'projection': round(projected_hours, 2),
                        'daily_average': round(avg_daily_hours, 2),
                        'target_date': config.reading_hours_target_date,
                        'target': config.reading_hours_target,
                        'current': round(current_hours, 2)
                    }
                except ValueError:
                    result['hours'] = {'projection': 0, 'daily_average': round(avg_daily_hours, 2)}
            else:
                result['hours'] = {'projection': 0, 'daily_average': round(avg_daily_hours, 2)}
            
            # Project characters by target date
            if config.character_count_target_date:
                try:
                    target_date = datetime.datetime.strptime(config.character_count_target_date, '%Y-%m-%d').date()
                    days_until_target = (target_date - today).days
                    projected_chars = int(current_chars + (avg_daily_chars * days_until_target))
                    result['characters'] = {
                        'projection': projected_chars,
                        'daily_average': int(avg_daily_chars),
                        'target_date': config.character_count_target_date,
                        'target': config.character_count_target,
                        'current': current_chars
                    }
                except ValueError:
                    result['characters'] = {'projection': 0, 'daily_average': int(avg_daily_chars)}
            else:
                result['characters'] = {'projection': 0, 'daily_average': int(avg_daily_chars)}
            
            # Project games by target date
            if config.games_target_date:
                try:
                    target_date = datetime.datetime.strptime(config.games_target_date, '%Y-%m-%d').date()
                    days_until_target = (target_date - today).days
                    projected_games = int(current_games + (avg_daily_games * days_until_target))
                    result['games'] = {
                        'projection': projected_games,
                        'daily_average': round(avg_daily_games, 2),
                        'target_date': config.games_target_date,
                        'target': config.games_target,
                        'current': current_games
                    }
                except ValueError:
                    result['games'] = {'projection': 0, 'daily_average': round(avg_daily_games, 2)}
            else:
                result['games'] = {'projection': 0, 'daily_average': round(avg_daily_games, 2)}
            
            return jsonify(result), 200
            
        except Exception as e:
            logger.error(f"Error calculating goal projections: {e}")
            return jsonify({'error': 'Failed to calculate projections'}), 500

    @app.route('/api/import-exstatic', methods=['POST'])
    def api_import_exstatic():
        """
        Import ExStatic CSV data into GSM database.
        Expected CSV format: uuid,given_identifier,name,line,time
        """
        try:
            # Check if file is provided
            if 'file' not in request.files:
                return jsonify({'error': 'No file provided'}), 400
            
            file = request.files['file']
            if file.filename == '':
                return jsonify({'error': 'No file selected'}), 400
            
            # Validate file type
            if not file.filename.lower().endswith('.csv'):
                return jsonify({'error': 'File must be a CSV file'}), 400
            
            # Read and parse CSV
            try:
                # Read file content as text with proper encoding handling
                file_content = file.read().decode('utf-8-sig')  # Handle BOM if present
                
                # First, get the header line manually to avoid issues with multi-line content
                lines = file_content.split('\n')
                if len(lines) == 1 and not lines[0].strip():
                    return jsonify({'error': 'Empty CSV file'}), 400
                
                header_line = lines[0].strip()
                logger.info(f"Header line: {header_line}")
                
                # Parse headers manually
                header_reader = csv.reader([header_line])
                try:
                    headers = next(header_reader)
                    headers = [h.strip() for h in headers]  # Clean whitespace
                    logger.info(f"Parsed headers: {headers}")
                except StopIteration:
                    return jsonify({'error': 'Could not parse CSV headers'}), 400
                
                # Validate headers
                expected_headers = {'uuid', 'given_identifier', 'name', 'line', 'time'}
                actual_headers = set(headers)
                
                if not expected_headers.issubset(actual_headers):
                    missing_headers = expected_headers - actual_headers
                    # Check if this looks like a stats CSV instead of lines CSV
                    if 'client' in actual_headers and 'chars_read' in actual_headers:
                        return jsonify({
                            'error': 'This appears to be an ExStatic stats CSV. Please upload the ExStatic lines CSV file instead. The lines CSV should contain columns: uuid, given_identifier, name, line, time'
                        }), 400
                    else:
                        return jsonify({
                            'error': f'Invalid CSV format. Missing required columns: {", ".join(missing_headers)}. Expected format: uuid, given_identifier, name, line, time. Found headers: {", ".join(actual_headers)}'
                        }), 400
                
                # Now parse the full CSV with proper handling for multi-line fields
                file_io = io.StringIO(file_content)
                csv_reader = csv.DictReader(file_io, quoting=csv.QUOTE_MINIMAL, skipinitialspace=True)
                
                # Process CSV rows
                games_set = set()
                errors = []
                
                all_lines = GameLinesTable.all()
                existing_uuids = {line.id for line in all_lines}
                batch_size = 1000  # For logging progress
                batch_insert = []
                imported_count = 0
                
                def get_line_hash(uuid: str, line_text: str) -> str:
                    return uuid + '|' + line_text.strip()

                for row_num, row in enumerate(csv_reader):
                    try:
                        # Extract and validate required fields
                        game_uuid = row.get('uuid', '').strip()
                        game_name = row.get('name', '').strip()
                        line = row.get('line', '').strip()
                        time_str = row.get('time', '').strip()
                        
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
                            logger.info(f"Skipping duplicate UUID already in database: {line_hash}")
                            continue

                        # Convert time to timestamp
                        try:
                            timestamp = float(time_str)
                        except ValueError:
                            errors.append(f"Row {row_num}: Invalid time format: {time_str}")
                            continue
                        
                        # Clean up line text (remove extra whitespace and newlines)
                        line_text = line.strip()
                        
                        # Create GameLinesTable entry
                        # Convert timestamp float to datetime object
                        dt = datetime.datetime.fromtimestamp(timestamp)
                        batch_insert.append(GameLine(
                            id=line_hash,
                            text=line_text,
                            scene=game_name,
                            time=dt,
                            prev=None,
                            next=None,
                            index=0,
                        ))
                        
                        logger.info(f"Batch insert size: {len(batch_insert)}")
                        
                        existing_uuids.add(line_hash)  # Add to existing to prevent duplicates in same import
                        
                        if len(batch_insert) >= batch_size:
                            logger.info(f"Importing batch of {len(batch_insert)} lines...")
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
                    logger.info(f"Importing final batch of {len(batch_insert)} lines...")
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

                # Prepare response
                response_data = {
                    'message': f'Successfully imported {imported_count} lines from {len(games_set)} games',
                    'imported_count': imported_count,
                    'games_count': len(games_set),
                    'games': list(games_set)
                }
                
                if errors:
                    response_data['warnings'] = errors
                    response_data['warning_count'] = len(errors)
                
                logger.info(f"ExStatic import completed: {imported_count} lines from {len(games_set)} games")
                
                logger.info(f"Import response: {response_data}")
                
                return jsonify(response_data), 200
                
            except csv.Error as e:
                return jsonify({'error': f'CSV parsing error: {str(e)}'}), 400
            except UnicodeDecodeError:
                return jsonify({'error': 'File encoding error. Please ensure the CSV is UTF-8 encoded.'}), 400
            
        except Exception as e:
            logger.error(f"Error in ExStatic import: {e}")
            return jsonify({'error': f'Import failed: {str(e)}'}), 500

    @app.route('/api/kanji-sorting-configs', methods=['GET'])
    def api_kanji_sorting_configs():
        """
        List available kanji sorting configuration JSON files.
        Returns metadata for each available sorting option.
        """
        try:
            # Get the kanji_grid directory path
            template_dir = Path(__file__).parent / 'templates' / 'components' / 'kanji_grid'
            
            if not template_dir.exists():
                logger.warning(f"Kanji grid directory does not exist: {template_dir}")
                return jsonify({'configs': []}), 200
            
            configs = []
            
            # Scan for JSON files in the directory
            for json_file in template_dir.glob('*.json'):
                try:
                    with open(json_file, 'r', encoding='utf-8') as f:
                        data = json.load(f)
                        
                        # Extract metadata from JSON
                        configs.append({
                            'filename': json_file.name,
                            'name': data.get('name', json_file.stem),
                            'version': data.get('version', 1),
                            'lang': data.get('lang', 'ja'),
                            'source': data.get('source', ''),
                            'group_count': len(data.get('groups', []))
                        })
                except json.JSONDecodeError as e:
                    logger.warning(f"Failed to parse {json_file.name}: {e}")
                    continue
                except Exception as e:
                    logger.warning(f"Error reading {json_file.name}: {e}")
                    continue
            
            # Sort by name for consistency
            configs.sort(key=lambda x: x['name'])
            
            return jsonify({'configs': configs}), 200
            
        except Exception as e:
            logger.error(f"Error fetching kanji sorting configs: {e}")
            return jsonify({'error': 'Failed to fetch sorting configurations'}), 500

    @app.route('/api/kanji-sorting-config/<filename>', methods=['GET'])
    def api_kanji_sorting_config(filename):
        """
        Get a specific kanji sorting configuration file.
        Returns the full JSON configuration.
        """
        try:
            # Sanitize filename to prevent path traversal
            if '..' in filename or '/' in filename or '\\' in filename:
                return jsonify({'error': 'Invalid filename'}), 400
            
            if not filename.endswith('.json'):
                filename += '.json'
            
            # Get the kanji_grid directory path
            template_dir = Path(__file__).parent / 'templates' / 'components' / 'kanji_grid'
            config_file = template_dir / filename
            
            if not config_file.exists() or not config_file.is_file():
                return jsonify({'error': 'Configuration file not found'}), 404
            
            # Read and return the JSON configuration
            with open(config_file, 'r', encoding='utf-8') as f:
                config_data = json.load(f)
            
            return jsonify(config_data), 200
            
        except json.JSONDecodeError as e:
            logger.error(f"Failed to parse {filename}: {e}")
            return jsonify({'error': 'Invalid JSON configuration'}), 500
        except Exception as e:
            logger.error(f"Error fetching config {filename}: {e}")
            return jsonify({'error': 'Failed to fetch configuration'}), 500