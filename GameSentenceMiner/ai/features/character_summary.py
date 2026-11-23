from __future__ import annotations

import json
from itertools import islice
from typing import Optional

from GameSentenceMiner.ai.prompts.templates import CHARACTER_SUMMARY_PROMPT
from GameSentenceMiner.ai.translation_cache import is_successful_translation


def _compact_character_cast(data: dict) -> str:
    cast = data.get("characters", data) if isinstance(data, dict) else data
    if isinstance(cast, dict):
        groups = cast
        cast = (
            character
            for role in ("main", "primary", "side", "appears")
            if isinstance(group := groups.get(role), list)
            for character in group
        )
    elif not isinstance(cast, list):
        return ""
    fields = {
        "name": 120,
        "name_original": 120,
        "role": 30,
        "gender": 30,
        "sex": 30,
        "age": 30,
        "pronouns": 80,
        "description": 480,
    }
    entries = []
    size = 2
    for character in cast:
        if not isinstance(character, dict):
            continue
        entry = {
            key: value.strip()[:limit]
            for key, limit in fields.items()
            if isinstance(value := character.get(key), str) and value.strip()
        }
        if not ("name" in entry or "name_original" in entry):
            continue
        if type(character.get("age")) in (int, float):
            entry["age"] = character["age"]
        for key, limit in (("aliases", 5), ("personality", 8)):
            values = character.get(key)
            if not isinstance(values, list):
                continue
            names = (value.get("name") if isinstance(value, dict) else value for value in values)
            labels = list(islice((name[:80] for name in names if isinstance(name, str)), limit))
            if labels:
                entry[key] = labels
        encoded = json.dumps(entry, ensure_ascii=False, separators=(",", ":"))
        size += len(encoded.encode("utf-8")) + bool(entries)
        if size > 16 * 1024:
            break
        entries.append(encoded)
    return "[" + ",".join(entries) + "]" if entries else ""


class CharacterSummaryService:
    def __init__(self, logger):
        self.logger = logger

    def generate_from_vndb(self, character_data: dict, ai_service) -> Optional[str]:
        if not character_data:
            return None

        character_json = _compact_character_cast(character_data)
        if not character_json:
            return None
        prompt = CHARACTER_SUMMARY_PROMPT.format(character_json=character_json)
        try:
            result = ai_service.generate_raw_prompt(prompt, request_kind="character_summary")
            if is_successful_translation(result):
                return result.strip()
        except Exception as e:
            self.logger.error(f"Failed to generate character summary: {e}")
        return None
