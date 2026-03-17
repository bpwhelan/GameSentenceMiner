"""Build per-game Sudachi user dictionary CSV sources from character data."""

from __future__ import annotations

import csv
import hashlib
import json
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import TYPE_CHECKING, Callable, Iterable

import jaconv

from GameSentenceMiner.util.config.configuration import get_app_directory, logger

from .name_parser import NameParser

if TYPE_CHECKING:
    from GameSentenceMiner.util.database.games_table import GamesTable


SUDACHI_USER_DICT_DIRNAME = "sudachi"
CSV_DIRNAME = "csv"
METADATA_DIRNAME = "metadata"
PERSON_NAME_POS = ("名詞", "固有名詞", "人名", "一般", "*", "*")
PERSON_NAME_LEFT_ID = 4787
PERSON_NAME_RIGHT_ID = 4787
KANJI_NAME_COST = 18086
HIRAGANA_NAME_COST = 18269
KATAKANA_NAME_COST = 13759

_TRUTHY_ENV_VALUES = {"1", "true", "yes", "on"}
# Default off for now. Set GSM_ENABLE_SUDACHI_USER_DICT=1 to re-enable while revisiting.
SUDACHI_USER_DICT_ENABLED = (
    os.getenv("GSM_ENABLE_SUDACHI_USER_DICT", "").strip().lower() in _TRUTHY_ENV_VALUES
)

_executor: ThreadPoolExecutor | None = None
_queue_lock = threading.Lock()
_last_queued_scene_name = ""
_startup_wait_lock = threading.Lock()
_startup_wait_active = False
STARTUP_SCENE_POLL_INTERVAL_SECONDS = 0.5
STARTUP_SCENE_MAX_ATTEMPTS = 120


def _background(message: str, *args, **kwargs) -> None:
    try:
        logger.background(message, *args, **kwargs)
    except Exception:
        logger.info(message, *args, **kwargs)


def _is_enabled() -> bool:
    return bool(SUDACHI_USER_DICT_ENABLED)


def _get_executor() -> ThreadPoolExecutor:
    global _executor

    if _executor is None:
        _executor = ThreadPoolExecutor(
            max_workers=1,
            thread_name_prefix="gsm-sudachi-userdict",
        )
    return _executor


def get_sudachi_user_dict_root() -> Path:
    root = Path(get_app_directory()) / "dictionaries" / SUDACHI_USER_DICT_DIRNAME
    root.mkdir(parents=True, exist_ok=True)
    return root


def _get_csv_dir() -> Path:
    directory = get_sudachi_user_dict_root() / CSV_DIRNAME
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def _get_metadata_dir() -> Path:
    directory = get_sudachi_user_dict_root() / METADATA_DIRNAME
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def _get_games_table():
    from GameSentenceMiner.util.database.games_table import GamesTable

    return GamesTable


def _parse_character_data(char_data: object) -> dict:
    if char_data is None:
        return {}
    if isinstance(char_data, str):
        try:
            char_data = json.loads(char_data)
        except json.JSONDecodeError:
            return {}
    return char_data if isinstance(char_data, dict) else {}


def has_character_data(game: "GamesTable") -> bool:
    char_data = _parse_character_data(getattr(game, "vndb_character_data", None))
    characters_obj = char_data.get("characters", {})
    if not isinstance(characters_obj, dict):
        return False

    for category in ("main", "primary", "side", "appears"):
        characters = characters_obj.get(category, [])
        if isinstance(characters, list) and characters:
            return True

    return False


def _resolve_game(scene_name: str):
    GamesTable = _get_games_table()

    game = GamesTable.get_by_obs_scene_name(scene_name)
    if game:
        return game

    game = GamesTable.get_by_title(scene_name)
    if game:
        return game

    return GamesTable.find_similar_game(scene_name)


def _display_game_name(game: "GamesTable") -> str:
    return (
        getattr(game, "title_original", "")
        or getattr(game, "title_romaji", "")
        or getattr(game, "title_english", "")
        or getattr(game, "obs_scene_name", "")
        or getattr(game, "id", "")
        or "Unknown Game"
    )


def _is_katakana_only(text: str) -> bool:
    stripped = str(text or "").replace(" ", "")
    if not stripped:
        return False
    for char in stripped:
        code = ord(char)
        if not (0x30A0 <= code <= 0x30FF):
            return False
    return True


