"""
Separate API endpoints for Anki statistics to improve performance through progressive loading.
These endpoints replace the monolithic /api/anki_stats_combined endpoint.

Uses hybrid rollup + live approach similar to /api/stats for GSM-based data (kanji, mining heatmap).
Anki review data (retention, game stats) is served from the local SQLite cache
populated by the anki_card_sync cron, eliminating direct AnkiConnect queries.
"""

from __future__ import annotations

import concurrent.futures
import datetime
import json
import traceback
from flask import request, jsonify
from threading import Lock

from GameSentenceMiner.anki import invoke
from GameSentenceMiner.util.config.configuration import get_config
from GameSentenceMiner.util.config.configuration import logger
from GameSentenceMiner.util.database.db import GameLinesTable
from GameSentenceMiner.util.database.stats_rollup_table import StatsRollupTable
from GameSentenceMiner.web.stats import (
    calculate_kanji_frequency,
    calculate_mining_heatmap_data,
    is_kanji,
)
from GameSentenceMiner.web.rollup_stats import (
    aggregate_rollup_data,
    calculate_live_stats_for_today,
    combine_rollup_and_live_stats,
)

_ANKI_SHARED_EXECUTOR = concurrent.futures.ThreadPoolExecutor(max_workers=6)
_ANKI_INFLIGHT_CALLS = {}
_ANKI_INFLIGHT_LOCK = Lock()

_CACHE_EMPTY_RESPONSE = {
    "message": "Anki cache has not been synced yet. Data will be available after the first sync completes.",
    "cache_empty": True,
}


def _is_cache_empty() -> bool:
    """Check whether the Anki note cache has any data."""
    from GameSentenceMiner.util.database.anki_tables import AnkiNotesTable
    try:
        return AnkiNotesTable.one() is None
    except Exception:
        return True


def _get_note_fields(note) -> dict:
    """Safely extract the fields dict from a cached note.

    ``fields_json`` may be a dict (auto-deserialized by ``from_row``) or a raw
    JSON string depending on how the ORM handled it.
    """
    fj = note.fields_json
    if isinstance(fj, dict):
        return fj
    if isinstance(fj, str):
        try:
            return json.loads(fj)
        except (json.JSONDecodeError, TypeError):
            return {}
    return {}


def _get_note_tags(note) -> list:
    """Safely extract the tags list from a cached note."""
    t = note.tags
    if isinstance(t, list):
        return t
    if isinstance(t, str):
        try:
            return json.loads(t)
        except (json.JSONDecodeError, TypeError):
            return []
    return []


def _get_anki_session_id():
    session_id = request.headers.get("X-Anki-Session")
    if session_id:
        return session_id
    session_id = request.args.get("anki_session")
    return session_id or "default"


def _make_anki_call_key(action, params, session_id):
    normalized_params = json.dumps(params, sort_keys=True, default=str)
    return (session_id, action, normalized_params)


def invoke_shared(action, timeout=30, session_id=None, **params):
    session_id = session_id or _get_anki_session_id()
    key = _make_anki_call_key(action, params, session_id)

    with _ANKI_INFLIGHT_LOCK:
        future = _ANKI_INFLIGHT_CALLS.get(key)
        if future is None:
            future = _ANKI_SHARED_EXECUTOR.submit(
                invoke, action, timeout=timeout, **params
            )
            _ANKI_INFLIGHT_CALLS[key] = future

    try:
        return future.result()
    finally:
        if future.done():
            with _ANKI_INFLIGHT_LOCK:
                _ANKI_INFLIGHT_CALLS.pop(key, None)


