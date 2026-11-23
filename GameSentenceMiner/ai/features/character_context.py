from __future__ import annotations

import json

from GameSentenceMiner.ai.features.character_filter import CharacterContext
from GameSentenceMiner.ai.translation_cache import is_successful_translation


class CharacterContextProvider:
    def __init__(self, summary_service, logger):
        self.summary_service = summary_service
        self.logger = logger

    def get_character_context(self, game_title: str, ai_service) -> CharacterContext:
        if not game_title:
            return CharacterContext("")

        try:
            from GameSentenceMiner.util.database.games_table import GamesTable

            game = GamesTable.get_by_obs_scene_name(game_title)
            if not game:
                game = GamesTable.get_by_title(game_title)

            if not game:
                return CharacterContext("")

            self.logger.debug(f"Found game '{game.title_original}' (id={game.id}) for scene '{game_title}'")
            data = game.vndb_character_data
            if isinstance(data, str):
                try:
                    data = json.loads(data)
                except json.JSONDecodeError:
                    data = None
            if is_successful_translation(game.character_summary):
                return CharacterContext.from_metadata(game.character_summary, data)

            if ai_service.config_snapshot.ai.auto_generate_character_summary and data:
                try:
                    summary = self.summary_service.generate_from_vndb(data, ai_service)
                    if summary:
                        GamesTable._db.execute(
                            "UPDATE games SET character_summary = ? WHERE id = ? AND character_summary IS ?",
                            (summary, game.id, game.character_summary),
                            commit=True,
                        )
                        self.logger.info(f"Generated and stored character summary for {game_title}")
                        return CharacterContext.from_metadata(summary, data)
                except Exception as e:
                    self.logger.error(f"Failed to generate character summary for {game_title}: {e}")
        except Exception as e:
            self.logger.error(f"Error fetching character context: {e}")

        return CharacterContext("")
