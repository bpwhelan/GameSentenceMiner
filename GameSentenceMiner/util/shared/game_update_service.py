"""
GameUpdateService - Shared logic for game database updates.

This service provides common functionality for updating game records from various sources
(Jiten, VNDB, AniList, IGDB), ensuring consistent behavior across API routes and cron jobs.

Extracted from jiten_upgrader.py and jiten_database_api.py to eliminate code duplication.
"""

import json
from typing import Any, Dict, List, Optional

from GameSentenceMiner.util.config.configuration import logger


class GameUpdateService:
    """Service for common game database update operations."""

    _FIELD_TO_ATTR = {
        "deck_id": "deck_id",
        "title_original": "title_original",
        "title_romaji": "title_romaji",
        "title_english": "title_english",
        "type": "type",
        "description": "description",
        "image": "image",
        "character_count": "character_count",
        "difficulty": "difficulty",
        "links": "links",
        "completed": "completed",
        "release_date": "release_date",
        "manual_overrides": "manual_overrides",
        "obs_scene_name": "obs_scene_name",
        "genres": "genres",
        "tags": "tags",
        "vndb_character_data": "vndb_character_data",
        "character_summary": "character_summary",
        "vndb_id": "vndb_id",
        "anilist_id": "anilist_id",
    }

    @staticmethod
    def build_update_fields(
        game_data: Dict,
        manual_overrides: Optional[List[str]] = None,
        source: str = "jiten",
    ) -> Dict:
        """
        Build update fields dictionary from game data, respecting manual overrides.

        This method handles data from multiple sources (Jiten, VNDB, AniList, IGDB) and
        constructs an update dictionary that respects any manually overridden fields.

        Args:
            game_data: Normalized game data from API client (Jiten, VNDB, AniList, or IGDB)
            manual_overrides: List of field names that should not be updated (default: empty list)
            source: Data source - 'jiten', 'vndb', 'anilist', or 'igdb' (default: 'jiten')

        Returns:
            Dictionary of fields to update (keys are field names, values are new values)

        Example:
            >>> jiten_data = JitenApiClient.normalize_deck_data(deck)
            >>> update_fields = GameUpdateService.build_update_fields(
            ...     jiten_data,
            ...     manual_overrides=['title_original', 'image'],
            ...     source='jiten'
            ... )
            >>> game.update_all_fields_from_jiten(**update_fields)
        """
        update_fields = {}
        manual_overrides = manual_overrides if manual_overrides is not None else []

        # Ensure manual_overrides is a list
        if not isinstance(manual_overrides, list):
            manual_overrides = []

        # === COMMON FIELDS (All sources) ===

        # Deck ID (Jiten only)
        if source == "jiten" and "deck_id" not in manual_overrides and game_data.get("deck_id"):
            update_fields["deck_id"] = game_data["deck_id"]

        # Title Original (Japanese)
        if "title_original" not in manual_overrides and game_data.get("title_original"):
            update_fields["title_original"] = game_data["title_original"]

        # Title Romaji
        if "title_romaji" not in manual_overrides and game_data.get("title_romaji"):
            update_fields["title_romaji"] = game_data["title_romaji"]

        # Title English
        if "title_english" not in manual_overrides and game_data.get("title_english"):
            update_fields["title_english"] = game_data["title_english"]

        # Media Type / Game Type
        if "type" not in manual_overrides and game_data.get("media_type_string"):
            update_fields["game_type"] = game_data["media_type_string"]

        # Description
        if "description" not in manual_overrides and game_data.get("description"):
            update_fields["description"] = game_data["description"]

        # Release Date
        if "release_date" not in manual_overrides and game_data.get("release_date"):
            update_fields["release_date"] = game_data["release_date"]

        # Links
        if "links" not in manual_overrides and game_data.get("links"):
            update_fields["links"] = game_data["links"]

        # Genres
        if "genres" not in manual_overrides and game_data.get("genres"):
            update_fields["genres"] = game_data["genres"]

        # Tags
        if "tags" not in manual_overrides and game_data.get("tags"):
            update_fields["tags"] = game_data["tags"]

        # === JITEN-SPECIFIC FIELDS ===
        if source == "jiten":
            # Difficulty (Jiten only)
            if "difficulty" not in manual_overrides and game_data.get("difficulty") is not None:
                update_fields["difficulty"] = game_data["difficulty"]

            # Character Count (Jiten's total character count)
            if "character_count" not in manual_overrides and game_data.get("character_count") is not None:
                update_fields["character_count"] = game_data["character_count"]

        return update_fields

    @staticmethod
    def normalize_links(links) -> List[Dict]:
        """Normalize a stored links value into a list of link dictionaries."""
        if isinstance(links, str):
            try:
                links = json.loads(links)
            except (json.JSONDecodeError, TypeError):
                return []
        if not isinstance(links, list):
            return []

        normalized = []
        for link in links:
            if isinstance(link, dict) and link.get("url"):
                normalized.append(link)
            elif isinstance(link, str) and link:
                normalized.append({"url": link, "linkType": 1})
        return normalized

    @classmethod
    def _is_field_value_effectively_empty(cls, field_name: str, value: Any) -> bool:
        """Return True when a stored field value is effectively empty/default."""
        if field_name == "links":
            return len(cls.normalize_links(value)) == 0

        if field_name in {"genres", "tags", "manual_overrides"}:
            return not isinstance(value, list) or len(value) == 0

        if field_name == "completed":
            return value in (None, False, 0, "")

        if field_name in {"deck_id", "difficulty"}:
            return value in (None, "")

        if field_name == "character_count":
            return value in (None, "", 0)

        if value is None:
            return True

        if isinstance(value, str):
            return value.strip() == ""

        return not bool(value)

    @classmethod
    def is_game_linked(cls, game) -> bool:
        """Return True if the game is linked to any supported external metadata source."""
        from GameSentenceMiner.util.clients.igdb_api_client import IGDBApiClient

        return bool(
            getattr(game, "deck_id", None)
            or getattr(game, "vndb_id", "")
            or getattr(game, "anilist_id", "")
            or IGDBApiClient.extract_igdb_url(getattr(game, "links", []))
        )

    @classmethod
    def get_manual_overrides_for_initial_link(cls, game) -> List[str]:
        """
        Relax manual overrides for blank fields when linking a currently-unlinked game.

        This lets the first real metadata import populate empty placeholders while still
        preserving meaningful user-entered data.
        """
        manual_overrides = getattr(game, "manual_overrides", [])
        if not isinstance(manual_overrides, list):
            manual_overrides = []

        if cls.is_game_linked(game):
            return manual_overrides

        effective_overrides = []
        relaxed_overrides = []

        for field_name in manual_overrides:
            attr_name = cls._FIELD_TO_ATTR.get(field_name, field_name)
            value = getattr(game, attr_name, None)
            if cls._is_field_value_effectively_empty(field_name, value):
                relaxed_overrides.append(field_name)
            else:
                effective_overrides.append(field_name)

        if relaxed_overrides:
            logger.info(
                f"Relaxing empty manual overrides for initial link on game {getattr(game, 'id', 'unknown')}: "
                f"{relaxed_overrides}"
            )

        return effective_overrides

    @classmethod
    def merge_links(cls, *link_groups) -> List[Dict]:
        """Merge link lists while preserving order and deduplicating by URL."""
        merged = []
        seen_urls = set()

        for links in link_groups:
            for link in cls.normalize_links(links):
                url = str(link.get("url", "")).strip()
                if not url:
                    continue
                url_key = url.lower()
                if url_key in seen_urls:
                    continue
                merged.append(link)
                seen_urls.add(url_key)

        return merged

    @staticmethod
    def add_jiten_link_to_game(game, deck_id: int) -> None:
        """
        Add or update Jiten.moe link in game's links list.

        This ensures there's only one Jiten link and it's up to date.
        Modifies the game object in-place (does not save to database).

        Args:
            game: GamesTable object to update
            deck_id: Jiten deck ID to link to

        Example:
            >>> GameUpdateService.add_jiten_link_to_game(game, deck_id=1234)
            >>> game.save()
        """
        jiten_url = f"https://jiten.moe/decks/media/{deck_id}/detail"

        # Ensure game.links is a list (handle cases where it might be a string or None)
        if not isinstance(game.links, list):
            if isinstance(game.links, str):
                try:
                    game.links = json.loads(game.links)
                except (json.JSONDecodeError, TypeError):
                    game.links = []
            else:
                game.links = []

        # Check if a Jiten link already exists
        jiten_link_index = None
        for i, link in enumerate(game.links):
            # Handle both string and object formats for backward compatibility
            link_url = link if isinstance(link, str) else (link.get("url") if isinstance(link, dict) else "")
            if "jiten.moe/deck" in link_url:
                jiten_link_index = i
                break

        # Create Jiten link object with proper structure
        jiten_link = {
            "url": jiten_url,
            "linkType": 99,  # Jiten.moe link type
            "deckId": deck_id,
        }

        if jiten_link_index is not None:
            # Update existing Jiten link
            game.links[jiten_link_index] = jiten_link
        else:
            # Add new Jiten link
            game.links.append(jiten_link)

    @staticmethod
    def add_vndb_link_to_game(game, vndb_id: str) -> None:
        """
        Add or update VNDB link in game's links list.

        This ensures there's only one VNDB link and it's up to date.
        Modifies the game object in-place (does not save to database).

        Args:
            game: GamesTable object to update
            vndb_id: VNDB ID (e.g., 'v1234')

        Example:
            >>> GameUpdateService.add_vndb_link_to_game(game, vndb_id='v1234')
            >>> game.save()
        """
        # Ensure vndb_id has 'v' prefix
        if vndb_id and not vndb_id.startswith("v"):
            vndb_id = f"v{vndb_id}"

        vndb_url = f"https://vndb.org/{vndb_id}"

        # Ensure game.links is a list
        if not isinstance(game.links, list):
            if isinstance(game.links, str):
                try:
                    game.links = json.loads(game.links)
                except (json.JSONDecodeError, TypeError):
                    game.links = []
            else:
                game.links = []

        # Check if a VNDB link already exists
        vndb_link_index = None
        for i, link in enumerate(game.links):
            link_url = link if isinstance(link, str) else (link.get("url") if isinstance(link, dict) else "")
            if "vndb.org" in link_url:
                vndb_link_index = i
                break

        # Create VNDB link object
        vndb_link = {
            "url": vndb_url,
            "linkType": 1,  # VNDB link type
            "vndbId": vndb_id,
        }

        if vndb_link_index is not None:
            game.links[vndb_link_index] = vndb_link
        else:
            game.links.append(vndb_link)

    @staticmethod
    def add_anilist_link_to_game(game, anilist_id: int, media_type: str = "ANIME") -> None:
        """
        Add or update AniList link in game's links list.

        This ensures there's only one AniList link and it's up to date.
        Modifies the game object in-place (does not save to database).

        Args:
            game: GamesTable object to update
            anilist_id: AniList media ID (integer)
            media_type: 'ANIME' or 'MANGA' (default: 'ANIME')

        Example:
            >>> GameUpdateService.add_anilist_link_to_game(game, anilist_id=12345, media_type='ANIME')
            >>> game.save()
        """
        # Determine URL based on media type
        if media_type.upper() == "MANGA":
            anilist_url = f"https://anilist.co/manga/{anilist_id}"
        else:
            anilist_url = f"https://anilist.co/anime/{anilist_id}"

        # Ensure game.links is a list
        if not isinstance(game.links, list):
            if isinstance(game.links, str):
                try:
                    game.links = json.loads(game.links)
                except (json.JSONDecodeError, TypeError):
                    game.links = []
            else:
                game.links = []

        # Check if an AniList link already exists
        anilist_link_index = None
        for i, link in enumerate(game.links):
            link_url = link if isinstance(link, str) else (link.get("url") if isinstance(link, dict) else "")
            if "anilist.co" in link_url:
                anilist_link_index = i
                break

        # Create AniList link object
        anilist_link = {
            "url": anilist_url,
            "linkType": 2,  # AniList link type
            "anilistId": anilist_id,
            "mediaType": media_type,
        }

        if anilist_link_index is not None:
            game.links[anilist_link_index] = anilist_link
        else:
            game.links.append(anilist_link)

    @staticmethod
    def merge_update_fields_from_multiple_sources(
        jiten_data: Optional[Dict] = None,
        vndb_data: Optional[Dict] = None,
        anilist_data: Optional[Dict] = None,
        igdb_data: Optional[Dict] = None,
        manual_overrides: Optional[List[str]] = None,
    ) -> Dict:
        """
        Merge update fields from multiple data sources with priority:
        Jiten > VNDB > IGDB > AniList.

        This is useful for the repull endpoint where data may come from multiple sources.

        Args:
            jiten_data: Normalized Jiten data (highest priority)
            vndb_data: Normalized VNDB data (medium priority)
            anilist_data: Normalized AniList data (lowest priority)
            igdb_data: Normalized IGDB data
            manual_overrides: List of fields that should not be updated

        Returns:
            Dictionary of merged update fields

        Example:
            >>> update_fields = GameUpdateService.merge_update_fields_from_multiple_sources(
            ...     jiten_data=jiten_data,
            ...     vndb_data=vndb_data,
            ...     manual_overrides=game.manual_overrides
            ... )
            >>> game.update_all_fields_from_jiten(**update_fields)
        """
        update_fields = {}
        manual_overrides = manual_overrides if manual_overrides is not None else []

        # Ensure manual_overrides is a list
        if not isinstance(manual_overrides, list):
            manual_overrides = []

        # Define field priority map: field_name -> [jiten_key, vndb_key, anilist_key]
        field_sources = {
            "deck_id": (jiten_data, "deck_id"),
            "title_original": [
                (jiten_data, "title_original"),
                (vndb_data, "title_original"),
                (igdb_data, "title_original"),
                (anilist_data, "title_original"),
            ],
            "title_romaji": [
                (jiten_data, "title_romaji"),
                (vndb_data, "title_romaji"),
                (igdb_data, "title_romaji"),
                (anilist_data, "title_romaji"),
            ],
            "title_english": [
                (jiten_data, "title_english"),
                (igdb_data, "title_english"),
                (anilist_data, "title_english"),
            ],
            "description": [
                (jiten_data, "description"),
                (vndb_data, "description"),
                (igdb_data, "description"),
                (anilist_data, "description"),
            ],
            "release_date": [
                (jiten_data, "release_date"),
                (vndb_data, "release_date"),
                (igdb_data, "release_date"),
                (anilist_data, "release_date"),
            ],
        }

        # Source-specific and list fields
        if jiten_data:
            if "difficulty" not in manual_overrides and jiten_data.get("difficulty") is not None:
                update_fields["difficulty"] = jiten_data["difficulty"]
            if "character_count" not in manual_overrides and jiten_data.get("character_count") is not None:
                update_fields["character_count"] = jiten_data["character_count"]

        if "genres" not in manual_overrides:
            for source_data in [jiten_data, vndb_data, igdb_data, anilist_data]:
                if source_data and source_data.get("genres"):
                    update_fields["genres"] = source_data["genres"]
                    break

        if "tags" not in manual_overrides:
            for source_data in [jiten_data, vndb_data, igdb_data, anilist_data]:
                if source_data and source_data.get("tags"):
                    update_fields["tags"] = source_data["tags"]
                    break

        if "links" not in manual_overrides:
            merged_links = GameUpdateService.merge_links(
                jiten_data.get("links") if jiten_data else None,
                vndb_data.get("links") if vndb_data else None,
                igdb_data.get("links") if igdb_data else None,
                anilist_data.get("links") if anilist_data else None,
            )
            if merged_links:
                update_fields["links"] = merged_links

        # Process common fields with priority
        for field_name, sources in field_sources.items():
            if field_name in manual_overrides:
                continue

            # Special handling for deck_id (Jiten-only, single source)
            if field_name == "deck_id":
                source_data, key = sources
                if source_data and source_data.get(key):
                    update_fields[field_name] = source_data[key]
                continue

            # Check sources in priority order
            for source_data, key in sources:
                if source_data and source_data.get(key):
                    update_fields[field_name] = source_data[key]
                    break

        # Media type with special handling
        if "type" not in manual_overrides:
            if jiten_data and jiten_data.get("media_type_string"):
                update_fields["game_type"] = jiten_data["media_type_string"]
            elif vndb_data:
                update_fields["game_type"] = "Visual Novel"
            elif igdb_data and igdb_data.get("media_type_string"):
                update_fields["game_type"] = igdb_data["media_type_string"]
            elif anilist_data and anilist_data.get("media_type"):
                update_fields["game_type"] = anilist_data["media_type"]

        return update_fields
