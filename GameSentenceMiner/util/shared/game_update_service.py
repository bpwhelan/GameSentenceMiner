"""
GameUpdateService - Shared logic for game database updates.

This service provides common functionality for updating game records from various sources
(Jiten, VNDB, AniList), ensuring consistent behavior across API routes and cron jobs.

Extracted from jiten_upgrader.py and jiten_database_api.py to eliminate code duplication.
"""

import json
from typing import Dict, List, Optional


class GameUpdateService:
    """Service for common game database update operations."""

    @staticmethod
    def build_update_fields(game_data: Dict, manual_overrides: Optional[List[str]] = None, source: str = 'jiten') -> Dict:
        """
        Build update fields dictionary from game data, respecting manual overrides.
        
        This method handles data from multiple sources (Jiten, VNDB, AniList) and
        constructs an update dictionary that respects any manually overridden fields.
        
        Args:
            game_data: Normalized game data from API client (Jiten, VNDB, or AniList)
            manual_overrides: List of field names that should not be updated (default: empty list)
            source: Data source - 'jiten', 'vndb', or 'anilist' (default: 'jiten')
            
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
        if source == 'jiten' and 'deck_id' not in manual_overrides and game_data.get('deck_id'):
            update_fields['deck_id'] = game_data['deck_id']
        
        # Title Original (Japanese)
        if 'title_original' not in manual_overrides and game_data.get('title_original'):
            update_fields['title_original'] = game_data['title_original']
        
        # Title Romaji
        if 'title_romaji' not in manual_overrides and game_data.get('title_romaji'):
            update_fields['title_romaji'] = game_data['title_romaji']
        
        # Title English
        if 'title_english' not in manual_overrides and game_data.get('title_english'):
            update_fields['title_english'] = game_data['title_english']
        
        # Media Type / Game Type
        if 'type' not in manual_overrides and game_data.get('media_type_string'):
            update_fields['game_type'] = game_data['media_type_string']
        
        # Description
        if 'description' not in manual_overrides and game_data.get('description'):
            update_fields['description'] = game_data['description']
        
        # Release Date
        if 'release_date' not in manual_overrides and game_data.get('release_date'):
            update_fields['release_date'] = game_data['release_date']
        
        # Links
        if 'links' not in manual_overrides and game_data.get('links'):
            update_fields['links'] = game_data['links']
        
        # === JITEN-SPECIFIC FIELDS ===
        if source == 'jiten':
            # Difficulty (Jiten only)
            if 'difficulty' not in manual_overrides and game_data.get('difficulty') is not None:
                update_fields['difficulty'] = game_data['difficulty']
            
            # Character Count (Jiten's total character count)
            if 'character_count' not in manual_overrides and game_data.get('character_count') is not None:
                update_fields['character_count'] = game_data['character_count']
            
            # Genres (Jiten only)
            if 'genres' not in manual_overrides and game_data.get('genres'):
                update_fields['genres'] = game_data['genres']
            
            # Tags (Jiten only)
            if 'tags' not in manual_overrides and game_data.get('tags'):
                update_fields['tags'] = game_data['tags']
        
        return update_fields

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
            link_url = link if isinstance(link, str) else (link.get('url') if isinstance(link, dict) else '')
            if 'jiten.moe/deck' in link_url:
                jiten_link_index = i
                break
        
        # Create Jiten link object with proper structure
        jiten_link = {
            'url': jiten_url,
            'linkType': 99,  # Jiten.moe link type
            'deckId': deck_id
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
        if vndb_id and not vndb_id.startswith('v'):
            vndb_id = f'v{vndb_id}'
        
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
            link_url = link if isinstance(link, str) else (link.get('url') if isinstance(link, dict) else '')
            if 'vndb.org' in link_url:
                vndb_link_index = i
                break
        
        # Create VNDB link object
        vndb_link = {
            'url': vndb_url,
            'linkType': 1,  # VNDB link type
            'vndbId': vndb_id
        }
        
        if vndb_link_index is not None:
            game.links[vndb_link_index] = vndb_link
        else:
            game.links.append(vndb_link)

    @staticmethod
    def add_anilist_link_to_game(game, anilist_id: int, media_type: str = 'ANIME') -> None:
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
        if media_type.upper() == 'MANGA':
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
            link_url = link if isinstance(link, str) else (link.get('url') if isinstance(link, dict) else '')
            if 'anilist.co' in link_url:
                anilist_link_index = i
                break
        
        # Create AniList link object
        anilist_link = {
            'url': anilist_url,
            'linkType': 2,  # AniList link type
            'anilistId': anilist_id,
            'mediaType': media_type
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
        manual_overrides: Optional[List[str]] = None
    ) -> Dict:
        """
        Merge update fields from multiple data sources with priority: Jiten > VNDB > AniList.
        
        This is useful for the repull endpoint where data may come from multiple sources.
        
        Args:
            jiten_data: Normalized Jiten data (highest priority)
            vndb_data: Normalized VNDB data (medium priority)
            anilist_data: Normalized AniList data (lowest priority)
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
            'deck_id': (jiten_data, 'deck_id'),
            'title_original': [(jiten_data, 'title_original'), (vndb_data, 'title_original'), (anilist_data, 'title_original')],
            'title_romaji': [(jiten_data, 'title_romaji'), (vndb_data, 'title_romaji'), (anilist_data, 'title_romaji')],
            'title_english': [(jiten_data, 'title_english'), (anilist_data, 'title_english')],
            'description': [(jiten_data, 'description'), (vndb_data, 'description'), (anilist_data, 'description')],
            'release_date': [(jiten_data, 'release_date'), (vndb_data, 'release_date'), (anilist_data, 'release_date')],
        }
        
        # Jiten-specific fields
        if jiten_data:
            if 'difficulty' not in manual_overrides and jiten_data.get('difficulty') is not None:
                update_fields['difficulty'] = jiten_data['difficulty']
            if 'character_count' not in manual_overrides and jiten_data.get('character_count') is not None:
                update_fields['character_count'] = jiten_data['character_count']
            if 'genres' not in manual_overrides and jiten_data.get('genres'):
                update_fields['genres'] = jiten_data['genres']
            if 'tags' not in manual_overrides and jiten_data.get('tags'):
                update_fields['tags'] = jiten_data['tags']
            if 'links' not in manual_overrides and jiten_data.get('links'):
                update_fields['links'] = jiten_data['links']
        
        # Process common fields with priority
        for field_name, sources in field_sources.items():
            if field_name in manual_overrides:
                continue
            
            # Special handling for deck_id (Jiten-only, single source)
            if field_name == 'deck_id':
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
        if 'type' not in manual_overrides:
            if jiten_data and jiten_data.get('media_type_string'):
                update_fields['game_type'] = jiten_data['media_type_string']
            elif vndb_data:
                update_fields['game_type'] = 'Visual Novel'
            elif anilist_data and anilist_data.get('media_type'):
                update_fields['game_type'] = anilist_data['media_type']
        
        return update_fields
