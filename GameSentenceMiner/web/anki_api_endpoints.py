"""
Separate API endpoints for Anki statistics to improve performance through progressive loading.
These endpoints replace the monolithic /api/anki_stats_combined endpoint.

Uses hybrid rollup + live approach similar to /api/stats for GSM-based data (kanji, mining heatmap).
Anki review data (retention, game stats) still requires direct AnkiConnect queries.
"""

import concurrent.futures
import datetime
import traceback
from flask import request, jsonify
from GameSentenceMiner.util.configuration import get_config
from GameSentenceMiner.anki import invoke
from GameSentenceMiner.web.stats import (
    calculate_kanji_frequency,
    calculate_mining_heatmap_data,
    is_kanji,
    aggregate_rollup_data,
    calculate_live_stats_for_today,
    combine_rollup_and_live_stats,
)
from GameSentenceMiner.util.db import GameLinesTable
from GameSentenceMiner.util.stats_rollup_table import StatsRollupTable
from GameSentenceMiner.util.configuration import logger


def register_anki_api_endpoints(app):
    """Register all Anki API endpoints with the Flask app."""

    @app.route("/api/anki_earliest_date")
    def api_anki_earliest_date():
        """Get the earliest Anki card creation date for date range initialization."""
        try:
            card_ids = invoke("findCards", query="")
            if card_ids:
                # Only get first 100 cards to find earliest date quickly
                sample_cards = card_ids[:100] if len(card_ids) > 100 else card_ids
                cards_info = invoke("cardsInfo", cards=sample_cards)
                created_times = [
                    card.get("created", 0) for card in cards_info if "created" in card
                ]
                earliest_date = min(created_times) if created_times else 0
            else:
                earliest_date = 0

            return jsonify({"earliest_date": earliest_date})
        except Exception as e:
            logger.error(f"Failed to fetch earliest date from Anki: {e}")
            return jsonify({"earliest_date": 0})

    @app.route("/api/anki_kanji_stats")
    def api_anki_kanji_stats():
        """
        Get kanji statistics including missing kanji analysis.
        Uses hybrid rollup + live approach for GSM kanji data.
        """
        start_timestamp = (
            int(request.args.get("start_timestamp"))
            if request.args.get("start_timestamp")
            else None
        )
        end_timestamp = (
            int(request.args.get("end_timestamp"))
            if request.args.get("end_timestamp")
            else None
        )

        try:
            # === HYBRID ROLLUP + LIVE APPROACH FOR GSM KANJI ===
            today = datetime.date.today()
            today_str = today.strftime("%Y-%m-%d")

            # Determine date range
            if start_timestamp and end_timestamp:
                try:
                    # Convert milliseconds to seconds for fromtimestamp
                    # Handle negative timestamps (before epoch) by clamping to epoch
                    start_ts_seconds = max(0, start_timestamp / 1000.0)
                    end_ts_seconds = max(0, end_timestamp / 1000.0)

                    start_date = datetime.date.fromtimestamp(start_ts_seconds)
                    end_date = datetime.date.fromtimestamp(end_ts_seconds)
                    start_date_str = start_date.strftime("%Y-%m-%d")
                    end_date_str = end_date.strftime("%Y-%m-%d")
                except (ValueError, OSError) as e:
                    logger.error(
                        f"Invalid timestamp conversion: start={start_timestamp}, end={end_timestamp}, error={e}"
                    )
                    # Fallback to using all data
                    start_date_str = None
                    end_date_str = today_str
            else:
                start_date_str = None
                end_date_str = today_str

            # Check if today is in the date range
            today_in_range = (not end_date_str) or (end_date_str >= today_str)

            # Query rollup data for historical dates (up to yesterday)
            rollup_stats = None
            if start_date_str:
                yesterday = today - datetime.timedelta(days=1)
                yesterday_str = yesterday.strftime("%Y-%m-%d")

                if start_date_str <= yesterday_str:
                    rollup_end = (
                        min(end_date_str, yesterday_str)
                        if end_date_str
                        else yesterday_str
                    )
                    rollups = StatsRollupTable.get_date_range(
                        start_date_str, rollup_end
                    )

                    if rollups:
                        rollup_stats = aggregate_rollup_data(rollups)

            # Calculate today's stats live if needed
            live_stats = None
            if today_in_range:
                today_start = datetime.datetime.combine(
                    today, datetime.time.min
                ).timestamp()
                today_end = datetime.datetime.combine(
                    today, datetime.time.max
                ).timestamp()
                today_lines = GameLinesTable.get_lines_filtered_by_timestamp(
                    start=today_start, end=today_end, for_stats=True
                )

                if today_lines:
                    live_stats = calculate_live_stats_for_today(today_lines)

            # Combine rollup and live stats
            combined_stats = combine_rollup_and_live_stats(rollup_stats, live_stats)

            # Extract kanji frequency data from combined stats
            kanji_freq_dict = combined_stats.get("kanji_frequency_data", {})

            # If no rollup data, fall back to querying all lines
            if not kanji_freq_dict:
                logger.debug(
                    "[Anki Kanji] No rollup data, falling back to direct query"
                )
                try:
                    if start_timestamp is not None and end_timestamp is not None:
                        # Handle negative timestamps by clamping to 0
                        start_ts = max(0, start_timestamp / 1000.0)
                        end_ts = max(0, end_timestamp / 1000.0)
                        all_lines = GameLinesTable.get_lines_filtered_by_timestamp(
                            start=start_ts, end=end_ts, for_stats=True
                        )
                    else:
                        all_lines = GameLinesTable.all()
                except Exception as e:
                    logger.error(f"Error querying lines by timestamp: {e}")
                    logger.error(traceback.format_exc())
                    all_lines = GameLinesTable.all()
                gsm_kanji_stats = calculate_kanji_frequency(all_lines)
            else:
                # Convert rollup kanji data to expected format
                from GameSentenceMiner.web.stats import get_gradient_color

                max_frequency = max(kanji_freq_dict.values()) if kanji_freq_dict else 0
                sorted_kanji = sorted(
                    kanji_freq_dict.items(), key=lambda x: x[1], reverse=True
                )

                kanji_data = []
                for kanji, count in sorted_kanji:
                    color = get_gradient_color(count, max_frequency)
                    kanji_data.append(
                        {"kanji": kanji, "frequency": count, "color": color}
                    )

                gsm_kanji_stats = {
                    "kanji_data": kanji_data,
                    "unique_count": len(sorted_kanji),
                    "max_frequency": max_frequency,
                }

            # Fetch Anki kanji (still requires direct query)
            def get_anki_kanji():
                try:
                    note_ids = invoke("findNotes", query="")
                    anki_kanji_set = set()
                    if note_ids:
                        # Process in smaller batches for better performance
                        batch_size = 500
                        for i in range(0, len(note_ids), batch_size):
                            batch_ids = note_ids[i : i + batch_size]
                            notes_info = invoke("notesInfo", notes=batch_ids)
                            for note in notes_info:
                                # Filter by timestamp if provided
                                note_created = note.get("created", None) or note.get(
                                    "mod", None
                                )
                                if (
                                    start_timestamp
                                    and end_timestamp
                                    and note_created is not None
                                ):
                                    note_created_int = int(note_created)
                                    start_ts = int(start_timestamp)
                                    end_ts = int(end_timestamp)
                                    if not (start_ts <= note_created_int <= end_ts):
                                        continue

                                fields = note.get("fields", {})
                                first_field = next(iter(fields.values()), None)
                                if first_field and "value" in first_field:
                                    first_field_value = first_field["value"]
                                    for char in first_field_value:
                                        if is_kanji(char):
                                            anki_kanji_set.add(char)
                    return anki_kanji_set
                except Exception as e:
                    logger.error(f"Failed to fetch kanji from Anki: {e}")
                    return set()

            anki_kanji_set = get_anki_kanji()

            gsm_kanji_list = gsm_kanji_stats.get("kanji_data", [])
            gsm_kanji_set = set([k["kanji"] for k in gsm_kanji_list])

            # Find missing kanji
            missing_kanji = [
                {"kanji": k["kanji"], "frequency": k["frequency"]}
                for k in gsm_kanji_list
                if k["kanji"] not in anki_kanji_set
            ]
            missing_kanji.sort(key=lambda x: x["frequency"], reverse=True)

            # Calculate coverage
            anki_kanji_count = len(anki_kanji_set)
            gsm_kanji_count = len(gsm_kanji_set)
            coverage_percent = (
                (anki_kanji_count / gsm_kanji_count * 100) if gsm_kanji_count else 0.0
            )

            return jsonify(
                {
                    "missing_kanji": missing_kanji,
                    "anki_kanji_count": anki_kanji_count,
                    "gsm_kanji_count": gsm_kanji_count,
                    "coverage_percent": round(coverage_percent, 1),
                }
            )

        except Exception as e:
            logger.error(f"Error fetching kanji stats: {e}")
            logger.error(traceback.format_exc())
            return jsonify({"error": str(e)}), 500

    @app.route("/api/anki_game_stats")
    def api_anki_game_stats():
        """Get game-specific Anki statistics."""
        start_timestamp = (
            int(request.args.get("start_timestamp"))
            if request.args.get("start_timestamp")
            else None
        )
        end_timestamp = (
            int(request.args.get("end_timestamp"))
            if request.args.get("end_timestamp")
            else None
        )
        parent_tag = get_config().anki.parent_tag.strip() or "Game"

        try:
            # Find all cards with Game:: parent tag
            query = f"tag:{parent_tag}::*"
            card_ids = invoke("findCards", query=query)
            game_stats = []

            if not card_ids:
                return jsonify([])

            # Get card info and filter by date
            cards_info = invoke("cardsInfo", cards=card_ids)

            if start_timestamp and end_timestamp:
                cards_info = [
                    card
                    for card in cards_info
                    if start_timestamp <= card.get("created", 0) <= end_timestamp
                ]

            if not cards_info:
                return jsonify([])

            # Get all unique note IDs and fetch note info in one batch call
            note_ids = list(set(card["note"] for card in cards_info))
            notes_info_list = invoke("notesInfo", notes=note_ids)
            notes_info = {note["noteId"]: note for note in notes_info_list}

            # Create card-to-note mapping
            card_to_note = {str(card["cardId"]): card["note"] for card in cards_info}

            # Group cards by game
            game_cards = {}
            for card in cards_info:
                note_id = card["note"]
                note_info = notes_info.get(note_id)
                if not note_info:
                    continue

                tags = note_info.get("tags", [])

                # Find game tag (format: Game::GameName)
                game_tag = None
                for tag in tags:
                    if tag.startswith(f"{parent_tag}::"):
                        tag_parts = tag.split("::")
                        if len(tag_parts) >= 2:
                            game_tag = tag_parts[1]
                            break

                if game_tag:
                    if game_tag not in game_cards:
                        game_cards[game_tag] = []
                    game_cards[game_tag].append(card["cardId"])

            # Process games concurrently
            def process_game(game_name, card_ids):
                try:
                    # Get review history for all cards in this game
                    reviews_data = invoke("getReviewsOfCards", cards=card_ids)

                    # Group reviews by note ID and calculate per-note retention
                    note_stats = {}

                    for card_id_str, reviews in reviews_data.items():
                        if not reviews:
                            continue

                        note_id = card_to_note.get(card_id_str)
                        if not note_id:
                            continue

                        # Filter reviews by timestamp if provided
                        filtered_reviews = reviews
                        if start_timestamp and end_timestamp:
                            filtered_reviews = [
                                r
                                for r in reviews
                                if start_timestamp <= r.get("time", 0) <= end_timestamp
                            ]

                        for review in filtered_reviews:
                            # Only count review-type entries (type=1)
                            review_type = review.get("type", -1)
                            if review_type != 1:
                                continue

                            if note_id not in note_stats:
                                note_stats[note_id] = {
                                    "passed": 0,
                                    "failed": 0,
                                    "total_time": 0,
                                }

                            note_stats[note_id]["total_time"] += review["time"]

                            # Ease: 1=Again, 2=Hard, 3=Good, 4=Easy
                            if review["ease"] == 1:
                                note_stats[note_id]["failed"] += 1
                            else:
                                note_stats[note_id]["passed"] += 1

                    if note_stats:
                        # Calculate per-note retention and average them
                        retention_sum = 0
                        total_time = 0
                        total_reviews = 0

                        for note_id, stats in note_stats.items():
                            passed = stats["passed"]
                            failed = stats["failed"]
                            total = passed + failed

                            if total > 0:
                                note_retention = passed / total
                                retention_sum += note_retention
                                total_time += stats["total_time"]
                                total_reviews += total

                        # Average retention across all notes
                        note_count = len(note_stats)
                        avg_retention = (
                            (retention_sum / note_count) * 100 if note_count > 0 else 0
                        )
                        avg_time_seconds = (
                            (total_time / total_reviews / 1000.0)
                            if total_reviews > 0
                            else 0
                        )

                        return {
                            "game_name": game_name,
                            "avg_time_per_card": round(avg_time_seconds, 2),
                            "retention_pct": round(avg_retention, 1),
                            "total_reviews": total_reviews,
                            "mined_lines": 0,
                        }
                    return None
                except Exception as e:
                    logger.error(f"Error processing game {game_name}: {e}")
                    return None

            # Process games in parallel
            with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
                futures = {
                    executor.submit(process_game, game_name, card_ids): game_name
                    for game_name, card_ids in game_cards.items()
                }

                for future in concurrent.futures.as_completed(futures):
                    result = future.result()
                    if result:
                        game_stats.append(result)

            # Sort by game name
            game_stats.sort(key=lambda x: x["game_name"])
            return jsonify(game_stats)

        except Exception as e:
            logger.error(f"Failed to fetch game stats from Anki: {e}")
            return jsonify([])

    @app.route("/api/anki_nsfw_sfw_retention")
    def api_anki_nsfw_sfw_retention():
        """Get NSFW vs SFW retention statistics."""
        start_timestamp = (
            int(request.args.get("start_timestamp"))
            if request.args.get("start_timestamp")
            else None
        )
        end_timestamp = (
            int(request.args.get("end_timestamp"))
            if request.args.get("end_timestamp")
            else None
        )

        def calculate_retention_for_cards(card_ids, start_timestamp, end_timestamp):
            if not card_ids:
                return 0.0, 0, 0.0

            try:
                # Get card info to filter by date
                cards_info = invoke("cardsInfo", cards=card_ids)

                # Use card['created'] for date filtering
                if start_timestamp and end_timestamp:
                    cards_info = [
                        card
                        for card in cards_info
                        if start_timestamp <= card.get("created", 0) <= end_timestamp
                    ]

                if not cards_info:
                    return 0.0, 0, 0.0

                # Create card-to-note mapping
                card_to_note = {
                    str(card["cardId"]): card["note"] for card in cards_info
                }

                # Get review history for all cards
                reviews_data = invoke(
                    "getReviewsOfCards", cards=[card["cardId"] for card in cards_info]
                )

                # Group reviews by note ID and calculate per-note retention
                note_stats = {}

                for card_id_str, reviews in reviews_data.items():
                    if not reviews:
                        continue

                    note_id = card_to_note.get(card_id_str)
                    if not note_id:
                        continue

                    # Filter reviews by timestamp if provided
                    filtered_reviews = reviews
                    if start_timestamp and end_timestamp:
                        filtered_reviews = [
                            r
                            for r in reviews
                            if start_timestamp <= r.get("time", 0) <= end_timestamp
                        ]

                    for review in filtered_reviews:
                        # Only count review-type entries (type=1)
                        review_type = review.get("type", -1)
                        if review_type != 1:
                            continue

                        if note_id not in note_stats:
                            note_stats[note_id] = {
                                "passed": 0,
                                "failed": 0,
                                "total_time": 0,
                            }

                        note_stats[note_id]["total_time"] += review["time"]

                        # Ease: 1=Again, 2=Hard, 3=Good, 4=Easy
                        if review["ease"] == 1:
                            note_stats[note_id]["failed"] += 1
                        else:
                            note_stats[note_id]["passed"] += 1

                if not note_stats:
                    return 0.0, 0, 0.0

                # Calculate per-note retention and average them
                retention_sum = 0
                total_reviews = 0
                total_time = 0

                for note_id, stats in note_stats.items():
                    passed = stats["passed"]
                    failed = stats["failed"]
                    total = passed + failed

                    if total > 0:
                        note_retention = passed / total
                        retention_sum += note_retention
                        total_reviews += total
                        total_time += stats["total_time"]

                # Average retention across all notes
                note_count = len(note_stats)
                avg_retention = (
                    (retention_sum / note_count) * 100 if note_count > 0 else 0
                )
                avg_time_seconds = (
                    (total_time / total_reviews / 1000.0) if total_reviews > 0 else 0
                )

                return avg_retention, total_reviews, avg_time_seconds

            except Exception as e:
                logger.error(f"Error calculating retention for cards: {e}")
                return 0.0, 0, 0.0

        try:
            # Query for NSFW and SFW cards concurrently
            def get_nsfw_cards():
                return invoke("findCards", query="tag:Game tag:NSFW")

            def get_sfw_cards():
                return invoke("findCards", query="tag:Game -tag:NSFW")

            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
                nsfw_future = executor.submit(get_nsfw_cards)
                sfw_future = executor.submit(get_sfw_cards)

                nsfw_card_ids = nsfw_future.result()
                sfw_card_ids = sfw_future.result()

            # Calculate retention for both categories concurrently
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
                nsfw_future = executor.submit(
                    calculate_retention_for_cards,
                    nsfw_card_ids,
                    start_timestamp,
                    end_timestamp,
                )
                sfw_future = executor.submit(
                    calculate_retention_for_cards,
                    sfw_card_ids,
                    start_timestamp,
                    end_timestamp,
                )

                nsfw_retention, nsfw_reviews, nsfw_avg_time = nsfw_future.result()
                sfw_retention, sfw_reviews, sfw_avg_time = sfw_future.result()

            return jsonify(
                {
                    "nsfw_retention": round(nsfw_retention, 1),
                    "sfw_retention": round(sfw_retention, 1),
                    "nsfw_reviews": nsfw_reviews,
                    "sfw_reviews": sfw_reviews,
                    "nsfw_avg_time": round(nsfw_avg_time, 2),
                    "sfw_avg_time": round(sfw_avg_time, 2),
                }
            )

        except Exception as e:
            logger.error(f"Failed to fetch NSFW/SFW retention stats from Anki: {e}")
            return jsonify(
                {
                    "nsfw_retention": 0,
                    "sfw_retention": 0,
                    "nsfw_reviews": 0,
                    "sfw_reviews": 0,
                    "nsfw_avg_time": 0,
                    "sfw_avg_time": 0,
                }
            )

    @app.route("/api/anki_mining_heatmap")
    def api_anki_mining_heatmap():
        """
        Get mining heatmap data.

        Note: Currently uses direct query approach since mining heatmap requires checking
        specific fields (screenshot_in_anki, audio_in_anki) which aren't aggregated in rollup.
        Could be optimized in future by adding daily mining counts to rollup table.
        """
        start_timestamp = (
            int(request.args.get("start_timestamp"))
            if request.args.get("start_timestamp")
            else None
        )
        end_timestamp = (
            int(request.args.get("end_timestamp"))
            if request.args.get("end_timestamp")
            else None
        )

        try:
            # Fetch GSM lines (direct query needed for mining-specific fields)
            try:
                if start_timestamp is not None and end_timestamp is not None:
                    # Handle negative timestamps by clamping to 0
                    start_ts = max(0, start_timestamp / 1000.0)
                    end_ts = max(0, end_timestamp / 1000.0)
                    all_lines = GameLinesTable.get_lines_filtered_by_timestamp(
                        start=start_ts, end=end_ts, for_stats=True
                    )
                else:
                    all_lines = GameLinesTable.all()
            except Exception as e:
                logger.warning(
                    f"Failed to filter lines by timestamp: {e}, fetching all lines instead"
                )
                logger.warning(traceback.format_exc())
                all_lines = GameLinesTable.all()

            # Calculate mining heatmap
            mining_heatmap = calculate_mining_heatmap_data(all_lines)
            return jsonify(mining_heatmap)

        except Exception as e:
            logger.error(f"Error fetching mining heatmap: {e}")
            return jsonify({})

    # Keep the original combined endpoint for backward compatibility
    @app.route("/api/anki_stats_combined")
    def api_anki_stats_combined():
        """
        Legacy combined endpoint - now redirects to individual endpoints.
        Kept for backward compatibility but should be deprecated.
        """
        start_timestamp = request.args.get("start_timestamp")
        end_timestamp = request.args.get("end_timestamp")

        # Build query parameters
        params = {}
        if start_timestamp:
            params["start_timestamp"] = start_timestamp
        if end_timestamp:
            params["end_timestamp"] = end_timestamp

        try:
            # Use concurrent requests to fetch all data
            import requests
            from urllib.parse import urlencode

            base_url = request.url_root.rstrip("/")
            query_string = urlencode(params) if params else ""

            def fetch_endpoint(endpoint):
                url = f"{base_url}/api/{endpoint}"
                if query_string:
                    url += f"?{query_string}"
                try:
                    response = requests.get(url, timeout=30)
                    return response.json() if response.status_code == 200 else {}
                except Exception as e:
                    logger.error(f"Error fetching {endpoint}: {e}")
                    return {}

            with concurrent.futures.ThreadPoolExecutor(max_workers=5) as executor:
                futures = {
                    "earliest_date": executor.submit(
                        fetch_endpoint, "anki_earliest_date"
                    ),
                    "kanji_stats": executor.submit(fetch_endpoint, "anki_kanji_stats"),
                    "game_stats": executor.submit(fetch_endpoint, "anki_game_stats"),
                    "nsfw_sfw_retention": executor.submit(
                        fetch_endpoint, "anki_nsfw_sfw_retention"
                    ),
                    "mining_heatmap": executor.submit(
                        fetch_endpoint, "anki_mining_heatmap"
                    ),
                }

                results = {}
                for key, future in futures.items():
                    results[key] = future.result()

            # Format response to match original structure
            combined_response = {
                "kanji_stats": results.get("kanji_stats", {}),
                "game_stats": results.get("game_stats", []),
                "nsfw_sfw_retention": results.get("nsfw_sfw_retention", {}),
                "mining_heatmap": results.get("mining_heatmap", {}),
                "earliest_date": results.get("earliest_date", {}).get(
                    "earliest_date", 0
                ),
            }

            return jsonify(combined_response)

        except Exception as e:
            logger.error(f"Error in combined endpoint: {e}")
            return jsonify({"error": str(e)}), 500
