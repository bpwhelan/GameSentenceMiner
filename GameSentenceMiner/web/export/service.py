from __future__ import annotations

import datetime
import json
import os
import tempfile
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Callable

from GameSentenceMiner.util.config.configuration import get_config, logger
from GameSentenceMiner.util.database.db import GameLinesTable
from GameSentenceMiner.util.database.game_daily_rollup_table import (
    GameDailyRollupTable,
)
from GameSentenceMiner.util.database.games_table import GamesTable
from GameSentenceMiner.util.database.stats_export_state_table import (
    StatsExportStateTable,
)
from GameSentenceMiner.util.database.third_party_stats_table import (
    ThirdPartyStatsTable,
)
from GameSentenceMiner.web.export import (
    NormalizedActivityRecord,
    NormalizedLibraryRecord,
    get_stats_exporter,
)
from GameSentenceMiner.web.stats import calculate_actual_reading_time
from GameSentenceMiner.web.stats_repository import fetch_today_lines, query_stats_lines


def _clamp_progress(value: int) -> int:
    return max(0, min(100, int(value)))


def _scale_progress(start: int, end: int, current: int, total: int) -> int:
    if total <= 0:
        return end
    return start + int(((end - start) * current) / total)


def _seconds_to_minutes(seconds: float) -> int:
    if seconds <= 0:
        return 0
    return max(0, int(round(seconds / 60)))


def _format_activity_type_label(raw_type: str) -> str:
    normalized = " ".join((raw_type or "").replace("_", " ").replace("-", " ").split()).strip()
    if not normalized:
        return ""
    upper_map = {
        "vn": "Visual Novel",
        "rpg": "RPG",
    }
    lowered = normalized.lower()
    if lowered in upper_map:
        return upper_map[lowered]
    return " ".join(part.capitalize() if not part.isupper() else part for part in normalized.split())


def _map_native_activity(game_type: str) -> tuple[str, str]:
    lowered = (game_type or "").strip().lower()
    label = _format_activity_type_label(game_type)

    if lowered in {"vn", "visual novel"} or "visual novel" in lowered:
        return "Playing", "Visual Novel"
    if "anime" in lowered:
        return "Watching", "Anime"
    if "manga" in lowered:
        return "Reading", "Manga"
    if "web novel" in lowered:
        return "Reading", "Web Novel"
    if "light novel" in lowered:
        return "Reading", "Light Novel"
    if "novel" in lowered or "book" in lowered or "reading" in lowered:
        return "Reading", label or "Reading"
    if "movie" in lowered or "show" in lowered or "watch" in lowered:
        return "Watching", label or "Watching"
    if "music" in lowered or "audio" in lowered or "listen" in lowered or "podcast" in lowered:
        return "Listening", label or "Listening"
    return "Playing", label or "Game"


def _map_external_activity(source: str) -> tuple[str, str]:
    lowered = (source or "").strip().lower()
    if lowered == "mokuro":
        return "Reading", "Book"
    return "Reading", "Reading"


def _map_library_content(game_type: str) -> tuple[str, str]:
    lowered = (game_type or "").strip().lower()

    if lowered in {"vn", "visual novel"} or "visual novel" in lowered:
        return "Playing", "Visual Novel"
    if "anime" in lowered:
        return "Watching", "Anime"
    if "manga" in lowered:
        return "Reading", "Manga"
    if "web novel" in lowered:
        return "Reading", "WebNovel"
    if "light novel" in lowered or lowered == "novel":
        return "Reading", "Novel"
    if "nonfiction" in lowered or "non-fiction" in lowered:
        return "Reading", "NonFiction"
    if "movie" in lowered or "film" in lowered:
        return "Watching", "Movie"
    if "drama" in lowered:
        return "Watching", "Drama"
    if "livestream" in lowered or "stream" in lowered:
        return "Watching", "Livestream"
    if "youtube" in lowered:
        return "Watching", "Youtube Video"
    if "audio" in lowered or "music" in lowered or "podcast" in lowered:
        return "Listening", "Audio"
    if "book" in lowered or "novel" in lowered or "reading" in lowered:
        return "Reading", "Novel"
    if "game" in lowered or "rpg" in lowered:
        return "Playing", "Videogame"
    return "None", "Unknown"


