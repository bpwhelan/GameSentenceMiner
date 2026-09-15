"""Reconcile GSM's complete history with Kechimochi, including historical edits.

Remote ownership markers are the recovery journal. Every run reads both sides;
an interrupted POST is discovered on the next run even if its response was lost.
There is deliberately no launch-time cursor or character threshold.
"""

from __future__ import annotations

import base64
import datetime as dt
import hashlib
import json
import math
import re
import time
import uuid
from collections import defaultdict
from dataclasses import dataclass, field

from GameSentenceMiner.util.config.configuration import get_config, get_stats_config, logger
from GameSentenceMiner.util.database.db import GameLinesTable, clean_text_for_stats
from GameSentenceMiner.util.database.game_archive import archive_dates, archived_stats_lines
from GameSentenceMiner.util.database.game_daily_rollup_table import GameDailyRollupTable
from GameSentenceMiner.util.database.games_table import GamesTable
from GameSentenceMiner.util.database.kechimochi_sync_state import KechimochiSyncState
from GameSentenceMiner.util.database.third_party_stats_table import ThirdPartyStatsTable
from GameSentenceMiner.util.kechimochi_client import (
    KechimochiClient,
    KechimochiConnectionError,
    KechimochiHTTPError,
    KechimochiSyncError,
    normalize_kechimochi_url,
)
from GameSentenceMiner.util.kechimochi_metadata import build_kechimochi_metadata, migrate_legacy_metadata
from GameSentenceMiner.web.export.service import (
    _build_library_extra_data,
    _map_external_activity,
    _map_library_content,
    _map_native_activity,
    _normalize_library_title,
    _seconds_to_minutes,
)
from GameSentenceMiner.web.stats import calculate_actual_reading_time

MEDIA_MARKER = "gsm_sync"
LOG_MARKER = re.compile(r"^\[GSM sync:([a-f0-9]{32}):([a-f0-9]{64})\]$", re.MULTILINE)


def _digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def run_state_key(url: str) -> str:
    return "run:" + _digest(normalize_kechimochi_url(url))


def _extra(value) -> dict:
    try:
        parsed = json.loads(value or "{}") if isinstance(value, str) else value
        return parsed if isinstance(parsed, dict) else {}
    except (ValueError, TypeError):
        return {}


def _metrics(characters, seconds):
    if not math.isfinite(float(seconds)) or float(seconds) < 0 or int(characters) < 0:
        raise KechimochiSyncError("GSM contains negative or invalid activity statistics")
    return int(characters), _seconds_to_minutes(float(seconds))


@dataclass
class KechimochiSnapshot:
    media: dict[str, dict] = field(default_factory=dict)
    logs: dict[str, dict] = field(default_factory=dict)
    observed_native: set[str] = field(default_factory=set)
    cover_games: dict[str, str] = field(default_factory=dict)
    legacy_activity_types: dict[str, str] = field(default_factory=dict)

    def summary(self):
        dates = [row["date"] for row in self.logs.values()]
        return {
            "media_count": len(self.media),
            "activity_count": len(self.logs),
            "characters": sum(row["characters"] for row in self.logs.values()),
            "duration_minutes": sum(row["duration_minutes"] for row in self.logs.values()),
            "first_date": min(dates, default=None),
            "last_date": max(dates, default=None),
        }


