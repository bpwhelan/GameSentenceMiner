"""
Separate API endpoints for Anki statistics to improve performance through progressive loading.
These endpoints replace the monolithic /api/anki_stats_combined endpoint.

Uses hybrid rollup + live approach similar to /api/stats for GSM-based data (kanji, mining heatmap).
Anki review data (retention, game stats) is served from the local SQLite cache
populated by the anki_card_sync cron, eliminating direct AnkiConnect queries.
"""

from __future__ import annotations

import datetime
import json
import time as _time
import traceback
from collections import defaultdict
from flask import request, jsonify
from threading import Lock

from GameSentenceMiner.util.config.configuration import get_config
from GameSentenceMiner.util.config.configuration import logger
from GameSentenceMiner.util.database.db import GameLinesTable
from GameSentenceMiner.util.database.stats_rollup_table import StatsRollupTable
from GameSentenceMiner.web.stats import (
    calculate_kanji_frequency,
    calculate_mining_heatmap_data,
)
from GameSentenceMiner.util.text_utils import is_kanji
from GameSentenceMiner.web.rollup_stats import (
    aggregate_rollup_data,
    calculate_live_stats_for_today,
    combine_rollup_and_live_stats,
)

_CACHE_EMPTY_RESPONSE = {
    "message": "Anki cache has not been synced yet. Data will be available after the first sync completes.",
    "cache_empty": True,
}

# ---------------------------------------------------------------------------
# Shared Anki data cache
# ---------------------------------------------------------------------------
# The game_stats, nsfw/sfw retention, and earliest_date endpoints all load
# the entire notes, cards, and reviews tables.  This cache loads them once and
# reuses the result for up to _ANKI_DATA_TTL seconds.
_ANKI_DATA_TTL = 60.0  # seconds
_anki_data_lock = Lock()
_anki_data_cache: dict | None = None
_anki_data_ts: float = 0.0

_ANKI_STATS_SECTION_DEFAULTS: dict[str, object] = {
    "earliest_date": 0,
    "kanji_stats": {},
    "game_stats": [],
    "nsfw_sfw_retention": {},
    "mining_heatmap": {},
    "reading_impact": {},
}


def _parse_note_fields(fields_json) -> dict:
    """Parse cached note fields once per cache refresh."""
    if isinstance(fields_json, dict):
        return fields_json
    if isinstance(fields_json, str):
        try:
            return json.loads(fields_json)
        except (json.JSONDecodeError, TypeError):
            return {}
    return {}


def _parse_note_tags(tags) -> list:
    """Parse cached note tags once per cache refresh."""
    if isinstance(tags, list):
        return tags
    if isinstance(tags, str):
        try:
            return json.loads(tags)
        except (json.JSONDecodeError, TypeError):
            return []
    return []


def _get_anki_data() -> dict:
    """Return a dict with ``notes_by_id``, ``all_cards``, ``reviews_by_card``
    loaded from the local Anki cache tables.  Results are memoised for
    ``_ANKI_DATA_TTL`` seconds.
    """
    global _anki_data_cache, _anki_data_ts
    now = _time.monotonic()

    with _anki_data_lock:
        if _anki_data_cache is not None and (now - _anki_data_ts) < _ANKI_DATA_TTL:
            return _anki_data_cache

    from GameSentenceMiner.util.database.anki_tables import (
        AnkiNotesTable,
        AnkiCardsTable,
        AnkiReviewsTable,
    )

    all_notes = AnkiNotesTable.all()
    notes_by_id = {n.note_id: n for n in all_notes}
    note_tags_by_id = {note.note_id: _parse_note_tags(note.tags) for note in all_notes}
    note_fields_by_id = {note.note_id: _parse_note_fields(note.fields_json) for note in all_notes}
    all_cards = AnkiCardsTable.all()

    all_reviews = AnkiReviewsTable.all()
    reviews_by_card: dict[int, list] = {}
    for review in all_reviews:
        reviews_by_card.setdefault(review.card_id, []).append(review)

    result = {
        "notes_by_id": notes_by_id,
        "note_tags_by_id": note_tags_by_id,
        "note_fields_by_id": note_fields_by_id,
        "all_cards": all_cards,
        "reviews_by_card": reviews_by_card,
    }

    with _anki_data_lock:
        _anki_data_cache = result
        _anki_data_ts = _time.monotonic()

    return result


def invalidate_anki_data_cache():
    """Clear the shared Anki data cache (call after sync)."""
    global _anki_data_cache, _anki_data_ts
    with _anki_data_lock:
        _anki_data_cache = None
        _anki_data_ts = 0.0


def _parse_requested_anki_stats_sections(raw_sections: str | None, available_sections: dict[str, object]) -> list[str]:
    """Parse the optional comma-separated combined-endpoint section filter."""
    if not raw_sections:
        return list(available_sections)

    sections: list[str] = []
    invalid_sections: list[str] = []

    for raw_section in raw_sections.split(","):
        section = raw_section.strip()
        if not section:
            continue
        if section not in available_sections:
            invalid_sections.append(section)
            continue
        if section not in sections:
            sections.append(section)

    if invalid_sections:
        raise ValueError("Unsupported Anki stats sections: " + ", ".join(sorted(invalid_sections)))
    if not sections:
        raise ValueError("At least one Anki stats section must be selected.")

    return sections