def _normalize_cover_image_base64(image_value: str) -> str:
    image = (image_value or "").strip()
    if not image:
        return ""
    if image.startswith("data:") and "," in image:
        return image.split(",", 1)[1].strip()
    return image


def _normalize_library_links(links_value) -> list[str]:
    if isinstance(links_value, str):
        try:
            links_value = json.loads(links_value)
        except (TypeError, json.JSONDecodeError):
            return []
    if not isinstance(links_value, list):
        return []

    normalized_links: list[str] = []
    seen_links: set[str] = set()

    for link in links_value:
        if isinstance(link, dict):
            url = str(link.get("url") or "").strip()
        elif isinstance(link, str):
            url = link.strip()
        else:
            url = ""

        if not url:
            continue

        url_key = url.lower()
        if url_key in seen_links:
            continue

        normalized_links.append(url)
        seen_links.add(url_key)

    return normalized_links


def _normalize_library_title(game: GamesTable) -> str:
    return (
        game.title_original or game.title_english or game.title_romaji or game.obs_scene_name or game.id or "Untitled"
    )


def _build_library_activity_bounds() -> dict[str, float]:
    rows = GameLinesTable._db.fetchall(
        f"""
        SELECT game_id, MAX(timestamp)
        FROM {GameLinesTable._table}
        WHERE game_id IS NOT NULL AND TRIM(game_id) != ''
        GROUP BY game_id
        """
    )
    return {str(row[0]): float(row[1]) for row in rows if row and row[0] and row[1] is not None}


def _map_library_status(game: GamesTable, last_activity_by_game_id: dict[str, float]) -> str:
    if bool(game.completed):
        return "Complete"
    if game.id and game.id in last_activity_by_game_id:
        return "Ongoing"
    return "Not Started"


def _build_library_extra_data(game: GamesTable, title: str) -> str:
    extra_data: dict[str, object] = {}

    if game.vndb_id:
        extra_data["vNDB_ID"] = game.vndb_id
    if game.anilist_id:
        extra_data["aniList_ID"] = game.anilist_id
    if game.deck_id is not None:
        extra_data["deck_id"] = game.deck_id
    if game.obs_scene_name:
        extra_data["obs_scene_name"] = game.obs_scene_name
    if game.release_date:
        extra_data["release_date"] = game.release_date
    if game.title_romaji and game.title_romaji != title:
        extra_data["title_romaji"] = game.title_romaji
    if game.title_english and game.title_english != title:
        extra_data["title_english"] = game.title_english
    if game.genres:
        extra_data["genres"] = game.genres
    if game.tags:
        extra_data["tags"] = game.tags
    normalized_links = _normalize_library_links(game.links)
    if normalized_links:
        extra_data["links"] = normalized_links

    return json.dumps(extra_data, ensure_ascii=False)


def _build_game_maps() -> tuple[dict[str, GamesTable], dict[str, GamesTable]]:
    games = GamesTable.all_without_images()
    by_id = {game.id: game for game in games if getattr(game, "id", "")}
    by_scene = {game.obs_scene_name: game for game in games if getattr(game, "obs_scene_name", "")}
    return by_id, by_scene


def _resolve_game_metadata(
    game_id: str,
    game_name: str,
    games_by_id: dict[str, GamesTable],
    games_by_scene: dict[str, GamesTable],
) -> tuple[str, str]:
    game = games_by_id.get(game_id) if game_id else None
    if game is None and game_name:
        game = games_by_scene.get(game_name)

    if game is None:
        return game_name or "Unknown Game", ""

    title = (
        game.title_original
        or game.title_english
        or game.title_romaji
        or game_name
        or game.obs_scene_name
        or "Unknown Game"
    )
    return title, game.type or ""


