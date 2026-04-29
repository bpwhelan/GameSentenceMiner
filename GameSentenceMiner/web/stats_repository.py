from __future__ import annotations

import datetime
import json
from functools import lru_cache
from typing import Any, Dict, Iterable, List, Tuple

from GameSentenceMiner.util.config.configuration import get_stats_config
from GameSentenceMiner.util.database.db import (
    GameLinesTable,
    clean_text_for_stats,
)
from GameSentenceMiner.util.database.games_table import GamesTable
from GameSentenceMiner.util.database.stats_rollup_table import StatsRollupTable


class StatsLineRecord:
    """Lightweight line record for stats endpoints."""

    __slots__ = (
        "id",
        "game_name",
        "line_text",
        "screenshot_in_anki",
        "audio_in_anki",
        "translation",
        "timestamp",
        "game_id",
        "note_ids",
    )

    def __init__(
        self,
        line_id: str,
        game_name: str,
        line_text: str,
        screenshot_in_anki: str = "",
        audio_in_anki: str = "",
        translation: str = "",
        timestamp: float = 0.0,
        game_id: str = "",
        note_ids: Any = None,
    ):
        self.id = line_id
        self.game_name = game_name
        self.line_text = line_text
        self.screenshot_in_anki = screenshot_in_anki
        self.audio_in_anki = audio_in_anki
        self.translation = translation
        self.timestamp = timestamp
        self.game_id = game_id
        self.note_ids = note_ids


def _clean_line_text_for_stats(
    raw_line_text: Any,
    regex_out_repetitions: bool,
    extra_punctuation_regex: str,
) -> str:
    if raw_line_text is None:
        return ""

    if isinstance(raw_line_text, str):
        if not raw_line_text:
            return ""
        return _clean_line_text_cached(raw_line_text, regex_out_repetitions, extra_punctuation_regex)

    normalized_text = str(raw_line_text)
    if not normalized_text:
        return ""
    return _clean_line_text_cached(normalized_text, regex_out_repetitions, extra_punctuation_regex)


@lru_cache(maxsize=200000)
def _clean_line_text_cached(
    raw_line_text: str,
    regex_out_repetitions: bool,
    extra_punctuation_regex: str,
) -> str:
    return clean_text_for_stats(
        raw_line_text,
        regex_out_repetitions=regex_out_repetitions,
        extra_punctuation_regex=extra_punctuation_regex,
    )


def _parse_note_ids_for_stats(raw_note_ids: Any) -> Any:
    if raw_note_ids is None:
        return []

    if isinstance(raw_note_ids, list):
        return raw_note_ids

    if isinstance(raw_note_ids, str):
        return _parse_note_ids_string_cached(raw_note_ids)

    return raw_note_ids


@lru_cache(maxsize=32768)
def _parse_note_ids_string_cached(raw_note_ids: str) -> Any:
    stripped = raw_note_ids.strip()
    if not stripped or stripped == "[]":
        return ()
    try:
        decoded = json.loads(stripped)
        if not decoded:
            return ()
        if isinstance(decoded, list):
            return tuple(decoded)
        return decoded
    except json.JSONDecodeError:
        return ()