def register_anki_api_endpoints(app):
    """Register all Anki API endpoints with the Flask app."""

    @app.route("/api/anki_earliest_date")
    def api_anki_earliest_date():
        """
        Get earliest Anki card creation date from the local cache.
        ---
        tags:
          - Anki
        responses:
          200:
            description: Earliest card creation timestamp
            schema:
              type: object
              properties:
                earliest_date:
                  type: integer
                  description: Unix timestamp of earliest card (mod field from notes)
        """
        if _is_cache_empty():
            return jsonify({"earliest_date": 0, **_CACHE_EMPTY_RESPONSE})

        try:
            from GameSentenceMiner.util.database.anki_tables import AnkiNotesTable, AnkiCardsTable

            parent_tag = get_config().anki.parent_tag.strip() or "Game"

            # Get all cached notes and filter by parent tag
            notes = AnkiNotesTable.all()
            tagged_note_ids = set()
            for note in notes:
                tags = _get_note_tags(note)
                if any(t.startswith(f"{parent_tag}::") for t in tags):
                    tagged_note_ids.add(note.note_id)

            if not tagged_note_ids:
                return jsonify({"earliest_date": 0})

            # Find earliest mod timestamp among matching notes
            # mod is the Anki modification timestamp (seconds since epoch)
            earliest = None
            for note in notes:
                if note.note_id in tagged_note_ids and note.mod:
                    if earliest is None or note.mod < earliest:
                        earliest = note.mod

            # Also check card-level data — use the note mod as a proxy for creation
            # since the cache doesn't store card.created directly
            return jsonify({"earliest_date": earliest or 0})
        except Exception as e:
            logger.error(f"Failed to fetch earliest date from cache: {e}")
            return jsonify({"earliest_date": 0})

    @app.route("/api/anki_kanji_stats")
    def api_anki_kanji_stats():
        """
        Get kanji statistics and coverage analysis.
        Anki kanji data is now served from the local cache.
        ---
        tags:
          - Anki
        parameters:
          - name: start_timestamp
            in: query
            type: integer
            required: false
            description: Start timestamp (milliseconds)
          - name: end_timestamp
            in: query
            type: integer
            required: false
            description: End timestamp (milliseconds)
        responses:
          200:
            description: Kanji statistics
          500:
            description: Failed to fetch kanji stats
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
                    start_date_str = None
                    end_date_str = today_str
            else:
                start_date_str = None
                end_date_str = today_str

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

            # Fetch Anki kanji from local cache instead of AnkiConnect
            anki_kanji_set = _get_anki_kanji_from_cache(start_timestamp, end_timestamp)

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
        """
        Get Anki stats grouped by game, served from local cache.
        ---
        tags:
          - Anki
        responses:
          200:
            description: Game-specific statistics
          500:
            description: Failed to gather game stats
        """
        if _is_cache_empty():
            return jsonify([])

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
            from GameSentenceMiner.util.database.anki_tables import (
                AnkiNotesTable,
                AnkiCardsTable,
                AnkiReviewsTable,
            )

            # Load all notes and build a lookup by note_id
            all_notes = AnkiNotesTable.all()
            notes_by_id = {n.note_id: n for n in all_notes}

            # Load all cards
            all_cards = AnkiCardsTable.all()

            # Filter cards by timestamp if provided (use note.mod as creation proxy)
            if start_timestamp and end_timestamp:
                filtered_cards = []
                for card in all_cards:
                    note = notes_by_id.get(card.note_id)
                    if note and note.mod:
                        # mod is in seconds, timestamps are in milliseconds
                        mod_ms = note.mod * 1000
                        if start_timestamp <= mod_ms <= end_timestamp:
                            filtered_cards.append(card)
                all_cards = filtered_cards

            if not all_cards:
                return jsonify([])

            # Group cards by game tag
            game_cards: dict[str, list] = {}
            card_to_note: dict[int, int] = {}
            for card in all_cards:
                note = notes_by_id.get(card.note_id)
                if not note:
                    continue

                card_to_note[card.card_id] = card.note_id
                tags = _get_note_tags(note)

                # Only include cards with the parent tag
                game_tag = None
                for tag in tags:
                    if tag.startswith(f"{parent_tag}::"):
                        tag_parts = tag.split("::")
                        if len(tag_parts) >= 2:
                            game_tag = tag_parts[1]
                            break

                if game_tag:
                    game_cards.setdefault(game_tag, []).append(card)

            if not game_cards:
                return jsonify([])

            # Load all reviews and index by card_id
            all_reviews = AnkiReviewsTable.all()
            reviews_by_card: dict[int, list] = {}
            for review in all_reviews:
                reviews_by_card.setdefault(review.card_id, []).append(review)

            # Process each game
            game_stats = []
            for game_name, cards in game_cards.items():
                note_stats: dict[int, dict] = {}

                for card in cards:
                    card_reviews = reviews_by_card.get(card.card_id, [])
                    note_id = card.note_id

                    for review in card_reviews:
                        # Filter reviews by timestamp if provided
                        if start_timestamp and end_timestamp:
                            # review_time is in milliseconds
                            if not (start_timestamp <= review.review_time <= end_timestamp):
                                continue

                        # Only count review-type entries (type=1 in AnkiConnect)
                        # In our cache, ease > 0 indicates a real review
                        if note_id not in note_stats:
                            note_stats[note_id] = {
                                "passed": 0,
                                "failed": 0,
                                "total_time": 0,
                            }

                        note_stats[note_id]["total_time"] += review.time_taken

                        # Ease: 1=Again, 2=Hard, 3=Good, 4=Easy
                        if review.ease == 1:
                            note_stats[note_id]["failed"] += 1
                        else:
                            note_stats[note_id]["passed"] += 1

                if note_stats:
                    retention_sum = 0
                    total_time = 0
                    total_reviews = 0

                    for nid, stats in note_stats.items():
                        passed = stats["passed"]
                        failed = stats["failed"]
                        total = passed + failed

                        if total > 0:
                            retention_sum += passed / total
                            total_time += stats["total_time"]
                            total_reviews += total

                    note_count = len(note_stats)
                    avg_retention = (
                        (retention_sum / note_count) * 100 if note_count > 0 else 0
                    )
                    avg_time_seconds = (
                        (total_time / total_reviews / 1000.0)
                        if total_reviews > 0
                        else 0
                    )

                    game_stats.append({
                        "game_name": game_name,
                        "card_count": len(cards),
                        "avg_time_per_card": round(avg_time_seconds, 2),
                        "retention_pct": round(avg_retention, 1),
                        "total_reviews": total_reviews,
                        "mined_lines": 0,
                    })
                else:
                    game_stats.append({
                        "game_name": game_name,
                        "card_count": len(cards),
                        "avg_time_per_card": 0,
                        "retention_pct": 0,
                        "total_reviews": 0,
                        "mined_lines": 0,
                    })

            game_stats.sort(key=lambda x: x["game_name"])
            return jsonify(game_stats)

        except Exception as e:
            logger.error(f"Failed to fetch game stats from cache: {e}")
            return jsonify([])

    @app.route("/api/anki_nsfw_sfw_retention")
    def api_anki_nsfw_sfw_retention():
        """Get NSFW vs SFW retention statistics from local cache."""
        if _is_cache_empty():
            return jsonify({
                "nsfw_retention": 0,
                "sfw_retention": 0,
                "nsfw_reviews": 0,
                "sfw_reviews": 0,
                "nsfw_avg_time": 0,
                "sfw_avg_time": 0,
                **_CACHE_EMPTY_RESPONSE,
            })

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
            from GameSentenceMiner.util.database.anki_tables import (
                AnkiNotesTable,
                AnkiCardsTable,
                AnkiReviewsTable,
            )

            parent_tag = get_config().anki.parent_tag.strip() or "Game"

            # Load all notes and classify as NSFW or SFW
            all_notes = AnkiNotesTable.all()
            nsfw_note_ids = set()
            sfw_note_ids = set()
            notes_by_id = {n.note_id: n for n in all_notes}

            for note in all_notes:
                tags = _get_note_tags(note)
                has_parent = any(t.startswith(f"{parent_tag}") for t in tags)
                if not has_parent:
                    continue
                if "NSFW" in tags:
                    nsfw_note_ids.add(note.note_id)
                else:
                    sfw_note_ids.add(note.note_id)

            # Load all cards and split by NSFW/SFW
            all_cards = AnkiCardsTable.all()

            # Filter by timestamp if provided
            if start_timestamp and end_timestamp:
                filtered_cards = []
                for card in all_cards:
                    note = notes_by_id.get(card.note_id)
                    if note and note.mod:
                        mod_ms = note.mod * 1000
                        if start_timestamp <= mod_ms <= end_timestamp:
                            filtered_cards.append(card)
                all_cards = filtered_cards

            nsfw_cards = [c for c in all_cards if c.note_id in nsfw_note_ids]
            sfw_cards = [c for c in all_cards if c.note_id in sfw_note_ids]

            # Load all reviews indexed by card_id
            all_reviews = AnkiReviewsTable.all()
            reviews_by_card: dict[int, list] = {}
            for review in all_reviews:
                reviews_by_card.setdefault(review.card_id, []).append(review)

            def calc_retention(cards, card_to_note_map):
                if not cards:
                    return 0.0, 0, 0.0

                note_stats: dict[int, dict] = {}
                for card in cards:
                    card_reviews = reviews_by_card.get(card.card_id, [])
                    note_id = card.note_id

                    for review in card_reviews:
                        if start_timestamp and end_timestamp:
                            if not (start_timestamp <= review.review_time <= end_timestamp):
                                continue

                        if note_id not in note_stats:
                            note_stats[note_id] = {
                                "passed": 0,
                                "failed": 0,
                                "total_time": 0,
                            }

                        note_stats[note_id]["total_time"] += review.time_taken
                        if review.ease == 1:
                            note_stats[note_id]["failed"] += 1
                        else:
                            note_stats[note_id]["passed"] += 1

                if not note_stats:
                    return 0.0, 0, 0.0

                retention_sum = 0
                total_reviews = 0
                total_time = 0

                for nid, stats in note_stats.items():
                    passed = stats["passed"]
                    failed = stats["failed"]
                    total = passed + failed
                    if total > 0:
                        retention_sum += passed / total
                        total_reviews += total
                        total_time += stats["total_time"]

                note_count = len(note_stats)
                avg_retention = (
                    (retention_sum / note_count) * 100 if note_count > 0 else 0
                )
                avg_time_seconds = (
                    (total_time / total_reviews / 1000.0) if total_reviews > 0 else 0
                )
                return avg_retention, total_reviews, avg_time_seconds

            nsfw_retention, nsfw_reviews, nsfw_avg_time = calc_retention(
                nsfw_cards, notes_by_id
            )
            sfw_retention, sfw_reviews, sfw_avg_time = calc_retention(
                sfw_cards, notes_by_id
            )

            return jsonify({
                "nsfw_retention": round(nsfw_retention, 1),
                "sfw_retention": round(sfw_retention, 1),
                "nsfw_reviews": nsfw_reviews,
                "sfw_reviews": sfw_reviews,
                "nsfw_avg_time": round(nsfw_avg_time, 2),
                "sfw_avg_time": round(sfw_avg_time, 2),
            })

        except Exception as e:
            logger.error(f"Failed to fetch NSFW/SFW retention stats from cache: {e}")
            return jsonify({
                "nsfw_retention": 0,
                "sfw_retention": 0,
                "nsfw_reviews": 0,
                "sfw_reviews": 0,
                "nsfw_avg_time": 0,
                "sfw_avg_time": 0,
            })

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

    @app.route("/api/anki_sync_status")
    def api_anki_sync_status():
        """Return sync status: last synced timestamp, cache state, and counts."""
        try:
            from GameSentenceMiner.util.database.anki_tables import (
                AnkiNotesTable,
                AnkiCardsTable,
            )

            notes = AnkiNotesTable.all()
            cards = AnkiCardsTable.all()
            note_count = len(notes) if notes else 0
            card_count = len(cards) if cards else 0
            cache_populated = note_count > 0

            last_synced = None
            if notes:
                max_synced = max(
                    (n.synced_at for n in notes if n.synced_at), default=None
                )
                if max_synced is not None:
                    import datetime as _dt

                    last_synced = _dt.datetime.fromtimestamp(
                        max_synced, tz=_dt.timezone.utc
                    ).isoformat()

            return jsonify({
                "last_synced": last_synced,
                "cache_populated": cache_populated,
                "note_count": note_count,
                "card_count": card_count,
            })
        except Exception as e:
            logger.error(f"Failed to fetch sync status: {e}")
            return jsonify({
                "last_synced": None,
                "cache_populated": False,
                "note_count": 0,
                "card_count": 0,
            })

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
            import requests
            from urllib.parse import urlencode

            base_url = request.url_root.rstrip("/")
            query_string = urlencode(params) if params else ""

            session_id = _get_anki_session_id()

            def fetch_endpoint(endpoint):
                url = f"{base_url}/api/{endpoint}"
                if query_string:
                    url += f"?{query_string}"
                try:
                    headers = {"X-Anki-Session": session_id} if session_id else None
                    response = requests.get(url, timeout=30, headers=headers)
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


def _get_anki_kanji_from_cache(
    start_timestamp: int | None = None,
    end_timestamp: int | None = None,
) -> set[str]:
    """Extract unique kanji characters from cached Anki notes, filtered by parent tag.

    Replaces the old ``get_anki_kanji()`` inner function that queried AnkiConnect
    directly via ``findNotes`` / ``notesInfo``.
    """
    if _is_cache_empty():
        return set()

    try:
        from GameSentenceMiner.util.database.anki_tables import AnkiNotesTable

        parent_tag = get_config().anki.parent_tag.strip() or "Game"
        notes = AnkiNotesTable.all()
        anki_kanji_set: set[str] = set()

        for note in notes:
            tags = _get_note_tags(note)
            if not any(t.startswith(f"{parent_tag}::") for t in tags):
                continue

            # Filter by timestamp if provided (mod is seconds, timestamps are ms)
            if start_timestamp and end_timestamp and note.mod:
                mod_ms = note.mod * 1000
                if not (start_timestamp <= mod_ms <= end_timestamp):
                    continue

            fields = _get_note_fields(note)
            first_field = next(iter(fields.values()), None)
            if first_field and isinstance(first_field, dict) and "value" in first_field:
                for char in first_field["value"]:
                    if is_kanji(char):
                        anki_kanji_set.add(char)

        return anki_kanji_set
    except Exception as e:
        logger.error(f"Failed to fetch kanji from cache: {e}")
        return set()