def _get_earliest_game_daily_rollup_date() -> str | None:
    db = GameLinesTable._db
    row = db.fetchone(f"SELECT date FROM {GameDailyRollupTable._table} ORDER BY date ASC LIMIT 1")
    return str(row[0]) if row and row[0] is not None else None


def _get_earliest_third_party_date() -> str | None:
    db = ThirdPartyStatsTable._db
    row = db.fetchone(f"SELECT date FROM {ThirdPartyStatsTable._table} ORDER BY date ASC LIMIT 1")
    return str(row[0]) if row and row[0] is not None else None


def _get_earliest_game_line_date() -> str | None:
    db = GameLinesTable._db
    row = db.fetchone(f"SELECT MIN(timestamp) FROM {GameLinesTable._table}")
    if not row or row[0] is None:
        return None
    return datetime.date.fromtimestamp(float(row[0])).isoformat()


def _resolve_date_range(options: dict) -> tuple[datetime.date, datetime.date]:
    today = datetime.date.today()
    scope = str(options.get("scope") or "all_time").strip().lower()

    if scope == "last_30_days":
        return today - datetime.timedelta(days=29), today

    if scope == "custom":
        start_date_raw = str(options.get("start_date") or "").strip()
        end_date_raw = str(options.get("end_date") or "").strip()
        if not start_date_raw or not end_date_raw:
            raise ValueError("Custom exports require both start_date and end_date.")

        try:
            start_date = datetime.date.fromisoformat(start_date_raw)
            end_date = datetime.date.fromisoformat(end_date_raw)
        except ValueError as exc:
            raise ValueError("Custom export dates must use YYYY-MM-DD.") from exc

        if end_date < start_date:
            raise ValueError("end_date must be on or after start_date.")
        return start_date, end_date

    if scope == "since_last_export":
        last_export_at = StatsExportStateTable.get_last_successful_export_at(str(options.get("format_key") or ""))
        if last_export_at is None:
            candidates = [
                _get_earliest_game_daily_rollup_date(),
                _get_earliest_third_party_date(),
                _get_earliest_game_line_date(),
            ]
            available = [datetime.date.fromisoformat(value) for value in candidates if value]
            start_date = min(available) if available else today
            return start_date, today
        start_date = datetime.date.fromtimestamp(last_export_at)
        return start_date, today

    if scope != "all_time":
        raise ValueError(f"Unsupported export scope: {scope}")

    candidates = [
        _get_earliest_game_daily_rollup_date(),
        _get_earliest_third_party_date(),
        _get_earliest_game_line_date(),
    ]
    available = [datetime.date.fromisoformat(value) for value in candidates if value]
    start_date = min(available) if available else today
    return start_date, today


def _group_line_records(
    records: list, *, games_by_id: dict[str, GamesTable], games_by_scene: dict[str, GamesTable]
) -> list[NormalizedActivityRecord]:
    grouped: dict[tuple[str, str], dict] = {}

    for record in records:
        date_str = datetime.date.fromtimestamp(float(record.timestamp)).isoformat()
        grouping_id = getattr(record, "game_id", "") or getattr(record, "game_name", "") or "unknown"
        key = (date_str, grouping_id)
        bucket = grouped.setdefault(
            key,
            {
                "date": date_str,
                "game_id": getattr(record, "game_id", "") or "",
                "game_name": getattr(record, "game_name", "") or "",
                "timestamps": [],
                "line_texts": [],
                "characters": 0,
            },
        )
        bucket["timestamps"].append(float(record.timestamp))
        line_text = record.line_text or ""
        bucket["line_texts"].append(line_text)
        bucket["characters"] += len(line_text)

    exported_records: list[NormalizedActivityRecord] = []
    language = get_config().general.get_target_language_name()

    for bucket in grouped.values():
        title, game_type = _resolve_game_metadata(
            bucket["game_id"],
            bucket["game_name"],
            games_by_id,
            games_by_scene,
        )
        media_type, activity_type = _map_native_activity(game_type)
        duration_seconds = calculate_actual_reading_time(bucket["timestamps"], line_texts=bucket["line_texts"])
        exported_records.append(
            NormalizedActivityRecord(
                date=bucket["date"],
                log_name=title,
                media_type=media_type,
                duration_minutes=_seconds_to_minutes(duration_seconds),
                language=language,
                characters=int(bucket["characters"]),
                activity_type=activity_type,
            )
        )

    return exported_records


