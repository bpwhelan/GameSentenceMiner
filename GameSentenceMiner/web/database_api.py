import copy
import datetime
import re
import csv
import io
import os
import json
from collections import defaultdict
import time
from pathlib import Path

import flask
from flask import request, jsonify
import regex

from GameSentenceMiner.util.db import GameLinesTable
from GameSentenceMiner.util.configuration import get_stats_config, logger, get_config, save_current_config, save_stats_config
from GameSentenceMiner.util.text_log import GameLine
from GameSentenceMiner.web.stats import (
    calculate_kanji_frequency, calculate_heatmap_data, calculate_mining_heatmap_data,
    calculate_total_chars_per_game, calculate_reading_time_per_game, calculate_reading_speed_per_game,
    calculate_current_game_stats, calculate_all_games_stats, calculate_daily_reading_time,
    calculate_time_based_streak, calculate_actual_reading_time, calculate_hourly_activity,
    calculate_hourly_reading_speed, calculate_peak_daily_stats, calculate_peak_session_stats,
    calculate_game_milestones
)

def register_database_api_routes(app):
    """Register all database API routes with the Flask app."""
    
    @app.route('/api/search-sentences')
    def api_search_sentences():
        """
        API endpoint for searching sentences with filters and pagination.
        """
        try:
            # Get query parameters
            query = request.args.get('q', '').strip()
            game_filter = request.args.get('game', '')
            sort_by = request.args.get('sort', 'relevance')
            page = int(request.args.get('page', 1))
            page_size = int(request.args.get('page_size', 20))
            use_regex = request.args.get('use_regex', 'false').lower() == 'true'
            
            # Validate parameters
            if not query:
                return jsonify({'error': 'Search query is required'}), 400
            
            if page < 1:
                page = 1
            if page_size < 1 or page_size > 200:
                page_size = 20

            if use_regex:
                # Regex search: fetch all candidate rows, filter in Python
                try:
                    # Ensure query is a string
                    if not isinstance(query, str):
                        return jsonify({'error': 'Invalid query parameter type'}), 400
                    
                    all_lines = GameLinesTable.all()
                    if game_filter:
                        all_lines = [line for line in all_lines if line.game_name == game_filter]
                    
                    # Compile regex pattern with proper error handling
                    try:
                        pattern = re.compile(query, re.IGNORECASE)
                    except re.error as regex_err:
                        return jsonify({'error': f'Invalid regex pattern: {str(regex_err)}'}), 400
                    
                    # Filter lines using regex
                    filtered_lines = []
                    for line in all_lines:
                        if line.line_text and isinstance(line.line_text, str):
                            try:
                                if pattern.search(line.line_text):
                                    filtered_lines.append(line)
                            except Exception as search_err:
                                # Log but continue with other lines
                                logger.warning(f"Regex search error on line {line.id}: {search_err}")
                                continue
                    
                    # Sorting (default: timestamp DESC, or as specified)
                    if sort_by == 'date_asc':
                        filtered_lines.sort(key=lambda l: float(l.timestamp) if l.timestamp else 0)
                    elif sort_by == 'game_name':
                        filtered_lines.sort(key=lambda l: (l.game_name or '', -(float(l.timestamp) if l.timestamp else 0)))
                    else:  # date_desc or relevance
                        filtered_lines.sort(key=lambda l: -(float(l.timestamp) if l.timestamp else 0))
                    
                    total_results = len(filtered_lines)
                    # Pagination
                    start = (page - 1) * page_size
                    end = start + page_size
                    paged_lines = filtered_lines[start:end]
                    results = []
                    for line in paged_lines:
                        results.append({
                            'id': line.id,
                            'sentence': line.line_text or '',
                            'game_name': line.game_name or 'Unknown Game',
                            'timestamp': float(line.timestamp) if line.timestamp else 0,
                            'translation': line.translation or None,
                            'has_audio': bool(getattr(line, 'audio_path', None)),
                            'has_screenshot': bool(getattr(line, 'screenshot_path', None))
                        })
                    return jsonify({
                        'results': results,
                        'total': total_results,
                        'page': page,
                        'page_size': page_size,
                        'total_pages': (total_results + page_size - 1) // page_size
                    }), 200
                except Exception as e:
                    logger.error(f"Regex search failed: {e}")
                    return jsonify({'error': f'Search failed: {str(e)}'}), 500
            else:
                # Build the SQL query
                base_query = f"SELECT * FROM {GameLinesTable._table} WHERE line_text LIKE ?"
                params = [f'%{query}%']
                
                # Add game filter if specified
                if game_filter:
                    base_query += " AND game_name = ?"
                    params.append(game_filter)
                
                # Add sorting
                if sort_by == 'date_desc':
                    base_query += " ORDER BY timestamp DESC"
                elif sort_by == 'date_asc':
                    base_query += " ORDER BY timestamp ASC"
                elif sort_by == 'game_name':
                    base_query += " ORDER BY game_name, timestamp DESC"
                else:  # relevance - could be enhanced with proper scoring
                    base_query += " ORDER BY timestamp DESC"
                
                # Get total count for pagination
                count_query = f"SELECT COUNT(*) FROM {GameLinesTable._table} WHERE line_text LIKE ?"
                count_params = [f'%{query}%']
                if game_filter:
                    count_query += " AND game_name = ?"
                    count_params.append(game_filter)
                
                total_results = GameLinesTable._db.fetchone(count_query, count_params)[0]
                
                # Add pagination
                offset = (page - 1) * page_size
                base_query += f" LIMIT ? OFFSET ?"
                params.extend([page_size, offset])
                
                # Execute search query
                rows = GameLinesTable._db.fetchall(base_query, params)
                
                # Format results
                results = []
                for row in rows:
                    game_line = GameLinesTable.from_row(row)
                    if game_line:
                        results.append({
                            'id': game_line.id,
                            'sentence': game_line.line_text or '',
                            'game_name': game_line.game_name or 'Unknown Game',
                            'timestamp': float(game_line.timestamp) if game_line.timestamp else 0,
                            'translation': game_line.translation or None,
                            'has_audio': bool(game_line.audio_path),
                            'has_screenshot': bool(game_line.screenshot_path)
                        })
                
                return jsonify({
                    'results': results,
                    'total': total_results,
                    'page': page,
                    'page_size': page_size,
                    'total_pages': (total_results + page_size - 1) // page_size
                }), 200
            
        except ValueError as e:
            return jsonify({'error': 'Invalid pagination parameters'}), 400
        except Exception as e:
            logger.error(f"Error in sentence search: {e}")
            return jsonify({'error': 'Search failed'}), 500

    @app.route('/api/games-list')
    def api_games_list():
        """
        Provides game list with metadata for deletion interface.
        """
        try:
            game_names = GameLinesTable.get_all_games_with_lines()
            games_data = []
            
            for game_name in game_names:
                lines = GameLinesTable.get_all_lines_for_scene(game_name)
                if not lines:
                    continue
                    
                # Calculate metadata
                sentence_count = len(lines)
                timestamps = [float(line.timestamp) for line in lines]
                min_date = datetime.date.fromtimestamp(min(timestamps))
                max_date = datetime.date.fromtimestamp(max(timestamps))
                total_chars = sum(len(line.line_text) if line.line_text else 0 for line in lines)
                
                games_data.append({
                    'name': game_name,
                    'sentence_count': sentence_count,
                    'first_entry_date': min_date.strftime('%Y-%m-%d'),
                    'last_entry_date': max_date.strftime('%Y-%m-%d'),
                    'total_characters': total_chars,
                    'date_range': f"{min_date.strftime('%Y-%m-%d')} to {max_date.strftime('%Y-%m-%d')}" if min_date != max_date else min_date.strftime('%Y-%m-%d')
                })
            
            # Sort by total characters (most characters first)
            games_data.sort(key=lambda x: x['total_characters'], reverse=True)
            
            return jsonify({'games': games_data}), 200
            
        except Exception as e:
            logger.error(f"Error fetching games list: {e}", exc_info=True)
            return jsonify({'error': 'Failed to fetch games list'}), 500

    @app.route('/api/delete-sentence-lines', methods=['POST'])
    def api_delete_sentence_lines():
        """
        Delete specific sentence lines by their IDs.
        """
        try:
            data = request.get_json()
            line_ids = data.get('line_ids', [])
            
            logger.debug(f"Request to delete line IDs: {line_ids}")
            
            if not line_ids:
                return jsonify({'error': 'No line IDs provided'}), 400
            
            if not isinstance(line_ids, list):
                return jsonify({'error': 'line_ids must be a list'}), 400
            
            # Delete the lines
            deleted_count = 0
            failed_ids = []
            
            for line_id in line_ids:
                try:
                    GameLinesTable._db.execute(
                        f"DELETE FROM {GameLinesTable._table} WHERE id=?",
                        (line_id,),
                        commit=True
                    )
                    deleted_count += 1
                except Exception as e:
                    logger.warning(f"Failed to delete line {line_id}: {e}")
                    failed_ids.append(line_id)
            
            logger.info(f"Deleted {deleted_count} sentence lines out of {len(line_ids)} requested")
            
            response_data = {
                'deleted_count': deleted_count,
                'message': f'Successfully deleted {deleted_count} {"sentence" if deleted_count == 1 else "sentences"}'
            }
            
            if failed_ids:
                response_data['warning'] = f'{len(failed_ids)} lines failed to delete'
                response_data['failed_ids'] = failed_ids
            
            return jsonify(response_data), 200
            
        except Exception as e:
            logger.error(f"Error in sentence line deletion: {e}")
            return jsonify({'error': f'Failed to delete sentences: {str(e)}'}), 500

    @app.route('/api/delete-games', methods=['POST'])
    def api_delete_games():
        """
        Handles bulk deletion of games and their associated data.
        """
        try:
            data = request.get_json()
            game_names = data.get('game_names', [])
            
            if not game_names:
                return jsonify({'error': 'No games specified for deletion'}), 400
            
            if not isinstance(game_names, list):
                return jsonify({'error': 'game_names must be a list'}), 400
            
            # Validate that all games exist
            existing_games = GameLinesTable.get_all_games_with_lines()
            invalid_games = [name for name in game_names if name not in existing_games]
            
            if invalid_games:
                return jsonify({'error': f'Games not found: {", ".join(invalid_games)}'}), 400
            
            deletion_results = {}
            total_deleted = 0
            
            # Delete each game's data
            for game_name in game_names:
                try:
                    # Get lines for this game before deletion for counting
                    lines = GameLinesTable.get_all_lines_for_scene(game_name)
                    lines_count = len(lines)
                    
                    # Delete all lines for this game using the database connection
                    GameLinesTable._db.execute(
                        f"DELETE FROM {GameLinesTable._table} WHERE game_name=?",
                        (game_name,),
                        commit=True
                    )
                    
                    deletion_results[game_name] = {
                        'deleted_sentences': lines_count,
                        'status': 'success'
                    }
                    total_deleted += lines_count
                    
                    logger.info(f"Deleted {lines_count} sentences for game: {game_name}")
                    
                except Exception as e:
                    logger.error(f"Error deleting game {game_name}: {e}")
                    deletion_results[game_name] = {
                        'deleted_sentences': 0,
                        'status': 'error',
                        'error': str(e)
                    }
            
            # Check if any deletions were successful
            successful_deletions = [name for name, result in deletion_results.items() if result['status'] == 'success']
            failed_deletions = [name for name, result in deletion_results.items() if result['status'] == 'error']
            
            response_data = {
                'message': f'Deletion completed. {len(successful_deletions)} games successfully deleted.',
                'total_sentences_deleted': total_deleted,
                'successful_games': successful_deletions,
                'failed_games': failed_deletions,
                'detailed_results': deletion_results
            }
            
            if failed_deletions:
                response_data['warning'] = f'Some games failed to delete: {", ".join(failed_deletions)}'
                return jsonify(response_data), 207  # Multi-Status (partial success)
            else:
                return jsonify(response_data), 200
                
        except Exception as e:
            logger.error(f"Error in bulk game deletion: {e}")
            return jsonify({'error': f'Failed to delete games: {str(e)}'}), 500

    @app.route('/api/settings', methods=['GET'])
    def api_get_settings():
        """
        Get current AFK timer, session gap, streak requirement, and goal settings.
        """
        try:
            config = get_stats_config()
            return jsonify({
                'afk_timer_seconds': config.afk_timer_seconds,
                'session_gap_seconds': config.session_gap_seconds,
                'streak_requirement_hours': config.streak_requirement_hours,
                'reading_hours_target': config.reading_hours_target,
                'character_count_target': config.character_count_target,
                'games_target': config.games_target,
                'reading_hours_target_date': config.reading_hours_target_date,
                'character_count_target_date': config.character_count_target_date,
                'games_target_date': config.games_target_date,
            }), 200
        except Exception as e:
            logger.error(f"Error getting settings: {e}")
            return jsonify({'error': 'Failed to get settings'}), 500

    @app.route('/api/settings', methods=['POST'])
    def api_save_settings():
        """
        Save/update AFK timer, session gap, streak requirement, and goal settings.
        """
        try:
            data = request.get_json()
            
            if not data:
                return jsonify({'error': 'No data provided'}), 400
            
            afk_timer = data.get('afk_timer_seconds')
            session_gap = data.get('session_gap_seconds')
            streak_requirement = data.get('streak_requirement_hours')
            reading_hours_target = data.get('reading_hours_target')
            character_count_target = data.get('character_count_target')
            games_target = data.get('games_target')
            reading_hours_target_date = data.get('reading_hours_target_date')
            character_count_target_date = data.get('character_count_target_date')
            games_target_date = data.get('games_target_date')
            
            # Validate input - only require the settings that are provided
            settings_to_update = {}
            
            if afk_timer is not None:
                try:
                    afk_timer = int(afk_timer)
                    if afk_timer < 0 or afk_timer > 600:
                        return jsonify({'error': 'AFK timer must be between 0 and 600 seconds'}), 400
                    settings_to_update['afk_timer_seconds'] = afk_timer
                except (ValueError, TypeError):
                    return jsonify({'error': 'AFK timer must be a valid integer'}), 400
            
            if session_gap is not None:
                try:
                    session_gap = int(session_gap)
                    if session_gap < 0 or session_gap > 7200:
                        return jsonify({'error': 'Session gap must be between 0 and 7200 seconds (0 to 2 hours)'}), 400
                    settings_to_update['session_gap_seconds'] = session_gap
                except (ValueError, TypeError):
                    return jsonify({'error': 'Session gap must be a valid integer'}), 400
            
            if streak_requirement is not None:
                try:
                    streak_requirement = float(streak_requirement)
                    if streak_requirement < 0.01 or streak_requirement > 24:
                        return jsonify({'error': 'Streak requirement must be between 0.01 and 24 hours'}), 400
                    settings_to_update['streak_requirement_hours'] = streak_requirement
                except (ValueError, TypeError):
                    return jsonify({'error': 'Streak requirement must be a valid number'}), 400
            
            if reading_hours_target is not None:
                try:
                    reading_hours_target = int(reading_hours_target)
                    if reading_hours_target < 1 or reading_hours_target > 10000:
                        return jsonify({'error': 'Reading hours target must be between 1 and 10,000 hours'}), 400
                    settings_to_update['reading_hours_target'] = reading_hours_target
                except (ValueError, TypeError):
                    return jsonify({'error': 'Reading hours target must be a valid integer'}), 400
            
            if character_count_target is not None:
                try:
                    character_count_target = int(character_count_target)
                    if character_count_target < 1000 or character_count_target > 1000000000:
                        return jsonify({'error': 'Character count target must be between 1,000 and 1,000,000,000 characters'}), 400
                    settings_to_update['character_count_target'] = character_count_target
                except (ValueError, TypeError):
                    return jsonify({'error': 'Character count target must be a valid integer'}), 400
            
            if games_target is not None:
                try:
                    games_target = int(games_target)
                    if games_target < 1 or games_target > 1000:
                        return jsonify({'error': 'Games target must be between 1 and 1,000'}), 400
                    settings_to_update['games_target'] = games_target
                except (ValueError, TypeError):
                    return jsonify({'error': 'Games target must be a valid integer'}), 400
            
            # Validate target dates (ISO format: YYYY-MM-DD)
            if reading_hours_target_date is not None:
                if reading_hours_target_date == '':
                    settings_to_update['reading_hours_target_date'] = ''
                else:
                    try:
                        datetime.datetime.strptime(reading_hours_target_date, '%Y-%m-%d')
                        settings_to_update['reading_hours_target_date'] = reading_hours_target_date
                    except ValueError:
                        return jsonify({'error': 'Reading hours target date must be in YYYY-MM-DD format'}), 400
            
            if character_count_target_date is not None:
                if character_count_target_date == '':
                    settings_to_update['character_count_target_date'] = ''
                else:
                    try:
                        datetime.datetime.strptime(character_count_target_date, '%Y-%m-%d')
                        settings_to_update['character_count_target_date'] = character_count_target_date
                    except ValueError:
                        return jsonify({'error': 'Character count target date must be in YYYY-MM-DD format'}), 400
            
            if games_target_date is not None:
                if games_target_date == '':
                    settings_to_update['games_target_date'] = ''
                else:
                    try:
                        datetime.datetime.strptime(games_target_date, '%Y-%m-%d')
                        settings_to_update['games_target_date'] = games_target_date
                    except ValueError:
                        return jsonify({'error': 'Games target date must be in YYYY-MM-DD format'}), 400
            
            if not settings_to_update:
                return jsonify({'error': 'No valid settings provided'}), 400
            
            # Update configuration
            config = get_stats_config()
            
            if 'afk_timer_seconds' in settings_to_update:
                config.afk_timer_seconds = settings_to_update['afk_timer_seconds']
            if 'session_gap_seconds' in settings_to_update:
                config.session_gap_seconds = settings_to_update['session_gap_seconds']
            if 'streak_requirement_hours' in settings_to_update:
                config.streak_requirement_hours = settings_to_update['streak_requirement_hours']
            if 'reading_hours_target' in settings_to_update:
                config.reading_hours_target = settings_to_update['reading_hours_target']
            if 'character_count_target' in settings_to_update:
                config.character_count_target = settings_to_update['character_count_target']
            if 'games_target' in settings_to_update:
                config.games_target = settings_to_update['games_target']
            if 'reading_hours_target_date' in settings_to_update:
                config.reading_hours_target_date = settings_to_update['reading_hours_target_date']
            if 'character_count_target_date' in settings_to_update:
                config.character_count_target_date = settings_to_update['character_count_target_date']
            if 'games_target_date' in settings_to_update:
                config.games_target_date = settings_to_update['games_target_date']
            
            save_stats_config(config)

            logger.info(f"Settings updated: {settings_to_update}")
            
            response_data = {'message': 'Settings saved successfully'}
            response_data.update(settings_to_update)
            
            return jsonify(response_data), 200
            
        except Exception as e:
            logger.error(f"Error saving settings: {e}")
            return jsonify({'error': 'Failed to save settings'}), 500


    @app.route('/api/preview-text-deletion', methods=['POST'])
    def api_preview_text_deletion():
        """
        Preview text lines that would be deleted based on regex or exact text matching.
        """
        try:
            data = request.get_json()
            if not data:
                return jsonify({'error': 'No data provided'}), 400
            
            regex_pattern = data.get('regex_pattern')
            exact_text = data.get('exact_text')
            case_sensitive = data.get('case_sensitive', False)
            use_regex = data.get('use_regex', False)
            
            if not regex_pattern and not exact_text:
                return jsonify({'error': 'Either regex_pattern or exact_text must be provided'}), 400
            
            # Get all lines from database
            all_lines = GameLinesTable.all()
            if not all_lines:
                return jsonify({'count': 0, 'samples': []}), 200
            
            matches = []
            
            if regex_pattern and use_regex:
                # Use regex matching
                try:
                    # Ensure regex_pattern is a string
                    if not isinstance(regex_pattern, str):
                        return jsonify({'error': 'Regex pattern must be a string'}), 400
                        
                    flags = 0 if case_sensitive else re.IGNORECASE
                    pattern = re.compile(regex_pattern, flags)
                    
                    for line in all_lines:
                        if line.line_text and isinstance(line.line_text, str) and pattern.search(line.line_text):
                            matches.append(line.line_text)
                            
                except re.error as e:
                    return jsonify({'error': f'Invalid regex pattern: {str(e)}'}), 400
                    
            elif exact_text:
                # Use exact text matching - ensure exact_text is properly handled
                if isinstance(exact_text, list):
                    text_lines = exact_text
                elif isinstance(exact_text, str):
                    text_lines = [exact_text]
                else:
                    return jsonify({'error': 'exact_text must be a string or list of strings'}), 400
                
                for line in all_lines:
                    if line.line_text and isinstance(line.line_text, str):
                        line_text = line.line_text if case_sensitive else line.line_text.lower()
                        
                        for target_text in text_lines:
                            # Ensure target_text is a string
                            if not isinstance(target_text, str):
                                continue
                            compare_text = target_text if case_sensitive else target_text.lower()
                            if compare_text in line_text:
                                matches.append(line.line_text)
                                break
            
            # Remove duplicates while preserving order
            unique_matches = []
            seen = set()
            for match in matches:
                if match not in seen:
                    unique_matches.append(match)
                    seen.add(match)
            
            # Get sample matches (first 10)
            samples = unique_matches[:10]
            
            return jsonify({
                'count': len(unique_matches),
                'samples': samples
            }), 200
            
        except Exception as e:
            logger.error(f"Error in preview text deletion: {e}")
            return jsonify({'error': f'Preview failed: {str(e)}'}), 500

    @app.route('/api/delete-text-lines', methods=['POST'])
    def api_delete_text_lines():
        """
        Delete text lines from database based on regex or exact text matching.
        """
        try:
            data = request.get_json()
            if not data:
                return jsonify({'error': 'No data provided'}), 400
            
            regex_pattern = data.get('regex_pattern')
            exact_text = data.get('exact_text')
            case_sensitive = data.get('case_sensitive', False)
            use_regex = data.get('use_regex', False)
            
            if not regex_pattern and not exact_text:
                return jsonify({'error': 'Either regex_pattern or exact_text must be provided'}), 400
            
            # Get all lines from database
            all_lines = GameLinesTable.all()
            if not all_lines:
                return jsonify({'deleted_count': 0}), 200
            
            lines_to_delete = []
            
            if regex_pattern and use_regex:
                # Use regex matching
                try:
                    # Ensure regex_pattern is a string
                    if not isinstance(regex_pattern, str):
                        return jsonify({'error': 'Regex pattern must be a string'}), 400
                        
                    flags = 0 if case_sensitive else re.IGNORECASE
                    pattern = re.compile(regex_pattern, flags)
                    
                    for line in all_lines:
                        if line.line_text and isinstance(line.line_text, str) and pattern.search(line.line_text):
                            lines_to_delete.append(line.id)
                            
                except re.error as e:
                    return jsonify({'error': f'Invalid regex pattern: {str(e)}'}), 400
                    
            elif exact_text:
                # Use exact text matching - ensure exact_text is properly handled
                if isinstance(exact_text, list):
                    text_lines = exact_text
                elif isinstance(exact_text, str):
                    text_lines = [exact_text]
                else:
                    return jsonify({'error': 'exact_text must be a string or list of strings'}), 400
                
                for line in all_lines:
                    if line.line_text and isinstance(line.line_text, str):
                        line_text = line.line_text if case_sensitive else line.line_text.lower()
                        
                        for target_text in text_lines:
                            # Ensure target_text is a string
                            if not isinstance(target_text, str):
                                continue
                            compare_text = target_text if case_sensitive else target_text.lower()
                            if compare_text in line_text:
                                lines_to_delete.append(line.id)
                                break
            
            # Delete the matching lines
            deleted_count = 0
            for line_id in set(lines_to_delete):  # Remove duplicates
                try:
                    GameLinesTable._db.execute(
                        f"DELETE FROM {GameLinesTable._table} WHERE id=?",
                        (line_id,),
                        commit=True
                    )
                    deleted_count += 1
                except Exception as e:
                    logger.warning(f"Failed to delete line {line_id}: {e}")
            
            logger.info(f"Deleted {deleted_count} lines using pattern: {regex_pattern or exact_text}")
            
            return jsonify({
                'deleted_count': deleted_count,
                'message': f'Successfully deleted {deleted_count} lines'
            }), 200
            
        except Exception as e:
            logger.error(f"Error in delete text lines: {e}")
            return jsonify({'error': f'Deletion failed: {str(e)}'}), 500

    @app.route('/api/preview-deduplication', methods=['POST'])
    def api_preview_deduplication():
        """
        Preview duplicate sentences that would be removed based on time window and game selection.
        Supports ignore_time_window parameter to find all duplicates regardless of time.
        """
        try:
            data = request.get_json()
            if not data:
                return jsonify({'error': 'No data provided'}), 400
            
            games = data.get('games', [])
            time_window_minutes = data.get('time_window_minutes', 5)
            case_sensitive = data.get('case_sensitive', False)
            ignore_time_window = data.get('ignore_time_window', False)
            
            if not games:
                return jsonify({'error': 'At least one game must be selected'}), 400
            
            # Get lines from selected games
            if 'all' in games:
                all_lines = GameLinesTable.all()
            else:
                all_lines = []
                for game_name in games:
                    game_lines = GameLinesTable.get_all_lines_for_scene(game_name)
                    all_lines.extend(game_lines)
            
            if not all_lines:
                return jsonify({'duplicates_count': 0, 'games_affected': 0, 'samples': []}), 200
            
            # Group lines by game and sort by timestamp
            game_lines = defaultdict(list)
            for line in all_lines:
                game_name = line.game_name or "Unknown Game"
                game_lines[game_name].append(line)
            
            # Sort lines within each game by timestamp
            for game_name in game_lines:
                game_lines[game_name].sort(key=lambda x: float(x.timestamp))
            
            duplicates_to_remove = []
            duplicate_samples = {}
            time_window_seconds = time_window_minutes * 60
            
            # Find duplicates for each game
            for game_name, lines in game_lines.items():
                if ignore_time_window:
                    # Find all duplicates regardless of time
                    seen_texts = {}
                    for line in lines:
                        if not line.line_text or not line.line_text.strip():
                            continue
                            
                        line_text = line.line_text if case_sensitive else line.line_text.lower()
                        
                        if line_text in seen_texts:
                            # Found duplicate
                            duplicates_to_remove.append(line.id)
                            
                            # Store sample for preview
                            if line_text not in duplicate_samples:
                                duplicate_samples[line_text] = {
                                    'text': line.line_text,  # Original case
                                    'occurrences': 1
                                }
                            duplicate_samples[line_text]['occurrences'] += 1
                        else:
                            seen_texts[line_text] = line.id
                else:
                    # Find duplicates within time window (original logic)
                    text_timeline = []
                    
                    for line in lines:
                        if not line.line_text or not line.line_text.strip():
                            continue
                            
                        line_text = line.line_text if case_sensitive else line.line_text.lower()
                        timestamp = float(line.timestamp)
                        
                        # Check for duplicates within time window
                        for prev_text, prev_timestamp, prev_line_id in reversed(text_timeline):
                            if timestamp - prev_timestamp > time_window_seconds:
                                break  # Outside time window
                                
                            if prev_text == line_text:
                                # Found duplicate within time window
                                duplicates_to_remove.append(line.id)
                                
                                # Store sample for preview
                                if line_text not in duplicate_samples:
                                    duplicate_samples[line_text] = {
                                        'text': line.line_text,  # Original case
                                        'occurrences': 1
                                    }
                                duplicate_samples[line_text]['occurrences'] += 1
                                break
                        
                        text_timeline.append((line_text, timestamp, line.id))
            
            # Calculate statistics
            duplicates_count = len(duplicates_to_remove)
            games_affected = len([game for game in game_lines.keys() if any(
                line.id in duplicates_to_remove for line in game_lines[game]
            )])
            
            # Get sample duplicates
            samples = list(duplicate_samples.values())[:10]
            
            return jsonify({
                'duplicates_count': duplicates_count,
                'games_affected': games_affected,
                'samples': samples
            }), 200
            
        except Exception as e:
            logger.error(f"Error in preview deduplication: {e}")
            return jsonify({'error': f'Preview failed: {str(e)}'}), 500

    @app.route('/api/deduplicate', methods=['POST'])
    def api_deduplicate():
        """
        Remove duplicate sentences from database based on time window and game selection.
        Supports ignore_time_window parameter to remove all duplicates regardless of time.
        """
        try:
            data = request.get_json()
            if not data:
                return jsonify({'error': 'No data provided'}), 400
            
            games = data.get('games', [])
            time_window_minutes = data.get('time_window_minutes', 5)
            case_sensitive = data.get('case_sensitive', False)
            preserve_newest = data.get('preserve_newest', False)
            ignore_time_window = data.get('ignore_time_window', False)
            
            if not games:
                return jsonify({'error': 'At least one game must be selected'}), 400
            
            # Get lines from selected games
            if 'all' in games:
                all_lines = GameLinesTable.all()
            else:
                all_lines = []
                for game_name in games:
                    game_lines = GameLinesTable.get_all_lines_for_scene(game_name)
                    all_lines.extend(game_lines)
            
            if not all_lines:
                return jsonify({'deleted_count': 0}), 200
            
            # Group lines by game and sort by timestamp
            game_lines = defaultdict(list)
            for line in all_lines:
                game_name = line.game_name or "Unknown Game"
                game_lines[game_name].append(line)
            
            # Sort lines within each game by timestamp
            for game_name in game_lines:
                game_lines[game_name].sort(key=lambda x: float(x.timestamp))
            
            duplicates_to_remove = []
            time_window_seconds = time_window_minutes * 60
            
            # Find duplicates for each game
            for game_name, lines in game_lines.items():
                if ignore_time_window:
                    # Find all duplicates regardless of time
                    seen_texts = {}
                    for line in lines:
                        if not line.line_text or not line.line_text.strip():
                            continue
                            
                        line_text = line.line_text if case_sensitive else line.line_text.lower()
                        
                        if line_text in seen_texts:
                            # Found duplicate
                            if preserve_newest:
                                # Remove the older one (previous)
                                duplicates_to_remove.append(seen_texts[line_text])
                                seen_texts[line_text] = line.id  # Update to keep newest
                            else:
                                # Remove the newer one (current)
                                duplicates_to_remove.append(line.id)
                        else:
                            seen_texts[line_text] = line.id
                else:
                    # Find duplicates within time window (original logic)
                    text_timeline = []
                    
                    for line in lines:
                        if not line.line_text or not line.line_text.strip():
                            continue
                            
                        line_text = line.line_text if case_sensitive else line.line_text.lower()
                        timestamp = float(line.timestamp)
                        
                        # Check for duplicates within time window
                        duplicate_found = False
                        for i, (prev_text, prev_timestamp, prev_line_id) in enumerate(reversed(text_timeline)):
                            if timestamp - prev_timestamp > time_window_seconds:
                                break  # Outside time window
                                
                            if prev_text == line_text:
                                # Found duplicate within time window
                                if preserve_newest:
                                    # Remove the older one (previous)
                                    duplicates_to_remove.append(prev_line_id)
                                    # Update timeline to replace old entry with new one
                                    timeline_index = len(text_timeline) - 1 - i
                                    text_timeline[timeline_index] = (line_text, timestamp, line.id)
                                else:
                                    # Remove the newer one (current)
                                    duplicates_to_remove.append(line.id)
                                
                                duplicate_found = True
                                break
                        
                        if not duplicate_found:
                            text_timeline.append((line_text, timestamp, line.id))
            
            # Delete the duplicate lines
            deleted_count = 0
            for line_id in set(duplicates_to_remove):  # Remove duplicates from deletion list
                try:
                    GameLinesTable._db.execute(
                        f"DELETE FROM {GameLinesTable._table} WHERE id=?",
                        (line_id,),
                        commit=True
                    )
                    deleted_count += 1
                except Exception as e:
                    logger.warning(f"Failed to delete duplicate line {line_id}: {e}")
            
            mode_desc = "entire game" if ignore_time_window else f"{time_window_minutes}min window"
            logger.info(f"Deduplication completed: removed {deleted_count} duplicate sentences from {len(games)} games with {mode_desc}")
            
            return jsonify({
                'deleted_count': deleted_count,
                'message': f'Successfully removed {deleted_count} duplicate sentences'
            }), 200
            
        except Exception as e:
            logger.error(f"Error in deduplication: {e}")
            return jsonify({'error': f'Deduplication failed: {str(e)}'}), 500

    @app.route('/api/deduplicate-entire-game', methods=['POST'])
    def api_deduplicate_entire_game():
        """
        Remove duplicate sentences from database across entire games without time window restrictions.
        This is a convenience endpoint that calls the main deduplicate function with ignore_time_window=True.
        """
        try:
            data = request.get_json()
            if not data:
                return jsonify({'error': 'No data provided'}), 400
            
            # Add ignore_time_window=True to the request data
            data['ignore_time_window'] = True
            
            # Call the main deduplication function
            return api_deduplicate()
            
        except Exception as e:
            logger.error(f"Error in entire game deduplication: {e}")
            return jsonify({'error': f'Entire game deduplication failed: {str(e)}'}), 500

    @app.route('/api/merge_games', methods=['POST'])
    def api_merge_games():
        """
        Merges multiple selected games into a single game entry.
        The first game in the list becomes the primary game that retains its name.
        All lines from secondary games are moved to the primary game.
        """
        try:
            data = request.get_json()
            target_game = data.get('target_game', None)
            games_to_merge = data.get('games_to_merge', [])
            
            logger.info(f"Merge request received: target_game='{target_game}', games_to_merge={games_to_merge}")
            
            # Validation
            if not target_game:
                return jsonify({'error': 'No target game specified for merging'}), 400

            if not games_to_merge:
                return jsonify({'error': 'No games specified for merging'}), 400
            
            if not isinstance(games_to_merge, list):
                return jsonify({'error': 'game_names must be a list'}), 400
                
            if len(games_to_merge) < 1:
                return jsonify({'error': 'At least 1 game must be selected for merging'}), 400

            # Validate that all games exist
            existing_games = GameLinesTable.get_all_games_with_lines()
            invalid_games = [name for name in games_to_merge if name not in existing_games]
            
            if invalid_games:
                return jsonify({'error': f'Games not found: {", ".join(invalid_games)}'}), 400
            
            # Check for duplicate game names
            if len(set(games_to_merge)) != len(games_to_merge):
                return jsonify({'error': 'Duplicate game names found in selection'}), 400
            
            # Identify primary and secondary games

            # Collect pre-merge statistics
            primary_lines_before = GameLinesTable.get_all_lines_for_scene(target_game)
            total_lines_to_merge = 0
            merge_summary = {
                'primary_game': target_game,
                'secondary_games': games_to_merge,
                'lines_moved': 0,
                'total_lines_after_merge': 0
            }
            
            # Calculate lines to be moved and store counts
            secondary_game_line_counts = {}
            for game_name in games_to_merge:
                secondary_lines = GameLinesTable.get_all_lines_for_scene(game_name)
                line_count = len(secondary_lines)
                secondary_game_line_counts[game_name] = line_count
                total_lines_to_merge += line_count
            
            if total_lines_to_merge == 0:
                return jsonify({'error': 'No lines found in secondary games to merge'}), 400
            
            # Begin database transaction for merge
            try:
                # Perform the merge operation within transaction
                lines_moved = 0
                for game_name in games_to_merge:
                    # Update game_name for all lines belonging to this secondary game
                    # Also set original_game_name to preserve the original title
                    # Ensure the table name is as expected to prevent SQL injection
                    if GameLinesTable._table != "game_lines":
                        raise ValueError("Unexpected table name in GameLinesTable._table")
                    GameLinesTable._db.execute(
                        "UPDATE game_lines SET game_name=?, original_game_name=COALESCE(original_game_name, ?) WHERE game_name=?",
                        (target_game, game_name, game_name),
                        commit=True
                    )
                    
                    # Add the count we calculated earlier
                    lines_moved += secondary_game_line_counts[game_name]
                
                # Update merge summary
                merge_summary['lines_moved'] = lines_moved
                merge_summary['total_lines_after_merge'] = len(primary_lines_before) + lines_moved
                
                # Log the successful merge
                logger.info(f"Successfully merged {len(games_to_merge)} games into '{target_game}': moved {lines_moved} lines")

                # Prepare success response
                response_data = {
                    'message': f'Successfully merged {len(games_to_merge)} games into "{target_game}"',
                    'primary_game': target_game,
                    'merged_games': games_to_merge,
                    'lines_moved': lines_moved,
                    'total_lines_in_primary': merge_summary['total_lines_after_merge'],
                    'merge_summary': merge_summary
                }
                
                return jsonify(response_data), 200
                
            except Exception as db_error:
                logger.error(f"Database error during game merge: {db_error}", exc_info=True)
                return jsonify({
                    'error': f'Failed to merge games due to database error: {str(db_error)}'
                }), 500
                
        except Exception as e:
            logger.error(f"Error in game merge API: {e}")
            return jsonify({'error': f'Game merge failed: {str(e)}'}), 500

    @app.route('/api/stats')
    def api_stats():
        """
        Provides aggregated, cumulative stats for charting.
        Accepts optional 'year' parameter to filter heatmap data.
        """
        try:
            # Get optional year filter parameter
            filter_year = request.args.get('year', None)

            # Get Start and End time as unix timestamp
            start_timestamp = request.args.get('start', None)
            end_timestamp = request.args.get('end', None)
            
            # Convert timestamps to float if provided
            start_timestamp = float(start_timestamp) if start_timestamp else None
            end_timestamp = float(end_timestamp) if end_timestamp else None

            # 1. Fetch all lines and sort them chronologically
            all_lines = GameLinesTable.get_lines_filtered_by_timestamp(start=start_timestamp, end=end_timestamp, for_stats=True)
            
            if not all_lines:
                return jsonify({"labels": [], "datasets": []})

            # 1.5. Build a mapping of game_name -> display_name (title_original if available)
            from GameSentenceMiner.util.games_table import GamesTable
            game_name_to_display = {}
            unique_game_names = set(line.game_name or "Unknown Game" for line in all_lines)
            
            for game_name in unique_game_names:
                # Find any line with this game_name to get game_id
                sample_line = next((line for line in all_lines if (line.game_name or "Unknown Game") == game_name), None)
                if sample_line:
                    game_metadata = GamesTable.get_by_game_line(sample_line)
                    if game_metadata and game_metadata.title_original:
                        game_name_to_display[game_name] = game_metadata.title_original
                    else:
                        game_name_to_display[game_name] = game_name

            # 2. Process data into daily totals for each game (using display names)
            # Structure: daily_data[date_str][display_name] = {'lines': N, 'chars': N}
            daily_data = defaultdict(lambda: defaultdict(lambda: {'lines': 0, 'chars': 0}))
            wrong_instance_found = False
            for line in all_lines:
                day_str = datetime.date.fromtimestamp(float(line.timestamp)).strftime('%Y-%m-%d')
                game_name = line.game_name or "Unknown Game"
                display_name = game_name_to_display.get(game_name, game_name)
                # Remove punctuation and symbols from line text before counting characters
                if not isinstance(line.line_text, str) and not wrong_instance_found:
                    logger.info(f"Non-string line_text encountered: {line.line_text} (type: {type(line.line_text)})")
                    wrong_instance_found = True

                daily_data[day_str][display_name]['lines'] += 1
                daily_data[day_str][display_name]['chars'] += len(line.line_text)

            # 3. Create cumulative datasets for Chart.js
            sorted_days = sorted(daily_data.keys())
            # Use display names instead of raw game_names
            display_names = sorted(set(game_name_to_display.values()))
            
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
                kanji_grid_data = calculate_kanji_frequency(all_lines)
            except Exception as e:
                logger.error(f"Error calculating kanji frequency: {e}")
                kanji_grid_data = []
                
            try:
                heatmap_data = calculate_heatmap_data(all_lines, filter_year)
            except Exception as e:
                logger.error(f"Error calculating heatmap data: {e}")
                heatmap_data = []
                
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
                all_games_stats = calculate_all_games_stats(all_lines)
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

            # 8. Calculate hourly activity pattern
            try:
                hourly_activity_data = calculate_hourly_activity(all_lines)
            except Exception as e:
                logger.error(f"Error calculating hourly activity: {e}")
                hourly_activity_data = [0] * 24

            # 8.5. Calculate hourly reading speed pattern
            try:
                hourly_reading_speed_data = calculate_hourly_reading_speed(all_lines)
            except Exception as e:
                logger.error(f"Error calculating hourly reading speed: {e}")
                hourly_reading_speed_data = [0] * 24

            # 9. Calculate peak statistics
            try:
                peak_daily_stats = calculate_peak_daily_stats(all_lines)
            except Exception as e:
                logger.error(f"Error calculating peak daily stats: {e}")
                peak_daily_stats = {'max_daily_chars': 0, 'max_daily_hours': 0.0}
                
            try:
                peak_session_stats = calculate_peak_session_stats(all_lines)
            except Exception as e:
                logger.error(f"Error calculating peak session stats: {e}")
                peak_session_stats = {'longest_session_hours': 0.0, 'max_session_chars': 0}

            # 10. Calculate game milestones (oldest/newest by release year)
            try:
                game_milestones = calculate_game_milestones(all_lines)
            except Exception as e:
                logger.error(f"Error calculating game milestones: {e}")
                game_milestones = None

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

    @app.route('/api/games-management', methods=['GET'])
    def api_games_management():
        """
        Get all games with their jiten.moe linking status and statistics.
        Automatically creates game records for orphaned game_lines.
        """
        try:
            from GameSentenceMiner.util.games_table import GamesTable
            
            # First, auto-create games for any orphaned game_lines
            # Get all distinct game names from game_lines
            game_names_from_lines = GameLinesTable._db.fetchall(
                f"SELECT DISTINCT game_name FROM {GameLinesTable._table} "
                f"WHERE game_name IS NOT NULL AND game_name != ''"
            )
            
            # Get existing game titles
            existing_games_rows = GamesTable._db.fetchall(
                f"SELECT title_original FROM {GamesTable._table}"
            )
            existing_titles = {row[0] for row in existing_games_rows}
            
            # Auto-create games for orphaned game_lines using get_or_create_by_name
            # This will reuse existing game_id mappings instead of creating duplicates
            for row in game_names_from_lines:
                game_name = row[0]
                if game_name not in existing_titles:
                    # Use get_or_create_by_name which checks for existing mappings
                    game = GamesTable.get_or_create_by_name(game_name)
                    
                    # Link any orphaned game_lines to this game
                    GameLinesTable._db.execute(
                        f"UPDATE {GameLinesTable._table} SET game_id = ? WHERE game_name = ? AND (game_id IS NULL OR game_id = '')",
                        (game.id, game_name),
                        commit=True
                    )
                    
                    logger.info(f"Auto-linked game_lines for: {game_name} -> game_id={game.id}")
                    existing_titles.add(game_name)
            
            # Get all games from the games table
            all_games = GamesTable.all()
            
            games_data = []
            for game in all_games:
                # Get line count and character count for this game
                lines = game.get_lines()
                line_count = len(lines)
                
                # Calculate actual mined character count from lines (don't store it)
                actual_char_count = sum(len(line.line_text) if line.line_text else 0 for line in lines)
                
                # Determine linking status
                is_linked = bool(game.deck_id)
                has_manual_overrides = len(game.manual_overrides) > 0
                
                # Get start and end dates
                start_date = GamesTable.get_start_date(game.id)
                last_played = GamesTable.get_last_played_date(game.id)
                
                games_data.append({
                    'id': game.id,
                    'title_original': game.title_original,
                    'title_romaji': game.title_romaji,
                    'title_english': game.title_english,
                    'type': game.type,
                    'description': game.description,
                    'image': game.image,
                    'deck_id': game.deck_id,
                    'difficulty': game.difficulty,
                    'completed': game.completed,
                    'is_linked': is_linked,
                    'has_manual_overrides': has_manual_overrides,
                    'manual_overrides': game.manual_overrides,
                    'line_count': line_count,
                    'mined_character_count': actual_char_count,  # Mined count (calculated from lines)
                    'jiten_character_count': game.character_count,  # Jiten total (from jiten.moe)
                    'start_date': start_date,
                    'last_played': last_played,
                    'links': game.links,
                    'release_date': game.release_date,  # Add release date to API response
                    'obs_scene_name': game.obs_scene_name if hasattr(game, 'obs_scene_name') else ''  # Add OBS scene name
                })
            
            # Sort by mined character count (most active games first)
            games_data.sort(key=lambda x: x['mined_character_count'], reverse=True)
            
            # Calculate summary statistics
            total_games = len(games_data)
            linked_games = sum(1 for game in games_data if game['is_linked'])
            unlinked_games = total_games - linked_games
            
            return jsonify({
                'games': games_data,
                'summary': {
                    'total_games': total_games,
                    'linked_games': linked_games,
                    'unlinked_games': unlinked_games
                }
            }), 200
            
        except Exception as e:
            logger.error(f"Error fetching games management data: {e}", exc_info=True)
            return jsonify({'error': 'Failed to fetch games data'}), 500

    @app.route('/api/jiten-search', methods=['GET'])
    def api_jiten_search():
        """
        Search jiten.moe media decks by title.
        """
        try:
            import requests
            
            title_filter = request.args.get('title', '').strip()
            if not title_filter:
                return jsonify({'error': 'Title parameter is required'}), 400
            
            # Call jiten.moe API
            jiten_url = 'https://api.jiten.moe/api/media-deck/get-media-decks'
            params = {
                'titleFilter': title_filter,
                'sortBy': 'title',
                'sortOrder': 0,
                'offset': 0
            }
            
            response = requests.get(jiten_url, params=params, timeout=10)
            
            if response.status_code != 200:
                return jsonify({'error': f'jiten.moe API returned status {response.status_code}'}), 500
            
            data = response.json()
            
            # Print FULL jiten.moe API response
            logger.info("=" * 80)
            logger.info("📋 FULL JITEN.MOE API RESPONSE (SEARCH)")
            logger.info("=" * 80)
            logger.info(json.dumps(data, indent=2, ensure_ascii=False))
            logger.info("=" * 80)
            
            # Process and format the results
            results = []
            for item in data.get('data', []):
                release_date = item.get('releaseDate', '')
                logger.info(f"🔍 Jiten search result for '{item.get('originalTitle', 'Unknown')}': release_date = '{release_date}' (type: {type(release_date)})")
                
                results.append({
                    'deck_id': item.get('deckId'),
                    'title_original': item.get('originalTitle', ''),
                    'title_romaji': item.get('romajiTitle', ''),
                    'title_english': item.get('englishTitle', ''),
                    'description': item.get('description', ''),
                    'cover_name': item.get('coverName', ''),
                    'media_type': item.get('mediaType'),
                    'character_count': item.get('characterCount', 0),  # Convert from camelCase to snake_case
                    'difficulty': item.get('difficulty', 0),
                    'difficulty_raw': item.get('difficultyRaw', 0),
                    'links': item.get('links', []),
                    'aliases': item.get('aliases', []),
                    'release_date': release_date
                })
            
            return jsonify({
                'results': results,
                'total_items': data.get('totalItems', 0)
            }), 200
            
        except requests.RequestException as e:
            logger.error(f"Error calling jiten.moe API: {e}")
            return jsonify({'error': 'Failed to search jiten.moe database'}), 500
        except Exception as e:
            logger.error(f"Error in jiten search: {e}")
            return jsonify({'error': 'Search failed'}), 500

    @app.route('/api/games/<game_id>/link-jiten', methods=['POST'])
    def api_link_game_to_jiten(game_id):
        """
        Link a game to jiten.moe data, respecting manual overrides.
        """
        try:
            from GameSentenceMiner.util.games_table import GamesTable
            import requests
            
            data = request.get_json()
            if not data:
                return jsonify({'error': 'No data provided'}), 400
            
            deck_id = data.get('deck_id')
            if not deck_id:
                return jsonify({'error': 'deck_id is required'}), 400
            
            # Get the game
            game = GamesTable.get(game_id)
            if not game:
                return jsonify({'error': 'Game not found'}), 404
            
            # Get jiten.moe data to ensure it's valid
            jiten_data = data.get('jiten_data', {})
            logger.info(f"🔍 Link-jiten API received jiten_data for game {game_id}: release_date = '{jiten_data.get('release_date', 'NOT_FOUND')}' (type: {type(jiten_data.get('release_date'))})")
            
            # Update game with jiten.moe data, respecting manual overrides
            update_fields = {}
            
            # Only update fields that are not manually overridden
            if 'deck_id' not in game.manual_overrides:
                update_fields['deck_id'] = deck_id
            
            if 'title_original' not in game.manual_overrides and jiten_data.get('title_original'):
                update_fields['title_original'] = jiten_data['title_original']
            
            if 'title_romaji' not in game.manual_overrides and jiten_data.get('title_romaji'):
                update_fields['title_romaji'] = jiten_data['title_romaji']
            
            if 'title_english' not in game.manual_overrides and jiten_data.get('title_english'):
                update_fields['title_english'] = jiten_data['title_english']
            
            if 'type' not in game.manual_overrides and jiten_data.get('media_type'):
                # Map media type to string
                media_type_map = {1: 'Anime', 7: 'Visual Novel', 2: 'Manga'}
                update_fields['game_type'] = media_type_map.get(jiten_data['media_type'], 'Unknown')
            
            if 'description' not in game.manual_overrides and jiten_data.get('description'):
                update_fields['description'] = jiten_data['description']
            
            if 'difficulty' not in game.manual_overrides and jiten_data.get('difficulty') is not None:
                difficulty_value = jiten_data['difficulty']
                logger.info(f"Setting difficulty for game {game_id}: {difficulty_value} (type: {type(difficulty_value)})")
                update_fields['difficulty'] = difficulty_value
            
            # Frontend sends snake_case (character_count) from the search endpoint
            if 'character_count' not in game.manual_overrides and jiten_data.get('character_count') is not None:
                logger.info(f"Setting character_count for game {game_id}: {jiten_data['character_count']}")
                update_fields['character_count'] = jiten_data['character_count']
            
            if 'links' not in game.manual_overrides and jiten_data.get('links'):
                update_fields['links'] = jiten_data['links']
            
            if 'release_date' not in game.manual_overrides and jiten_data.get('release_date'):
                logger.info(f"📅 Processing release_date for game {game_id}: '{jiten_data['release_date']}' (manual_overrides: {game.manual_overrides})")
                update_fields['release_date'] = jiten_data['release_date']
            else:
                logger.info(f"⏭️ Skipping release_date for game {game_id}: manual_override={('release_date' in game.manual_overrides)}, has_data={bool(jiten_data.get('release_date'))}")
            
            # Download and encode image if not manually overridden
            if 'image' not in game.manual_overrides and jiten_data.get('cover_name'):
                try:
                    import base64
                    img_response = requests.get(jiten_data['cover_name'], timeout=10)
                    if img_response.status_code == 200:
                        # Encode image to base64
                        img_base64 = base64.b64encode(img_response.content).decode('utf-8')
                        
                        # Detect image format from content-type header or magic bytes
                        content_type = img_response.headers.get('content-type', '').lower()
                        if 'png' in content_type:
                            mime_type = 'image/png'
                        elif 'jpeg' in content_type or 'jpg' in content_type:
                            mime_type = 'image/jpeg'
                        elif 'gif' in content_type:
                            mime_type = 'image/gif'
                        elif 'webp' in content_type:
                            mime_type = 'image/webp'
                        else:
                            # Fallback: detect from magic bytes
                            if img_base64.startswith('iVBOR'):
                                mime_type = 'image/png'
                            elif img_base64.startswith('/9j/'):
                                mime_type = 'image/jpeg'
                            elif img_base64.startswith('R0lGOD'):
                                mime_type = 'image/gif'
                            else:
                                # Default to JPEG if unknown
                                mime_type = 'image/jpeg'
                        
                        # Store with proper data URI prefix
                        update_fields['image'] = f'data:{mime_type};base64,{img_base64}'
                        logger.debug(f"Downloaded and encoded image for game {game_id} as {mime_type}")
                except Exception as img_error:
                    logger.warning(f"Failed to download image for game {game_id}: {img_error}")
            
            # CRITICAL FIX: Use obs_scene_name if available, otherwise query game_lines for actual game_name
            # The obs_scene_name field stores the immutable OBS scene name (e.g., "君と彼女と彼女の恋。　ver1.00")
            # After update_all_fields_from_jiten(), title_original will be the jiten title (e.g., "君と彼女と彼女の恋。")
            
            # First, try to get obs_scene_name from the game record
            obs_scene_name = game.obs_scene_name if hasattr(game, 'obs_scene_name') and game.obs_scene_name else None
            
            # If obs_scene_name is not set, query game_lines to find the actual game_name
            if not obs_scene_name:
                logger.info(f"📝 obs_scene_name not set for game {game_id}, querying game_lines...")
                result = GameLinesTable._db.fetchone(
                    f"SELECT DISTINCT game_name FROM {GameLinesTable._table} WHERE game_id = ? LIMIT 1",
                    (game_id,)
                )
                if result and result[0]:
                    obs_scene_name = result[0]
                    logger.info(f"📝 Found game_name from game_lines: '{obs_scene_name}'")
                    # Store it in obs_scene_name for future use
                    game.obs_scene_name = obs_scene_name
                else:
                    # Fallback to title_original (this is the old buggy behavior)
                    obs_scene_name = game.title_original
                    logger.warning(f"⚠️ Could not find game_name in game_lines for game_id={game_id}, falling back to title_original: '{obs_scene_name}'")
            else:
                logger.info(f"📝 Using existing obs_scene_name: '{obs_scene_name}'")
            
            # Update the game using the jiten update method (doesn't mark as manual)
            game.update_all_fields_from_jiten(**update_fields)
            logger.info(f"📝 After jiten update, title_original is now: '{game.title_original}', obs_scene_name: '{game.obs_scene_name}'")
            
            # Update ALL game_lines with the OBS scene name to point to this game_id
            # This creates the explicit mapping: OBS scene name -> game_id
            # When a user links a game to jiten.moe, they're saying "this OBS scene name maps to this jiten game"
            lines_updated = 0
            try:
                # Use the obs_scene_name (OBS scene name) to find and update game_lines
                # This will OVERWRITE any existing game_id values
                GameLinesTable._db.execute(
                    f"UPDATE {GameLinesTable._table} SET game_id = ? WHERE game_name = ?",
                    (game_id, obs_scene_name),
                    commit=True
                )
                
                # Count how many lines were updated
                updated_count = GameLinesTable._db.fetchone(
                    f"SELECT COUNT(*) FROM {GameLinesTable._table} WHERE game_id = ?",
                    (game_id,)
                )
                lines_updated = updated_count[0] if updated_count else 0
                logger.info(f"✓ Linked {lines_updated} game_lines with game_name='{obs_scene_name}' to game_id={game_id}")
                
            except Exception as link_error:
                logger.warning(f"Failed to update game_lines for game {game_id}: {link_error}")
            
            logger.info(f"Successfully linked game {game_id} to jiten.moe deck {deck_id}")
            
            return jsonify({
                'success': True,
                'message': f'Game linked to jiten.moe deck {deck_id}',
                'updated_fields': list(update_fields.keys()),
                'manual_overrides': game.manual_overrides,
                'lines_updated': lines_updated
            }), 200
            
        except Exception as e:
            logger.error(f"Error linking game to jiten: {e}")
            return jsonify({'error': f'Failed to link game: {str(e)}'}), 500

    @app.route('/api/games/<game_id>', methods=['PUT'])
    def api_update_game(game_id):
        """
        Update game information manually (marks fields as manually overridden).
        Supports all game fields including image, deck_id, character_count, and links.
        """
        try:
            from GameSentenceMiner.util.games_table import GamesTable
            
            data = request.get_json()
            if not data:
                return jsonify({'error': 'No data provided'}), 400
            
            # Get the game
            game = GamesTable.get(game_id)
            if not game:
                return jsonify({'error': 'Game not found'}), 404
            
            # Update fields using manual update method (marks as manual override)
            update_fields = {}
            
            # All allowed fields for manual editing
            allowed_fields = [
                'title_original', 'title_romaji', 'title_english', 'type',
                'description', 'difficulty', 'completed', 'deck_id',
                'character_count', 'image', 'links', 'release_date'
            ]
            
            for field in allowed_fields:
                if field in data:
                    value = data[field]
                    # Map 'type' to 'game_type' for the method parameter
                    field_key = 'game_type' if field == 'type' else field
                    
                    # Handle empty strings for optional fields
                    if field in ['title_romaji', 'title_english', 'type', 'description', 'image', 'release_date'] and value == '':
                        update_fields[field_key] = ''
                    # Handle None values for numeric fields
                    elif field in ['difficulty', 'deck_id', 'character_count'] and value == '':
                        update_fields[field_key] = None
                    # Handle boolean
                    elif field == 'completed':
                        update_fields[field_key] = bool(value)
                    # Handle lists
                    elif field == 'links':
                        if isinstance(value, list):
                            update_fields[field_key] = value
                        elif value == '':
                            update_fields[field_key] = []
                    else:
                        update_fields[field_key] = value
            
            if update_fields:
                game.update_all_fields_manual(**update_fields)
                
                logger.info(f"Manually updated game {game_id} fields: {list(update_fields.keys())}")
                
                return jsonify({
                    'success': True,
                    'message': 'Game updated successfully',
                    'updated_fields': list(update_fields.keys()),
                    'manual_overrides': game.manual_overrides
                }), 200
            else:
                return jsonify({'error': 'No valid fields to update'}), 400
                
        except Exception as e:
            logger.error(f"Error updating game: {e}", exc_info=True)
            return jsonify({'error': f'Failed to update game: {str(e)}'}), 500

    @app.route('/api/games/<game_id>/mark-complete', methods=['POST'])
    def api_mark_game_complete(game_id):
        """
        Mark a game as completed.
        Sets the completed field to True for the specified game.
        """
        try:
            from GameSentenceMiner.util.games_table import GamesTable
            
            # Get the game
            game = GamesTable.get(game_id)
            if not game:
                return jsonify({'error': 'Game not found'}), 404
            
            # Mark as completed
            game.completed = True
            game.save()
            
            logger.info(f"Marked game {game_id} ({game.title_original}) as completed")
            
            return jsonify({
                'success': True,
                'message': f'Game "{game.title_original}" marked as completed',
                'game_id': game_id,
                'completed': True
            }), 200
            
        except Exception as e:
            logger.error(f"Error marking game as complete: {e}", exc_info=True)
            return jsonify({'error': f'Failed to mark game as complete: {str(e)}'}), 500

    @app.route('/api/games/<game_id>/repull-jiten', methods=['POST'])
    def api_repull_game_from_jiten(game_id):
        """
        Repull jiten.moe data for a game, respecting manual overrides.
        Only updates fields that are not in the manually edited fields list.
        """
        try:
            from GameSentenceMiner.util.games_table import GamesTable
            import requests
            
            logger.info(f"🔄 Starting repull operation for game ID: {game_id}")
            
            # Get the game
            game = GamesTable.get(game_id)
            if not game:
                logger.error(f"❌ Game not found: {game_id}")
                return jsonify({'error': 'Game not found'}), 404
            
            logger.info(f"📋 Game found: {game.title_original} (deck_id: {game.deck_id})")
            logger.info(f"🔒 Manual overrides: {game.manual_overrides}")
            
            # Check if game is linked to jiten.moe
            if not game.deck_id:
                logger.error(f"❌ Game {game_id} is not linked to jiten.moe")
                return jsonify({'error': 'Game is not linked to jiten.moe. Please link it first.'}), 400
            
            # Fetch fresh data from jiten.moe API
            try:
                logger.info(f"📡 Fetching data from jiten.moe for deck_id: {game.deck_id}")
                jiten_url = 'https://api.jiten.moe/api/media-deck/get-media-decks'
                params = {
                    'titleFilter': game.title_original,
                    'sortBy': 'title',
                    'sortOrder': 0,
                    'offset': 0
                }
                
                response = requests.get(jiten_url, params=params, timeout=10)
                logger.info(f"📥 jiten.moe API response: {response.status_code}")
                
                if response.status_code != 200:
                    logger.error(f"❌ jiten.moe API error: {response.status_code}")
                    return jsonify({'error': f'jiten.moe API returned status {response.status_code}'}), 500
                
                data = response.json()
                logger.info(f"📊 jiten.moe returned {len(data.get('data', []))} results")
                
                # Print FULL jiten.moe API response
                logger.info("=" * 80)
                logger.info("📋 FULL JITEN.MOE API RESPONSE (REPULL)")
                logger.info("=" * 80)
                logger.info(json.dumps(data, indent=2, ensure_ascii=False))
                logger.info("=" * 80)
                
                # Find the specific deck by deck_id
                jiten_data = None
                for item in data.get('data', []):
                    if item.get('deckId') == game.deck_id:
                        jiten_data = {
                            'deck_id': item.get('deckId'),
                            'title_original': item.get('originalTitle', ''),
                            'title_romaji': item.get('romajiTitle', ''),
                            'title_english': item.get('englishTitle', ''),
                            'description': item.get('description', ''),
                            'cover_name': item.get('coverName', ''),
                            'media_type': item.get('mediaType'),
                            'character_count': item.get('characterCount', 0),  # Convert from camelCase to snake_case
                            'difficulty': item.get('difficulty', 0),
                            'difficulty_raw': item.get('difficultyRaw', 0),
                            'links': item.get('links', []),
                            'aliases': item.get('aliases', []),
                            'release_date': item.get('releaseDate', '')
                        }
                        logger.info(f"✅ Found matching deck: {jiten_data['title_original']} - release_date: '{jiten_data['release_date']}'")
                        break
                
                if not jiten_data:
                    logger.error(f"❌ Deck {game.deck_id} not found in jiten.moe results")
                    return jsonify({'error': f'Game with deck_id {game.deck_id} not found on jiten.moe'}), 404
                
            except requests.RequestException as e:
                logger.error(f"💥 jiten.moe API request failed: {e}")
                return jsonify({'error': 'Failed to fetch data from jiten.moe'}), 500
            
            # Update game with fresh jiten.moe data, respecting manual overrides
            update_fields = {}
            skipped_fields = []
            
            # Ensure manual_overrides is always a list
            manual_overrides = game.manual_overrides if game.manual_overrides is not None else []
            if not isinstance(manual_overrides, list):
                logger.warning(f"⚠️ manual_overrides is not a list: {type(manual_overrides)} - {manual_overrides}")
                manual_overrides = []
            
            logger.info(f"🔍 Checking fields for updates (manual overrides: {manual_overrides})")
            
            # Only update fields that are not manually overridden
            if 'deck_id' not in manual_overrides:
                update_fields['deck_id'] = jiten_data['deck_id']
                logger.debug(f"📝 Will update deck_id: {jiten_data['deck_id']}")
            else:
                skipped_fields.append('deck_id')
                logger.debug(f"⏭️ Skipping deck_id (manual override)")
            
            if 'title_original' not in manual_overrides and jiten_data.get('title_original'):
                update_fields['title_original'] = jiten_data['title_original']
                logger.debug(f"📝 Will update title_original: {jiten_data['title_original']}")
            elif 'title_original' in manual_overrides:
                skipped_fields.append('title_original')
                logger.debug(f"⏭️ Skipping title_original (manual override)")
            
            if 'title_romaji' not in manual_overrides and jiten_data.get('title_romaji'):
                update_fields['title_romaji'] = jiten_data['title_romaji']
                logger.debug(f"📝 Will update title_romaji: {jiten_data['title_romaji']}")
            elif 'title_romaji' in manual_overrides:
                skipped_fields.append('title_romaji')
                logger.debug(f"⏭️ Skipping title_romaji (manual override)")
            
            if 'title_english' not in manual_overrides and jiten_data.get('title_english'):
                update_fields['title_english'] = jiten_data['title_english']
                logger.debug(f"📝 Will update title_english: {jiten_data['title_english']}")
            elif 'title_english' in manual_overrides:
                skipped_fields.append('title_english')
                logger.debug(f"⏭️ Skipping title_english (manual override)")
            
            if 'type' not in manual_overrides and jiten_data.get('media_type'):
                # Map media type to string
                media_type_map = {1: 'Anime', 7: 'Visual Novel', 2: 'Manga'}
                update_fields['game_type'] = media_type_map.get(jiten_data['media_type'], 'Unknown')
                logger.debug(f"📝 Will update type: {update_fields['game_type']}")
            elif 'type' in manual_overrides:
                skipped_fields.append('type')
                logger.debug(f"⏭️ Skipping type (manual override)")
            
            if 'description' not in manual_overrides and jiten_data.get('description'):
                update_fields['description'] = jiten_data['description']
                logger.debug(f"📝 Will update description: {jiten_data['description'][:50]}...")
            elif 'description' in manual_overrides:
                skipped_fields.append('description')
                logger.debug(f"⏭️ Skipping description (manual override)")
            
            if 'difficulty' not in manual_overrides and jiten_data.get('difficulty') is not None:
                update_fields['difficulty'] = jiten_data['difficulty']
                logger.debug(f"📝 Will update difficulty: {jiten_data['difficulty']}")
            elif 'difficulty' in manual_overrides:
                skipped_fields.append('difficulty')
                logger.debug(f"⏭️ Skipping difficulty (manual override)")
            
            if 'character_count' not in manual_overrides and jiten_data.get('character_count') is not None:
                update_fields['character_count'] = jiten_data['character_count']
                logger.debug(f"📝 Will update character_count: {jiten_data['character_count']}")
            elif 'character_count' in manual_overrides:
                skipped_fields.append('character_count')
                logger.debug(f"⏭️ Skipping character_count (manual override)")
            
            if 'links' not in manual_overrides and jiten_data.get('links'):
                update_fields['links'] = jiten_data['links']
                logger.debug(f"📝 Will update links: {len(jiten_data['links'])} links")
            elif 'links' in manual_overrides:
                skipped_fields.append('links')
                logger.debug(f"⏭️ Skipping links (manual override)")
            
            if 'release_date' not in manual_overrides and jiten_data.get('release_date'):
                update_fields['release_date'] = jiten_data['release_date']
                logger.info(f"📅 Repull: Will update release_date for game {game_id}: '{jiten_data['release_date']}'")
            elif 'release_date' in manual_overrides:
                skipped_fields.append('release_date')
                logger.info(f"⏭️ Repull: Skipping release_date (manual override) for game {game_id}")
            else:
                logger.info(f"⏭️ Repull: Skipping release_date (no data) for game {game_id}: '{jiten_data.get('release_date', 'NONE')}'")
            
            # Download and encode image if not manually overridden
            if 'image' not in manual_overrides and jiten_data.get('cover_name'):
                try:
                    import base64
                    logger.debug(f"🖼️ Downloading image: {jiten_data['cover_name']}")
                    img_response = requests.get(jiten_data['cover_name'], timeout=10)
                    if img_response.status_code == 200:
                        # Encode image to base64
                        img_base64 = base64.b64encode(img_response.content).decode('utf-8')
                        update_fields['image'] = img_base64
                        logger.info(f"✅ Downloaded and encoded image for game {game_id}")
                    else:
                        logger.warning(f"⚠️ Failed to download image: HTTP {img_response.status_code}")
                except Exception as img_error:
                    logger.warning(f"⚠️ Failed to download image for game {game_id}: {img_error}")
            elif 'image' in manual_overrides:
                skipped_fields.append('image')
                logger.debug(f"⏭️ Skipping image (manual override)")
            
            logger.info(f"📊 Update summary - Fields to update: {len(update_fields)}, Fields to skip: {len(skipped_fields)}")
            logger.info(f"📝 Fields to update: {list(update_fields.keys())}")
            logger.info(f"⏭️ Fields to skip: {skipped_fields}")
            
            # Update the game using the jiten update method (doesn't mark as manual)
            if update_fields:
                game.update_all_fields_from_jiten(**update_fields)
                logger.info(f"✅ Successfully repulled jiten.moe data for game {game_id} ({game.title_original})")
                
                return jsonify({
                    'success': True,
                    'message': f'Successfully repulled data from jiten.moe for "{game.title_original}"',
                    'updated_fields': list(update_fields.keys()),
                    'skipped_fields': skipped_fields,  # Always return as list
                    'deck_id': game.deck_id,
                    'jiten_raw_response': jiten_data  # Include full jiten.moe data
                }), 200
            else:
                logger.info(f"ℹ️ No fields updated - all fields are manually overridden for game {game_id}")
                return jsonify({
                    'success': True,
                    'message': f'No fields updated - all fields are manually overridden for "{game.title_original}"',
                    'updated_fields': [],
                    'skipped_fields': skipped_fields,  # Always return as list
                    'deck_id': game.deck_id,
                    'jiten_raw_response': jiten_data  # Include full jiten.moe data
                }), 200
            
        except Exception as e:
            logger.error(f"💥 Error repulling jiten data for game {game_id}: {e}")
            logger.error(f"💥 Error stack trace:", exc_info=True)
            return jsonify({'error': f'Failed to repull jiten data: {str(e)}'}), 500

    @app.route('/api/games/<game_id>', methods=['DELETE'])
    def api_delete_individual_game(game_id):
        """
        Delete (unlink) an individual game from the games table.
        This removes the game record but preserves all game_lines data by setting game_id to NULL.
        """
        try:
            from GameSentenceMiner.util.games_table import GamesTable
            
            # Get the game to verify it exists
            game = GamesTable.get(game_id)
            if not game:
                return jsonify({'error': 'Game not found'}), 404
            
            game_name = game.title_original
            
            # Get count of lines that will be unlinked
            lines_count = GameLinesTable._db.fetchone(
                f"SELECT COUNT(*) FROM {GameLinesTable._table} WHERE game_id=?",
                (game_id,)
            )
            unlinked_lines = lines_count[0] if lines_count else 0
            
            # Unlink game_lines by setting game_id to NULL
            GameLinesTable._db.execute(
                f"UPDATE {GameLinesTable._table} SET game_id = NULL WHERE game_id = ?",
                (game_id,),
                commit=True
            )
            
            # Delete the game record from games table
            GameLinesTable._db.execute(
                f"DELETE FROM {GamesTable._table} WHERE id = ?",
                (game_id,),
                commit=True
            )
            
            logger.info(f"Unlinked game '{game_name}' (id={game_id}): removed game record, unlinked {unlinked_lines} lines")
            
            return jsonify({
                'success': True,
                'message': f'Game "{game_name}" has been unlinked successfully',
                'game_name': game_name,
                'unlinked_lines': unlinked_lines
            }), 200
            
        except Exception as e:
            logger.error(f"Error unlinking game {game_id}: {e}", exc_info=True)
            return jsonify({'error': f'Failed to unlink game: {str(e)}'}), 500

    @app.route('/api/orphaned-games', methods=['GET'])
    def api_orphaned_games():
        """
        Get game names from game_lines that don't have corresponding games records.
        Returns potential games that users can choose to create.
        """
        try:
            from GameSentenceMiner.util.games_table import GamesTable
            
            # Get all distinct game names from game_lines
            game_names_from_lines = GameLinesTable._db.fetchall(
                f"SELECT DISTINCT game_name, COUNT(*) as line_count, SUM(LENGTH(line_text)) as char_count "
                f"FROM {GameLinesTable._table} "
                f"WHERE game_name IS NOT NULL AND game_name != '' "
                f"GROUP BY game_name"
            )
            
            # Get all existing game titles from games table
            existing_games = GamesTable._db.fetchall(
                f"SELECT title_original FROM {GamesTable._table}"
            )
            existing_titles = {row[0] for row in existing_games}
            
            # Find orphaned games (in game_lines but not in games table)
            orphaned_games = []
            for row in game_names_from_lines:
                game_name, line_count, char_count = row
                if game_name not in existing_titles:
                    # Get date range for this game
                    date_range = GameLinesTable._db.fetchone(
                        f"SELECT MIN(timestamp), MAX(timestamp) FROM {GameLinesTable._table} WHERE game_name=?",
                        (game_name,)
                    )
                    min_timestamp, max_timestamp = date_range if date_range else (None, None)
                    
                    orphaned_games.append({
                        'game_name': game_name,
                        'line_count': line_count,
                        'character_count': char_count or 0,
                        'first_seen': min_timestamp,
                        'last_seen': max_timestamp
                    })
            
            # Sort by character count (most active first)
            orphaned_games.sort(key=lambda x: x['character_count'], reverse=True)
            
            return jsonify({
                'orphaned_games': orphaned_games,
                'total_orphaned': len(orphaned_games),
                'total_managed': len(existing_titles)
            }), 200
            
        except Exception as e:
            logger.error(f"Error fetching orphaned games: {e}")
            return jsonify({'error': 'Failed to fetch orphaned games'}), 500

    @app.route('/api/games', methods=['POST'])
    def api_create_game():
        """
        Create a new game record (custom or from jiten.moe data).
        Links orphaned game_lines to the newly created game.
        """
        try:
            from GameSentenceMiner.util.games_table import GamesTable
            
            data = request.get_json()
            if not data:
                return jsonify({'error': 'No data provided'}), 400
            
            # Required field
            title_original = data.get('title_original', '').strip()
            if not title_original:
                return jsonify({'error': 'title_original is required'}), 400
            
            # Check if game already exists
            existing_game = GamesTable.get_by_title(title_original)
            if existing_game:
                return jsonify({'error': f'Game with title "{title_original}" already exists'}), 400
            
            # Create new game with provided data
            game_data = {
                'title_original': title_original,
                'title_romaji': data.get('title_romaji', ''),
                'title_english': data.get('title_english', ''),
                'game_type': data.get('type', ''),
                'description': data.get('description', ''),
                'image': data.get('image', ''),
                'difficulty': data.get('difficulty'),
                'links': data.get('links', []),
                'completed': data.get('completed', False)
            }
            
            # Create the game
            new_game = GamesTable(**game_data)
            new_game.add()  # Use add() instead of save() for new records with UUID primary keys
            
            # Link orphaned game_lines to this new game
            lines_updated = 0
            try:
                GameLinesTable._db.execute(
                    f"UPDATE {GameLinesTable._table} SET game_id = ? WHERE game_name = ? AND (game_id IS NULL OR game_id = '')",
                    (new_game.id, title_original),
                    commit=True
                )
                
                # Count how many lines were updated
                updated_count = GameLinesTable._db.fetchone(
                    f"SELECT COUNT(*) FROM {GameLinesTable._table} WHERE game_id = ?",
                    (new_game.id,)
                )
                lines_updated = updated_count[0] if updated_count else 0
                
                # Don't update character_count - it should only store jiten.moe's total
                # Mined character count is calculated on-the-fly from game_lines
                
            except Exception as link_error:
                logger.warning(f"Failed to link orphaned lines to new game {new_game.id}: {link_error}")
            
            logger.info(f"Created new game: {title_original} (id={new_game.id}, linked {lines_updated} lines)")
            
            return jsonify({
                'success': True,
                'message': f'Game "{title_original}" created successfully',
                'game': {
                    'id': new_game.id,
                    'title_original': new_game.title_original,
                    'title_romaji': new_game.title_romaji,
                    'title_english': new_game.title_english,
                    'type': new_game.type,
                    'jiten_character_count': new_game.character_count,  # Jiten total (if linked)
                    'lines_linked': lines_updated
                }
            }), 201
            
        except Exception as e:
            logger.error(f"Error creating game: {e}")
            return jsonify({'error': f'Failed to create game: {str(e)}'}), 500

    @app.route('/api/debug-db', methods=['GET'])
    def api_debug_db():
        """Debug endpoint to check database structure and content."""
        try:
            # Check table structure
            columns_info = GameLinesTable._db.fetchall("PRAGMA table_info(game_lines)")
            table_structure = [{'name': col[1], 'type': col[2], 'notnull': col[3], 'default': col[4]} for col in columns_info]
            
            # Check if we have any data
            count_result = GameLinesTable._db.fetchone("SELECT COUNT(*) FROM game_lines")
            total_count = count_result[0] if count_result else 0
            
            # Try to get a sample record
            sample_record = None
            if total_count > 0:
                sample_row = GameLinesTable._db.fetchone("SELECT * FROM game_lines LIMIT 1")
                if sample_row:
                    sample_record = {
                        'row_length': len(sample_row),
                        'sample_data': sample_row[:5] if len(sample_row) > 5 else sample_row  # First 5 columns only
                    }
            
            # Test the model
            model_info = {
                'fields_count': len(GameLinesTable._fields),
                'types_count': len(GameLinesTable._types),
                'fields': GameLinesTable._fields,
                'types': [str(t) for t in GameLinesTable._types]
            }
            
            return jsonify({
                'table_structure': table_structure,
                'total_records': total_count,
                'sample_record': sample_record,
                'model_info': model_info
            }), 200
            
        except Exception as e:
            logger.error(f"Error in debug endpoint: {e}")
            return jsonify({'error': f'Debug failed: {str(e)}'}), 500