def _reading_cost(surface: str) -> int:
    compact = str(surface or "").replace(" ", "")
    if not compact:
        return KANJI_NAME_COST
    if _is_katakana_only(compact):
        return KATAKANA_NAME_COST
    if compact == jaconv.kata2hira(compact):
        return HIRAGANA_NAME_COST
    return KANJI_NAME_COST


def _reading_to_katakana(reading_hiragana: str) -> str:
    return NameParser.hira_to_kata(str(reading_hiragana or "").replace(" ", ""))


def _build_csv_row(surface: str, reading_hiragana: str) -> list[str] | None:
    normalized_surface = str(surface or "").strip()
    katakana_reading = _reading_to_katakana(reading_hiragana)
    if not normalized_surface or not katakana_reading:
        return None

    return [
        normalized_surface,
        str(PERSON_NAME_LEFT_ID),
        str(PERSON_NAME_RIGHT_ID),
        str(_reading_cost(normalized_surface)),
        normalized_surface,
        *PERSON_NAME_POS,
        katakana_reading,
        normalized_surface,
        "*",
        "A",
        "*",
        "*",
        "*",
        "*",
    ]


def _character_surfaces(parser: NameParser, char: dict) -> Iterable[tuple[str, str]]:
    name_original = str(char.get("name_original") or char.get("name") or "").strip()
    if not name_original:
        return

    romanized_name = str(char.get("name") or "").strip()
    readings = parser.generate_mixed_name_readings(name_original, romanized_name)
    full_reading = str(readings.get("full") or "").replace(" ", "")
    if not full_reading:
        return

    name_parts = parser.split_japanese_name(name_original)
    surfaces: list[tuple[str, str]] = []
    surfaces.append((name_original, full_reading))

    combined = str(name_parts.get("combined") or "")
    if combined and combined != name_original:
        surfaces.append((combined, full_reading))

    if parser.contains_kanji(name_original):
        surfaces.append((full_reading, full_reading))
        katakana_surface = parser.hira_to_kata(full_reading)
        if katakana_surface:
            surfaces.append((katakana_surface, full_reading))

    aliases = char.get("aliases", [])
    if isinstance(aliases, list):
        for alias in aliases:
            alias_text = str(alias or "").strip()
            if not alias_text:
                continue
            if parser.contains_kanji(alias_text):
                continue
            alias_reading = jaconv.kata2hira(alias_text.replace(" ", ""))
            if alias_reading:
                surfaces.append((alias_text, alias_reading))

    seen = set()
    for surface, reading in surfaces:
        key = (surface, reading)
        if key in seen:
            continue
        seen.add(key)
        yield key


def build_rows_for_game(game: "GamesTable") -> list[list[str]]:
    parser = NameParser()
    char_data = _parse_character_data(getattr(game, "vndb_character_data", None))
    characters_obj = char_data.get("characters", {})
    if not isinstance(characters_obj, dict):
        return []

    rows: list[list[str]] = []
    seen_surfaces = set()
    for category in ("main", "primary", "side", "appears"):
        characters = characters_obj.get(category, [])
        if not isinstance(characters, list):
            continue
        for char in characters:
            if not isinstance(char, dict):
                continue
            for surface, reading in _character_surfaces(parser, char):
                if surface in seen_surfaces:
                    continue
                row = _build_csv_row(surface, reading)
                if row is None:
                    continue
                seen_surfaces.add(surface)
                rows.append(row)

    rows.sort(key=lambda row: row[0])
    return rows


def _rows_hash(rows: list[list[str]]) -> str:
    payload = json.dumps(rows, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _write_json_atomic(path: Path, payload: dict) -> None:
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    tmp_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    tmp_path.replace(path)


def _write_csv_atomic(path: Path, rows: list[list[str]]) -> None:
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    with tmp_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle, lineterminator="\n")
        writer.writerows(rows)
    tmp_path.replace(path)