def _load_historical_native_records(
    start_date: datetime.date,
    end_date: datetime.date,
    *,
    progress_cb: Callable[[int, str], None] | None,
    games_by_id: dict[str, GamesTable],
    games_by_scene: dict[str, GamesTable],
) -> list[NormalizedActivityRecord]:
    if end_date < start_date:
        return []

    rollup_rows = GameDailyRollupTable.get_date_range(start_date.isoformat(), end_date.isoformat())
    if rollup_rows:
        language = get_config().general.get_target_language_name()
        total = len(rollup_rows)
        records: list[NormalizedActivityRecord] = []
        for index, row in enumerate(rollup_rows, start=1):
            title, game_type = _resolve_game_metadata(row.game_id, "", games_by_id, games_by_scene)
            media_type, activity_type = _map_native_activity(game_type)
            records.append(
                NormalizedActivityRecord(
                    date=row.date,
                    log_name=title,
                    media_type=media_type,
                    duration_minutes=_seconds_to_minutes(float(row.total_reading_time_seconds or 0.0)),
                    language=language,
                    characters=int(row.total_characters or 0),
                    activity_type=activity_type,
                )
            )
            if progress_cb and (index == total or index % 100 == 0):
                progress_cb(
                    _scale_progress(10, 55, index, total),
                    f"Loaded {index:,}/{total:,} historical activity rows.",
                )
        return records

    start_ts = datetime.datetime.combine(start_date, datetime.time.min).timestamp()
    end_ts = datetime.datetime.combine(end_date, datetime.time.max).timestamp()
    raw_lines = query_stats_lines(
        where_clause="timestamp >= ? AND timestamp <= ?",
        params=(start_ts, end_ts),
        include_media_fields=False,
        parse_note_ids=False,
    )
    if progress_cb:
        progress_cb(45, f"Historical rollups unavailable. Falling back to {len(raw_lines):,} raw lines.")
    return _group_line_records(raw_lines, games_by_id=games_by_id, games_by_scene=games_by_scene)


def _load_today_native_records(
    today: datetime.date,
    *,
    progress_cb: Callable[[int, str], None] | None,
    games_by_id: dict[str, GamesTable],
    games_by_scene: dict[str, GamesTable],
) -> list[NormalizedActivityRecord]:
    today_lines = fetch_today_lines(today)
    if progress_cb:
        progress_cb(65, f"Loaded {len(today_lines):,} live lines for today.")
    return _group_line_records(today_lines, games_by_id=games_by_id, games_by_scene=games_by_scene)


def _load_third_party_records(
    start_date: datetime.date,
    end_date: datetime.date,
    *,
    progress_cb: Callable[[int, str], None] | None,
) -> list[NormalizedActivityRecord]:
    rows = ThirdPartyStatsTable.get_date_range(start_date.isoformat(), end_date.isoformat())
    language = get_config().general.get_target_language_name()
    total = len(rows)
    records: list[NormalizedActivityRecord] = []

    for index, row in enumerate(rows, start=1):
        media_type, activity_type = _map_external_activity(row.source)
        records.append(
            NormalizedActivityRecord(
                date=row.date,
                log_name=row.label or row.source or "External Activity",
                media_type=media_type,
                duration_minutes=_seconds_to_minutes(float(row.time_read_seconds or 0.0)),
                language=language,
                characters=int(row.characters_read or 0),
                activity_type=activity_type,
            )
        )
        if progress_cb and (index == total or index % 100 == 0):
            progress_cb(
                _scale_progress(80, 92, index, total),
                f"Loaded {index:,}/{total:,} external activity rows.",
            )

    return records


