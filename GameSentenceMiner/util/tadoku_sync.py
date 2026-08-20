from __future__ import annotations

import re
import threading
import time
from typing import Any

import requests

from GameSentenceMiner.util.config.configuration import get_stats_config, logger, save_stats_config
from GameSentenceMiner.util.database.db import GameLinesTable
from GameSentenceMiner.util.database.games_table import GamesTable
from GameSentenceMiner.util.database.stats_export_state_table import StatsExportStateTable


# The OpenAPI document still advertises /api/immersion/, but Tadoku's deployed
# web client and ingress route the service through /api/internal/immersion/.
TADOKU_API_BASE_URL = "https://tadoku.app/api/internal/immersion/"
TADOKU_AUTH_BASE_URL = "https://account.tadoku.app/kratos/"
TADOKU_CURSOR_KEY = "tadoku_incremental"
TADOKU_READING_ACTIVITY_ID = 1
TADOKU_GAME_TAG = "game"
TADOKU_GSM_TAG = "gsm"
TADOKU_REQUEST_TIMEOUT_SECONDS = 20
TADOKU_AUTO_SYNC_MINIMUM_CHARACTERS = 5_000

_sync_lock = threading.Lock()


class TadokuSyncError(RuntimeError):
    """Raised when an incremental Tadoku sync cannot be completed safely."""


def initialize_tadoku_cursor(now: float | None = None) -> float:
    """Create the launch-time cursor if this database has never synced to Tadoku."""
    existing = StatsExportStateTable.get_last_successful_export_at(TADOKU_CURSOR_KEY)
    if existing is not None:
        return existing

    cursor = float(now if now is not None else time.time())
    StatsExportStateTable.mark_successful_export(TADOKU_CURSOR_KEY, cursor)
    logger.info("Initialized Tadoku incremental sync cursor")
    return cursor


def tadoku_game_cursor_key(game_key: str) -> str:
    """Return the export-state key used to track one game's Tadoku progress."""
    return f"{TADOKU_CURSOR_KEY}:game:{game_key}"


def _game_key(line) -> str:
    game_id = str(line.game_id or "").strip()
    if game_id:
        return game_id
    return f"scene:{line.game_name or 'Unknown Game'}"


def _tadoku_media_tag(media_type: str | None) -> str:
    """Normalize a GSM media type into a compact Tadoku tag."""
    normalized = re.sub(r"[^a-z0-9]+", "", str(media_type or "").casefold())
    aliases = {
        "visualnovel": "vn",
        "vn": "vn",
        "videogame": TADOKU_GAME_TAG,
        "game": TADOKU_GAME_TAG,
        "unknown": TADOKU_GAME_TAG,
    }
    return aliases.get(normalized, normalized or TADOKU_GAME_TAG)


def _game_metadata(lines: list) -> tuple[dict[str, str], dict[str, str]]:
    names: dict[str, str] = {}
    media_tags: dict[str, str] = {}
    game_ids = {_game_key(line) for line in lines if not _game_key(line).startswith("scene:")}
    for game_id in game_ids:
        game = GamesTable.get(game_id)
        if game is not None:
            english_title = str(getattr(game, "title_english", "") or "").strip()
            original_title = str(getattr(game, "title_original", "") or "").strip()
            if english_title:
                names[game_id] = english_title
            elif original_title:
                names[game_id] = original_title
            media_tags[game_id] = _tadoku_media_tag(game.type)

    for line in lines:
        key = _game_key(line)
        names.setdefault(key, line.game_name or "Unknown Game")
        media_tags.setdefault(key, TADOKU_GAME_TAG)
    return names, media_tags


def _deduplication_ids(lines: list, game_keys: set[str] | None = None) -> set[str]:
    """Return newer duplicate IDs, keeping the oldest text within each game group.

    Identical text in different game groups is intentionally retained because
    each group is exported as its own Tadoku log.
    """
    grouped: dict[str, list] = {}
    for line in lines:
        key = _game_key(line)
        if game_keys is not None and key not in game_keys:
            continue
        grouped.setdefault(key, []).append(line)

    duplicate_ids: set[str] = set()
    for grouped_lines in grouped.values():
        seen: set[str] = set()
        for line in sorted(grouped_lines, key=lambda item: float(item.timestamp or 0)):
            if not isinstance(line.line_text, str) or not line.line_text.strip():
                continue
            normalized = line.line_text.lower()
            if normalized in seen:
                duplicate_ids.add(line.id)
            else:
                seen.add(normalized)
    return duplicate_ids


def _load_lines(upper_bound: float) -> list:
    rows = GameLinesTable._db.fetchall(
        f"SELECT * FROM {GameLinesTable._table} WHERE CAST(created_at AS REAL) <= ?",
        (upper_bound,),
    )
    return [GameLinesTable.from_row(row, clean_columns=["line_text"]) for row in rows]