def build_kechimochi_snapshot(*, config=None, state=None, progress_cb=None) -> KechimochiSnapshot:
    """Read a consistent snapshot, processing one calendar day at a time.

    Live and archived events take precedence over cached rollups. Rollups remain a
    fallback for legacy aggregate-only history. Remember event-backed keys so deleting
    the last line of a previously synced day cannot resurrect an obsolete rollup.
    """
    config = config or get_stats_config()
    state = state or KechimochiSyncState()
    previous_events = set(state.get("observed_native", []))
    snapshot = KechimochiSnapshot()
    language = get_config().general.get_target_language_name()
    conn = GameLinesTable._db._get_read_connection()
    conn.execute("SAVEPOINT kechimochi_snapshot")
    try:
        games = GamesTable.all_without_images()
        by_id = {game.id: game for game in games}
        by_scene = {game.obs_scene_name: game for game in games if game.obs_scene_name}
        fallback_titles = {}

        def media_for(game_id, scene=""):
            game = by_id.get(game_id) or (by_scene.get(scene) if not game_id else None)
            key = f"game:{game.id}" if game else (f"game:{game_id}" if game_id else f"scene:{scene}")
            if key not in snapshot.media:
                title = (
                    _normalize_library_title(game)
                    if game
                    else (scene or fallback_titles.get(game_id) or (f"Game {game_id}" if game_id else "Unknown Game"))
                )
                activity, legacy_activity = _map_native_activity(game.type if game else "")
                _, content = _map_library_content(game.type if game else "Game")
                status = getattr(game, "effective_status", "in_progress") if game else "in_progress"
                remote_status, tracking = {
                    "completed": ("Complete", "Complete"),
                    "planned": ("Planned", "Not Started"),
                    "on_hold": ("Paused", "Paused"),
                    "dropped": ("Dropped", "Dropped"),
                }.get(status, ("Active", "Ongoing"))
                snapshot.media[key] = {
                    "title": title,
                    "default_activity_type": activity,
                    "status": remote_status,
                    "tracking_status": tracking,
                    "language": language,
                    "description": game.description if game else "",
                    "content_type": content,
                    "extra_data": json.dumps(
                        build_kechimochi_metadata(game, _extra(_build_library_extra_data(game, title))),
                        ensure_ascii=False,
                    )
                    if game
                    else "{}",
                }
                if game and game.image:
                    snapshot.cover_games[key] = game.id
                snapshot.legacy_activity_types[key] = legacy_activity
            return key

        for game in games:
            media_for(game.id, game.obs_scene_name)

        rollups = defaultdict(dict)
        for row in GameDailyRollupTable.get_date_range("0001-01-01", "9999-12-31"):
            rollups[row.date][row.game_id] = row
        raw_dates = [
            row[0] for row in conn.execute("SELECT DISTINCT DATE(timestamp, 'unixepoch', 'localtime') FROM game_lines")
        ]
        if any(date is None for date in raw_dates):
            raise KechimochiSyncError("GSM contains a line with an invalid timestamp")
        event_dates = set(raw_dates) | set(archive_dates())
        prior_event_dates = {key.rsplit(":", 1)[-1] for key in previous_events}
        # Older GSM databases may retain only the original JSON daily rollup.
        # Fill gaps per game; never replace newer rows or invent a residual from
        # stale totals when a day still has live events.
        if GameLinesTable._db.table_exists("daily_stats_rollup"):
            for date, raw_details, characters, seconds in conn.execute(
                "SELECT date, game_activity_data, total_characters, total_reading_time_seconds FROM daily_stats_rollup"
            ):
                details = json.loads(raw_details or "{}")
                if not isinstance(details, dict) or any(not isinstance(value, dict) for value in details.values()):
                    raise KechimochiSyncError(f"Invalid GSM historical game details for {date}")
                for game_id, values in details.items():
                    fallback_titles.setdefault(game_id, values.get("title") or f"Game {game_id}")
                    rollups[date].setdefault(
                        game_id,
                        GameDailyRollupTable(
                            date=date,
                            game_id=game_id,
                            total_characters=values.get("chars", 0),
                            total_reading_time_seconds=values.get("time", 0),
                        ),
                    )
                if (
                    not details
                    and not rollups[date]
                    and date not in event_dates | prior_event_dates
                    and (characters or seconds)
                ):
                    key = "legacy:unattributed"
                    fallback_titles[key] = "GSM historical activity"
                    rollups[date][key] = GameDailyRollupTable(
                        date=date, game_id=key, total_characters=characters, total_reading_time_seconds=seconds
                    )
        dates = sorted(event_dates | set(rollups))
        for index, date in enumerate(dates):
            parsed_date = dt.date.fromisoformat(date)
            start = dt.datetime.combine(parsed_date, dt.time.min).timestamp()
            end = dt.datetime.combine(parsed_date + dt.timedelta(days=1), dt.time.min).timestamp()
            buckets = defaultdict(lambda: {"timestamps": [], "texts": [], "characters": 0})
            for game_id, scene, raw_text, timestamp in conn.execute(
                "SELECT game_id, game_name, line_text, timestamp FROM game_lines "
                "WHERE timestamp >= ? AND timestamp < ? ORDER BY timestamp, id",
                (start, end),
            ):
                key = media_for(str(game_id or "").strip(), str(scene or ""))
                text = clean_text_for_stats(
                    str(raw_text or ""),
                    regex_out_repetitions=config.regex_out_repetitions,
                    extra_punctuation_regex=config.extra_punctuation_regex,
                )
                bucket = buckets[key]
                bucket["timestamps"].append(float(timestamp))
                bucket["texts"].append(text)
                bucket["characters"] += len(text)
            for line in archived_stats_lines(start, end - 0.000001):
                key = media_for(line.game_id, line.game_name)
                bucket = buckets[key]
                bucket["timestamps"].append(line.timestamp)
                bucket["texts"].append(line.line_text)
                bucket["characters"] += len(line.line_text)
            for media_key, bucket in buckets.items():
                log_key = f"native:{media_key}:{date}"
                snapshot.observed_native.add(log_key)
                characters, minutes = _metrics(
                    bucket["characters"], calculate_actual_reading_time(bucket["timestamps"], bucket["texts"])
                )
                snapshot.logs[log_key] = {
                    "media_key": media_key,
                    "date": date,
                    "characters": characters,
                    "duration_minutes": minutes,
                    "activity_type": snapshot.media[media_key]["default_activity_type"],
                }
            for game_id, row in rollups[date].items():
                media_key = media_for(game_id)
                log_key = f"native:{media_key}:{date}"
                if media_key in buckets or log_key in previous_events:
                    continue
                characters, minutes = _metrics(row.total_characters, row.total_reading_time_seconds)
                snapshot.logs[log_key] = {
                    "media_key": media_key,
                    "date": date,
                    "characters": characters,
                    "duration_minutes": minutes,
                    "activity_type": snapshot.media[media_key]["default_activity_type"],
                }
            if progress_cb:
                progress_cb(index + 1, len(dates), "Reading all GSM history")

        if config.kechimochi_include_external_stats:
            for row in ThirdPartyStatsTable.get_date_range("0001-01-01", "9999-12-31"):
                date = dt.date.fromisoformat(row.date).isoformat()
                title = row.label or row.source or "External Activity"
                media_key = "external:" + _digest(json.dumps([row.source, title], ensure_ascii=False))
                snapshot.media.setdefault(
                    media_key,
                    {
                        "title": title,
                        "default_activity_type": "Reading",
                        "status": "Active",
                        "tracking_status": "Ongoing",
                        "language": language,
                        "description": "",
                        "content_type": "Manga" if row.source == "mokuro" else "Unknown",
                        "extra_data": json.dumps({"gsm_external_source": row.source}),
                    },
                )
                snapshot.legacy_activity_types[media_key] = _map_external_activity(row.source)[1]
                characters, minutes = _metrics(row.characters_read, row.time_read_seconds)
                snapshot.logs[f"external:{row.id}"] = {
                    "media_key": media_key,
                    "date": date,
                    "characters": characters,
                    "duration_minutes": minutes,
                    "activity_type": "Reading",
                }
    finally:
        conn.execute("RELEASE SAVEPOINT kechimochi_snapshot")
    return snapshot