def _load_incremental_native_records(
    last_export_at: float,
    *,
    progress_cb: Callable[[int, str], None] | None,
    games_by_id: dict[str, GamesTable],
    games_by_scene: dict[str, GamesTable],
) -> list[NormalizedActivityRecord]:
    raw_lines = query_stats_lines(
        where_clause="last_modified > ?",
        params=(last_export_at,),
        include_media_fields=False,
        parse_note_ids=False,
    )
    if progress_cb:
        progress_cb(55, f"Loaded {len(raw_lines):,} native lines changed since the last export.")
    return _group_line_records(raw_lines, games_by_id=games_by_id, games_by_scene=games_by_scene)


def _load_incremental_third_party_records(
    last_export_at: float,
    *,
    progress_cb: Callable[[int, str], None] | None,
) -> list[NormalizedActivityRecord]:
    rows = ThirdPartyStatsTable._db.fetchall(
        f"""
        SELECT *
        FROM {ThirdPartyStatsTable._table}
        WHERE created_at > ?
        ORDER BY created_at ASC
        """,
        (last_export_at,),
    )
    entries = [ThirdPartyStatsTable.from_row(row) for row in rows]
    language = get_config().general.get_target_language_name()
    total = len(entries)
    records: list[NormalizedActivityRecord] = []

    for index, row in enumerate(entries, start=1):
        media_type, activity_type = _map_external_activity(row.source)
        records.append(
            NormalizedActivityRecord(
                date=row.date,
                log_name=row.label or row.source or "External Activity",
                media_type=media_type,
                duration_minutes=_seconds_to_minutes(float(row.time_read_seconds or 0.0)),
                language=language,
                characters=int(row.characters_read or 0),
                activity_type=activity_type,
            )
        )
        if progress_cb and (index == total or index % 100 == 0):
            progress_cb(
                _scale_progress(75, 90, index, total),
                f"Loaded {index:,}/{total:,} external entries added since the last export.",
            )

    return records


def _load_library_records(
    *,
    progress_cb: Callable[[int, str], None] | None,
) -> list[NormalizedLibraryRecord]:
    games = GamesTable.all()
    last_activity_by_game_id = _build_library_activity_bounds()
    language = get_config().general.get_target_language_name()
    total = len(games)
    records: list[NormalizedLibraryRecord] = []

    for index, game in enumerate(games, start=1):
        title = _normalize_library_title(game)
        media_type, content_type = _map_library_content(game.type or "")
        records.append(
            NormalizedLibraryRecord(
                title=title,
                media_type=media_type,
                status=_map_library_status(game, last_activity_by_game_id),
                language=language,
                description=game.description or "",
                content_type=content_type,
                extra_data_json=_build_library_extra_data(game, title),
                cover_image_base64=_normalize_cover_image_base64(game.image or ""),
            )
        )
        if progress_cb and (index == total or index % 50 == 0):
            progress_cb(
                _scale_progress(15, 92, index, total),
                f"Prepared {index:,}/{total:,} library rows.",
            )

    return sorted(records, key=lambda record: record.title.lower())


def _build_library_export_file(
    exporter,
    *,
    progress_cb: Callable[[int, str], None] | None = None,
) -> tuple[str, str, int]:
    if progress_cb:
        progress_cb(5, "Preparing library export.")

    records = _load_library_records(progress_cb=progress_cb)
    temp_fd, temp_path = tempfile.mkstemp(prefix="gsm_stats_export_", suffix=".csv")
    os.close(temp_fd)
    filename = exporter.build_filename()

    if progress_cb:
        progress_cb(94, f"Writing {len(records):,} library rows to CSV.")

    row_count = exporter.export_to_file(
        records,
        temp_path,
        progress_cb=(
            lambda current, total: (
                progress_cb(
                    _scale_progress(94, 99, current, total),
                    f"Wrote {current:,}/{total:,} library rows.",
                )
                if progress_cb
                else None
            )
        ),
    )

    if progress_cb:
        progress_cb(100, f"Library export complete. {row_count:,} rows ready for download.")

    return temp_path, filename, row_count


