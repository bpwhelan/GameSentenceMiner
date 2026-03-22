"""
Import API Endpoint

This module contains the /api/import-exstatic endpoint, extracted from
stats_api.py so that the stats module stays focused on stats.
"""

from __future__ import annotations

import csv
import datetime
import io

from flask import jsonify, request

from GameSentenceMiner.util.config.configuration import logger
from GameSentenceMiner.util.cron import cron_scheduler
from GameSentenceMiner.util.database.db import GameLinesTable
from GameSentenceMiner.util.text_log import GameLine


def register_import_api_routes(app):
    """Register import API routes with the Flask app."""

    @app.route("/api/import-exstatic", methods=["POST"])
    def api_import_exstatic():
        """
        Import ExStatic CSV data into GSM database.
        ---
        tags:
          - Import/Export
        consumes:
          - multipart/form-data
        parameters:
          - name: file
            in: formData
            type: file
            required: true
            description: CSV file with ExStatic data (uuid,given_identifier,name,line,time)
        responses:
          200:
            description: Import results with statistics
            schema:
              type: object
              properties:
                message: {type: string}
                imported_count: {type: integer}
                games_count: {type: integer}
                games: {type: array, items: {type: string}}
                warnings: {type: array, items: {type: string}}
                warning_count: {type: integer}
          400:
            description: Invalid file format or missing file
          500:
            description: Import failed due to server error
        """
        try:
            # Check if file is provided
            if "file" not in request.files:
                return jsonify({"error": "No file provided"}), 400

            file = request.files["file"]
            if file.filename == "":
                return jsonify({"error": "No file selected"}), 400

            # Validate file type
            if not file.filename.lower().endswith(".csv"):
                return jsonify({"error": "File must be a CSV file"}), 400

            # Read and parse CSV
            try:
                # Read file content as text with proper encoding handling
                file_content = file.read().decode("utf-8-sig")  # Handle BOM if present

                # First, get the header line manually to avoid issues with multi-line content
                lines = file_content.split("\n")
                if len(lines) == 1 and not lines[0].strip():
                    return jsonify({"error": "Empty CSV file"}), 400

                header_line = lines[0].strip()

                # Parse headers manually
                header_reader = csv.reader([header_line])
                try:
                    headers = next(header_reader)
                    headers = [h.strip() for h in headers]  # Clean whitespace

                except StopIteration:
                    return jsonify({"error": "Could not parse CSV headers"}), 400

                # Validate headers
                expected_headers = {"uuid", "given_identifier", "name", "line", "time"}
                actual_headers = set(headers)

                if not expected_headers.issubset(actual_headers):
                    missing_headers = expected_headers - actual_headers
                    # Check if this looks like a stats CSV instead of lines CSV
                    if "client" in actual_headers and "chars_read" in actual_headers:
                        return jsonify(
                            {
                                "error": "This appears to be an ExStatic stats CSV. Please upload the ExStatic lines CSV file instead. The lines CSV should contain columns: uuid, given_identifier, name, line, time"
                            }
                        ), 400
                    else:
                        return jsonify(
                            {
                                "error": f"Invalid CSV format. Missing required columns: {', '.join(missing_headers)}. Expected format: uuid, given_identifier, name, line, time. Found headers: {', '.join(actual_headers)}"
                            }
                        ), 400

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

                def get_line_hash(uuid: str, given_identifier: str) -> str:
                    return uuid + "|" + given_identifier.strip()

                for row_num, row in enumerate(csv_reader):
                    try:
                        # Extract and validate required fields
                        game_uuid = row.get("uuid", "").strip()
                        given_identifier = row.get("given_identifier", "").strip()
                        game_name = row.get("name", "").strip()
                        line = row.get("line", "").strip()
                        time_str = row.get("time", "").strip()

                        # Validate required fields
                        if not game_uuid:
                            errors.append(f"Row {row_num}: Missing UUID")
                            continue
                        if not given_identifier:
                            errors.append(f"Row {row_num}: Missing given identifier")
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

                        line_hash = get_line_hash(game_uuid, given_identifier)

                        # Check if this line already exists in database
                        if line_hash in existing_uuids:
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
                        batch_insert.append(
                            GameLine(
                                id=line_hash,
                                text=line_text,
                                scene=game_name,
                                time=dt,
                                prev=None,
                                next=None,
                                index=0,
                            )
                        )

                        existing_uuids.add(line_hash)  # Add to existing to prevent duplicates in same import

                        if len(batch_insert) >= batch_size:
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
                    GameLinesTable.add_lines(batch_insert)
                    imported_count += len(batch_insert)
                    batch_insert = []

                # Queue daily rollup so stats refresh after the import completes.
                logger.info("Queuing daily rollup after ExStatic import to update statistics...")
                rollup_status = "queued"
                rollup_message = "Daily rollup has been queued."
                try:
                    cron_scheduler.force_daily_rollup()
                    logger.info("Daily rollup queued after ExStatic import")
                except Exception as rollup_error:
                    rollup_status = "failed"
                    rollup_message = "Daily rollup could not be queued."
                    logger.error(f"Error running daily rollup after import: {rollup_error}")
                    # Don't fail the import if rollup fails - just log it

                # Prepare response
                response_data = {
                    "message": (
                        f"Successfully imported {imported_count} lines from {len(games_set)} games. {rollup_message}"
                    ),
                    "imported_count": imported_count,
                    "games_count": len(games_set),
                    "games": list(games_set),
                    "rollup_status": rollup_status,
                    "rollup_message": rollup_message,
                }

                if errors:
                    response_data["warnings"] = errors
                    response_data["warning_count"] = len(errors)

                return jsonify(response_data), 200

            except csv.Error as e:
                return jsonify({"error": f"CSV parsing error: {str(e)}"}), 400
            except UnicodeDecodeError:
                return jsonify({"error": "File encoding error. Please ensure the CSV is UTF-8 encoded."}), 400

        except Exception as e:
            logger.error(f"Error in ExStatic import: {e}")
            return jsonify({"error": f"Import failed: {str(e)}"}), 500