def _owned_media(row, source_id):
    marker = _extra(_extra(row.get("extra_data")).get(MEDIA_MARKER))
    return marker.get("key") if marker.get("source") == source_id else None


def _merge_metadata(existing, desired, previous_state):
    """Keep Kechimochi enrichments until the corresponding GSM value changes."""
    extra = migrate_legacy_metadata(_extra(existing.get("extra_data")))
    source = _extra(desired["extra_data"])
    previous = _extra(previous_state.get("fields"))
    fingerprints = {}
    for name, value in source.items():
        fingerprint = _digest(str(value))
        fingerprints[name.lower()] = fingerprint
        remote_key = next((key for key in extra if key.lower() == name.lower()), name)
        old_hash = previous.get(name.lower())
        if remote_key not in extra or not extra[remote_key] or (old_hash is not None and old_hash != fingerprint):
            extra[remote_key] = value
    # Only remove a cleared GSM field when it still contains our previous value.
    for name, fingerprint in previous.items():
        if name not in fingerprints:
            remote_key = next((key for key in extra if key.lower() == name), None)
            if remote_key and _digest(str(extra[remote_key])) == fingerprint:
                del extra[remote_key]
    description = existing.get("description") or ""
    source_description = desired.get("description") or ""
    fingerprint = _digest(source_description)
    previous_hash = previous_state.get("description")
    if (not description or (previous_hash is not None and previous_hash != fingerprint)) and (
        source_description or _digest(description) == previous_hash
    ):
        description = source_description
    return extra, description, {"fields": fingerprints, "description": fingerprint}


def _serialize_metadata(extra, marker):
    # Kechimochi normalizes editable extra_data values to strings when saving a
    # media entry. Store JSON as a string so editing metadata preserves ownership.
    return json.dumps(
        {**extra, MEDIA_MARKER: json.dumps(marker, sort_keys=True, ensure_ascii=False)},
        ensure_ascii=False,
        sort_keys=True,
    )


