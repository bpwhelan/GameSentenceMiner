"""Shared recent-character-name helpers for Yomitan and controller tokenization."""

from __future__ import annotations

from dataclasses import dataclass
import json
import time
from typing import TYPE_CHECKING, Any, Dict, List, Optional, Sequence

import jaconv

from GameSentenceMiner.util.config.configuration import logger

if TYPE_CHECKING:
    from GameSentenceMiner.util.database.games_table import GamesTable


RECENT_CHARACTER_GAME_COUNT = 3
RECENT_CHARACTER_MAX_SEARCH = 50
CHARACTER_NAME_CACHE_TTL_SECONDS = 60.0
CHARACTER_CATEGORIES = ("main", "primary", "side", "appears")


@dataclass(frozen=True)
class CharacterNameCandidate:
    """A searchable character-name variant with a canonical reading."""

    term: str
    reading_hiragana: str
    reading_katakana: str
    headword: str


_NAME_PARSER = None
_CACHED_NAME_INDEX: Optional[Dict[str, List[CharacterNameCandidate]]] = None
_CACHED_NAME_INDEX_AT = 0.0


def _get_games_table():
    from GameSentenceMiner.util.database.games_table import GamesTable

    return GamesTable


def _get_name_parser():
    global _NAME_PARSER
    if _NAME_PARSER is None:
        from .name_parser import NameParser

        _NAME_PARSER = NameParser()
    return _NAME_PARSER


def has_character_data(game: "GamesTable") -> bool:
    """Validate that a game has at least one character entry."""
    if not game.vndb_character_data:
        return False

    try:
        char_data = game.vndb_character_data
        if isinstance(char_data, str):
            char_data = json.loads(char_data)

        if not isinstance(char_data, dict):
            return False

        characters_obj = char_data.get("characters", {})
        if not isinstance(characters_obj, dict):
            return False

        for category in CHARACTER_CATEGORIES:
            characters = characters_obj.get(category, [])
            if isinstance(characters, list) and len(characters) > 0:
                return True

        return False
    except (json.JSONDecodeError, TypeError, AttributeError):
        return False


def get_recent_games_with_character_data(
    desired_count: int = RECENT_CHARACTER_GAME_COUNT,
    max_search: int = RECENT_CHARACTER_MAX_SEARCH,
) -> List[GamesTable]:
    """Return recently played games that have usable character data."""
    GamesTable = _get_games_table()
    query = """
        SELECT g.id
        FROM games g
        LEFT JOIN (
            SELECT game_id, MAX(timestamp) AS last_played
            FROM game_lines
            WHERE game_id IS NOT NULL AND game_id != ''
            GROUP BY game_id
        ) gl ON g.id = gl.game_id
        WHERE g.vndb_character_data IS NOT NULL
          AND g.vndb_character_data != ''
          AND g.vndb_character_data != '{}'
        ORDER BY gl.last_played DESC NULLS LAST
        LIMIT ?
    """
    rows = GamesTable._db.fetchall(query, (max_search,))

    logger.info(
        f"Character names: Found {len(rows)} games with populated vndb_character_data"
    )

    valid_games: List[GamesTable] = []
    checked_games = []

    for (game_id,) in rows:
        game = GamesTable.get(game_id)
        if not game:
            continue

        game_title = game.title_original or game.title_romaji or game.title_english or game_id
        if has_character_data(game):
            valid_games.append(game)
            checked_games.append((game_title, True))
            logger.info(f"Character names: + '{game_title}'")
            if len(valid_games) >= desired_count:
                break
        else:
            checked_games.append((game_title, False))
            logger.info(f"Character names: - '{game_title}' (empty or invalid)")

    if valid_games:
        logger.info(
            f"Character names: Using {len(valid_games)} game(s) out of {len(checked_games)} checked"
        )
    else:
        logger.warning(
            f"Character names: No recent games with valid character data found (checked {len(checked_games)})"
        )

    return valid_games


def _iter_game_characters(game: "GamesTable"):
    char_data = game.vndb_character_data
    if char_data is None:
        return

    if isinstance(char_data, str):
        try:
            char_data = json.loads(char_data)
        except json.JSONDecodeError:
            return

    if not isinstance(char_data, dict):
        return

    characters_obj = char_data.get("characters", {})
    if not isinstance(characters_obj, dict):
        return

    for category in CHARACTER_CATEGORIES:
        characters = characters_obj.get(category, [])
        if not isinstance(characters, list):
            continue
        for char in characters:
            if isinstance(char, dict):
                yield char