def _is_cache_empty() -> bool:
    """Check whether the Anki note cache has any data."""
    from GameSentenceMiner.util.database.anki_tables import AnkiNotesTable

    try:
        return AnkiNotesTable.one() is None
    except Exception:
        return True


def _get_note_fields(note, cached_fields_by_id: dict[int, dict] | None = None) -> dict:
    """Safely extract the fields dict from a cached note.

    ``fields_json`` may be a dict (auto-deserialized by ``from_row``) or a raw
    JSON string depending on how the ORM handled it.
    """
    if cached_fields_by_id is not None:
        cached_fields = cached_fields_by_id.get(note.note_id)
        if cached_fields is not None:
            return cached_fields
    return _parse_note_fields(note.fields_json)


def _get_note_tags(note, cached_tags_by_id: dict[int, list] | None = None) -> list:
    """Safely extract the tags list from a cached note."""
    if cached_tags_by_id is not None:
        cached_tags = cached_tags_by_id.get(note.note_id)
        if cached_tags is not None:
            return cached_tags
    return _parse_note_tags(note.tags)


def _timestamp_ms_to_seconds(timestamp_ms: int | None) -> float | None:
    """Convert a millisecond timestamp to seconds while tolerating open bounds."""
    if timestamp_ms is None:
        return None
    return max(0, timestamp_ms / 1000.0)


def _matches_optional_timestamp_range(value: int, start_timestamp: int | None, end_timestamp: int | None) -> bool:
    """Return True when *value* falls inside the optional [start, end] bounds."""
    if start_timestamp is not None and value < start_timestamp:
        return False
    if end_timestamp is not None and value > end_timestamp:
        return False
    return True


def _default_anki_stats_start_date(today: datetime.date) -> datetime.date:
    """Return the default lower bound for Anki stats ranges."""
    first_rollup_date = StatsRollupTable.get_first_date()
    if first_rollup_date:
        try:
            return datetime.datetime.strptime(first_rollup_date, "%Y-%m-%d").date()
        except ValueError:
            pass
    return today


# ---------------------------------------------------------------------------
# Standalone data-fetching functions (extracted from route handlers)
# ---------------------------------------------------------------------------
# These module-level functions contain the core logic that was previously
# nested inside register_anki_api_endpoints().  They accept start/end
# timestamps (milliseconds, or None) and return plain dicts so they can be
# called directly — e.g. from the combined endpoint — without issuing HTTP
# requests back to ourselves.
# ---------------------------------------------------------------------------


def _fetch_earliest_date(
    start_timestamp: int | None,
    end_timestamp: int | None,
) -> dict:
    """Return ``{"earliest_date": <unix-seconds>}`` for the earliest note
    matching the configured parent tag.  Timestamps are ignored for this
    query (all matching notes are considered).
    """
    if _is_cache_empty():
        return {"earliest_date": 0, **_CACHE_EMPTY_RESPONSE}

    try:
        parent_tag = get_config().anki.parent_tag.strip() or "Game"
        parent_tag_prefix = f"{parent_tag}::"

        anki_data = _get_anki_data()
        notes_by_id = anki_data["notes_by_id"]
        note_tags_by_id = anki_data.get("note_tags_by_id")

        tagged_note_ids = set()
        for note in notes_by_id.values():
            tags = _get_note_tags(note, note_tags_by_id)
            if any(t.startswith(parent_tag_prefix) for t in tags):
                tagged_note_ids.add(note.note_id)

        if not tagged_note_ids:
            return {"earliest_date": 0}

        earliest_ms = None
        for note in notes_by_id.values():
            if note.note_id in tagged_note_ids:
                if earliest_ms is None or note.note_id < earliest_ms:
                    earliest_ms = note.note_id

        return {"earliest_date": earliest_ms / 1000 if earliest_ms else 0}
    except Exception as e:
        logger.error(f"Failed to fetch earliest date from cache: {e}")
        return {"earliest_date": 0}