def build_export_file(
    format_key: str,
    options: dict,
    *,
    progress_cb: Callable[[int, str], None] | None = None,
) -> tuple[str, str, int]:
    exporter = get_stats_exporter(format_key)
    if exporter is None:
        raise ValueError(f"Unsupported export format: {format_key}")

    if not exporter.supports_date_range:
        return _build_library_export_file(exporter, progress_cb=progress_cb)

    scope = str(options.get("scope") or "all_time").strip().lower()
    stateful_options = dict(options)
    stateful_options["format_key"] = format_key
    start_date, end_date = _resolve_date_range(stateful_options)
    include_external_stats = bool(options.get("include_external_stats", True))
    last_export_at = (
        StatsExportStateTable.get_last_successful_export_at(format_key) if scope == "since_last_export" else None
    )

    if progress_cb:
        if scope == "since_last_export" and last_export_at is None:
            progress_cb(5, "No previous successful export found. Exporting all time.")
        elif scope == "since_last_export":
            progress_cb(5, "Preparing incremental export since the last successful export.")
        else:
            progress_cb(5, f"Preparing {exporter.label} export for {start_date.isoformat()} to {end_date.isoformat()}.")

    games_by_id, games_by_scene = _build_game_maps()
    today = datetime.date.today()
    yesterday = today - datetime.timedelta(days=1)

    native_records: list[NormalizedActivityRecord] = []
    third_party_records: list[NormalizedActivityRecord] = []

    if scope == "since_last_export" and last_export_at is not None:
        native_records.extend(
            _load_incremental_native_records(
                last_export_at,
                progress_cb=progress_cb,
                games_by_id=games_by_id,
                games_by_scene=games_by_scene,
            )
        )
        if include_external_stats:
            third_party_records = _load_incremental_third_party_records(last_export_at, progress_cb=progress_cb)
    else:
        historical_end = min(end_date, yesterday)
        if historical_end >= start_date:
            native_records.extend(
                _load_historical_native_records(
                    start_date,
                    historical_end,
                    progress_cb=progress_cb,
                    games_by_id=games_by_id,
                    games_by_scene=games_by_scene,
                )
            )

        if start_date <= today <= end_date:
            native_records.extend(
                _load_today_native_records(
                    today,
                    progress_cb=progress_cb,
                    games_by_id=games_by_id,
                    games_by_scene=games_by_scene,
                )
            )

        if include_external_stats:
            third_party_records = _load_third_party_records(start_date, end_date, progress_cb=progress_cb)

    records = sorted(
        [*native_records, *third_party_records],
        key=lambda record: (record.date, record.log_name.lower(), record.activity_type.lower()),
    )

    temp_fd, temp_path = tempfile.mkstemp(prefix="gsm_stats_export_", suffix=".csv")
    os.close(temp_fd)
    filename = exporter.build_filename()

    if progress_cb:
        progress_cb(94, f"Writing {len(records):,} rows to CSV.")

    row_count = exporter.export_to_file(
        records,
        temp_path,
        progress_cb=(
            lambda current, total: (
                progress_cb(
                    _scale_progress(94, 99, current, total),
                    f"Wrote {current:,}/{total:,} rows.",
                )
                if progress_cb
                else None
            )
        ),
    )

    if progress_cb:
        progress_cb(100, f"Export complete. {row_count:,} rows ready for download.")

    return temp_path, filename, row_count


@dataclass(slots=True)
class StatsExportJob:
    job_id: str
    format_key: str
    options: dict
    status: str = "queued"
    progress: int = 0
    message: str = "Queued"
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)
    completed_at: float | None = None
    error: str | None = None
    file_path: str | None = None
    filename: str | None = None
    row_count: int = 0

    def to_payload(self) -> dict:
        payload = {
            "job_id": self.job_id,
            "format": self.format_key,
            "status": self.status,
            "progress": self.progress,
            "message": self.message,
            "row_count": self.row_count,
        }
        if self.error:
            payload["error"] = self.error
        if self.completed_at is not None:
            payload["completed_at"] = self.completed_at
        if self.filename:
            payload["filename"] = self.filename
        if self.status == "completed":
            payload["download_url"] = f"/api/stats-export/jobs/{self.job_id}/download"
        return payload


