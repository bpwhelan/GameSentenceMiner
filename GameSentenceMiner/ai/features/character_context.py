from __future__ import annotations

import json


class CharacterContextProvider:
    def __init__(self, summary_service, logger):
        self.summary_service = summary_service
        self.logger = logger

    def get_character_context(self, game_title: str, ai_service) -> str:
        if not game_title:
            return ""

        try:
            from GameSentenceMiner.util.database.games_table import GamesTable

            game = GamesTable.get_by_obs_scene_name(game_title)
            if not game:
                game = GamesTable.get_by_title(game_title)

            if not game:
                return ""

            self.logger.debug(
                f"Found game '{game.title_original}' (id={game.id}) for scene '{game_title}'"
            )
            if game.character_summary:
                return game.character_summary

            if game.vndb_character_data:
                try:
                    if isinstance(game.vndb_character_data, dict):
                        vndb_data = game.vndb_character_data
                    else:
                        vndb_data = json.loads(game.vndb_character_data)
                    summary = self.summary_service.generate_from_vndb(vndb_data, ai_service)
                    if summary:
                        game.character_summary = summary
                        game.save()
                        self.logger.info(f"Generated and stored character summary for {game_title}")
                        return summary
                except json.JSONDecodeError:
                    self.logger.warning(f"Failed to parse VNDB data for {game_title}")
                except Exception as e:
                    self.logger.error(f"Failed to generate character summary for {game_title}: {e}")
        except Exception as e:
            self.logger.error(f"Error fetching character context: {e}")

        return ""