def _fetch_kanji_stats(
    start_timestamp: int | None,
    end_timestamp: int | None,
) -> dict:
    """Return kanji coverage statistics for the given time range."""
    try:
        today = datetime.date.today()
        today_str = today.strftime("%Y-%m-%d")

        # Determine date range
        if start_timestamp is not None or end_timestamp is not None:
            try:
                start_ts_seconds = _timestamp_ms_to_seconds(start_timestamp)
                end_ts_seconds = _timestamp_ms_to_seconds(end_timestamp)

                start_date = (
                    datetime.date.fromtimestamp(start_ts_seconds)
                    if start_ts_seconds is not None
                    else _default_anki_stats_start_date(today)
                )
                end_date = datetime.date.fromtimestamp(end_ts_seconds) if end_ts_seconds is not None else today
                start_date_str = start_date.strftime("%Y-%m-%d")
                end_date_str = end_date.strftime("%Y-%m-%d")
            except (ValueError, OSError) as e:
                logger.error(f"Invalid timestamp conversion: start={start_timestamp}, end={end_timestamp}, error={e}")
                start_date_str = None
                end_date_str = today_str
        else:
            start_date_str = StatsRollupTable.get_first_date()
            end_date_str = today_str

        today_in_range = (not end_date_str) or (end_date_str >= today_str)

        # Query rollup data for historical dates (up to yesterday)
        rollup_stats = None
        if start_date_str:
            yesterday = today - datetime.timedelta(days=1)
            yesterday_str = yesterday.strftime("%Y-%m-%d")

            if start_date_str <= yesterday_str:
                rollup_end = min(end_date_str, yesterday_str) if end_date_str else yesterday_str
                rollups = StatsRollupTable.get_date_range(start_date_str, rollup_end)

                if rollups:
                    rollup_stats = aggregate_rollup_data(rollups)

        # Calculate today's stats live if needed
        live_stats = None
        if today_in_range:
            today_start = datetime.datetime.combine(today, datetime.time.min).timestamp()
            today_end = datetime.datetime.combine(today, datetime.time.max).timestamp()
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
            logger.debug("[Anki Kanji] No rollup data, falling back to direct query")
            try:
                if start_timestamp is not None or end_timestamp is not None:
                    start_ts = _timestamp_ms_to_seconds(start_timestamp)
                    end_ts = _timestamp_ms_to_seconds(end_timestamp)
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
            sorted_kanji = sorted(kanji_freq_dict.items(), key=lambda x: x[1], reverse=True)

            kanji_data = []
            for kanji, count in sorted_kanji:
                color = get_gradient_color(count, max_frequency)
                kanji_data.append({"kanji": kanji, "frequency": count, "color": color})

            gsm_kanji_stats = {
                "kanji_data": kanji_data,
                "unique_count": len(sorted_kanji),
                "max_frequency": max_frequency,
            }

        # Fetch Anki kanji from the cached notes using the same parent-tag and
        # optional creation-time filters as the rest of the Anki stats views.
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
        overlap_count = len(gsm_kanji_set & anki_kanji_set)
        coverage_percent = (overlap_count / gsm_kanji_count * 100) if gsm_kanji_count else 0.0

        return {
            "missing_kanji": missing_kanji,
            "anki_kanji_count": anki_kanji_count,
            "gsm_kanji_count": gsm_kanji_count,
            "coverage_percent": round(coverage_percent, 1),
        }

    except Exception as e:
        logger.error(f"Error fetching kanji stats: {e}")
        logger.error(traceback.format_exc())
        raise


def _fetch_game_stats(
    start_timestamp: int | None,
    end_timestamp: int | None,
) -> list:
    """Return per-game Anki statistics from the local cache."""
    if _is_cache_empty():
        return []

    try:
        parent_tag = get_config().anki.parent_tag.strip() or "Game"

        anki_data = _get_anki_data()
        notes_by_id = anki_data["notes_by_id"]
        note_tags_by_id = anki_data.get("note_tags_by_id")
        all_cards = list(anki_data["all_cards"])
        reviews_by_card = anki_data["reviews_by_card"]

        # Filter cards by timestamp if provided (note.note_id is creation time in ms)
        if start_timestamp is not None or end_timestamp is not None:
            filtered_cards = []
            for card in all_cards:
                note = notes_by_id.get(card.note_id)
                if note and _matches_optional_timestamp_range(note.note_id, start_timestamp, end_timestamp):
                    filtered_cards.append(card)
            all_cards = filtered_cards

        if not all_cards:
            return []

        # Group cards by game tag
        game_cards: dict[str, list] = {}
        for card in all_cards:
            note = notes_by_id.get(card.note_id)
            if not note:
                continue

            tags = _get_note_tags(note, note_tags_by_id)

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
            return []

        # Process each game
        game_stats = []
        for game_name, cards in game_cards.items():
            note_stats: dict[int, dict] = {}

            for card in cards:
                card_reviews = reviews_by_card.get(card.card_id, [])
                note_id = card.note_id

                for review in card_reviews:
                    if not _matches_optional_timestamp_range(review.review_time, start_timestamp, end_timestamp):
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
                avg_retention = (retention_sum / note_count) * 100 if note_count > 0 else 0
                avg_time_seconds = (total_time / total_reviews / 1000.0) if total_reviews > 0 else 0

                game_stats.append(
                    {
                        "game_name": game_name,
                        "card_count": len(cards),
                        "avg_time_per_card": round(avg_time_seconds, 2),
                        "retention_pct": round(avg_retention, 1),
                        "total_reviews": total_reviews,
                        "mined_lines": 0,
                    }
                )
            else:
                game_stats.append(
                    {
                        "game_name": game_name,
                        "card_count": len(cards),
                        "avg_time_per_card": 0,
                        "retention_pct": 0,
                        "total_reviews": 0,
                        "mined_lines": 0,
                    }
                )

        game_stats.sort(key=lambda x: x["game_name"])
        return game_stats

    except Exception as e:
        logger.error(f"Failed to fetch game stats from cache: {e}")
        return []


