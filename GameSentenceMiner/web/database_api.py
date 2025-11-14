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
from GameSentenceMiner.util.stats_rollup_table import StatsRollupTable
from GameSentenceMiner.util.configuration import (
    get_stats_config,
    logger,
    get_config,
    save_current_config,
    save_stats_config,
)
from GameSentenceMiner.util.cron.daily_rollup import run_daily_rollup
from GameSentenceMiner.util.text_log import GameLine
from GameSentenceMiner.web.stats import (
    calculate_kanji_frequency,
    calculate_mining_heatmap_data,
    calculate_total_chars_per_game,
    calculate_reading_time_per_game,
    calculate_reading_speed_per_game,
    calculate_current_game_stats,
    calculate_all_games_stats,
    calculate_daily_reading_time,
    calculate_time_based_streak,
    calculate_actual_reading_time,
    calculate_hourly_activity,
    calculate_hourly_reading_speed,
    calculate_peak_daily_stats,
    calculate_peak_session_stats,
    calculate_game_milestones,
    build_game_display_name_mapping,
)
from GameSentenceMiner.web.rollup_stats import (
    aggregate_rollup_data,
    calculate_live_stats_for_today,
    combine_rollup_and_live_stats,
    build_heatmap_from_rollup,
    build_daily_chart_data_from_rollup,
)


