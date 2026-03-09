"""
Third-Party Stats API Endpoints

Provides endpoints for importing and managing pre-computed reading stats
from external applications (Mokuro, manual entry, etc.).
"""

import json
from collections import defaultdict
from datetime import datetime, timezone

from flask import request, jsonify

from GameSentenceMiner.util.config.configuration import logger


def parse_mokuro_volume_data(volume_data: dict) -> list[dict]:
    """
    Parse Mokuro volume-data.json into per-day reading stats.

    For volumes with recentPageTurns, groups page turns by date and computes
    chars read per day from the running chars_so_far total. Time is distributed
    proportionally based on chars read per day.

    For volumes without page turns, creates a single entry using lastProgressUpdate
    or addedOn as the date.

    Args:
        volume_data: Parsed JSON dict from Mokuro volume-data.json

    Returns:
        List of dicts with keys: date, characters_read, time_read_seconds, label
    """
    results = []

    for volume_id, volume in volume_data.items():
        # Skip deleted volumes
        if volume.get("deletedOn"):
            continue

        # Skip placeholder entries (no series info)
        if not volume.get("series_title") and not volume.get("volume_title"):
            continue

        total_chars = volume.get("chars", 0)
        total_time_minutes = volume.get("timeReadInMinutes", 0)

        # Skip volumes with no reading data
        if not total_chars and not total_time_minutes:
            continue

        total_time_seconds = total_time_minutes * 60.0

        # Build label
        series = volume.get("series_title", "")
        vol = volume.get("volume_title", "")
        if series and vol:
            label = f"{series} - {vol}"
        else:
            label = series or vol or volume_id

        page_turns = volume.get("recentPageTurns", [])

        if page_turns:
            daily_stats = _analyze_page_turns(
                page_turns, total_chars, total_time_seconds, volume
            )
            for date_str, stats in sorted(daily_stats.items()):
                if stats["chars"] > 0 or stats["time"] > 0:
                    results.append(
                        {
                            "date": date_str,
                            "characters_read": stats["chars"],
                            "time_read_seconds": stats["time"],
                            "label": label,
                        }
                    )
        else:
            # No page turns - use lastProgressUpdate or addedOn as single date
            date_str = _extract_date_from_volume(volume)
            if date_str and (total_chars > 0 or total_time_seconds > 0):
                results.append(
                    {
                        "date": date_str,
                        "characters_read": total_chars,
                        "time_read_seconds": total_time_seconds,
                        "label": label,
                    }
                )

    return results


def _analyze_page_turns(
    page_turns: list, total_chars: int, total_time_seconds: float, volume: dict
) -> dict:
    """
    Compute per-day character counts from page turn data.

    Each page turn is [timestamp_ms, page_number, chars_so_far].
    We use a high-water mark approach: new characters are counted only when
    chars_so_far exceeds the previous maximum. Each increment beyond the
    high-water mark is attributed to the date of that page turn. This correctly
    handles:
    - Backward navigation (user re-reads pages; chars_so_far decreases)
    - Inter-day gaps (chars read between sessions attributed to next session's date)

    Chars read before the first logged page turn (first_chars_so_far > 0)
    are attributed to the volume's `addedOn` date if available, otherwise
    to the first page turn's date.

    Time is distributed proportionally across days based on chars read per day.

    Returns:
        dict: date_str -> {"chars": int, "time": float}
    """
    # Sort by timestamp
    sorted_turns = sorted(page_turns, key=lambda t: t[0])

    if not sorted_turns:
        return {}

    # Track new characters using a high-water mark.
    # Only chars_so_far values that exceed the running max count as new reading.
    daily_chars: dict[str, int] = defaultdict(int)
    high_water = sorted_turns[0][2] if len(sorted_turns[0]) > 2 else 0

    for i in range(1, len(sorted_turns)):
        curr_chars = sorted_turns[i][2] if len(sorted_turns[i]) > 2 else 0

        if curr_chars > high_water:
            new_chars = curr_chars - high_water
            ts_ms = sorted_turns[i][0]
            dt = datetime.fromtimestamp(ts_ms / 1000.0, tz=timezone.utc)
            date_str = dt.strftime("%Y-%m-%d")
            daily_chars[date_str] += new_chars
            high_water = curr_chars

    # Handle chars read before the first page turn in the log.
    # If the first page turn has chars_so_far > 0, those chars were read
    # before the logged page turns. Attribute them to `addedOn` date if available,
    # or the first page turn date otherwise.
    first_chars_so_far = sorted_turns[0][2] if len(sorted_turns[0]) > 2 else 0
    if first_chars_so_far > 0:
        added_on = volume.get("addedOn")
        added_date = None
        if added_on:
            try:
                added_date = datetime.fromisoformat(
                    added_on.replace("Z", "+00:00")
                ).strftime("%Y-%m-%d")
            except (ValueError, AttributeError):
                pass

        # Attribute pre-log chars to addedOn date or first turn date
        first_turn_date = datetime.fromtimestamp(
            sorted_turns[0][0] / 1000.0, tz=timezone.utc
        ).strftime("%Y-%m-%d")
        target_date = added_date or first_turn_date
        daily_chars[target_date] += first_chars_so_far

    # Ensure we have at least one date entry even if all deltas were zero
    if not daily_chars:
        first_turn_date = datetime.fromtimestamp(
            sorted_turns[0][0] / 1000.0, tz=timezone.utc
        ).strftime("%Y-%m-%d")
        daily_chars[first_turn_date] = 0

    # Distribute time proportionally across days based on chars
    total_daily_chars = sum(daily_chars.values())
    daily_stats = {}

    if total_daily_chars > 0:
        for date_str, chars in daily_chars.items():
            ratio = chars / total_daily_chars
            daily_stats[date_str] = {
                "chars": chars,
                "time": round(total_time_seconds * ratio, 1),
            }
    else:
        # Edge case: page turns exist but no char deltas (all same page)
        # Put all time on the first day
        first_date = min(daily_chars.keys())
        daily_stats[first_date] = {
            "chars": 0,
            "time": total_time_seconds,
        }

    return daily_stats