def build_tadoku_preview(
    *,
    deduplicate: bool = False,
    upper_bound: float | None = None,
) -> dict[str, Any]:
    """Describe the exact per-game logs currently eligible for the next sync."""
    cursor = initialize_tadoku_cursor()
    cutoff = float(upper_bound if upper_bound is not None else time.time())
    lines = _load_lines(cutoff)
    names, media_tags = _game_metadata(lines)
    game_character_totals: dict[str, int] = {}
    for line in lines:
        text = line.line_text if isinstance(line.line_text, str) else ""
        if text:
            key = _game_key(line)
            game_character_totals[key] = game_character_totals.get(key, 0) + len(text)
    game_cursors: dict[str, float] = {}

    def game_cursor(game_key: str) -> float:
        if game_key not in game_cursors:
            saved_cursor = StatsExportStateTable.get_last_successful_export_at(tadoku_game_cursor_key(game_key))
            # The legacy global cursor remains the baseline for games that have
            # never been handled by the per-game automatic sync.
            game_cursors[game_key] = max(cursor, saved_cursor) if saved_cursor is not None else cursor
        return game_cursors[game_key]

    # Only compare lines in the current pending batch. Historical lines from a
    # previous successful sync must not suppress newly queued text.
    pending_lines = [line for line in lines if float(line.created_at or 0) > game_cursor(_game_key(line))]
    duplicates = _deduplication_ids(pending_lines) if deduplicate else set()

    grouped: dict[str, dict[str, Any]] = {}
    for line in lines:
        created_at = float(line.created_at or 0)
        key = _game_key(line)
        if created_at <= game_cursor(key) or line.id in duplicates:
            continue
        text = line.line_text if isinstance(line.line_text, str) else ""
        if not text:
            continue
        entry = grouped.setdefault(
            key,
            {
                "game_key": key,
                "game_name": names.get(key, line.game_name or "Unknown Game"),
                "media_tag": media_tags.get(key, TADOKU_GAME_TAG),
                "characters": 0,
                "lines": 0,
            },
        )
        entry["characters"] += len(text)
        entry["lines"] += 1

    entries = sorted(grouped.values(), key=lambda entry: entry["game_key"].casefold())
    return {
        "cursor": cursor,
        "upper_bound": cutoff,
        "deduplicate": bool(deduplicate),
        "duplicates_excluded": len(
            {
                line.id
                for line in lines
                if line.id in duplicates and float(line.created_at or 0) > game_cursor(_game_key(line))
            }
        ),
        "game_character_totals": game_character_totals,
        "total_entries": len(entries),
        "total_characters": sum(entry["characters"] for entry in entries),
        "entries": entries,
    }