def write_game_dictionary_source(game: "GamesTable") -> bool:
    rows = build_rows_for_game(game)
    csv_path = _get_csv_dir() / f"{game.id}.csv"
    metadata_path = _get_metadata_dir() / f"{game.id}.json"

    if not rows:
        _background(
            "[SudachiUserDict] No rows generated for {} (id={})",
            _display_game_name(game),
            getattr(game, "id", ""),
        )
        return False

    source_hash = _rows_hash(rows)
    if metadata_path.is_file():
        try:
            existing = json.loads(metadata_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            existing = {}
        if existing.get("source_hash") == source_hash:
            _background(
                "[SudachiUserDict] Up to date for {} (id={})",
                _display_game_name(game),
                getattr(game, "id", ""),
            )
            return False

    _write_csv_atomic(csv_path, rows)
    _write_json_atomic(
        metadata_path,
        {
            "game_id": game.id,
            "title": getattr(game, "title_original", "") or "",
            "obs_scene_name": getattr(game, "obs_scene_name", "") or "",
            "row_count": len(rows),
            "source_hash": source_hash,
        },
    )
    _background(
        "[SudachiUserDict] Wrote {} rows for {} (id={}) to {}",
        len(rows),
        _display_game_name(game),
        getattr(game, "id", ""),
        csv_path,
    )
    return True


def ensure_scene_dictionary(scene_name: str, *, reason: str = "unspecified") -> bool:
    if not _is_enabled():
        _background(
            "[SudachiUserDict] Disabled; skipping scene export for '{}' (reason={})",
            str(scene_name or "").strip(),
            reason,
        )
        return False

    normalized_scene_name = str(scene_name or "").strip()
    if not normalized_scene_name:
        _background("[SudachiUserDict] Skipping empty scene name (reason={})", reason)
        return False

    _background(
        "[SudachiUserDict] Resolving scene '{}' (reason={})",
        normalized_scene_name,
        reason,
    )
    game = _resolve_game(normalized_scene_name)
    if game is None:
        _background(
            "[SudachiUserDict] No game match found for scene '{}' (reason={})",
            normalized_scene_name,
            reason,
        )
        return False

    if not has_character_data(game):
        _background(
            "[SudachiUserDict] Game '{}' has no character data yet (scene='{}', reason={})",
            _display_game_name(game),
            normalized_scene_name,
            reason,
        )
        return False

    return write_game_dictionary_source(game)


def ensure_game_dictionary(game: "GamesTable", *, reason: str = "unspecified") -> bool:
    if not _is_enabled():
        _background(
            "[SudachiUserDict] Disabled; skipping game export for '{}' (reason={})",
            _display_game_name(game) if game is not None else "",
            reason,
        )
        return False

    if game is None:
        _background("[SudachiUserDict] Skipping null game object (reason={})", reason)
        return False

    if not has_character_data(game):
        _background(
            "[SudachiUserDict] Game '{}' has no character data yet (reason={})",
            _display_game_name(game),
            reason,
        )
        return False

    _background(
        "[SudachiUserDict] Building dictionary source for {} (id={}, reason={})",
        _display_game_name(game),
        getattr(game, "id", ""),
        reason,
    )
    return write_game_dictionary_source(game)


def _ensure_scene_dictionary_safe(scene_name: str, reason: str) -> None:
    try:
        ensure_scene_dictionary(scene_name, reason=reason)
    except Exception as exc:
        logger.warning(
            f"Failed to update Sudachi user dictionary source for '{scene_name}' (reason={reason}): {exc}"
        )


def _ensure_game_dictionary_safe(game: "GamesTable", reason: str) -> None:
    try:
        ensure_game_dictionary(game, reason=reason)
    except Exception as exc:
        logger.warning(
            f"Failed to update Sudachi user dictionary source for '{_display_game_name(game)}' (reason={reason}): {exc}"
        )


def _wait_for_scene_name_and_queue(
    scene_name_supplier: Callable[[], str],
    *,
    reason: str,
    force: bool,
    poll_interval_seconds: float,
    max_attempts: int,
) -> None:
    global _startup_wait_active

    try:
        _background(
            "[SudachiUserDict] Waiting for initial non-empty scene name (reason={}, poll_interval_seconds={}, max_attempts={})",
            reason,
            poll_interval_seconds,
            max_attempts,
        )

        for attempt in range(1, max(1, max_attempts) + 1):
            try:
                scene_name = str(scene_name_supplier() or "").strip()
            except Exception as exc:
                logger.debug(
                    f"Failed to read scene name while waiting for Sudachi startup export (reason={reason}, attempt={attempt}): {exc}"
                )
                scene_name = ""

            if scene_name:
                _background(
                    "[SudachiUserDict] Initial scene name '{}' became available on attempt {} (reason={})",
                    scene_name,
                    attempt,
                    reason,
                )
                queue_ensure_scene_dictionary(
                    scene_name,
                    reason=f"{reason}:ready",
                    force=force,
                )
                return

            if attempt < max_attempts:
                time.sleep(max(0.0, poll_interval_seconds))

        _background(
            "[SudachiUserDict] Timed out waiting for initial scene name (reason={}, max_attempts={})",
            reason,
            max_attempts,
        )
    finally:
        with _startup_wait_lock:
            _startup_wait_active = False


def queue_ensure_scene_dictionary(
    scene_name: str, *, reason: str = "scene-change", force: bool = False
) -> None:
    global _last_queued_scene_name

    if not _is_enabled():
        _background(
            "[SudachiUserDict] Disabled; not queueing scene '{}' (reason={})",
            str(scene_name or "").strip(),
            reason,
        )
        return

    normalized_scene_name = str(scene_name or "").strip()
    if not normalized_scene_name:
        _background(
            "[SudachiUserDict] Not queueing empty scene name (reason={})", reason
        )
        return

    with _queue_lock:
        if not force and normalized_scene_name == _last_queued_scene_name:
            _background(
                "[SudachiUserDict] Skipping duplicate queue for scene '{}' (reason={})",
                normalized_scene_name,
                reason,
            )
            return
        _last_queued_scene_name = normalized_scene_name

    _background(
        "[SudachiUserDict] Queued scene '{}' for background export (reason={}, force={})",
        normalized_scene_name,
        reason,
        force,
    )
    _get_executor().submit(_ensure_scene_dictionary_safe, normalized_scene_name, reason)


def queue_wait_for_scene_dictionary(
    scene_name_supplier: Callable[[], str],
    *,
    reason: str = "startup",
    force: bool = False,
    poll_interval_seconds: float = STARTUP_SCENE_POLL_INTERVAL_SECONDS,
    max_attempts: int = STARTUP_SCENE_MAX_ATTEMPTS,
) -> None:
    global _startup_wait_active

    if not _is_enabled():
        _background(
            "[SudachiUserDict] Disabled; not queueing startup wait (reason={})",
            reason,
        )
        return

    with _startup_wait_lock:
        if _startup_wait_active:
            _background(
                "[SudachiUserDict] Startup scene wait already active (reason={})",
                reason,
            )
            return
        _startup_wait_active = True

    _background(
        "[SudachiUserDict] Queued startup wait for initial scene name (reason={}, force={})",
        reason,
        force,
    )
    threading.Thread(
        _wait_for_scene_name_and_queue,
        kwargs={
            "scene_name_supplier": scene_name_supplier,
            "reason": reason,
            "force": force,
            "poll_interval_seconds": poll_interval_seconds,
            "max_attempts": max_attempts,
        },
        daemon=True,
        name="gsm-sudachi-startup-wait",
    ).start()


def queue_ensure_game_dictionary(
    game: "GamesTable", *, reason: str = "game-update", force: bool = False
) -> None:
    global _last_queued_scene_name

    if not _is_enabled():
        _background(
            "[SudachiUserDict] Disabled; not queueing game '{}' (reason={})",
            _display_game_name(game) if game is not None else "",
            reason,
        )
        return

    if game is None:
        _background(
            "[SudachiUserDict] Not queueing null game object (reason={})", reason
        )
        return

    game_key = str(
        getattr(game, "obs_scene_name", "") or getattr(game, "id", "") or ""
    ).strip()
    with _queue_lock:
        if game_key and not force and game_key == _last_queued_scene_name:
            _background(
                "[SudachiUserDict] Skipping duplicate queue for game '{}' (reason={})",
                _display_game_name(game),
                reason,
            )
            return
        if game_key:
            _last_queued_scene_name = game_key

    _background(
        "[SudachiUserDict] Queued game '{}' for background export (reason={}, force={})",
        _display_game_name(game),
        reason,
        force,
    )
    _get_executor().submit(_ensure_game_dictionary_safe, game, reason)