def _extract_date_from_volume(volume: dict) -> str | None:
    """Extract a YYYY-MM-DD date from volume metadata."""
    for field in ("lastProgressUpdate", "addedOn"):
        value = volume.get(field)
        if value:
            try:
                dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
                return dt.strftime("%Y-%m-%d")
            except (ValueError, AttributeError):
                continue
    return None


def register_third_party_stats_routes(app):
    """Register third-party stats API routes with the Flask app."""

    @app.route("/api/third-party-stats", methods=["GET"])
    def api_get_third_party_stats():
        """List all third-party stats entries, optionally filtered by source."""
        from GameSentenceMiner.util.database.third_party_stats_table import (
            ThirdPartyStatsTable,
        )

        source = request.args.get("source")
        try:
            if source:
                entries = ThirdPartyStatsTable.get_all_by_source(source)
            else:
                entries = ThirdPartyStatsTable.all()

            return jsonify(
                {
                    "entries": [
                        {
                            "id": e.id,
                            "date": e.date,
                            "characters_read": e.characters_read,
                            "time_read_seconds": e.time_read_seconds,
                            "source": e.source,
                            "label": e.label,
                            "created_at": e.created_at,
                        }
                        for e in entries
                    ],
                    "count": len(entries),
                }
            ), 200
        except Exception as e:
            logger.error(f"Error fetching third-party stats: {e}")
            return jsonify({"error": "Failed to fetch third-party stats"}), 500

    @app.route("/api/third-party-stats/summary", methods=["GET"])
    def api_third_party_stats_summary():
        """Get summary of third-party stats (counts, totals by source)."""
        from GameSentenceMiner.util.database.third_party_stats_table import (
            ThirdPartyStatsTable,
        )

        try:
            summary = ThirdPartyStatsTable.get_summary()
            return jsonify(summary), 200
        except Exception as e:
            logger.error(f"Error fetching third-party stats summary: {e}")
            return jsonify({"error": "Failed to fetch summary"}), 500

    @app.route("/api/third-party-stats", methods=["POST"])
    def api_add_third_party_stat():
        """Add a manual third-party stats entry."""
        from GameSentenceMiner.util.database.third_party_stats_table import (
            ThirdPartyStatsTable,
        )

        try:
            data = request.get_json()
            if not data:
                return jsonify({"error": "No data provided"}), 400

            date_str = data.get("date", "").strip()
            characters_read = data.get("characters_read", 0)
            time_read_seconds = data.get("time_read_seconds", 0)
            label = data.get("label", "").strip()

            # Validate date
            if not date_str:
                return jsonify({"error": "Date is required"}), 400
            try:
                datetime.strptime(date_str, "%Y-%m-%d")
            except ValueError:
                return jsonify({"error": "Date must be in YYYY-MM-DD format"}), 400

            # Validate numbers
            try:
                characters_read = int(characters_read)
                time_read_seconds = float(time_read_seconds)
            except (ValueError, TypeError):
                return jsonify(
                    {
                        "error": "characters_read must be int, time_read_seconds must be number"
                    }
                ), 400

            if characters_read < 0 or time_read_seconds < 0:
                return jsonify({"error": "Values cannot be negative"}), 400

            if characters_read == 0 and time_read_seconds == 0:
                return jsonify(
                    {
                        "error": "At least one of characters_read or time_read_seconds must be > 0"
                    }
                ), 400

            source = data.get("source", "manual").strip() or "manual"

            entry = ThirdPartyStatsTable(
                date=date_str,
                characters_read=characters_read,
                time_read_seconds=time_read_seconds,
                source=source,
                label=label or "Manual entry",
            )
            entry.save()

            return jsonify(
                {
                    "message": "Entry added successfully",
                    "id": entry.id,
                    "entry": {
                        "id": entry.id,
                        "date": entry.date,
                        "characters_read": entry.characters_read,
                        "time_read_seconds": entry.time_read_seconds,
                        "source": entry.source,
                        "label": entry.label,
                    },
                }
            ), 201
        except Exception as e:
            logger.error(f"Error adding third-party stat: {e}")
            return jsonify({"error": f"Failed to add entry: {str(e)}"}), 500

    @app.route("/api/third-party-stats/<int:entry_id>", methods=["DELETE"])
    def api_delete_third_party_stat(entry_id):
        """Delete a single third-party stats entry by ID."""
        from GameSentenceMiner.util.database.third_party_stats_table import (
            ThirdPartyStatsTable,
        )

        try:
            entry = ThirdPartyStatsTable.get(entry_id)
            if not entry:
                return jsonify({"error": "Entry not found"}), 404
            entry.delete()
            return jsonify({"message": "Entry deleted successfully"}), 200
        except Exception as e:
            logger.error(f"Error deleting third-party stat {entry_id}: {e}")
            return jsonify({"error": "Failed to delete entry"}), 500

    @app.route("/api/third-party-stats/source/<source>", methods=["DELETE"])
    def api_delete_third_party_stats_by_source(source):
        """Delete all third-party stats entries for a given source."""
        from GameSentenceMiner.util.database.third_party_stats_table import (
            ThirdPartyStatsTable,
        )

        try:
            count = ThirdPartyStatsTable.delete_by_source(source)
            return jsonify(
                {
                    "message": f"Deleted {count} entries from source '{source}'",
                    "deleted_count": count,
                }
            ), 200
        except Exception as e:
            logger.error(f"Error deleting third-party stats for source {source}: {e}")
            return jsonify({"error": "Failed to delete entries"}), 500

    @app.route("/api/import-stats", methods=["POST"])
    def api_import_stats_batch():
        """
        Batch import third-party stats entries.

        Accepts a JSON body with an array of entries. Designed as a
        programmatic API for scripts and external tools.

        Request body:
            {
                "entries": [
                    {
                        "date": "YYYY-MM-DD",
                        "characters_read": int,
                        "time_read_seconds": float,
                        "source": "string",      // e.g. "ttsu", "custom_script"
                        "label": "string"         // e.g. book title
                    },
                    ...
                ],
                "clear_source": "string" | null  // optional: delete all existing entries
                                                 // for this source before importing
            }
        """
        from GameSentenceMiner.util.database.third_party_stats_table import (
            ThirdPartyStatsTable,
        )

        try:
            data = request.get_json()
            if not data:
                return jsonify({"error": "No JSON data provided"}), 400

            entries = data.get("entries")
            if not entries or not isinstance(entries, list):
                return jsonify({"error": "'entries' must be a non-empty array"}), 400

            if len(entries) > 50000:
                return jsonify({"error": "Maximum 50000 entries per request"}), 400

            clear_source = data.get("clear_source")

            # Validate all entries before inserting any
            validated = []
            errors = []
            for i, entry in enumerate(entries):
                if not isinstance(entry, dict):
                    errors.append(f"Entry {i}: must be an object")
                    continue

                date_str = str(entry.get("date", "")).strip()
                if not date_str:
                    errors.append(f"Entry {i}: 'date' is required")
                    continue
                try:
                    datetime.strptime(date_str, "%Y-%m-%d")
                except ValueError:
                    errors.append(
                        f"Entry {i}: 'date' must be YYYY-MM-DD (got '{date_str}')"
                    )
                    continue

                try:
                    characters_read = int(entry.get("characters_read", 0))
                    time_read_seconds = float(entry.get("time_read_seconds", 0))
                except (ValueError, TypeError):
                    errors.append(
                        f"Entry {i}: invalid number for characters_read or time_read_seconds"
                    )
                    continue

                if characters_read < 0 or time_read_seconds < 0:
                    errors.append(f"Entry {i}: values cannot be negative")
                    continue

                if characters_read == 0 and time_read_seconds == 0:
                    continue  # Silently skip zero entries

                source = str(entry.get("source", "")).strip()
                if not source:
                    errors.append(f"Entry {i}: 'source' is required")
                    continue

                label = str(entry.get("label", "")).strip() or source

                validated.append(
                    {
                        "date": date_str,
                        "characters_read": characters_read,
                        "time_read_seconds": time_read_seconds,
                        "source": source,
                        "label": label,
                    }
                )

            if errors and not validated:
                return jsonify(
                    {"error": "All entries failed validation", "details": errors}
                ), 400

            # Clear previous data for the source if requested
            cleared_count = 0
            if clear_source:
                cleared_count = ThirdPartyStatsTable.delete_by_source(
                    str(clear_source).strip()
                )

            # Insert all validated entries
            imported_count = 0
            total_characters = 0
            total_time = 0.0

            for entry_data in validated:
                obj = ThirdPartyStatsTable(
                    date=entry_data["date"],
                    characters_read=entry_data["characters_read"],
                    time_read_seconds=entry_data["time_read_seconds"],
                    source=entry_data["source"],
                    label=entry_data["label"],
                )
                obj.save()
                imported_count += 1
                total_characters += entry_data["characters_read"]
                total_time += entry_data["time_read_seconds"]

            result = {
                "message": f"Successfully imported {imported_count} entries",
                "imported_count": imported_count,
                "total_characters": total_characters,
                "total_time_seconds": round(total_time, 1),
                "cleared_count": cleared_count,
            }
            if errors:
                result["warnings"] = errors
                result["skipped_count"] = len(errors)

            return jsonify(result), 200

        except Exception as e:
            logger.error(f"Error in batch import: {e}")
            return jsonify({"error": f"Import failed: {str(e)}"}), 500

    @app.route("/api/import-mokuro", methods=["POST"])
    def api_import_mokuro():
        """
        Import Mokuro volume-data.json file.

        Parses page turn data to compute per-day reading stats.
        Optionally clears previous Mokuro data before importing.
        """
        from GameSentenceMiner.util.database.third_party_stats_table import (
            ThirdPartyStatsTable,
        )

        try:
            # Check if file is provided
            if "file" not in request.files:
                return jsonify({"error": "No file provided"}), 400

            file = request.files["file"]
            if file.filename == "":
                return jsonify({"error": "No file selected"}), 400

            # Validate file type
            if not file.filename.lower().endswith(".json"):
                return jsonify({"error": "File must be a JSON file"}), 400

            # Check if we should clear previous mokuro data
            clear_previous = (
                request.form.get("clear_previous", "false").lower() == "true"
            )

            # Read and parse JSON
            try:
                file_content = file.read().decode("utf-8-sig")
                volume_data = json.loads(file_content)
            except (json.JSONDecodeError, UnicodeDecodeError) as e:
                return jsonify({"error": f"Invalid JSON file: {str(e)}"}), 400

            if not isinstance(volume_data, dict):
                return jsonify(
                    {"error": "Expected a JSON object with volume UUIDs as keys"}
                ), 400

            # Clear previous mokuro data if requested
            cleared_count = 0
            if clear_previous:
                cleared_count = ThirdPartyStatsTable.delete_by_source("mokuro")

            # Parse the volume data
            parsed_entries = parse_mokuro_volume_data(volume_data)

            if not parsed_entries:
                return jsonify(
                    {
                        "message": "No valid reading data found in the file",
                        "imported_count": 0,
                        "cleared_count": cleared_count,
                        "volumes_processed": len(volume_data),
                    }
                ), 200

            # Save all entries
            imported_count = 0
            volumes_seen = set()
            date_range = {"min": None, "max": None}

            for entry_data in parsed_entries:
                entry = ThirdPartyStatsTable(
                    date=entry_data["date"],
                    characters_read=entry_data["characters_read"],
                    time_read_seconds=entry_data["time_read_seconds"],
                    source="mokuro",
                    label=entry_data["label"],
                )
                entry.save()
                imported_count += 1
                volumes_seen.add(entry_data["label"])

                if date_range["min"] is None or entry_data["date"] < date_range["min"]:
                    date_range["min"] = entry_data["date"]
                if date_range["max"] is None or entry_data["date"] > date_range["max"]:
                    date_range["max"] = entry_data["date"]

            total_chars = sum(e["characters_read"] for e in parsed_entries)
            total_time = sum(e["time_read_seconds"] for e in parsed_entries)

            return jsonify(
                {
                    "message": f"Successfully imported {imported_count} daily entries from {len(volumes_seen)} volumes",
                    "imported_count": imported_count,
                    "cleared_count": cleared_count,
                    "volumes_processed": len(volume_data),
                    "volumes_with_data": len(volumes_seen),
                    "total_characters": total_chars,
                    "total_time_minutes": round(total_time / 60, 1),
                    "date_range": date_range,
                    "volumes": sorted(volumes_seen),
                }
            ), 200

        except Exception as e:
            logger.error(f"Error importing Mokuro data: {e}")
            return jsonify({"error": f"Import failed: {str(e)}"}), 500