class TadokuClient:
    def __init__(
        self,
        username: str,
        password: str,
        *,
        session_cookie: str = "",
        session: requests.Session | None = None,
    ):
        self._username = str(username or "").strip()
        self._password = str(password or "")
        if not self._username or not self._password:
            raise TadokuSyncError("Tadoku username and password are not configured")
        self._session = session or requests.Session()
        cookie = str(session_cookie or "").strip()
        if cookie:
            self._session.cookies.set(
                "ory_kratos_session",
                cookie,
                domain=".tadoku.app",
                path="/",
                secure=True,
            )

    def _has_session_cookie(self) -> bool:
        return any(cookie.name == "ory_kratos_session" and bool(cookie.value) for cookie in self._session.cookies)

    @property
    def session_cookie(self) -> str:
        return next(
            (
                str(cookie.value)
                for cookie in self._session.cookies
                if cookie.name == "ory_kratos_session" and cookie.value
            ),
            "",
        )

    def _clear_session_cookie(self) -> None:
        for cookie in list(self._session.cookies):
            if cookie.name == "ory_kratos_session":
                self._session.cookies.clear(cookie.domain, cookie.path, cookie.name)

    def refresh_session(self) -> None:
        """Replace any saved browser session by explicitly logging in again."""
        self._clear_session_cookie()
        self._login()

    @staticmethod
    def _json_payload(response, error_message: str) -> dict[str, Any]:
        if not response.content:
            return {}
        try:
            payload = response.json()
        except ValueError as exc:
            raise TadokuSyncError(error_message) from exc
        return payload if isinstance(payload, dict) else {}

    def _login(self) -> None:
        try:
            flow_response = self._session.request(
                "GET",
                f"{TADOKU_AUTH_BASE_URL}self-service/login/browser",
                timeout=TADOKU_REQUEST_TIMEOUT_SECONDS,
                headers={"Accept": "application/json"},
            )
        except requests.RequestException as exc:
            raise TadokuSyncError(f"Could not reach Tadoku login: {exc}") from exc
        if not flow_response.ok:
            raise TadokuSyncError(f"Tadoku login could not be started (HTTP {flow_response.status_code})")
        flow = self._json_payload(flow_response, "Tadoku login returned an invalid response")
        ui = flow.get("ui") or {}
        action = str(ui.get("action") or "")
        if not action.startswith(f"{TADOKU_AUTH_BASE_URL}self-service/login?"):
            raise TadokuSyncError("Tadoku login returned an invalid flow")
        csrf_token = next(
            (
                str((node.get("attributes") or {}).get("value") or "")
                for node in ui.get("nodes", [])
                if (node.get("attributes") or {}).get("name") == "csrf_token"
            ),
            "",
        )
        if not csrf_token:
            raise TadokuSyncError("Tadoku login did not return a CSRF token")

        try:
            login_response = self._session.request(
                "POST",
                action,
                timeout=TADOKU_REQUEST_TIMEOUT_SECONDS,
                headers={"Accept": "application/json"},
                data={
                    "identifier": self._username,
                    "password": self._password,
                    "method": "password",
                    "csrf_token": csrf_token,
                },
            )
        except requests.RequestException as exc:
            raise TadokuSyncError(f"Could not reach Tadoku login: {exc}") from exc
        if not login_response.ok:
            raise TadokuSyncError("Tadoku login failed; check the saved username and password")
        if not self._has_session_cookie():
            raise TadokuSyncError("Tadoku login did not return a browser session cookie")

    def _request_json(self, method: str, path: str, **kwargs) -> dict[str, Any]:
        if not self._has_session_cookie():
            self._login()

        def send_request():
            try:
                return self._session.request(
                    method,
                    f"{TADOKU_API_BASE_URL}{path.lstrip('/')}",
                    timeout=TADOKU_REQUEST_TIMEOUT_SECONDS,
                    **kwargs,
                )
            except requests.RequestException as exc:
                raise TadokuSyncError(f"Could not reach Tadoku: {exc}") from exc

        response = send_request()
        if response.status_code == 401:
            self._clear_session_cookie()
            self._login()
            response = send_request()

        if not response.ok:
            detail = response.text.strip()[:300]
            suffix = f": {detail}" if detail else ""
            raise TadokuSyncError(f"Tadoku returned HTTP {response.status_code}{suffix}")
        return self._json_payload(response, "Tadoku returned an invalid JSON response")

    def resolve_character_unit_id(self, language_code: str) -> str:
        payload = self._request_json("GET", "logs/configuration-options")
        candidates = [
            unit
            for unit in payload.get("units", [])
            if int(unit.get("log_activity_id", 0)) == TADOKU_READING_ACTIVITY_ID
            and str(unit.get("name", "")).casefold() == "character"
        ]
        language_specific = next(
            (unit for unit in candidates if unit.get("language_code") == language_code),
            None,
        )
        fallback = next((unit for unit in candidates if not unit.get("language_code")), None)
        selected = language_specific or fallback
        if not selected or not selected.get("id"):
            raise TadokuSyncError(f"Tadoku has no Character unit available for language '{language_code}'")
        return str(selected["id"])

    def get_eligible_registration_ids(self, language_code: str, activity_id: int) -> list[str]:
        """Return every ongoing contest registration that accepts this log."""
        payload = self._request_json("GET", "contests/ongoing-registrations")
        eligible_ids: list[str] = []
        for registration in payload.get("registrations", []):
            registration_id = str(registration.get("id") or "")
            if not registration_id:
                continue

            languages = {
                str(language.get("code") or "")
                for language in registration.get("languages", [])
                if isinstance(language, dict)
            }
            contest = registration.get("contest") or {}
            activities = {
                int(activity.get("id", 0))
                for activity in contest.get("allowed_activities", [])
                if isinstance(activity, dict)
            }
            if language_code in languages and activity_id in activities:
                eligible_ids.append(registration_id)
        return eligible_ids

    def create_log(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self._request_json("POST", "logs", json=payload)

    def delete_log(self, log_id: str) -> None:
        self._request_json("DELETE", f"logs/{log_id}")


def run_tadoku_sync(
    *,
    config=None,
    client: TadokuClient | None = None,
    deduplicate: bool = False,
    minimum_characters_per_game: int = 0,
    game_whitelist: set[str] | None = None,
) -> dict[str, Any]:
    """Upload eligible per-game Character logs without consuming deferred games."""
    if not _sync_lock.acquire(blocking=False):
        raise TadokuSyncError("A Tadoku sync is already running")

    stats_config = None
    tadoku_client = None
    saved_session_cookie = ""
    try:
        stats_config = config or get_stats_config()
        language_code = str(getattr(stats_config, "tadoku_language_code", "jpn") or "jpn").strip().lower()
        upper_bound = time.time()
        # Deduplication is export-only. Local gamelines are immutable from Tadoku's
        # perspective; duplicates are omitted from the outgoing aggregate and kept.
        preview = build_tadoku_preview(deduplicate=deduplicate, upper_bound=upper_bound)
        pending_entries = preview["entries"]
        duplicates_excluded = int(preview["duplicates_excluded"])
        required_characters = max(0, int(minimum_characters_per_game))
        normalized_whitelist = None
        if game_whitelist:
            normalized_whitelist = {str(game_id).strip() for game_id in game_whitelist if str(game_id).strip()} or None
        whitelisted_entries = [
            entry
            for entry in pending_entries
            if normalized_whitelist is None or entry["game_key"] in normalized_whitelist
        ]
        game_character_totals = preview["game_character_totals"]
        entries = [
            entry
            for entry in whitelisted_entries
            if game_character_totals.get(entry["game_key"], 0) >= required_characters
        ]
        partial_sync = normalized_whitelist is not None or required_characters > 0

        if not entries and partial_sync:
            scope = "whitelisted game" if normalized_whitelist is not None else "game"
            reason = f"no {scope} has queued characters"
            if required_characters and whitelisted_entries:
                reason = f"no {scope} has {required_characters:,} total characters"
            return {
                "success": True,
                "skipped": True,
                "reason": reason,
                "entries_sent": 0,
                "characters_sent": 0,
                "pending_characters": sum(entry["characters"] for entry in whitelisted_entries),
                "minimum_characters_per_game": required_characters,
                "duplicates_excluded": duplicates_excluded,
                "cursor": preview["cursor"],
            }
        if not entries:
            StatsExportStateTable.mark_successful_export(TADOKU_CURSOR_KEY, upper_bound)
            return {
                "success": True,
                "entries_sent": 0,
                "characters_sent": 0,
                "duplicates_excluded": duplicates_excluded,
                "cursor": upper_bound,
            }

        saved_session_cookie = str(getattr(stats_config, "tadoku_session_cookie", "") or "")
        tadoku_client = client or TadokuClient(
            getattr(stats_config, "tadoku_username", ""),
            getattr(stats_config, "tadoku_password", ""),
            session_cookie=saved_session_cookie,
        )
        unit_id = tadoku_client.resolve_character_unit_id(language_code)
        registration_ids = tadoku_client.get_eligible_registration_ids(
            language_code,
            TADOKU_READING_ACTIVITY_ID,
        )
        created_log_ids: list[str] = []
        try:
            for entry in entries:
                payload = {
                    "language_code": language_code,
                    "activity_id": TADOKU_READING_ACTIVITY_ID,
                    "amount": entry["characters"],
                    "unit_id": unit_id,
                    "tags": [entry["media_tag"], TADOKU_GSM_TAG],
                    "description": entry["game_name"][:255],
                    "registration_ids": registration_ids,
                }
                created = tadoku_client.create_log(payload)
                log_id = str(created.get("id") or "")
                if not log_id:
                    raise TadokuSyncError("Tadoku created a log without returning its ID")
                created_log_ids.append(log_id)
        except Exception as exc:
            rollback_errors = []
            for log_id in reversed(created_log_ids):
                try:
                    tadoku_client.delete_log(log_id)
                except Exception as rollback_exc:
                    rollback_errors.append(str(rollback_exc))
            if rollback_errors:
                raise TadokuSyncError(f"{exc}. Tadoku rollback also failed for {len(rollback_errors)} log(s)") from exc
            if isinstance(exc, TadokuSyncError):
                raise
            raise TadokuSyncError(str(exc)) from exc

        for entry in entries:
            StatsExportStateTable.mark_successful_export(tadoku_game_cursor_key(entry["game_key"]), upper_bound)
        if not partial_sync:
            # A manual/unfiltered sync consumed every pending entry. Partial
            # automatic runs must leave the global cursor in place so filtered
            # and below-threshold games remain queued.
            StatsExportStateTable.mark_successful_export(TADOKU_CURSOR_KEY, upper_bound)
        characters_sent = sum(entry["characters"] for entry in entries)
        return {
            "success": True,
            "entries_sent": len(entries),
            "characters_sent": characters_sent,
            "duplicates_excluded": duplicates_excluded,
            "cursor": upper_bound if not partial_sync else preview["cursor"],
        }
    finally:
        if client is None and tadoku_client is not None and stats_config is not None:
            current_session_cookie = tadoku_client.session_cookie
            if current_session_cookie and current_session_cookie != saved_session_cookie:
                stats_config.tadoku_session_cookie = current_session_cookie
                try:
                    save_stats_config(stats_config)
                except Exception as exc:
                    logger.error("Could not persist refreshed Tadoku session: %s", exc)
        _sync_lock.release()