def register_database_api_routes(app):
    """Register all database API routes with the Flask app."""

    @app.route("/api/search-sentences")
    def api_search_sentences():
        """
        API endpoint for searching sentences with filters and pagination.
        """
        try:
            # Get query parameters
            query = request.args.get("q", "").strip()
            game_filter = request.args.get("game", "")
            from_date = request.args.get("from_date", "").strip()
            to_date = request.args.get("to_date", "").strip()
            sort_by = request.args.get("sort", "relevance")
            page = int(request.args.get("page", 1))
            page_size = int(request.args.get("page_size", 20))
            use_regex = request.args.get("use_regex", "false").lower() == "true"

            # Validate parameters
            if not query:
                return jsonify({"error": "Search query is required"}), 400

            if page < 1:
                page = 1
            if page_size < 1 or page_size > 200:
                page_size = 20
            
            # Parse and validate date range if provided
            date_start_timestamp = None
            date_end_timestamp = None
            
            if from_date:
                try:
                    # Parse from_date in YYYY-MM-DD format
                    from_date_obj = datetime.datetime.strptime(from_date, "%Y-%m-%d")
                    # Get start of day (00:00:00)
                    date_start_timestamp = from_date_obj.replace(hour=0, minute=0, second=0, microsecond=0).timestamp()
                except ValueError:
                    return jsonify({"error": "Invalid from_date format. Use YYYY-MM-DD"}), 400
            
            if to_date:
                try:
                    # Parse to_date in YYYY-MM-DD format
                    to_date_obj = datetime.datetime.strptime(to_date, "%Y-%m-%d")
                    # Get end of day (23:59:59)
                    date_end_timestamp = to_date_obj.replace(hour=23, minute=59, second=59, microsecond=999999).timestamp()
                except ValueError:
                    return jsonify({"error": "Invalid to_date format. Use YYYY-MM-DD"}), 400

            if use_regex:
                # Regex search: fetch all candidate rows, filter in Python
                try:
                    # Ensure query is a string
                    if not isinstance(query, str):
                        return jsonify({"error": "Invalid query parameter type"}), 400

                    all_lines = GameLinesTable.all()
                    if game_filter:
                        all_lines = [
                            line for line in all_lines if line.game_name == game_filter
                        ]
                    
                    # Apply date range filter if provided
                    if date_start_timestamp is not None or date_end_timestamp is not None:
                        filtered_lines = []
                        for line in all_lines:
                            if not line.timestamp:
                                continue
                            timestamp = float(line.timestamp)
                            # Check if timestamp is within range
                            if date_start_timestamp is not None and timestamp < date_start_timestamp:
                                continue
                            if date_end_timestamp is not None and timestamp > date_end_timestamp:
                                continue
                            filtered_lines.append(line)
                        all_lines = filtered_lines

                    # Compile regex pattern with proper error handling
                    try:
                        pattern = re.compile(query, re.IGNORECASE)
                    except re.error as regex_err:
                        return jsonify(
                            {"error": f"Invalid regex pattern: {str(regex_err)}"}
                        ), 400

                    # Filter lines using regex
                    filtered_lines = []
                    for line in all_lines:
                        if line.line_text and isinstance(line.line_text, str):
                            try:
                                if pattern.search(line.line_text):
                                    filtered_lines.append(line)
                            except Exception as search_err:
                                # Log but continue with other lines
                                logger.warning(
                                    f"Regex search error on line {line.id}: {search_err}"
                                )
                                continue

                    # Sorting (default: timestamp DESC, or as specified)
                    if sort_by == "date_asc":
                        filtered_lines.sort(
                            key=lambda l: float(l.timestamp) if l.timestamp else 0
                        )
                    elif sort_by == "game_name":
                        filtered_lines.sort(
                            key=lambda l: (
                                l.game_name or "",
                                -(float(l.timestamp) if l.timestamp else 0),
                            )
                        )
                    elif sort_by == "length_desc":
                        filtered_lines.sort(
                            key=lambda l: -(len(l.line_text) if l.line_text else 0)
                        )
                    elif sort_by == "length_asc":
                        filtered_lines.sort(
                            key=lambda l: len(l.line_text) if l.line_text else 0
                        )
                    else:  # date_desc or relevance
                        filtered_lines.sort(
                            key=lambda l: -(float(l.timestamp) if l.timestamp else 0)
                        )

                    total_results = len(filtered_lines)
                    # Pagination
                    start = (page - 1) * page_size
                    end = start + page_size
                    paged_lines = filtered_lines[start:end]
                    results = []
                    for line in paged_lines:
                        results.append(
                            {
                                "id": line.id,
                                "sentence": line.line_text or "",
                                "game_name": line.game_name or "Unknown Game",
                                "timestamp": float(line.timestamp)
                                if line.timestamp
                                else 0,
                                "translation": line.translation or None,
                                "has_audio": bool(getattr(line, "audio_path", None)),
                                "has_screenshot": bool(
                                    getattr(line, "screenshot_path", None)
                                ),
                            }
                        )
                    return jsonify(
                        {
                            "results": results,
                            "total": total_results,
                            "page": page,
                            "page_size": page_size,
                            "total_pages": (total_results + page_size - 1) // page_size,
                        }
                    ), 200
                except Exception as e:
                    logger.error(f"Regex search failed: {e}")
                    return jsonify({"error": f"Search failed: {str(e)}"}), 500
            else:
                # Build the SQL query
                base_query = (
                    f"SELECT * FROM {GameLinesTable._table} WHERE line_text LIKE ?"
                )
                params = [f"%{query}%"]

                # Add game filter if specified
                if game_filter:
                    base_query += " AND game_name = ?"
                    params.append(game_filter)
                
                # Add date range filter if specified
                if date_start_timestamp is not None:
                    base_query += " AND timestamp >= ?"
                    params.append(date_start_timestamp)
                if date_end_timestamp is not None:
                    base_query += " AND timestamp <= ?"
                    params.append(date_end_timestamp)

                # Add sorting
                if sort_by == "date_desc":
                    base_query += " ORDER BY timestamp DESC"
                elif sort_by == "date_asc":
                    base_query += " ORDER BY timestamp ASC"
                elif sort_by == "game_name":
                    base_query += " ORDER BY game_name, timestamp DESC"
                elif sort_by == "length_desc":
                    base_query += " ORDER BY LENGTH(line_text) DESC"
                elif sort_by == "length_asc":
                    base_query += " ORDER BY LENGTH(line_text) ASC"
                else:  # relevance - could be enhanced with proper scoring
                    base_query += " ORDER BY timestamp DESC"

                # Get total count for pagination
                count_query = f"SELECT COUNT(*) FROM {GameLinesTable._table} WHERE line_text LIKE ?"
                count_params = [f"%{query}%"]
                if game_filter:
                    count_query += " AND game_name = ?"
                    count_params.append(game_filter)
                if date_start_timestamp is not None:
                    count_query += " AND timestamp >= ?"
                    count_params.append(date_start_timestamp)
                if date_end_timestamp is not None:
                    count_query += " AND timestamp <= ?"
                    count_params.append(date_end_timestamp)

                total_results = GameLinesTable._db.fetchone(count_query, count_params)[
                    0
                ]

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
                        results.append(
                            {
                                "id": game_line.id,
                                "sentence": game_line.line_text or "",
                                "game_name": game_line.game_name or "Unknown Game",
                                "timestamp": float(game_line.timestamp)
                                if game_line.timestamp
                                else 0,
                                "translation": game_line.translation or None,
                                "has_audio": bool(game_line.audio_path),
                                "has_screenshot": bool(game_line.screenshot_path),
                            }
                        )

                return jsonify(
                    {
                        "results": results,
                        "total": total_results,
                        "page": page,
                        "page_size": page_size,
                        "total_pages": (total_results + page_size - 1) // page_size,
                    }
                ), 200

        except ValueError as e:
            return jsonify({"error": "Invalid pagination parameters"}), 400
        except Exception as e:
            logger.error(f"Error in sentence search: {e}")
            return jsonify({"error": "Search failed"}), 500

    @app.route("/api/games-list")
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
                total_chars = sum(
                    len(line.line_text) if line.line_text else 0 for line in lines
                )

                games_data.append(
                    {
                        "name": game_name,
                        "sentence_count": sentence_count,
                        "first_entry_date": min_date.strftime("%Y-%m-%d"),
                        "last_entry_date": max_date.strftime("%Y-%m-%d"),
                        "total_characters": total_chars,
                        "date_range": f"{min_date.strftime('%Y-%m-%d')} to {max_date.strftime('%Y-%m-%d')}"
                        if min_date != max_date
                        else min_date.strftime("%Y-%m-%d"),
                    }
                )

            # Sort by total characters (most characters first)
            games_data.sort(key=lambda x: x["total_characters"], reverse=True)

            return jsonify({"games": games_data}), 200

        except Exception as e:
            logger.error(f"Error fetching games list: {e}", exc_info=True)
            return jsonify({"error": "Failed to fetch games list"}), 500

    @app.route("/api/delete-sentence-lines", methods=["POST"])
    def api_delete_sentence_lines():
        """
        Delete specific sentence lines by their IDs.
        """
        try:
            data = request.get_json()
            line_ids = data.get("line_ids", [])

            logger.debug(f"Request to delete line IDs: {line_ids}")

            if not line_ids:
                return jsonify({"error": "No line IDs provided"}), 400

            if not isinstance(line_ids, list):
                return jsonify({"error": "line_ids must be a list"}), 400

            # Delete the lines
            deleted_count = 0
            failed_ids = []

            for line_id in line_ids:
                try:
                    GameLinesTable._db.execute(
                        f"DELETE FROM {GameLinesTable._table} WHERE id=?",
                        (line_id,),
                        commit=True,
                    )
                    deleted_count += 1
                except Exception as e:
                    logger.warning(f"Failed to delete line {line_id}: {e}")
                    failed_ids.append(line_id)

            logger.info(
                f"Deleted {deleted_count} sentence lines out of {len(line_ids)} requested"
            )

            response_data = {
                "deleted_count": deleted_count,
                "message": f"Successfully deleted {deleted_count} {'sentence' if deleted_count == 1 else 'sentences'}",
            }

            if failed_ids:
                response_data["warning"] = f"{len(failed_ids)} lines failed to delete"
                response_data["failed_ids"] = failed_ids

            # Trigger stats rollup after successful deletion
            if deleted_count > 0:
                try:
                    logger.info("Triggering stats rollup after sentence line deletion")
                    run_daily_rollup()
                except Exception as rollup_error:
                    logger.error(f"Stats rollup failed after sentence line deletion: {rollup_error}")
                    # Don't fail the deletion operation if rollup fails

            return jsonify(response_data), 200

        except Exception as e:
            logger.error(f"Error in sentence line deletion: {e}")
            return jsonify({"error": f"Failed to delete sentences: {str(e)}"}), 500

    @app.route("/api/delete-games", methods=["POST"])
    def api_delete_games():
        """
        Handles bulk deletion of games and their associated data.
        """
        try:
            data = request.get_json()
            game_names = data.get("game_names", [])

            if not game_names:
                return jsonify({"error": "No games specified for deletion"}), 400

            if not isinstance(game_names, list):
                return jsonify({"error": "game_names must be a list"}), 400

            # Validate that all games exist
            existing_games = GameLinesTable.get_all_games_with_lines()
            invalid_games = [name for name in game_names if name not in existing_games]

            if invalid_games:
                return jsonify(
                    {"error": f"Games not found: {', '.join(invalid_games)}"}
                ), 400

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
                        commit=True,
                    )

                    deletion_results[game_name] = {
                        "deleted_sentences": lines_count,
                        "status": "success",
                    }
                    total_deleted += lines_count

                    logger.info(
                        f"Deleted {lines_count} sentences for game: {game_name}"
                    )

                except Exception as e:
                    logger.error(f"Error deleting game {game_name}: {e}")
                    deletion_results[game_name] = {
                        "deleted_sentences": 0,
                        "status": "error",
                        "error": str(e),
                    }

            # Check if any deletions were successful
            successful_deletions = [
                name
                for name, result in deletion_results.items()
                if result["status"] == "success"
            ]
            failed_deletions = [
                name
                for name, result in deletion_results.items()
                if result["status"] == "error"
            ]

            response_data = {
                "message": f"Deletion completed. {len(successful_deletions)} games successfully deleted.",
                "total_sentences_deleted": total_deleted,
                "successful_games": successful_deletions,
                "failed_games": failed_deletions,
                "detailed_results": deletion_results,
            }

            if failed_deletions:
                response_data["warning"] = (
                    f"Some games failed to delete: {', '.join(failed_deletions)}"
                )
                status_code = 207  # Multi-Status (partial success)
            else:
                status_code = 200
            
            # Trigger stats rollup after successful deletion
            if successful_deletions:
                try:
                    logger.info("Triggering stats rollup after game deletion")
                    run_daily_rollup()
                except Exception as rollup_error:
                    logger.error(f"Stats rollup failed after game deletion: {rollup_error}")
                    # Don't fail the deletion operation if rollup fails
            
            return jsonify(response_data), status_code

        except Exception as e:
            logger.error(f"Error in bulk game deletion: {e}")
            return jsonify({"error": f"Failed to delete games: {str(e)}"}), 500

    @app.route("/api/settings", methods=["GET"])
    def api_get_settings():
        """
        Get current AFK timer, session gap, streak requirement, and goal settings.
        """
        try:
            config = get_stats_config()
            return jsonify(
                {
                    "afk_timer_seconds": config.afk_timer_seconds,
                    "session_gap_seconds": config.session_gap_seconds,
                    "streak_requirement_hours": config.streak_requirement_hours,
                    "reading_hours_target": config.reading_hours_target,
                    "character_count_target": config.character_count_target,
                    "games_target": config.games_target,
                    "reading_hours_target_date": config.reading_hours_target_date,
                    "character_count_target_date": config.character_count_target_date,
                    "games_target_date": config.games_target_date,
                    "cards_mined_daily_target": getattr(config, 'cards_mined_daily_target', 10),
                }
            ), 200
        except Exception as e:
            logger.error(f"Error getting settings: {e}")
            return jsonify({"error": "Failed to get settings"}), 500

    @app.route("/api/settings", methods=["POST"])
    def api_save_settings():
        """
        Save/update AFK timer, session gap, streak requirement, and goal settings.
        """
        try:
            data = request.get_json()

            if not data:
                return jsonify({"error": "No data provided"}), 400

            afk_timer = data.get("afk_timer_seconds")
            session_gap = data.get("session_gap_seconds")
            streak_requirement = data.get("streak_requirement_hours")
            reading_hours_target = data.get("reading_hours_target")
            character_count_target = data.get("character_count_target")
            games_target = data.get("games_target")
            reading_hours_target_date = data.get("reading_hours_target_date")
            character_count_target_date = data.get("character_count_target_date")
            games_target_date = data.get("games_target_date")
            cards_mined_daily_target = data.get("cards_mined_daily_target")

            # Validate input - only require the settings that are provided
            settings_to_update = {}

            if afk_timer is not None:
                try:
                    afk_timer = int(afk_timer)
                    if afk_timer < 0 or afk_timer > 600:
                        return jsonify(
                            {"error": "AFK timer must be between 0 and 600 seconds"}
                        ), 400
                    settings_to_update["afk_timer_seconds"] = afk_timer
                except (ValueError, TypeError):
                    return jsonify({"error": "AFK timer must be a valid integer"}), 400

            if session_gap is not None:
                try:
                    session_gap = int(session_gap)
                    if session_gap < 0 or session_gap > 7200:
                        return jsonify(
                            {
                                "error": "Session gap must be between 0 and 7200 seconds (0 to 2 hours)"
                            }
                        ), 400
                    settings_to_update["session_gap_seconds"] = session_gap
                except (ValueError, TypeError):
                    return jsonify(
                        {"error": "Session gap must be a valid integer"}
                    ), 400

            if streak_requirement is not None:
                try:
                    streak_requirement = float(streak_requirement)
                    if streak_requirement < 0.01 or streak_requirement > 24:
                        return jsonify(
                            {
                                "error": "Streak requirement must be between 0.01 and 24 hours"
                            }
                        ), 400
                    settings_to_update["streak_requirement_hours"] = streak_requirement
                except (ValueError, TypeError):
                    return jsonify(
                        {"error": "Streak requirement must be a valid number"}
                    ), 400

            if reading_hours_target is not None:
                try:
                    reading_hours_target = int(reading_hours_target)
                    if reading_hours_target < 1 or reading_hours_target > 10000:
                        return jsonify(
                            {
                                "error": "Reading hours target must be between 1 and 10,000 hours"
                            }
                        ), 400
                    settings_to_update["reading_hours_target"] = reading_hours_target
                except (ValueError, TypeError):
                    return jsonify(
                        {"error": "Reading hours target must be a valid integer"}
                    ), 400

            if character_count_target is not None:
                try:
                    character_count_target = int(character_count_target)
                    if (
                        character_count_target < 1000
                        or character_count_target > 1000000000
                    ):
                        return jsonify(
                            {
                                "error": "Character count target must be between 1,000 and 1,000,000,000 characters"
                            }
                        ), 400
                    settings_to_update["character_count_target"] = (
                        character_count_target
                    )
                except (ValueError, TypeError):
                    return jsonify(
                        {"error": "Character count target must be a valid integer"}
                    ), 400

            if games_target is not None:
                try:
                    games_target = int(games_target)
                    if games_target < 1 or games_target > 1000:
                        return jsonify(
                            {"error": "Games target must be between 1 and 1,000"}
                        ), 400
                    settings_to_update["games_target"] = games_target
                except (ValueError, TypeError):
                    return jsonify(
                        {"error": "Games target must be a valid integer"}
                    ), 400

            # Validate target dates (ISO format: YYYY-MM-DD)
            if reading_hours_target_date is not None:
                if reading_hours_target_date == "":
                    settings_to_update["reading_hours_target_date"] = ""
                else:
                    try:
                        datetime.datetime.strptime(
                            reading_hours_target_date, "%Y-%m-%d"
                        )
                        settings_to_update["reading_hours_target_date"] = (
                            reading_hours_target_date
                        )
                    except ValueError:
                        return jsonify(
                            {
                                "error": "Reading hours target date must be in YYYY-MM-DD format"
                            }
                        ), 400

            if character_count_target_date is not None:
                if character_count_target_date == "":
                    settings_to_update["character_count_target_date"] = ""
                else:
                    try:
                        datetime.datetime.strptime(
                            character_count_target_date, "%Y-%m-%d"
                        )
                        settings_to_update["character_count_target_date"] = (
                            character_count_target_date
                        )
                    except ValueError:
                        return jsonify(
                            {
                                "error": "Character count target date must be in YYYY-MM-DD format"
                            }
                        ), 400

            if games_target_date is not None:
                if games_target_date == "":
                    settings_to_update["games_target_date"] = ""
                else:
                    try:
                        datetime.datetime.strptime(games_target_date, "%Y-%m-%d")
                        settings_to_update["games_target_date"] = games_target_date
                    except ValueError:
                        return jsonify(
                            {"error": "Games target date must be in YYYY-MM-DD format"}
                        ), 400

            if cards_mined_daily_target is not None:
                try:
                    cards_mined_daily_target = int(cards_mined_daily_target)
                    if cards_mined_daily_target < 0 or cards_mined_daily_target > 1000:
                        return jsonify(
                            {"error": "Cards mined daily target must be between 0 and 1,000"}
                        ), 400
                    settings_to_update["cards_mined_daily_target"] = cards_mined_daily_target
                except (ValueError, TypeError):
                    return jsonify(
                        {"error": "Cards mined daily target must be a valid integer"}
                    ), 400

            if not settings_to_update:
                return jsonify({"error": "No valid settings provided"}), 400

            # Update configuration
            config = get_stats_config()

            if "afk_timer_seconds" in settings_to_update:
                config.afk_timer_seconds = settings_to_update["afk_timer_seconds"]
            if "session_gap_seconds" in settings_to_update:
                config.session_gap_seconds = settings_to_update["session_gap_seconds"]
            if "streak_requirement_hours" in settings_to_update:
                config.streak_requirement_hours = settings_to_update[
                    "streak_requirement_hours"
                ]
            if "reading_hours_target" in settings_to_update:
                config.reading_hours_target = settings_to_update["reading_hours_target"]
            if "character_count_target" in settings_to_update:
                config.character_count_target = settings_to_update[
                    "character_count_target"
                ]
            if "games_target" in settings_to_update:
                config.games_target = settings_to_update["games_target"]
            if "reading_hours_target_date" in settings_to_update:
                config.reading_hours_target_date = settings_to_update[
                    "reading_hours_target_date"
                ]
            if "character_count_target_date" in settings_to_update:
                config.character_count_target_date = settings_to_update[
                    "character_count_target_date"
                ]
            if "games_target_date" in settings_to_update:
                config.games_target_date = settings_to_update["games_target_date"]
            if "cards_mined_daily_target" in settings_to_update:
                config.cards_mined_daily_target = settings_to_update["cards_mined_daily_target"]

            save_stats_config(config)

            logger.info(f"Settings updated: {settings_to_update}")

            response_data = {"message": "Settings saved successfully"}
            response_data.update(settings_to_update)

            return jsonify(response_data), 200

        except Exception as e:
            logger.error(f"Error saving settings: {e}")
            return jsonify({"error": "Failed to save settings"}), 500

    @app.route("/api/preview-text-deletion", methods=["POST"])
    def api_preview_text_deletion():
        """
        Preview text lines that would be deleted based on regex or exact text matching.
        """
        try:
            data = request.get_json()
            if not data:
                return jsonify({"error": "No data provided"}), 400

            regex_pattern = data.get("regex_pattern")
            exact_text = data.get("exact_text")
            case_sensitive = data.get("case_sensitive", False)
            use_regex = data.get("use_regex", False)

            if not regex_pattern and not exact_text:
                return jsonify(
                    {"error": "Either regex_pattern or exact_text must be provided"}
                ), 400

            # Get all lines from database
            all_lines = GameLinesTable.all()
            if not all_lines:
                return jsonify({"count": 0, "samples": []}), 200

            matches = []

            if regex_pattern and use_regex:
                # Use regex matching
                try:
                    # Ensure regex_pattern is a string
                    if not isinstance(regex_pattern, str):
                        return jsonify({"error": "Regex pattern must be a string"}), 400

                    flags = 0 if case_sensitive else re.IGNORECASE
                    pattern = re.compile(regex_pattern, flags)

                    for line in all_lines:
                        if (
                            line.line_text
                            and isinstance(line.line_text, str)
                            and pattern.search(line.line_text)
                        ):
                            matches.append(line.line_text)

                except re.error as e:
                    return jsonify({"error": f"Invalid regex pattern: {str(e)}"}), 400

            elif exact_text:
                # Use exact text matching - ensure exact_text is properly handled
                if isinstance(exact_text, list):
                    text_lines = exact_text
                elif isinstance(exact_text, str):
                    text_lines = [exact_text]
                else:
                    return jsonify(
                        {"error": "exact_text must be a string or list of strings"}
                    ), 400

                for line in all_lines:
                    if line.line_text and isinstance(line.line_text, str):
                        line_text = (
                            line.line_text if case_sensitive else line.line_text.lower()
                        )

                        for target_text in text_lines:
                            # Ensure target_text is a string
                            if not isinstance(target_text, str):
                                continue
                            compare_text = (
                                target_text if case_sensitive else target_text.lower()
                            )
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

            return jsonify({"count": len(unique_matches), "samples": samples}), 200

        except Exception as e:
            logger.error(f"Error in preview text deletion: {e}")
            return jsonify({"error": f"Preview failed: {str(e)}"}), 500

    @app.route("/api/delete-text-lines", methods=["POST"])
    def api_delete_text_lines():
        """
        Delete text lines from database based on regex or exact text matching.
        """
        try:
            data = request.get_json()
            if not data:
                return jsonify({"error": "No data provided"}), 400

            regex_pattern = data.get("regex_pattern")
            exact_text = data.get("exact_text")
            case_sensitive = data.get("case_sensitive", False)
            use_regex = data.get("use_regex", False)

            if not regex_pattern and not exact_text:
                return jsonify(
                    {"error": "Either regex_pattern or exact_text must be provided"}
                ), 400

            # Get all lines from database
            all_lines = GameLinesTable.all()
            if not all_lines:
                return jsonify({"deleted_count": 0}), 200

            lines_to_delete = []

            if regex_pattern and use_regex:
                # Use regex matching
                try:
                    # Ensure regex_pattern is a string
                    if not isinstance(regex_pattern, str):
                        return jsonify({"error": "Regex pattern must be a string"}), 400

                    flags = 0 if case_sensitive else re.IGNORECASE
                    pattern = re.compile(regex_pattern, flags)

                    for line in all_lines:
                        if (
                            line.line_text
                            and isinstance(line.line_text, str)
                            and pattern.search(line.line_text)
                        ):
                            lines_to_delete.append(line.id)

                except re.error as e:
                    return jsonify({"error": f"Invalid regex pattern: {str(e)}"}), 400

            elif exact_text:
                # Use exact text matching - ensure exact_text is properly handled
                if isinstance(exact_text, list):
                    text_lines = exact_text
                elif isinstance(exact_text, str):
                    text_lines = [exact_text]
                else:
                    return jsonify(
                        {"error": "exact_text must be a string or list of strings"}
                    ), 400

                for line in all_lines:
                    if line.line_text and isinstance(line.line_text, str):
                        line_text = (
                            line.line_text if case_sensitive else line.line_text.lower()
                        )

                        for target_text in text_lines:
                            # Ensure target_text is a string
                            if not isinstance(target_text, str):
                                continue
                            compare_text = (
                                target_text if case_sensitive else target_text.lower()
                            )
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
                        commit=True,
                    )
                    deleted_count += 1
                except Exception as e:
                    logger.warning(f"Failed to delete line {line_id}: {e}")

            logger.info(
                f"Deleted {deleted_count} lines using pattern: {regex_pattern or exact_text}"
            )

            # Trigger stats rollup after successful deletion
            if deleted_count > 0:
                try:
                    logger.info("Triggering stats rollup after text line deletion")
                    run_daily_rollup()
                except Exception as rollup_error:
                    logger.error(f"Stats rollup failed after text line deletion: {rollup_error}")
                    # Don't fail the deletion operation if rollup fails

            return jsonify(
                {
                    "deleted_count": deleted_count,
                    "message": f"Successfully deleted {deleted_count} lines",
                }
            ), 200

        except Exception as e:
            logger.error(f"Error in delete text lines: {e}")
            return jsonify({"error": f"Deletion failed: {str(e)}"}), 500

    @app.route("/api/preview-deduplication", methods=["POST"])
    def api_preview_deduplication():
        """
        Preview duplicate sentences that would be removed based on time window and game selection.
        Supports ignore_time_window parameter to find all duplicates regardless of time.
        """
        try:
            data = request.get_json()
            if not data:
                return jsonify({"error": "No data provided"}), 400

            games = data.get("games", [])
            time_window_minutes = data.get("time_window_minutes", 5)
            case_sensitive = data.get("case_sensitive", False)
            ignore_time_window = data.get("ignore_time_window", False)

            if not games:
                return jsonify({"error": "At least one game must be selected"}), 400

            # Get lines from selected games
            if "all" in games:
                all_lines = GameLinesTable.all()
            else:
                all_lines = []
                for game_name in games:
                    game_lines = GameLinesTable.get_all_lines_for_scene(game_name)
                    all_lines.extend(game_lines)

            if not all_lines:
                return jsonify(
                    {"duplicates_count": 0, "games_affected": 0, "samples": []}
                ), 200

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

                        line_text = (
                            line.line_text if case_sensitive else line.line_text.lower()
                        )

                        if line_text in seen_texts:
                            # Found duplicate
                            duplicates_to_remove.append(line.id)

                            # Store sample for preview
                            if line_text not in duplicate_samples:
                                duplicate_samples[line_text] = {
                                    "text": line.line_text,  # Original case
                                    "occurrences": 1,
                                }
                            duplicate_samples[line_text]["occurrences"] += 1
                        else:
                            seen_texts[line_text] = line.id
                else:
                    # Find duplicates within time window (original logic)
                    text_timeline = []

                    for line in lines:
                        if not line.line_text or not line.line_text.strip():
                            continue

                        line_text = (
                            line.line_text if case_sensitive else line.line_text.lower()
                        )
                        timestamp = float(line.timestamp)

                        # Check for duplicates within time window
                        for prev_text, prev_timestamp, prev_line_id in reversed(
                            text_timeline
                        ):
                            if timestamp - prev_timestamp > time_window_seconds:
                                break  # Outside time window

                            if prev_text == line_text:
                                # Found duplicate within time window
                                duplicates_to_remove.append(line.id)

                                # Store sample for preview
                                if line_text not in duplicate_samples:
                                    duplicate_samples[line_text] = {
                                        "text": line.line_text,  # Original case
                                        "occurrences": 1,
                                    }
                                duplicate_samples[line_text]["occurrences"] += 1
                                break

                        text_timeline.append((line_text, timestamp, line.id))

            # Calculate statistics
            duplicates_count = len(duplicates_to_remove)
            games_affected = len(
                [
                    game
                    for game in game_lines.keys()
                    if any(line.id in duplicates_to_remove for line in game_lines[game])
                ]
            )

            # Get sample duplicates
            samples = list(duplicate_samples.values())[:10]

            return jsonify(
                {
                    "duplicates_count": duplicates_count,
                    "games_affected": games_affected,
                    "samples": samples,
                }
            ), 200

        except Exception as e:
            logger.error(f"Error in preview deduplication: {e}")
            return jsonify({"error": f"Preview failed: {str(e)}"}), 500

    @app.route("/api/deduplicate", methods=["POST"])
    def api_deduplicate():
        """
        Remove duplicate sentences from database based on time window and game selection.
        Supports ignore_time_window parameter to remove all duplicates regardless of time.
        """
        try:
            data = request.get_json()
            if not data:
                return jsonify({"error": "No data provided"}), 400

            games = data.get("games", [])
            time_window_minutes = data.get("time_window_minutes", 5)
            case_sensitive = data.get("case_sensitive", False)
            preserve_newest = data.get("preserve_newest", False)
            ignore_time_window = data.get("ignore_time_window", False)

            if not games:
                return jsonify({"error": "At least one game must be selected"}), 400

            # Get lines from selected games
            if "all" in games:
                all_lines = GameLinesTable.all()
            else:
                all_lines = []
                for game_name in games:
                    game_lines = GameLinesTable.get_all_lines_for_scene(game_name)
                    all_lines.extend(game_lines)

            if not all_lines:
                return jsonify({"deleted_count": 0}), 200

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

                        line_text = (
                            line.line_text if case_sensitive else line.line_text.lower()
                        )

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

                        line_text = (
                            line.line_text if case_sensitive else line.line_text.lower()
                        )
                        timestamp = float(line.timestamp)

                        # Check for duplicates within time window
                        duplicate_found = False
                        for i, (prev_text, prev_timestamp, prev_line_id) in enumerate(
                            reversed(text_timeline)
                        ):
                            if timestamp - prev_timestamp > time_window_seconds:
                                break  # Outside time window

                            if prev_text == line_text:
                                # Found duplicate within time window
                                if preserve_newest:
                                    # Remove the older one (previous)
                                    duplicates_to_remove.append(prev_line_id)
                                    # Update timeline to replace old entry with new one
                                    timeline_index = len(text_timeline) - 1 - i
                                    text_timeline[timeline_index] = (
                                        line_text,
                                        timestamp,
                                        line.id,
                                    )
                                else:
                                    # Remove the newer one (current)
                                    duplicates_to_remove.append(line.id)

                                duplicate_found = True
                                break

                        if not duplicate_found:
                            text_timeline.append((line_text, timestamp, line.id))

            # Delete the duplicate lines
            deleted_count = 0
            for line_id in set(
                duplicates_to_remove
            ):  # Remove duplicates from deletion list
                try:
                    GameLinesTable._db.execute(
                        f"DELETE FROM {GameLinesTable._table} WHERE id=?",
                        (line_id,),
                        commit=True,
                    )
                    deleted_count += 1
                except Exception as e:
                    logger.warning(f"Failed to delete duplicate line {line_id}: {e}")

            mode_desc = (
                "entire game"
                if ignore_time_window
                else f"{time_window_minutes}min window"
            )
            logger.info(
                f"Deduplication completed: removed {deleted_count} duplicate sentences from {len(games)} games with {mode_desc}"
            )

            # Trigger stats rollup after successful deduplication
            if deleted_count > 0:
                try:
                    logger.info("Triggering stats rollup after deduplication")
                    run_daily_rollup()
                except Exception as rollup_error:
                    logger.error(f"Stats rollup failed after deduplication: {rollup_error}")
                    # Don't fail the deduplication operation if rollup fails

            return jsonify(
                {
                    "deleted_count": deleted_count,
                    "message": f"Successfully removed {deleted_count} duplicate sentences",
                }
            ), 200

        except Exception as e:
            logger.error(f"Error in deduplication: {e}")
            return jsonify({"error": f"Deduplication failed: {str(e)}"}), 500

    @app.route("/api/deduplicate-entire-game", methods=["POST"])
    def api_deduplicate_entire_game():
        """
        Remove duplicate sentences from database across entire games without time window restrictions.
        This is a convenience endpoint that calls the main deduplicate function with ignore_time_window=True.
        """
        try:
            data = request.get_json()
            if not data:
                return jsonify({"error": "No data provided"}), 400

            # Add ignore_time_window=True to the request data
            data["ignore_time_window"] = True

            # Call the main deduplication function
            return api_deduplicate()

        except Exception as e:
            logger.error(f"Error in entire game deduplication: {e}")
            return jsonify(
                {"error": f"Entire game deduplication failed: {str(e)}"}
            ), 500

    @app.route("/api/search-duplicates", methods=["POST"])
    def api_search_duplicates():
        """
        Search for duplicate sentences and return full line details for display in search results.
        Similar to preview-deduplication but returns complete line information with IDs.
        """
        try:
            data = request.get_json()
            if not data:
                return jsonify({"error": "No data provided"}), 400

            game_filter = data.get("game", "")
            time_window_minutes = data.get("time_window_minutes", 5)
            case_sensitive = data.get("case_sensitive", False)
            ignore_time_window = data.get("ignore_time_window", False)

            # Get lines from selected game or all games
            if game_filter:
                all_lines = GameLinesTable.get_all_lines_for_scene(game_filter)
            else:
                all_lines = GameLinesTable.all()

            if not all_lines:
                return jsonify({
                    "results": [],
                    "total": 0,
                    "duplicates_found": 0
                }), 200

            # Group lines by game and sort by timestamp
            game_lines = defaultdict(list)
            for line in all_lines:
                game_name = line.game_name or "Unknown Game"
                game_lines[game_name].append(line)

            # Sort lines within each game by timestamp
            for game_name in game_lines:
                game_lines[game_name].sort(key=lambda x: float(x.timestamp))

            duplicate_line_ids = set()
            time_window_seconds = time_window_minutes * 60

            # Find duplicates for each game
            for game_name, lines in game_lines.items():
                if ignore_time_window:
                    # Find all duplicates regardless of time
                    seen_texts = {}
                    for line in lines:
                        # Ensure line_text is a string
                        if not line.line_text or not isinstance(line.line_text, str):
                            continue
                        if not line.line_text.strip():
                            continue

                        line_text = (
                            line.line_text if case_sensitive else line.line_text.lower()
                        )

                        if line_text in seen_texts:
                            # Mark this as a duplicate (keep first occurrence)
                            duplicate_line_ids.add(line.id)
                        else:
                            seen_texts[line_text] = line.id
                else:
                    # Find duplicates within time window
                    text_timeline = []

                    for line in lines:
                        # Ensure line_text is a string
                        if not line.line_text or not isinstance(line.line_text, str):
                            continue
                        if not line.line_text.strip():
                            continue

                        line_text = (
                            line.line_text if case_sensitive else line.line_text.lower()
                        )
                        timestamp = float(line.timestamp)

                        # Check for duplicates within time window
                        for prev_text, prev_timestamp, prev_line_id in reversed(
                            text_timeline
                        ):
                            if timestamp - prev_timestamp > time_window_seconds:
                                break  # Outside time window

                            if prev_text == line_text:
                                # Found duplicate within time window
                                duplicate_line_ids.add(line.id)
                                break

                        text_timeline.append((line_text, timestamp, line.id))

            # Get full details for all duplicate lines
            duplicate_lines = [line for line in all_lines if line.id in duplicate_line_ids]
            
            # Group duplicates by normalized text for sorting
            # Sort by: 1) normalized text (to group duplicates), 2) timestamp (oldest first within group)
            def get_sort_key(line):
                if not line.line_text or not isinstance(line.line_text, str):
                    return ("", 0)
                normalized_text = line.line_text.lower() if not case_sensitive else line.line_text
                timestamp = float(line.timestamp) if line.timestamp else 0
                return (normalized_text, timestamp)
            
            duplicate_lines.sort(key=get_sort_key)

            # Format results to match search results format
            results = []
            for line in duplicate_lines:
                results.append({
                    "id": line.id,
                    "sentence": line.line_text or "",
                    "game_name": line.game_name or "Unknown Game",
                    "timestamp": float(line.timestamp) if line.timestamp else 0,
                    "translation": line.translation or None,
                    "has_audio": bool(getattr(line, "audio_path", None)),
                    "has_screenshot": bool(getattr(line, "screenshot_path", None)),
                })

            return jsonify({
                "results": results,
                "total": len(results),
                "duplicates_found": len(results),
                "search_mode": "duplicates"
            }), 200

        except Exception as e:
            logger.error(f"Error in search duplicates: {e}")
            return jsonify({"error": f"Duplicate search failed: {str(e)}"}), 500

    @app.route("/api/merge_games", methods=["POST"])
    def api_merge_games():
        """
        Merges multiple selected games into a single game entry.
        The first game in the list becomes the primary game that retains its name.
        All lines from secondary games are moved to the primary game.
        """
        try:
            data = request.get_json()
            target_game = data.get("target_game", None)
            games_to_merge = data.get("games_to_merge", [])

            logger.info(
                f"Merge request received: target_game='{target_game}', games_to_merge={games_to_merge}"
            )

            # Validation
            if not target_game:
                return jsonify({"error": "No target game specified for merging"}), 400

            if not games_to_merge:
                return jsonify({"error": "No games specified for merging"}), 400

            if not isinstance(games_to_merge, list):
                return jsonify({"error": "game_names must be a list"}), 400

            if len(games_to_merge) < 1:
                return jsonify(
                    {"error": "At least 1 game must be selected for merging"}
                ), 400

            # Validate that all games exist
            existing_games = GameLinesTable.get_all_games_with_lines()
            invalid_games = [
                name for name in games_to_merge if name not in existing_games
            ]

            if invalid_games:
                return jsonify(
                    {"error": f"Games not found: {', '.join(invalid_games)}"}
                ), 400

            # Check for duplicate game names
            if len(set(games_to_merge)) != len(games_to_merge):
                return jsonify(
                    {"error": "Duplicate game names found in selection"}
                ), 400

            # Identify primary and secondary games

            # Collect pre-merge statistics
            primary_lines_before = GameLinesTable.get_all_lines_for_scene(target_game)
            total_lines_to_merge = 0
            merge_summary = {
                "primary_game": target_game,
                "secondary_games": games_to_merge,
                "lines_moved": 0,
                "total_lines_after_merge": 0,
            }

            # Calculate lines to be moved and store counts
            secondary_game_line_counts = {}
            for game_name in games_to_merge:
                secondary_lines = GameLinesTable.get_all_lines_for_scene(game_name)
                line_count = len(secondary_lines)
                secondary_game_line_counts[game_name] = line_count
                total_lines_to_merge += line_count

            if total_lines_to_merge == 0:
                return jsonify(
                    {"error": "No lines found in secondary games to merge"}
                ), 400

            # Begin database transaction for merge
            try:
                # Get the target game's game_id (pick the first valid one we find)
                target_game_id_result = GameLinesTable._db.fetchone(
                    f"SELECT game_id FROM {GameLinesTable._table} WHERE game_name = ? AND game_id IS NOT NULL AND game_id != '' LIMIT 1",
                    (target_game,)
                )
                target_game_id = target_game_id_result[0] if target_game_id_result else None
                # Perform the merge operation within transaction
                lines_moved = 0
                for game_name in games_to_merge:
                    # Update game_name for all lines belonging to this secondary game
                    # Also set original_game_name to preserve the original title
                    # Ensure the table name is as expected to prevent SQL injection
                    if GameLinesTable._table != "game_lines":
                        raise ValueError(
                            "Unexpected table name in GameLinesTable._table"
                        )
                    GameLinesTable._db.execute(
                        "UPDATE game_lines SET game_name=?, game_id=?, original_game_name=COALESCE(original_game_name, ?) WHERE game_name=?",
                        (target_game, target_game_id, game_name, game_name),
                        commit=True,
                    )

                    # Add the count we calculated earlier
                    lines_moved += secondary_game_line_counts[game_name]

                # Update merge summary
                merge_summary["lines_moved"] = lines_moved
                merge_summary["total_lines_after_merge"] = (
                    len(primary_lines_before) + lines_moved
                )

                # Log the successful merge
                logger.info(
                    f"Successfully merged {len(games_to_merge)} games into '{target_game}': moved {lines_moved} lines"
                )

                # Prepare success response
                response_data = {
                    "message": f'Successfully merged {len(games_to_merge)} games into "{target_game}"',
                    "primary_game": target_game,
                    "merged_games": games_to_merge,
                    "lines_moved": lines_moved,
                    "total_lines_in_primary": merge_summary["total_lines_after_merge"],
                    "merge_summary": merge_summary,
                }

                # Trigger stats rollup after successful merge
                try:
                    logger.info("Triggering stats rollup after game merge")
                    run_daily_rollup()
                except Exception as rollup_error:
                    logger.error(f"Stats rollup failed after game merge: {rollup_error}")
                    # Don't fail the merge operation if rollup fails

                return jsonify(response_data), 200

            except Exception as db_error:
                logger.error(
                    f"Database error during game merge: {db_error}", exc_info=True
                )
                return jsonify(
                    {
                        "error": f"Failed to merge games due to database error: {str(db_error)}"
                    }
                ), 500

        except Exception as e:
            logger.error(f"Error in game merge API: {e}")
            return jsonify({"error": f"Game merge failed: {str(e)}"}), 500
