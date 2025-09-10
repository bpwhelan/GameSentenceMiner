import datetime
import re
import csv
import io
from collections import defaultdict

import flask
from flask import request, jsonify

from GameSentenceMiner.util.db import GameLinesTable
from GameSentenceMiner.util.configuration import logger, get_config, save_current_config
from GameSentenceMiner.web.stats import (
    calculate_kanji_frequency, calculate_heatmap_data, calculate_total_chars_per_game,
    calculate_reading_time_per_game, calculate_reading_speed_per_game,
    calculate_current_game_stats, calculate_all_games_stats, calculate_daily_reading_time,
    calculate_time_based_streak, calculate_actual_reading_time
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
            
            # Validate parameters
            if not query:
                return jsonify({'error': 'Search query is required'}), 400
            
            if page < 1:
                page = 1
            if page_size < 1 or page_size > 100:
                page_size = 20
            
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
            logger.error(f"Error fetching games list: {e}")
            return jsonify({'error': 'Failed to fetch games list'}), 500

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
        Get current AFK timer, session gap, and streak requirement settings.
        """
        try:
            config = get_config()
            return jsonify({
                'afk_timer_seconds': config.advanced.afk_timer_seconds,
                'session_gap_seconds': config.advanced.session_gap_seconds,
                'streak_requirement_hours': getattr(config.advanced, 'streak_requirement_hours', 1.0)
            }), 200
        except Exception as e:
            logger.error(f"Error getting settings: {e}")
            return jsonify({'error': 'Failed to get settings'}), 500

    @app.route('/api/settings', methods=['POST'])
    def api_save_settings():
        """
        Save/update AFK timer, session gap, and streak requirement settings.
        """
        try:
            data = request.get_json()
            
            if not data:
                return jsonify({'error': 'No data provided'}), 400
            
            afk_timer = data.get('afk_timer_seconds')
            session_gap = data.get('session_gap_seconds')
            streak_requirement = data.get('streak_requirement_hours')
            
            # Validate input - only require the settings that are provided
            settings_to_update = {}
            
            if afk_timer is not None:
                try:
                    afk_timer = int(afk_timer)
                    if afk_timer < 30 or afk_timer > 600:
                        return jsonify({'error': 'AFK timer must be between 30 and 600 seconds'}), 400
                    settings_to_update['afk_timer_seconds'] = afk_timer
                except (ValueError, TypeError):
                    return jsonify({'error': 'AFK timer must be a valid integer'}), 400
            
            if session_gap is not None:
                try:
                    session_gap = int(session_gap)
                    if session_gap < 300 or session_gap > 7200:
                        return jsonify({'error': 'Session gap must be between 300 and 7200 seconds (5 minutes to 2 hours)'}), 400
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
            
            if not settings_to_update:
                return jsonify({'error': 'No valid settings provided'}), 400
            
            # Update configuration
            config = get_config()
            
            if 'afk_timer_seconds' in settings_to_update:
                config.advanced.afk_timer_seconds = settings_to_update['afk_timer_seconds']
            if 'session_gap_seconds' in settings_to_update:
                config.advanced.session_gap_seconds = settings_to_update['session_gap_seconds']
            if 'streak_requirement_hours' in settings_to_update:
                setattr(config.advanced, 'streak_requirement_hours', settings_to_update['streak_requirement_hours'])
            
            # Save configuration
            save_current_config(config)
            
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
        """
        try:
            data = request.get_json()
            if not data:
                return jsonify({'error': 'No data provided'}), 400
            
            games = data.get('games', [])
            time_window_minutes = data.get('time_window_minutes', 5)
            case_sensitive = data.get('case_sensitive', False)
            
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
            
            # Find duplicates within time window for each game
            for game_name, lines in game_lines.items():
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
        """
        try:
            data = request.get_json()
            if not data:
                return jsonify({'error': 'No data provided'}), 400
            
            games = data.get('games', [])
            time_window_minutes = data.get('time_window_minutes', 5)
            case_sensitive = data.get('case_sensitive', False)
            preserve_newest = data.get('preserve_newest', False)
            
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
            
            # Find duplicates within time window for each game
            for game_name, lines in game_lines.items():
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
            
            logger.info(f"Deduplication completed: removed {deleted_count} duplicate sentences from {len(games)} games with {time_window_minutes}min window")
            
            return jsonify({
                'deleted_count': deleted_count,
                'message': f'Successfully removed {deleted_count} duplicate sentences'
            }), 200
            
        except Exception as e:
            logger.error(f"Error in deduplication: {e}")
            return jsonify({'error': f'Deduplication failed: {str(e)}'}), 500

    @app.route('/api/stats')
    def api_stats():
        """
        Provides aggregated, cumulative stats for charting.
        Accepts optional 'year' parameter to filter heatmap data.
        """
        # Get optional year filter parameter
        filter_year = request.args.get('year', None)
        
        # 1. Fetch all lines and sort them chronologically
        all_lines = sorted(GameLinesTable.all(), key=lambda line: line.timestamp)
        
        if not all_lines:
            return jsonify({"labels": [], "datasets": []})

        # 2. Process data into daily totals for each game
        # Structure: daily_data[date_str][game_name] = {'lines': N, 'chars': N}
        daily_data = defaultdict(lambda: defaultdict(lambda: {'lines': 0, 'chars': 0}))

        for line in all_lines:
            day_str = datetime.date.fromtimestamp(float(line.timestamp)).strftime('%Y-%m-%d')
            game = line.game_name or "Unknown Game"
            
            daily_data[day_str][game]['lines'] += 1
            daily_data[day_str][game]['chars'] += len(line.line_text) if line.line_text else 0

        # 3. Create cumulative datasets for Chart.js
        sorted_days = sorted(daily_data.keys())
        game_names = GameLinesTable.get_all_games_with_lines()
        
        # Keep track of the running total for each metric for each game
        cumulative_totals = defaultdict(lambda: {'lines': 0, 'chars': 0})
        
        # Structure for final data: final_data[game_name][metric] = [day1_val, day2_val, ...]
        final_data = defaultdict(lambda: defaultdict(list))

        for day in sorted_days:
            for game in game_names:
                # Add the day's total to the cumulative total
                cumulative_totals[game]['lines'] += daily_data[day][game]['lines']
                cumulative_totals[game]['chars'] += daily_data[day][game]['chars']
                
                # Append the new cumulative total to the list for that day
                final_data[game]['lines'].append(cumulative_totals[game]['lines'])
                final_data[game]['chars'].append(cumulative_totals[game]['chars'])
        
        # 4. Format into Chart.js dataset structure
        datasets = []
        # A simple color palette for the chart lines
        colors = ['#3498db', '#e74c3c', '#2ecc71', '#f1c40f', '#9b59b6', '#1abc9c', '#e67e22']
        
        for i, game in enumerate(game_names):
            color = colors[i % len(colors)]
            
            datasets.append({
                "label": f"{game}",
                "for": "Lines Received",
                "data": final_data[game]['lines'],
                "borderColor": color,
                "backgroundColor": f"{color}33", # Semi-transparent for fill
                "fill": False,
                "tension": 0.1
            })
            datasets.append({
                "label": f"{game}",
                "for": "Characters Read",
                "data": final_data[game]['chars'],
                "borderColor": color,
                "backgroundColor": f"{color}33",
                "fill": False,
                "tension": 0.1,
                "hidden": True # Hide by default to not clutter the chart
            })

        # 5. Calculate additional chart data
        kanji_grid_data = calculate_kanji_frequency(all_lines)
        heatmap_data = calculate_heatmap_data(all_lines, filter_year)
        total_chars_data = calculate_total_chars_per_game(all_lines)
        reading_time_data = calculate_reading_time_per_game(all_lines)
        reading_speed_per_game_data = calculate_reading_speed_per_game(all_lines)
        
        # 6. Calculate dashboard statistics
        current_game_stats = calculate_current_game_stats(all_lines)
        all_games_stats = calculate_all_games_stats(all_lines)

        # 7. Prepare allLinesData for frontend calculations (needed for average daily time)
        all_lines_data = []
        for line in all_lines:
            all_lines_data.append({
                'timestamp': float(line.timestamp),
                'game_name': line.game_name or 'Unknown Game',
                'characters': len(line.line_text) if line.line_text else 0
            })

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
            "allLinesData": all_lines_data
        })

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
                imported_lines = []
                games_set = set()
                errors = []
                seen_uuids = set()  # Track UUIDs within this import batch
                
                for row_num, row in enumerate(csv_reader):
                    try:
                        # Extract and validate required fields
                        uuid = row.get('uuid', '').strip()
                        name = row.get('name', '').strip()
                        line = row.get('line', '').strip()
                        time_str = row.get('time', '').strip()
                        
                        # Validate required fields
                        if not uuid:
                            errors.append(f"Row {row_num}: Missing UUID")
                            continue
                        if not name:
                            errors.append(f"Row {row_num}: Missing name")
                            continue
                        if not line:
                            errors.append(f"Row {row_num}: Missing line text")
                            continue
                        if not time_str:
                            errors.append(f"Row {row_num}: Missing time")
                            continue
                        
                        # Check for duplicates within this import batch
                        if uuid in seen_uuids:
                            logger.info(f"Skipping duplicate UUID within import batch: {uuid}")
                            continue
                        seen_uuids.add(uuid)
                        
                        # Convert time to timestamp
                        try:
                            timestamp = float(time_str)
                        except ValueError:
                            errors.append(f"Row {row_num}: Invalid time format: {time_str}")
                            continue
                        
                        # Clean up line text (remove extra whitespace and newlines)
                        line_text = line.strip()
                        
                        # Check if this UUID already exists in database
                        existing_line = GameLinesTable.get(uuid)
                        if existing_line:
                            logger.info(f"Skipping duplicate UUID already in database: {uuid}")
                            continue
                        
                        # Create GameLinesTable entry
                        game_line = GameLinesTable(
                            id=uuid,
                            game_name=name,
                            line_text=line_text,
                            timestamp=timestamp
                        )
                        
                        imported_lines.append(game_line)
                        games_set.add(name)
                        
                    except Exception as e:
                        errors.append(f"Row {row_num}: Error processing row - {str(e)}")
                        continue
                
                # Import lines into database
                imported_count = 0
                for game_line in imported_lines:
                    try:
                        game_line.add()
                        imported_count += 1
                    except Exception as e:
                        logger.error(f"Failed to import line {game_line.id}: {e}")
                        errors.append(f"Failed to import line {game_line.id}: {str(e)}")
                
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
                
                return jsonify(response_data), 200
                
            except csv.Error as e:
                return jsonify({'error': f'CSV parsing error: {str(e)}'}), 400
            except UnicodeDecodeError:
                return jsonify({'error': 'File encoding error. Please ensure the CSV is UTF-8 encoded.'}), 400
            
        except Exception as e:
            logger.error(f"Error in ExStatic import: {e}")
            return jsonify({'error': f'Import failed: {str(e)}'}), 500