def _fetch_nsfw_sfw_retention(
    start_timestamp: int | None,
    end_timestamp: int | None,
) -> dict:
    """Return NSFW vs SFW retention statistics from the local cache."""
    _empty = {
        "nsfw_retention": 0,
        "sfw_retention": 0,
        "nsfw_reviews": 0,
        "sfw_reviews": 0,
        "nsfw_avg_time": 0,
        "sfw_avg_time": 0,
    }

    if _is_cache_empty():
        return {**_empty, **_CACHE_EMPTY_RESPONSE}

    try:
        anki_data = _get_anki_data()
        notes_by_id = anki_data["notes_by_id"]
        note_tags_by_id = anki_data.get("note_tags_by_id")
        reviews_by_card = anki_data["reviews_by_card"]

        parent_tag = get_config().anki.parent_tag.strip() or "Game"

        # Classify notes as NSFW or SFW
        nsfw_note_ids = set()
        sfw_note_ids = set()

        for note in notes_by_id.values():
            tags = _get_note_tags(note, note_tags_by_id)
            has_parent = any(t.startswith(f"{parent_tag}") for t in tags)
            if not has_parent:
                continue
            if "NSFW" in tags:
                nsfw_note_ids.add(note.note_id)
            else:
                sfw_note_ids.add(note.note_id)

        all_cards = list(anki_data["all_cards"])

        # Filter cards by timestamp if provided (note.note_id is creation time in ms)
        if start_timestamp is not None or end_timestamp is not None:
            filtered_cards = []
            for card in all_cards:
                note = notes_by_id.get(card.note_id)
                if note and _matches_optional_timestamp_range(note.note_id, start_timestamp, end_timestamp):
                    filtered_cards.append(card)
            all_cards = filtered_cards

        nsfw_cards = [c for c in all_cards if c.note_id in nsfw_note_ids]
        sfw_cards = [c for c in all_cards if c.note_id in sfw_note_ids]

        def calc_retention(cards):
            if not cards:
                return 0.0, 0, 0.0

            note_stats: dict[int, dict] = {}
            for card in cards:
                card_reviews = reviews_by_card.get(card.card_id, [])
                note_id = card.note_id

                for review in card_reviews:
                    if not _matches_optional_timestamp_range(review.review_time, start_timestamp, end_timestamp):
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
            avg_retention = (retention_sum / note_count) * 100 if note_count > 0 else 0
            avg_time_seconds = (total_time / total_reviews / 1000.0) if total_reviews > 0 else 0
            return avg_retention, total_reviews, avg_time_seconds

        nsfw_retention, nsfw_reviews, nsfw_avg_time = calc_retention(nsfw_cards)
        sfw_retention, sfw_reviews, sfw_avg_time = calc_retention(sfw_cards)

        return {
            "nsfw_retention": round(nsfw_retention, 1),
            "sfw_retention": round(sfw_retention, 1),
            "nsfw_reviews": nsfw_reviews,
            "sfw_reviews": sfw_reviews,
            "nsfw_avg_time": round(nsfw_avg_time, 2),
            "sfw_avg_time": round(sfw_avg_time, 2),
        }

    except Exception as e:
        logger.error(f"Failed to fetch NSFW/SFW retention stats from cache: {e}")
        return _empty


def _fetch_anki_mining_heatmap(
    start_timestamp: int | None,
    end_timestamp: int | None,
) -> dict:
    """Return mining heatmap data for the given time range."""
    try:
        try:
            if start_timestamp is not None or end_timestamp is not None:
                start_ts = _timestamp_ms_to_seconds(start_timestamp)
                end_ts = _timestamp_ms_to_seconds(end_timestamp)
                all_lines = GameLinesTable.get_lines_filtered_by_timestamp(start=start_ts, end=end_ts, for_stats=True)
            else:
                all_lines = GameLinesTable.all()
        except Exception as e:
            logger.warning(f"Failed to filter lines by timestamp: {e}, fetching all lines instead")
            logger.warning(traceback.format_exc())
            all_lines = GameLinesTable.all()

        mining_heatmap = calculate_mining_heatmap_data(all_lines)
        return mining_heatmap

    except Exception as e:
        logger.error(f"Error fetching mining heatmap: {e}")
        return {}


def _resolve_anki_reading_impact_date_range(
    start_timestamp: int | None, end_timestamp: int | None
) -> tuple[datetime.date, datetime.date]:
    """Resolve a safe inclusive date range for reading-impact charts."""
    today = datetime.date.today()

    if start_timestamp is not None or end_timestamp is not None:
        try:
            start_seconds = _timestamp_ms_to_seconds(start_timestamp)
            end_seconds = _timestamp_ms_to_seconds(end_timestamp)
            start_date = (
                datetime.date.fromtimestamp(start_seconds)
                if start_seconds is not None
                else _default_anki_stats_start_date(today)
            )
            end_date = datetime.date.fromtimestamp(end_seconds) if end_seconds is not None else today
        except (OverflowError, OSError, TypeError, ValueError):
            start_date = today
            end_date = today
    else:
        start_date = _default_anki_stats_start_date(today)
        end_date = today

    if start_date > end_date:
        start_date, end_date = end_date, start_date

    if end_date > today:
        end_date = today
    if start_date > today:
        start_date = today

    return start_date, end_date


def _week_start_for_date(value: datetime.date) -> datetime.date:
    """Return the Monday-start week anchor for a date."""
    return value - datetime.timedelta(days=value.weekday())


def _build_week_starts(start_date: datetime.date, end_date: datetime.date) -> list[datetime.date]:
    """Return all Monday-start week buckets that intersect the range."""
    first_week = _week_start_for_date(start_date)
    last_week = _week_start_for_date(end_date)
    current = first_week
    weeks: list[datetime.date] = []
    while current <= last_week:
        weeks.append(current)
        current += datetime.timedelta(days=7)
    return weeks


def _safe_parse_game_activity_payload(payload: object) -> dict:
    """Return a normalized game activity mapping from rollup JSON or dict."""
    if not payload:
        return {}
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except (json.JSONDecodeError, TypeError):
            return {}
    return payload if isinstance(payload, dict) else {}