def build_character_name_candidates(char: Dict[str, Any]) -> List[CharacterNameCandidate]:
    """Build the name variants and readings used for character-aware tokenization."""
    name_original = char.get("name_original", "") or char.get("name", "")
    if not name_original:
        return []

    name_parser = _get_name_parser()
    romanized_name = char.get("name", "")
    hiragana_readings = name_parser.generate_mixed_name_readings(name_original, romanized_name)
    name_parts = name_parser.split_japanese_name(name_original)
    canonical_headword = name_parts.get("combined") or name_parts.get("original") or name_original

    candidates: List[CharacterNameCandidate] = []
    added_terms = set()

    def add_candidate(term: Optional[str], reading: Optional[str], headword: Optional[str] = None) -> None:
        normalized_term = str(term or "").strip()
        if not normalized_term or normalized_term in added_terms:
            return

        normalized_reading = str(reading or "").strip()
        candidates.append(
            CharacterNameCandidate(
                term=normalized_term,
                reading_hiragana=normalized_reading,
                reading_katakana=jaconv.hira2kata(normalized_reading) if normalized_reading else "",
                headword=str(headword or canonical_headword or normalized_term),
            )
        )
        added_terms.add(normalized_term)

    if name_parts["has_space"]:
        add_candidate(name_parts.get("original"), hiragana_readings.get("full"))
        add_candidate(name_parts.get("combined"), hiragana_readings.get("full"))
        add_candidate(name_parts.get("family"), hiragana_readings.get("family"))
        add_candidate(name_parts.get("given"), hiragana_readings.get("given"))
    else:
        add_candidate(name_original, hiragana_readings.get("full"))

    base_names_with_readings = []
    if name_parts["has_space"]:
        if name_parts.get("family"):
            base_names_with_readings.append((name_parts["family"], hiragana_readings.get("family")))
        if name_parts.get("given"):
            base_names_with_readings.append((name_parts["given"], hiragana_readings.get("given")))
        if name_parts.get("combined"):
            base_names_with_readings.append((name_parts["combined"], hiragana_readings.get("full")))
        if name_parts.get("original"):
            base_names_with_readings.append((name_parts["original"], hiragana_readings.get("full")))
    else:
        base_names_with_readings.append((name_original, hiragana_readings.get("full")))

    for base_name, base_reading in base_names_with_readings:
        for suffix, suffix_reading in name_parser.HONORIFIC_SUFFIXES:
            add_candidate(
                f"{base_name}{suffix}",
                f"{base_reading or ''}{suffix_reading}",
            )

    aliases = char.get("aliases", [])
    if isinstance(aliases, list):
        for alias in aliases:
            add_candidate(alias, hiragana_readings.get("full"))
            for suffix, suffix_reading in name_parser.HONORIFIC_SUFFIXES:
                add_candidate(
                    f"{alias}{suffix}",
                    f"{hiragana_readings.get('full') or ''}{suffix_reading}",
                )

    return candidates


def build_recent_character_name_candidates(
    desired_count: int = RECENT_CHARACTER_GAME_COUNT,
    max_search: int = RECENT_CHARACTER_MAX_SEARCH,
) -> List[CharacterNameCandidate]:
    """Build searchable name variants from recent games, keeping most recent collisions."""
    candidates: List[CharacterNameCandidate] = []
    seen_terms = set()

    for game in get_recent_games_with_character_data(desired_count=desired_count, max_search=max_search):
        for char in _iter_game_characters(game):
            for candidate in build_character_name_candidates(char):
                if candidate.term in seen_terms:
                    continue
                seen_terms.add(candidate.term)
                candidates.append(candidate)

    return candidates


def build_character_name_index(
    candidates: Sequence[CharacterNameCandidate],
) -> Dict[str, List[CharacterNameCandidate]]:
    """Index candidates by first character so matching stays cheap."""
    index: Dict[str, List[CharacterNameCandidate]] = {}
    for candidate in candidates:
        if not candidate.term:
            continue
        index.setdefault(candidate.term[0], []).append(candidate)

    for group in index.values():
        group.sort(key=lambda item: len(item.term), reverse=True)

    return index