def _owned_log(row, source_id):
    matches = [match[1] for match in LOG_MARKER.findall(row.get("notes") or "") if match[0] == source_id]
    if len(matches) > 1:
        raise KechimochiSyncError("A Kechimochi log has multiple GSM ownership markers")
    return matches[0] if matches else None


def _index_owned(rows, key_for):
    result = {}
    for row in rows:
        key = key_for(row)
        if key:
            if key in result:
                raise KechimochiSyncError(
                    "Kechimochi contains duplicate GSM ownership markers; resolve the duplicates first"
                )
            result[key] = row
    return result


def _sync_snapshot(snapshot, remote, state, config, report):
    media = remote.get_media()
    logs = remote.get_logs()
    owned_media = _index_owned(media, lambda row: _owned_media(row, state.source_id))
    owned_logs = _index_owned(logs, lambda row: _owned_log(row, state.source_id))
    result = {
        "success": True,
        **snapshot.summary(),
        **dict.fromkeys(
            (
                "media_created",
                "media_updated",
                "logs_created",
                "logs_updated",
                "logs_deleted",
                "logs_adopted",
                "covers_uploaded",
            ),
            0,
        ),
        "warnings": [],
    }
    media_ids = {}
    covers_available = True
    total = len(snapshot.media) + len(snapshot.logs) + len(owned_logs)
    processed = 0
    metadata_prefix = "metadata:" + _digest(normalize_kechimochi_url(config.kechimochi_url)) + ":"
    for key, desired in snapshot.media.items():
        key_hash = _digest(key)
        existing = owned_media.get(key_hash)
        if existing is None:
            candidates = [
                row
                for row in media
                if row.get("title") == desired["title"]
                and not row.get("variant")
                and row.get("language") == desired["language"]
                and row.get("content_type") in {desired["content_type"], "Unknown", ""}
                and MEDIA_MARKER not in _extra(row.get("extra_data"))
            ]
            if len(candidates) == 1:
                existing = candidates[0]
        variant = (existing or {}).get("variant", "")
        if any(
            row["title"] == desired["title"]
            and row.get("variant", "") == variant
            and row["id"] != (existing or {}).get("id")
            for row in media
        ):
            variant = "GSM " + key_hash[:10]
        marker = {
            **_extra(_extra((existing or {}).get("extra_data")).get(MEDIA_MARKER)),
            "source": state.source_id,
            "key": key_hash,
        }
        metadata_key = metadata_prefix + key_hash
        previous_metadata = state.get(metadata_key, {})
        extra, description, metadata_state = _merge_metadata(existing or {}, desired, previous_metadata)
        payload = {
            **desired,
            "description": description,
            "variant": variant,
            "uid": existing.get("uid") if existing else str(uuid.uuid5(uuid.UUID(state.source_id), key)),
            "cover_image": (existing or {}).get("cover_image", ""),
            "extra_data": _serialize_metadata(extra, marker),
        }
        if existing is None:
            media_id = remote.save_media(payload)
            existing = {**payload, "id": media_id}
            media.append(existing)
            result["media_created"] += 1
        else:
            media_id = existing["id"]
            if any(existing.get(name) != value for name, value in payload.items()):
                remote.save_media(payload, media_id)
                existing.update(payload)
                result["media_updated"] += 1
        media_ids[key] = media_id
        # Keep comparison hashes in GSM, away from Kechimochi's visible metadata
        # cards. Persist only after the media write succeeds; interrupted writes
        # are safely reconciled using the unchanged ownership marker.
        if previous_metadata != metadata_state:
            state.put(metadata_key, metadata_state)
        if config.kechimochi_sync_covers and covers_available and key in snapshot.cover_games:
            game = GamesTable.get(snapshot.cover_games[key])
            if game and game.image:
                try:
                    encoded = game.image.split(",", 1)[-1] if game.image.startswith("data:") else game.image
                    image_bytes = base64.b64decode(encoded, validate=True)
                    cover_hash = hashlib.sha256(image_bytes).hexdigest()
                    if marker.get("cover_sha256") != cover_hash or not payload["cover_image"]:
                        uploaded = remote.upload_cover(media_id, image_bytes)
                        if not isinstance(uploaded, dict) or not isinstance(uploaded.get("path"), str):
                            raise KechimochiSyncError("Kechimochi returned an invalid cover path")
                        payload["cover_image"] = uploaded["path"]
                        marker["cover_sha256"] = cover_hash
                        payload["extra_data"] = _serialize_metadata(extra, marker)
                        remote.save_media(payload, media_id)
                        existing.update(payload)
                        result["covers_uploaded"] += 1
                except KechimochiHTTPError as exc:
                    if exc.status_code not in {403, 404}:
                        raise
                    covers_available = False
                    result["warnings"].append(
                        "Stats synced. Enable Full HTTP API scope in Kechimochi to sync covers too."
                    )
                except ValueError:
                    result["warnings"].append(f"Could not decode the GSM cover for {desired['title']}.")
        processed += 1
        report(processed, total, "Syncing media library")

    wanted_keys = set()
    claimed_logs = set()
    for key, desired in snapshot.logs.items():
        key_hash = _digest(key)
        wanted_keys.add(key_hash)
        existing = owned_logs.get(key_hash)
        fields = {name: value for name, value in desired.items() if name != "media_key"}
        fields["media_id"] = media_ids[desired["media_key"]]
        if existing is None and config.kechimochi_adopt_matching_logs:
            candidates = [
                row
                for row in logs
                if row["id"] not in claimed_logs
                and not LOG_MARKER.search(row.get("notes") or "")
                and not (row.get("notes") or "").strip()
                and all(row.get(name) == value for name, value in fields.items() if name != "activity_type")
                and row.get("activity_type")
                in {
                    fields["activity_type"],
                    snapshot.media[desired["media_key"]]["content_type"],
                    snapshot.legacy_activity_types.get(desired["media_key"], ""),
                    "",
                }
            ]
            if len(candidates) > 1:
                raise KechimochiSyncError(
                    "Multiple existing Kechimochi logs match one GSM activity. Resolve them before adopting CSV imports."
                )
            if candidates:
                existing = candidates[0]
                claimed_logs.add(existing["id"])
                result["logs_adopted"] += 1
        notes = (existing or {}).get("notes") or ""
        marker = f"[GSM sync:{state.source_id}:{key_hash}]"
        if not existing or _owned_log(existing, state.source_id) is None:
            notes = (notes.rstrip() + "\n" + marker).lstrip("\n")
        payload = {**fields, "notes": notes}
        if existing is None:
            remote.save_log(payload)
            result["logs_created"] += 1
        elif any(existing.get(name) != value for name, value in payload.items()):
            remote.save_log(payload, existing["id"])
            result["logs_updated"] += 1
        processed += 1
        report(processed, total, "Syncing daily activity")

    # Reconcile removals only after the complete source snapshot and all upserts
    # succeeded. Media stays because Kechimochi may have unrelated logs for it.
    for key_hash, row in owned_logs.items():
        if key_hash not in wanted_keys:
            remote.delete_log(row["id"])
            result["logs_deleted"] += 1
        processed += 1
        report(processed, total, "Reconciling removed activity")
    return result