def _merge_game_activity_totals(target: dict, payload: object) -> None:
    """Merge a game_activity_data payload into cumulative totals."""
    for game_id, activity in _safe_parse_game_activity_payload(payload).items():
        if not isinstance(activity, dict):
            continue
        merged = target.setdefault(
            str(game_id),
            {
                "title": activity.get("title", f"Game {game_id}"),
                "chars": 0,
                "time": 0.0,
                "lines": 0,
            },
        )
        if not merged.get("title"):
            merged["title"] = activity.get("title", f"Game {game_id}")
        merged["chars"] += int(activity.get("chars", 0) or 0)
        merged["time"] += float(activity.get("time", 0) or 0.0)
        merged["lines"] += int(activity.get("lines", 0) or 0)


def _normalise_game_name_for_impact(value: object) -> str:
    """Normalise game names/titles for approximate cross-source matching."""
    if value in (None, ""):
        return ""
    collapsed = "".join(ch if str(ch).isalnum() else " " for ch in str(value).casefold())
    return " ".join(collapsed.split())


def _build_weekly_maturity_series(
    item_dates: dict[int | str, datetime.date],
    start_date: datetime.date,
    end_date: datetime.date,
    week_starts: list[datetime.date],
) -> list[int]:
    """Count first-mature item dates into Monday-start week buckets."""
    weekly_counts: dict[str, int] = defaultdict(int)
    for item_date in item_dates.values():
        if start_date <= item_date <= end_date:
            weekly_counts[_week_start_for_date(item_date).isoformat()] += 1
    return [int(weekly_counts.get(week_start.isoformat(), 0)) for week_start in week_starts]


def _build_lagged_series(series: list[int], lag_weeks: int) -> list[int | None]:
    """Align a target series back onto its source weeks with null trailing values."""
    aligned: list[int | None] = []
    for index in range(len(series)):
        target_index = index + lag_weeks
        aligned.append(series[target_index] if target_index < len(series) else None)
    return aligned


def _build_lagged_pairs(
    week_starts: list[datetime.date],
    reading_chars: list[int],
    reading_hours: list[float],
    cards_mined: list[int],
    mature_words: list[int],
    mature_kanji: list[int],
    lag_weeks: int,
) -> list[dict]:
    """Return complete lag pairs for scatter/trend charts."""
    pairs: list[dict] = []
    for index, week_start in enumerate(week_starts):
        target_index = index + lag_weeks
        if target_index >= len(week_starts):
            break
        pairs.append(
            {
                "source_label": week_start.isoformat(),
                "target_label": week_starts[target_index].isoformat(),
                "reading_chars": int(reading_chars[index]),
                "reading_hours": round(float(reading_hours[index]), 2),
                "cards_mined": int(cards_mined[index]),
                "mature_words": int(mature_words[target_index]),
                "mature_kanji": int(mature_kanji[target_index]),
            }
        )
    return pairs


def _build_per_game_reading_impact(game_activity_totals: dict, anki_game_stats: list[dict]) -> list[dict]:
    """Merge reading totals with Anki review stats using normalized game names."""
    reading_by_name: dict[str, dict] = {}
    for activity in game_activity_totals.values():
        title = activity.get("title") or ""
        normalized = _normalise_game_name_for_impact(title)
        if not normalized:
            continue
        merged = reading_by_name.setdefault(
            normalized,
            {
                "game_name": title,
                "reading_chars": 0,
                "reading_hours": 0.0,
            },
        )
        if not merged.get("game_name"):
            merged["game_name"] = title
        merged["reading_chars"] += int(activity.get("chars", 0) or 0)
        merged["reading_hours"] += float(activity.get("time", 0) or 0.0) / 3600.0

    merged_games: list[dict] = []
    for game in anki_game_stats:
        normalized = _normalise_game_name_for_impact(game.get("game_name"))
        reading = reading_by_name.get(normalized)
        if not reading:
            continue
        card_count = int(game.get("card_count", 0) or 0)
        reading_chars = int(reading.get("reading_chars", 0) or 0)
        if reading_chars <= 0 or card_count <= 0:
            continue
        merged_games.append(
            {
                "game_name": game.get("game_name") or reading.get("game_name") or "Unknown Game",
                "reading_chars": reading_chars,
                "reading_hours": round(float(reading.get("reading_hours", 0.0)), 2),
                "card_count": card_count,
                "retention_pct": round(float(game.get("retention_pct", 0) or 0), 1),
                "avg_time_per_card": round(float(game.get("avg_time_per_card", 0) or 0), 2),
                "total_reviews": int(game.get("total_reviews", 0) or 0),
            }
        )

    merged_games.sort(
        key=lambda item: (item.get("reading_chars", 0), item.get("card_count", 0)),
        reverse=True,
    )
    return merged_games