def get_recent_character_name_index(
    *,
    force_refresh: bool = False,
    cache_ttl_seconds: float = CHARACTER_NAME_CACHE_TTL_SECONDS,
    desired_count: int = RECENT_CHARACTER_GAME_COUNT,
    max_search: int = RECENT_CHARACTER_MAX_SEARCH,
) -> Dict[str, List[CharacterNameCandidate]]:
    """Return a cached index of recent character names and readings."""
    global _CACHED_NAME_INDEX
    global _CACHED_NAME_INDEX_AT

    now = time.time()
    cache_valid = (
        not force_refresh
        and _CACHED_NAME_INDEX is not None
        and (now - _CACHED_NAME_INDEX_AT) < cache_ttl_seconds
    )
    if cache_valid:
        return _CACHED_NAME_INDEX

    candidates = build_recent_character_name_candidates(
        desired_count=desired_count,
        max_search=max_search,
    )
    _CACHED_NAME_INDEX = build_character_name_index(candidates)
    _CACHED_NAME_INDEX_AT = now
    return _CACHED_NAME_INDEX


def text_contains_kanji(text: str) -> bool:
    """Check whether the text contains any kanji characters."""
    if not text:
        return False
    for char in text:
        code = ord(char)
        if (
            0x4E00 <= code <= 0x9FFF
            or 0x3400 <= code <= 0x4DBF
            or 0x20000 <= code <= 0x2A6DF
        ):
            return True
    return False


def katakana_to_hiragana(text: str) -> str:
    """Convert katakana to hiragana, leaving other characters untouched."""
    out: List[str] = []
    for char in text:
        code = ord(char)
        if 0x30A1 <= code <= 0x30F6:
            out.append(chr(code - 0x60))
        else:
            out.append(char)
    return "".join(out)


def _coerce_int(value: Any) -> Optional[int]:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _find_match_end_index(
    tokens: Sequence[Dict[str, Any]],
    start_index: int,
    target_end: int,
) -> Optional[int]:
    for index in range(start_index, len(tokens)):
        token_end = _coerce_int(tokens[index].get("end"))
        if token_end is None:
            return None
        if token_end < target_end:
            continue
        return index if token_end == target_end else None
    return None


def merge_tokens_with_character_names(
    text: str,
    tokens: Sequence[Dict[str, Any]],
    candidate_index: Optional[Dict[str, List[CharacterNameCandidate]]] = None,
) -> List[Dict[str, Any]]:
    """Merge token spans that match known character names from recent games."""
    if not text or not tokens:
        return list(tokens)

    if candidate_index is None:
        candidate_index = get_recent_character_name_index()
    if not candidate_index:
        return [dict(token) for token in tokens]

    merged_tokens: List[Dict[str, Any]] = []
    index = 0

    while index < len(tokens):
        token = tokens[index]
        token_start = _coerce_int(token.get("start"))
        if token_start is None or token_start < 0 or token_start >= len(text):
            merged_tokens.append(dict(token))
            index += 1
            continue

        best_candidate = None
        best_end_index = None
        for candidate in candidate_index.get(text[token_start], []):
            candidate_end = token_start + len(candidate.term)
            if candidate_end > len(text) or not text.startswith(candidate.term, token_start):
                continue
            end_index = _find_match_end_index(tokens, index, candidate_end)
            if end_index is None:
                continue
            best_candidate = candidate
            best_end_index = end_index
            break

        if best_candidate is None or best_end_index is None:
            merged_tokens.append(dict(token))
            index += 1
            continue

        merged_token = {
            "word": text[token_start:token_start + len(best_candidate.term)],
            "start": token_start,
            "end": token_start + len(best_candidate.term),
            "headword": best_candidate.headword,
            "pos": "character-name",
        }
        if best_candidate.reading_katakana:
            merged_token["reading"] = best_candidate.reading_katakana

        merged_tokens.append(merged_token)
        index = best_end_index + 1

    return merged_tokens


def tokens_to_furigana_segments(tokens: Sequence[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Convert token output into furigana segments for the overlay."""
    segments: List[Dict[str, Any]] = []

    for token in tokens:
        word = str(token.get("word") or "")
        start = _coerce_int(token.get("start"))
        end = _coerce_int(token.get("end"))
        if not word or start is None or end is None:
            continue

        reading = str(token.get("reading") or "").strip()
        reading_hiragana = katakana_to_hiragana(reading) if reading else ""
        has_reading = (
            bool(reading_hiragana)
            and reading_hiragana != word
            and text_contains_kanji(word)
        )

        segments.append(
            {
                "text": word,
                "start": start,
                "end": end,
                "hasReading": has_reading,
                "reading": reading_hiragana if has_reading else None,
            }
        )

    return segments
