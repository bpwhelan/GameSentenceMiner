from __future__ import annotations

import json
from typing import Optional

from GameSentenceMiner.ai.prompts.templates import CHARACTER_SUMMARY_PROMPT


class CharacterSummaryService:
    def __init__(self, logger):
        self.logger = logger

    def generate_from_vndb(self, character_data: dict, ai_service) -> Optional[str]:
        if not character_data:
            return None

        character_json = json.dumps(character_data, ensure_ascii=False, indent=2)
        prompt = CHARACTER_SUMMARY_PROMPT.format(character_json=character_json)
        try:
            result = ai_service.generate_raw_prompt(prompt, request_kind="character_summary")
            if result:
                return result.strip()
        except Exception as e:
            self.logger.error(f"Failed to generate character summary: {e}")
        return None