def _fetch_anki_reading_impact(
    start_timestamp: int | None,
    end_timestamp: int | None,
    lag_weeks: int = 3,
    *,
    include_lagged_pairs: bool = True,
    include_per_game: bool = True,
) -> dict:
    """Return weekly GSM-reading vs Anki-impact aggregates for the Anki page."""
    lag_weeks = max(int(lag_weeks or 3), 1)
    start_date, end_date = _resolve_anki_reading_impact_date_range(start_timestamp, end_timestamp)
    today = datetime.date.today()
    week_starts = _build_week_starts(start_date, end_date)
    week_labels = [week_start.isoformat() for week_start in week_starts]

    weekly_reading_chars: dict[str, int] = defaultdict(int)
    weekly_reading_hours: dict[str, float] = defaultdict(float)
    weekly_cards_mined: dict[str, int] = defaultdict(int)
    game_activity_totals: dict[str, dict] = {}

    if start_date <= end_date:
        historical_end = min(end_date, today - datetime.timedelta(days=1))
        if start_date <= historical_end:
            rollups = StatsRollupTable.get_date_range(start_date.isoformat(), historical_end.isoformat())
        else:
            rollups = []

        for rollup in rollups:
            try:
                rollup_date = datetime.datetime.strptime(rollup.date, "%Y-%m-%d").date()
            except (TypeError, ValueError):
                continue
            week_key = _week_start_for_date(rollup_date).isoformat()
            weekly_reading_chars[week_key] += int(rollup.total_characters or 0)
            weekly_reading_hours[week_key] += float(rollup.total_reading_time_seconds or 0.0) / 3600.0
            weekly_cards_mined[week_key] += int(rollup.anki_cards_created or 0)
            _merge_game_activity_totals(game_activity_totals, rollup.game_activity_data)

        if start_date <= today <= end_date:
            today_start = datetime.datetime.combine(today, datetime.time.min).timestamp()
            today_end = datetime.datetime.combine(today, datetime.time.max).timestamp()
            today_lines = GameLinesTable.get_lines_filtered_by_timestamp(
                start=today_start, end=today_end, for_stats=True
            )
            if today_lines:
                live_stats = calculate_live_stats_for_today(today_lines, include_frequency_data=False)
                today_week_key = _week_start_for_date(today).isoformat()
                weekly_reading_chars[today_week_key] += int(live_stats.get("total_characters", 0) or 0)
                weekly_reading_hours[today_week_key] += (
                    float(live_stats.get("total_reading_time_seconds", 0) or 0.0) / 3600.0
                )
                weekly_cards_mined[today_week_key] += int(live_stats.get("anki_cards_created", 0) or 0)
                _merge_game_activity_totals(game_activity_totals, live_stats.get("game_activity_data", {}))

    tokenization_enabled = False
    mature_word_dates: dict[str, datetime.date] = {}
    mature_kanji_dates: dict[int, datetime.date] = {}
    try:
        from GameSentenceMiner.web.tokenization_api import (
            _get_db,
            _get_first_mature_kanji_dates,
            _get_first_mature_word_dates,
            is_tokenization_enabled,
        )

        tokenization_enabled = bool(is_tokenization_enabled())
        if tokenization_enabled:
            db = _get_db()
            mature_word_dates = _get_first_mature_word_dates(db)
            mature_kanji_dates = _get_first_mature_kanji_dates(db)
    except Exception as exc:
        logger.debug(f"Failed to load tokenization maturity data for reading impact: {exc}")

    reading_chars = [int(weekly_reading_chars.get(week_label, 0)) for week_label in week_labels]
    reading_hours = [round(float(weekly_reading_hours.get(week_label, 0.0)), 2) for week_label in week_labels]
    cards_mined = [int(weekly_cards_mined.get(week_label, 0)) for week_label in week_labels]
    mature_words = _build_weekly_maturity_series(mature_word_dates, start_date, end_date, week_starts)
    mature_kanji = _build_weekly_maturity_series(mature_kanji_dates, start_date, end_date, week_starts)
    lagged_mature_words = _build_lagged_series(mature_words, lag_weeks)
    lagged_mature_kanji = _build_lagged_series(mature_kanji, lag_weeks)
    lagged_pairs = (
        _build_lagged_pairs(
            week_starts,
            reading_chars,
            reading_hours,
            cards_mined,
            mature_words,
            mature_kanji,
            lag_weeks,
        )
        if include_lagged_pairs
        else []
    )
    per_game = []
    if include_per_game:
        per_game = _build_per_game_reading_impact(
            game_activity_totals, _fetch_game_stats(start_timestamp, end_timestamp)
        )

    return {
        "start_date": start_date.isoformat(),
        "end_date": end_date.isoformat(),
        "lag_weeks": lag_weeks,
        "tokenization_enabled": tokenization_enabled,
        "labels": week_labels,
        "reading_chars": reading_chars,
        "reading_hours": reading_hours,
        "cards_mined": cards_mined,
        "mature_words": mature_words,
        "mature_kanji": mature_kanji,
        "lagged_mature_words": lagged_mature_words,
        "lagged_mature_kanji": lagged_mature_kanji,
        "lagged_pairs": lagged_pairs,
        "per_game": per_game,
    }