def query_stats_lines(
    where_clause: str,
    params: tuple,
    order_clause: str = "timestamp ASC",
    limit_clause: str = "",
    include_media_fields: bool = True,
    parse_note_ids: bool = True,
) -> list[StatsLineRecord]:
    stats_config = get_stats_config()
    regex_out_repetitions = getattr(stats_config, "regex_out_repetitions", False)
    extra_punctuation_regex = getattr(stats_config, "extra_punctuation_regex", "")
    if include_media_fields and parse_note_ids:
        rows = GameLinesTable._db.fetchall(
            f"""
            SELECT id, game_name, line_text, screenshot_in_anki, audio_in_anki,
                   translation, timestamp, game_id, note_ids
            FROM {GameLinesTable._table}
            WHERE {where_clause}
            ORDER BY {order_clause}
            {limit_clause}
            """,
            params,
        )
        return [
            StatsLineRecord(
                line_id=str(row[0] or ""),
                game_name=str(row[1] or ""),
                line_text=_clean_line_text_for_stats(row[2], regex_out_repetitions, extra_punctuation_regex),
                screenshot_in_anki=str(row[3] or ""),
                audio_in_anki=str(row[4] or ""),
                translation=str(row[5] or ""),
                timestamp=float(row[6]) if row[6] is not None else 0.0,
                game_id=str(row[7] or ""),
                note_ids=_parse_note_ids_for_stats(row[8]),
            )
            for row in rows
        ]

    if include_media_fields and not parse_note_ids:
        rows = GameLinesTable._db.fetchall(
            f"""
            SELECT id, game_name, line_text, screenshot_in_anki, audio_in_anki,
                   translation, timestamp, game_id
            FROM {GameLinesTable._table}
            WHERE {where_clause}
            ORDER BY {order_clause}
            {limit_clause}
            """,
            params,
        )
        return [
            StatsLineRecord(
                line_id=str(row[0] or ""),
                game_name=str(row[1] or ""),
                line_text=_clean_line_text_for_stats(row[2], regex_out_repetitions, extra_punctuation_regex),
                screenshot_in_anki=str(row[3] or ""),
                audio_in_anki=str(row[4] or ""),
                translation=str(row[5] or ""),
                timestamp=float(row[6]) if row[6] is not None else 0.0,
                game_id=str(row[7] or ""),
                note_ids=[],
            )
            for row in rows
        ]

    if parse_note_ids:
        rows = GameLinesTable._db.fetchall(
            f"""
            SELECT id, game_name, line_text, timestamp, game_id, note_ids
            FROM {GameLinesTable._table}
            WHERE {where_clause}
            ORDER BY {order_clause}
            {limit_clause}
            """,
            params,
        )
        return [
            StatsLineRecord(
                line_id=str(row[0] or ""),
                game_name=str(row[1] or ""),
                line_text=_clean_line_text_for_stats(row[2], regex_out_repetitions, extra_punctuation_regex),
                timestamp=float(row[3]) if row[3] is not None else 0.0,
                game_id=str(row[4] or ""),
                note_ids=_parse_note_ids_for_stats(row[5]),
            )
            for row in rows
        ]

    rows = GameLinesTable._db.fetchall(
        f"""
        SELECT id, game_name, line_text, timestamp, game_id
        FROM {GameLinesTable._table}
        WHERE {where_clause}
        ORDER BY {order_clause}
        {limit_clause}
        """,
        params,
    )
    return [
        StatsLineRecord(
            line_id=str(row[0] or ""),
            game_name=str(row[1] or ""),
            line_text=_clean_line_text_for_stats(row[2], regex_out_repetitions, extra_punctuation_regex),
            timestamp=float(row[3]) if row[3] is not None else 0.0,
            game_id=str(row[4] or ""),
            note_ids=[],
        )
        for row in rows
    ]


def fetch_stats_lines_for_timestamp_range(
    start_timestamp: float,
    end_timestamp: float,
) -> list[StatsLineRecord]:
    """Fetch lightweight stats line records for an inclusive timestamp range."""
    return query_stats_lines(
        where_clause="timestamp >= ? AND timestamp <= ?",
        params=(start_timestamp, end_timestamp),
        include_media_fields=False,
        parse_note_ids=False,
    )


def build_game_mappings(
    all_games: Iterable[Any],
) -> Tuple[Dict[str, str], Dict[str, str], Dict[str, str]]:
    """Build game_id and game_name mappings from an iterable of game records."""
    game_id_to_game_name: Dict[str, str] = {}
    game_name_to_title: Dict[str, str] = {}
    game_id_to_title: Dict[str, str] = {}

    for game in all_games:
        if game.id and game.obs_scene_name:
            game_id_to_game_name[game.id] = game.obs_scene_name
        if game.id and game.title_original:
            game_id_to_title[game.id] = game.title_original
        if game.obs_scene_name and game.title_original:
            game_name_to_title[game.obs_scene_name] = game.title_original
        elif game.obs_scene_name:
            game_name_to_title[game.obs_scene_name] = game.obs_scene_name

    return game_id_to_game_name, game_name_to_title, game_id_to_title


def build_game_mappings_from_games_table() -> Tuple[Dict[str, str], Dict[str, str], Dict[str, str]]:
    """Build game_id and game_name mappings from GamesTable."""
    return build_game_mappings(GamesTable.all_without_images())


def get_date_range_params(
    start_timestamp: float | None,
    end_timestamp: float | None,
    today: datetime.date,
) -> Tuple[str, str]:
    """Determine start/end date strings from optional timestamps."""
    today_str = today.strftime("%Y-%m-%d")

    if start_timestamp and end_timestamp:
        start_date_str = datetime.date.fromtimestamp(start_timestamp).strftime("%Y-%m-%d")
        end_date_str = datetime.date.fromtimestamp(end_timestamp).strftime("%Y-%m-%d")
    else:
        first_rollup_date = StatsRollupTable.get_first_date()
        start_date_str = first_rollup_date if first_rollup_date else today_str
        end_date_str = today_str

    return start_date_str, end_date_str


def fetch_rollups_for_range(
    start_date_str: str,
    yesterday_str: str,
) -> List:
    """Fetch rollup records for a historical date range (up to yesterday)."""
    if start_date_str <= yesterday_str:
        return StatsRollupTable.get_date_range(start_date_str, yesterday_str)
    return []


def fetch_today_lines(today: datetime.date) -> list[StatsLineRecord]:
    """Fetch today's game lines for live stats calculation."""
    today_start = datetime.datetime.combine(today, datetime.time.min).timestamp()
    today_end = datetime.datetime.combine(today, datetime.time.max).timestamp()
    return query_stats_lines(
        where_clause="timestamp >= ? AND timestamp <= ?",
        params=(today_start, today_end),
    )