def run_kechimochi_sync(*, config=None, client=None, progress_cb=None):
    config = config or get_stats_config()
    state = KechimochiSyncState()
    state_key = run_state_key(config.kechimochi_url)
    with state.sync_lock():
        previous = state.get(state_key, {})
        status = {
            "run_id": uuid.uuid4().hex,
            "status": "running",
            "started_at": time.time(),
            "last_success_at": previous.get("last_success_at"),
            "phase": "Connecting to Kechimochi",
            "processed": 0,
            "total": 0,
            "error": None,
        }
        state.put(state_key, status)
        last_progress = 0.0

        def report(processed, total, phase):
            nonlocal last_progress
            status.update(processed=processed, total=total, phase=phase, updated_at=time.time())
            if time.monotonic() - last_progress >= 1:
                state.put(state_key, status)
                last_progress = time.monotonic()
            if progress_cb:
                progress_cb(processed, total, phase)

        remote = client
        try:
            remote = remote or KechimochiClient(config.kechimochi_url)
            # Fail fast when offline, before scanning years of local history.
            if client is None:
                remote.version()
            snapshot = build_kechimochi_snapshot(config=config, state=state, progress_cb=report)
            state.put("observed_native", sorted(set(state.get("observed_native", [])) | snapshot.observed_native))
            result = _sync_snapshot(snapshot, remote, state, config, report)
            status.update(
                status="completed", result=result, phase="Sync complete", last_success_at=time.time(), error=None
            )
            logger.info(
                "Kechimochi sync complete: {} activities, {} characters", result["activity_count"], result["characters"]
            )
            return result
        except Exception as exc:
            status.update(status="failed", error=str(exc), phase="Sync failed")
            if isinstance(exc, KechimochiConnectionError):
                logger.debug("Kechimochi sync deferred: {}", exc)
            else:
                logger.error("Kechimochi sync failed: {}", exc)
            raise
        finally:
            status["updated_at"] = time.time()
            state.put(state_key, status)
            if client is None and remote is not None:
                remote.close()