def _extract_note_field_kanji(notes_info, field_name):
    anki_kanji_set = set()
    for note in notes_info:
        fields = note.get("fields", {})
        target_field = fields.get(field_name)
        if not target_field or "value" not in target_field:
            continue

        field_value = target_field["value"]
        if not field_value:
            continue

        for char in str(field_value):
            if is_kanji(char):
                anki_kanji_set.add(char)

    return anki_kanji_set


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
        start_timestamp = int(request.args.get("start_timestamp")) if request.args.get("start_timestamp") else None
        end_timestamp = int(request.args.get("end_timestamp")) if request.args.get("end_timestamp") else None
        return jsonify(_fetch_earliest_date(start_timestamp, end_timestamp))

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
            schema:
              type: object
              properties:
                missing_kanji:
                  type: array
                  items:
                    type: object
                    properties:
                      kanji:
                        type: string
                      frequency:
                        type: integer
                anki_kanji_count:
                  type: integer
                  description: Unique kanji in the configured Anki word field across the whole collection
                gsm_kanji_count:
                  type: integer
                  description: Unique kanji seen in GSM for the selected GSM date range
                coverage_percent:
                  type: number
                  description: Percentage of GSM kanji covered by the configured Anki word field
          500:
            description: Failed to fetch kanji stats
        """
        start_timestamp = int(request.args.get("start_timestamp")) if request.args.get("start_timestamp") else None
        end_timestamp = int(request.args.get("end_timestamp")) if request.args.get("end_timestamp") else None

        try:
            return jsonify(_fetch_kanji_stats(start_timestamp, end_timestamp))
        except Exception as e:
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
        start_timestamp = int(request.args.get("start_timestamp")) if request.args.get("start_timestamp") else None
        end_timestamp = int(request.args.get("end_timestamp")) if request.args.get("end_timestamp") else None
        return jsonify(_fetch_game_stats(start_timestamp, end_timestamp))

    @app.route("/api/anki_nsfw_sfw_retention")
    def api_anki_nsfw_sfw_retention():
        """Get NSFW vs SFW retention statistics from local cache."""
        start_timestamp = int(request.args.get("start_timestamp")) if request.args.get("start_timestamp") else None
        end_timestamp = int(request.args.get("end_timestamp")) if request.args.get("end_timestamp") else None
        return jsonify(_fetch_nsfw_sfw_retention(start_timestamp, end_timestamp))

    @app.route("/api/anki_mining_heatmap")
    def api_anki_mining_heatmap():
        """
        Get mining heatmap data.

        Note: Currently uses direct query approach since mining heatmap requires checking
        specific fields (screenshot_in_anki, audio_in_anki) which aren't aggregated in rollup.
        Could be optimized in future by adding daily mining counts to rollup table.
        """
        start_timestamp = int(request.args.get("start_timestamp")) if request.args.get("start_timestamp") else None
        end_timestamp = int(request.args.get("end_timestamp")) if request.args.get("end_timestamp") else None
        return jsonify(_fetch_anki_mining_heatmap(start_timestamp, end_timestamp))

    @app.route("/api/anki-reading-impact")
    def api_anki_reading_impact():
        """Return weekly reading-to-Anki impact series for the Anki stats page."""
        start_timestamp = int(request.args.get("start_timestamp")) if request.args.get("start_timestamp") else None
        end_timestamp = int(request.args.get("end_timestamp")) if request.args.get("end_timestamp") else None
        lag_weeks = int(request.args.get("lag_weeks")) if request.args.get("lag_weeks") else 3
        try:
            return jsonify(_fetch_anki_reading_impact(start_timestamp, end_timestamp, lag_weeks=lag_weeks))
        except Exception as e:
            logger.exception(f"Failed to fetch Anki reading impact: {e}")
            return jsonify({"error": "Failed to fetch Anki reading impact"}), 500

    @app.route("/api/anki_sync_status")
    def api_anki_sync_status():
        """Return sync status, including cache counts and auto-sync schedule metadata."""
        try:
            from GameSentenceMiner.util.database.anki_tables import (
                AnkiNotesTable,
                AnkiCardsTable,
            )

            # Use SQL aggregation instead of loading all rows into Python
            note_row = AnkiNotesTable._db.fetchone(f"SELECT COUNT(*), MAX(synced_at) FROM {AnkiNotesTable._table}")
            card_row = AnkiCardsTable._db.fetchone(f"SELECT COUNT(*) FROM {AnkiCardsTable._table}")
            note_count = note_row[0] if note_row else 0
            card_count = card_row[0] if card_row else 0
            cache_populated = note_count > 0

            last_synced = None
            if note_row and note_row[1] is not None:
                import datetime as _dt

                last_synced = _dt.datetime.fromtimestamp(float(note_row[1]), tz=_dt.timezone.utc).isoformat()

            auto_sync_enabled = False
            auto_sync_schedule = None
            next_auto_sync = None

            try:
                from GameSentenceMiner.util.database.cron_table import CronTable
                import datetime as _dt

                anki_sync_cron = CronTable.get_by_name("anki_card_sync")
                if anki_sync_cron is not None:
                    auto_sync_enabled = bool(anki_sync_cron.enabled)
                    auto_sync_schedule = anki_sync_cron.schedule

                    if anki_sync_cron.next_run is not None:
                        next_auto_sync = _dt.datetime.fromtimestamp(
                            float(anki_sync_cron.next_run), tz=_dt.timezone.utc
                        ).isoformat()
            except Exception as cron_error:
                logger.debug(f"Unable to load anki_card_sync cron status: {cron_error}")

            return jsonify(
                {
                    "last_synced": last_synced,
                    "cache_populated": cache_populated,
                    "note_count": note_count,
                    "card_count": card_count,
                    "auto_sync_enabled": auto_sync_enabled,
                    "auto_sync_schedule": auto_sync_schedule,
                    "next_auto_sync": next_auto_sync,
                }
            )
        except Exception as e:
            logger.error(f"Failed to fetch sync status: {e}")
            return jsonify(
                {
                    "last_synced": None,
                    "cache_populated": False,
                    "note_count": 0,
                    "card_count": 0,
                    "auto_sync_enabled": False,
                    "auto_sync_schedule": None,
                    "next_auto_sync": None,
                }
            )

    @app.route("/api/anki_sync_now", methods=["POST"])
    def api_anki_sync_now():
        """Queue a manual Anki cache sync run."""
        try:
            from GameSentenceMiner.util.cron import cron_scheduler
            import datetime as _dt

            cron_scheduler.force_anki_card_sync()
            queued_at = _dt.datetime.now(_dt.timezone.utc).isoformat()

            return (
                jsonify(
                    {
                        "status": "queued",
                        "message": "Anki sync has been queued.",
                        "queued_at": queued_at,
                    }
                ),
                202,
            )
        except Exception as e:
            logger.error(f"Failed to queue manual Anki sync: {e}")
            return jsonify({"status": "error", "error": str(e)}), 500

    @app.route("/api/anki_stats_combined")
    def api_anki_stats_combined():
        """Combined Anki stats endpoint.

        Calls the extracted ``_fetch_*`` functions directly instead of
        making self-referential HTTP requests, avoiding potential
        deadlocks in the waitress thread pool. Use the optional
        ``sections=foo,bar`` query parameter to limit work to the
        requested subsections.
        """
        start_timestamp = int(request.args.get("start_timestamp")) if request.args.get("start_timestamp") else None
        end_timestamp = int(request.args.get("end_timestamp")) if request.args.get("end_timestamp") else None
        lag_weeks = int(request.args.get("lag_weeks")) if request.args.get("lag_weeks") else 3

        section_fetchers = {
            "earliest_date": lambda s, e: _fetch_earliest_date(s, e),
            "kanji_stats": lambda s, e: _fetch_kanji_stats(s, e),
            "game_stats": lambda s, e: _fetch_game_stats(s, e),
            "nsfw_sfw_retention": lambda s, e: _fetch_nsfw_sfw_retention(s, e),
            "mining_heatmap": lambda s, e: _fetch_anki_mining_heatmap(s, e),
            "reading_impact": lambda s, e: _fetch_anki_reading_impact(
                s,
                e,
                lag_weeks=lag_weeks,
                include_lagged_pairs=False,
                include_per_game=False,
            ),
        }

        try:
            requested_sections = _parse_requested_anki_stats_sections(request.args.get("sections"), section_fetchers)
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400

        results: dict[str, object] = {}
        for key in requested_sections:
            try:
                results[key] = section_fetchers[key](start_timestamp, end_timestamp)
            except Exception as e:
                logger.error(f"Error fetching {key}: {e}")
                results[key] = _ANKI_STATS_SECTION_DEFAULTS.get(key, {})

        combined_response: dict[str, object] = {}
        for key in requested_sections:
            if key == "earliest_date":
                earliest = results.get("earliest_date", {})
                if isinstance(earliest, dict):
                    combined_response[key] = earliest.get("earliest_date", 0)
                else:
                    combined_response[key] = 0
                continue
            combined_response[key] = results.get(key, _ANKI_STATS_SECTION_DEFAULTS.get(key, {}))

        return jsonify(combined_response)


def _get_anki_kanji_from_cache(
    start_timestamp: int | None = None,
    end_timestamp: int | None = None,
) -> set[str]:
    """Extract unique kanji characters from cached Anki notes.

    Notes must match the configured parent tag and, when provided, the optional
    creation-time bounds. The configured word field is preferred, but we fall
    back to the first available field for backward compatibility with older
    configs and tests.
    """
    if _is_cache_empty():
        return set()

    try:
        parent_tag = get_config().anki.parent_tag.strip() or "Game"
        parent_tag_prefix = f"{parent_tag}::"
        raw_word_field = getattr(get_config().anki, "word_field", "")
        word_field = raw_word_field.strip() if isinstance(raw_word_field, str) else ""

        data = _get_anki_data()
        notes = data["notes_by_id"].values()
        note_tags_by_id = data.get("note_tags_by_id")
        note_fields_by_id = data.get("note_fields_by_id")
        anki_kanji_set: set[str] = set()

        for note in notes:
            tags = _get_note_tags(note, note_tags_by_id)
            if not any(
                isinstance(tag, str) and tag.startswith(parent_tag_prefix)
                for tag in tags
            ):
                continue

            if not _matches_optional_timestamp_range(
                note.note_id, start_timestamp, end_timestamp
            ):
                continue

            fields = _get_note_fields(note, note_fields_by_id)
            value = None

            if word_field:
                configured_field = fields.get(word_field, {})
                if isinstance(configured_field, dict):
                    configured_value = configured_field.get("value")
                    if isinstance(configured_value, str):
                        value = configured_value

            if value is None:
                first_field = next(iter(fields.values()), None)
                if isinstance(first_field, dict):
                    first_value = first_field.get("value")
                    if isinstance(first_value, str):
                        value = first_value

            if not isinstance(value, str):
                continue

            for char in value:
                if is_kanji(char):
                    anki_kanji_set.add(char)

        return anki_kanji_set
    except Exception as e:
        logger.error(f"Failed to fetch kanji from cache: {e}")
        return set()