class StatsExportJobManager:
    _retention_seconds = 3600

    def __init__(self) -> None:
        self._jobs: dict[str, StatsExportJob] = {}
        self._lock = threading.RLock()

    def _cleanup_old_jobs(self) -> None:
        cutoff = time.time() - self._retention_seconds
        stale_ids: list[str] = []
        with self._lock:
            for job_id, job in self._jobs.items():
                if job.updated_at < cutoff:
                    stale_ids.append(job_id)

            for job_id in stale_ids:
                job = self._jobs.pop(job_id, None)
                if job and job.file_path and os.path.exists(job.file_path):
                    try:
                        os.remove(job.file_path)
                    except OSError:
                        logger.warning(f"Failed to remove stale export file: {job.file_path}")

    def _set_job_state(
        self,
        job_id: str,
        *,
        status: str | None = None,
        progress: int | None = None,
        message: str | None = None,
        error: str | None = None,
        file_path: str | None = None,
        filename: str | None = None,
        row_count: int | None = None,
    ) -> None:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return

            if status is not None:
                job.status = status
            if progress is not None:
                job.progress = _clamp_progress(progress)
            if message is not None:
                job.message = message
            if error is not None:
                job.error = error
            if file_path is not None:
                job.file_path = file_path
            if filename is not None:
                job.filename = filename
            if row_count is not None:
                job.row_count = row_count
            if status in {"completed", "failed"}:
                job.completed_at = time.time()
            job.updated_at = time.time()

    def _run_job(self, job_id: str) -> None:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return
            format_key = job.format_key
            options = dict(job.options)

        self._set_job_state(job_id, status="running", progress=1, message="Starting export.")
        scope = str(options.get("scope") or "all_time").strip().lower()
        first_incremental_export = (
            scope == "since_last_export" and StatsExportStateTable.get_last_successful_export_at(format_key) is None
        )

        try:
            file_path, filename, row_count = build_export_file(
                format_key,
                options,
                progress_cb=lambda progress, message: self._set_job_state(
                    job_id,
                    status="running",
                    progress=progress,
                    message=message,
                ),
            )
            self._set_job_state(
                job_id,
                status="completed",
                progress=100,
                message=(
                    "Export complete. No previous successful export was found, so all-time data was exported."
                    if first_incremental_export
                    else "Export complete."
                ),
                file_path=file_path,
                filename=filename,
                row_count=row_count,
            )
            StatsExportStateTable.mark_successful_export(format_key)
        except Exception as exc:
            logger.exception(f"Stats export job {job_id} failed: {exc}")
            self._set_job_state(
                job_id,
                status="failed",
                progress=100,
                message="Export failed.",
                error=str(exc),
            )

    def start_job(self, format_key: str, options: dict, *, run_inline: bool = False) -> dict:
        if get_stats_exporter(format_key) is None:
            raise ValueError(f"Unsupported export format: {format_key}")

        job_id = str(uuid.uuid4())
        job = StatsExportJob(job_id=job_id, format_key=format_key, options=dict(options))

        self._cleanup_old_jobs()
        with self._lock:
            self._jobs[job_id] = job

        if run_inline:
            self._run_job(job_id)
        else:
            thread = threading.Thread(target=self._run_job, args=(job_id,), daemon=True)
            thread.start()

        return self.get_job(job_id)

    def get_job(self, job_id: str) -> dict | None:
        self._cleanup_old_jobs()
        with self._lock:
            job = self._jobs.get(job_id)
            return job.to_payload() if job else None

    def get_job_file(self, job_id: str) -> tuple[str, str] | None:
        self._cleanup_old_jobs()
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None or job.status != "completed" or not job.file_path or not job.filename:
                return None
            return job.file_path, job.filename


stats_export_job_manager = StatsExportJobManager()
