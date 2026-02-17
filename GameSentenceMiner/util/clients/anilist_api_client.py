"""
AniList API Client

Fetch character information from AniList for Anime and Manga media types.
Mirrors the vndb_api_client.py pattern for consistency.
"""

import re
import requests
from typing import Optional, Dict, List

from GameSentenceMiner.util.config.configuration import logger
from GameSentenceMiner.util.shared.base_api_client import BaseApiClient
from GameSentenceMiner.util.shared.image_utils import (
    download_cover_image as _download_cover_image,
    fetch_image_as_base64 as _fetch_image_as_base64,
)
from GameSentenceMiner.util.shared.spoiler_utils import (
    has_anilist_spoiler_tags,
    strip_anilist_spoiler_tags,
)


class AniListApiClient(BaseApiClient):
    """
    Client for AniList GraphQL API interactions.

    Provides methods for:
    - Fetching all characters for an Anime/Manga with automatic pagination
    - Formatting character data for translation context
    - Creating compact text summaries for AI prompts
    
    Role mappings:
    - AniList MAIN → "main" (protagonist)
    - AniList SUPPORTING → "primary" (main characters)
    - AniList BACKGROUND → "side" (side characters)
    """

    API_URL = "https://graphql.anilist.co"
    TIMEOUT = 15
    DEFAULT_PER_PAGE = 25  # AniList default page size for characters

    # Thumbnail size for character images (same as VNDB)
    THUMBNAIL_SIZE = (80, 100)
    
    # Cover image size (larger for game covers)
    COVER_IMAGE_SIZE = (300, 400)

    # Role mapping from AniList to VNDB-compatible format
    ROLE_MAP = {
        "MAIN": "main",        # Protagonist
        "SUPPORTING": "primary",  # Main characters
        "BACKGROUND": "side",     # Side characters
    }

    # Implementation of abstract methods from BaseApiClient
    @classmethod
    def search_game(cls, query: str, **kwargs) -> Optional[Dict]:
        """
        Search for games/media by title.
        
        This is an implementation of the BaseApiClient abstract method.
        Delegates to search_media() for backward compatibility.
        
        Args:
            query: Search query string
            **kwargs: Additional parameters (e.g., media_type)
            
        Returns:
            Dictionary with search results, or None if request fails
        """
        media_type = kwargs.get('media_type', 'ANIME')
        return cls.search_media(query, media_type)
    
    @classmethod
    def get_game_details(cls, game_id: str, **kwargs) -> Optional[Dict]:
        """
        Fetch detailed metadata for a specific game/media.
        
        This is an implementation of the BaseApiClient abstract method.
        Delegates to fetch_media_metadata() for backward compatibility.
        
        Args:
            game_id: Game/media identifier (AniList ID as string)
            **kwargs: Additional parameters (e.g., media_type)
            
        Returns:
            Dictionary with game metadata, or None if request fails
        """
        media_type = kwargs.get('media_type', 'ANIME')
        return cls.fetch_media_metadata(int(game_id), media_type)
    
    @classmethod
    def get_characters(cls, game_id: str, **kwargs) -> Optional[List[Dict]]:
        """
        Fetch all characters for a specific game/media.
        
        This is an implementation of the BaseApiClient abstract method.
        Delegates to fetch_characters() for backward compatibility.
        
        Args:
            game_id: Game/media identifier (AniList ID as string)
            **kwargs: Additional parameters (e.g., media_type)
            
        Returns:
            List of character dictionaries, or None if request fails
        """
        media_type = kwargs.get('media_type', 'ANIME')
        return cls.fetch_characters(int(game_id), media_type)

    # GraphQL query for searching media
    SEARCH_QUERY = """
    query ($search: String!, $type: MediaType) {
        Page(page: 1, perPage: 10) {
            media(search: $search, type: $type) {
                id
                idMal
                title {
                    romaji
                    english
                    native
                }
                description(asHtml: false)
                coverImage {
                    large
                    medium
                }
                format
                status
                averageScore
                siteUrl
            }
        }
    }
    """

    # GraphQL query for fetching characters
    CHARACTERS_QUERY = """
    query ($id: Int!, $type: MediaType, $page: Int, $perPage: Int) {
        Media(id: $id, type: $type) {
            id
            title {
                romaji
                english
                native
            }
            characters(page: $page, perPage: $perPage, sort: [ROLE, RELEVANCE, ID]) {
                pageInfo {
                    total
                    currentPage
                    lastPage
                    hasNextPage
                    perPage
                }
                edges {
                    role
                    node {
                        id
                        name {
                            first
                            last
                            full
                            native
                            alternative
                        }
                        image {
                            large
                            medium
                        }
                        description
                        gender
                        age
                    }
                }
            }
        }
    }
    """

    # GraphQL query for fetching media by ID (for cover image and metadata)
    MEDIA_BY_ID_QUERY = """
    query ($id: Int!, $type: MediaType) {
        Media(id: $id, type: $type) {
            id
            title {
                romaji
                english
                native
            }
            description(asHtml: false)
            coverImage {
                extraLarge
                large
                medium
            }
            format
            status
            averageScore
            siteUrl
            startDate {
                year
                month
                day
            }
            genres
            tags {
                name
                rank
                isMediaSpoiler
            }
        }
    }
    """

    @classmethod
    def download_cover_image(
        cls,
        media_id: int,
        media_type: str = "ANIME"
    ) -> Optional[str]:
        """
        Download the cover image for an anime or manga from AniList.
        
        Uses shared image utilities for consistent image processing.
        
        Args:
            media_id: AniList media ID
            media_type: "ANIME" or "MANGA"
            
        Returns:
            Base64-encoded PNG image string with data URI prefix, or None on failure
        """
        try:
            # First, fetch media info to get the cover image URL
            variables = {
                "id": media_id,
                "type": media_type.upper()
            }
            
            response = requests.post(
                cls.API_URL,
                headers={
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                },
                json={
                    "query": cls.MEDIA_BY_ID_QUERY,
                    "variables": variables
                },
                timeout=cls.TIMEOUT
            )
            
            if response.status_code != 200:
                logger.debug(f"AniList API returned status {response.status_code} for cover fetch")
                return None
            
            data = response.json()
            
            if "errors" in data:
                logger.debug(f"AniList API returned errors: {data['errors']}")
                return None
            
            media_data = data.get("data", {}).get("Media")
            if not media_data:
                logger.debug(f"No media data returned for {media_type} ID {media_id}")
                return None
            
            cover_info = media_data.get("coverImage", {})
            
            # Try extraLarge first, then large, then medium
            image_url = cover_info.get("extraLarge") or cover_info.get("large") or cover_info.get("medium")
            
            if not image_url:
                logger.debug(f"No cover image URL for {media_type} {media_id}")
                return None
            
            # Use shared utility for image download and processing
            result = _download_cover_image(
                image_url=image_url,
                cover_size=cls.COVER_IMAGE_SIZE,
                timeout=cls.TIMEOUT
            )
            if result:
                logger.info(f"Successfully downloaded AniList cover image for {media_type} {media_id}")
            return result
            
        except requests.RequestException as e:
            logger.debug(f"Failed to fetch AniList cover image for {media_type} {media_id}: {e}")
            return None
        except Exception as e:
            logger.debug(f"Unexpected error downloading AniList cover: {e}")
            return None

    @classmethod
    def fetch_media_metadata(
        cls,
        media_id: int,
        media_type: str = "ANIME"
    ) -> Optional[Dict]:
        """
        Fetch full metadata for an anime or manga from AniList.
        
        Args:
            media_id: AniList media ID
            media_type: "ANIME" or "MANGA"
            
        Returns:
            Dictionary with media metadata, or None on failure
        """
        try:
            variables = {
                "id": media_id,
                "type": media_type.upper()
            }
            
            response = requests.post(
                cls.API_URL,
                headers={
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                },
                json={
                    "query": cls.MEDIA_BY_ID_QUERY,
                    "variables": variables
                },
                timeout=cls.TIMEOUT
            )
            
            if response.status_code != 200:
                logger.debug(f"AniList API returned status {response.status_code} for metadata fetch")
                return None
            
            data = response.json()
            
            if "errors" in data:
                logger.debug(f"AniList API returned errors: {data['errors']}")
                return None
            
            media_data = data.get("data", {}).get("Media")
            if not media_data:
                logger.debug(f"No media data returned for {media_type} ID {media_id}")
                return None
            
            title_info = media_data.get("title", {})
            cover_info = media_data.get("coverImage", {})
            start_date = media_data.get("startDate", {})
            
            # Format release date
            release_date = None
            if start_date and start_date.get("year"):
                year = start_date.get("year")
                month = start_date.get("month", 1) or 1
                day = start_date.get("day", 1) or 1
                release_date = f"{year:04d}-{month:02d}-{day:02d}"
            
            # Clean description
            description = media_data.get("description", "") or ""
            description = re.sub(r'<[^>]+>', '', description)  # Remove HTML
            description = re.sub(r'~!.+?!~', '', description, flags=re.DOTALL)  # Remove spoilers
            
            # Extract genres (already a simple array of strings)
            genres = media_data.get("genres", []) or []
            
            # Extract tags, excluding spoiler tags
            tags_data = media_data.get("tags", []) or []
            tags = [
                tag.get("name", "")
                for tag in tags_data
                if tag.get("name") and not tag.get("isMediaSpoiler", False)
            ]
            
            return {
                "anilist_id": media_id,
                "title_romaji": title_info.get("romaji", ""),
                "title_original": title_info.get("native", ""),
                "title_english": title_info.get("english", ""),
                "description": description,
                "release_date": release_date,
                "score": media_data.get("averageScore"),
                "status": media_data.get("status"),
                "format": media_data.get("format"),
                "cover_url": cover_info.get("extraLarge") or cover_info.get("large") or cover_info.get("medium"),
                "site_url": media_data.get("siteUrl"),
                "media_type": media_type.capitalize(),  # "Anime" or "Manga"
                "genres": genres,  # List of genre strings
                "tags": tags       # List of tag names (spoilers excluded)
            }
            
        except requests.RequestException as e:
            logger.debug(f"Failed to fetch AniList metadata for {media_type} {media_id}: {e}")
            return None
        except Exception as e:
            logger.debug(f"Unexpected error fetching AniList metadata: {e}")
            return None

    @staticmethod
    def extract_media_id(url: str) -> Optional[int]:
        """
        Parse media ID from AniList URL.

        Args:
            url: AniList URL (e.g., "https://anilist.co/manga/149544")

        Returns:
            Media ID as integer, or None if not found
        """
        if not url:
            return None
        
        match = re.search(r"anilist\.co/(?:anime|manga)/(\d+)", url)
        if match:
            return int(match.group(1))
        return None

    @staticmethod
    def get_media_type(url: str) -> Optional[str]:
        """
        Extract media type (ANIME or MANGA) from AniList URL.

        Args:
            url: AniList URL (e.g., "https://anilist.co/manga/149544")

        Returns:
            "ANIME" or "MANGA", or None if not found
        """
        if not url:
            return None
        
        match = re.search(r"anilist\.co/(anime|manga)/\d+", url)
        if match:
            return match.group(1).upper()
        return None

    @classmethod
    def search_media(
        cls,
        query: str,
        media_type: str = "ANIME"
    ) -> Optional[Dict]:
        """
        Search AniList for anime or manga by title.
        
        Rate limit: 90 requests per minute.
        
        Args:
            query: Search query string
            media_type: "ANIME" or "MANGA" (default: "ANIME")
        
        Returns:
            Dictionary with search results from AniList API, or None if request fails.
            Response structure:
            {
                "data": {
                    "Page": {
                        "media": [
                            {
                                "id": 9253,
                                "idMal": 9253,
                                "title": {"romaji": "...", "english": "...", "native": "..."},
                                "description": "...",
                                "coverImage": {"large": "...", "medium": "..."},
                                "format": "TV",
                                "status": "FINISHED",
                                "averageScore": 88,
                                "siteUrl": "https://anilist.co/anime/9253"
                            },
                            ...
                        ]
                    }
                }
            }
        """
        try:
            variables = {
                "search": query,
                "type": media_type.upper()
            }
            
            logger.debug(f"Searching AniList for {media_type}: {query}")
            
            response = requests.post(
                cls.API_URL,
                headers={
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                },
                json={
                    "query": cls.SEARCH_QUERY,
                    "variables": variables
                },
                timeout=cls.TIMEOUT
            )
            
            if response.status_code != 200:
                logger.debug(f"AniList search API returned status {response.status_code}")
                return None
            
            data = response.json()
            
            # Check for GraphQL errors
            if "errors" in data:
                logger.debug(f"AniList search API returned errors: {data['errors']}")
                return None
            
            results = data.get("data", {}).get("Page", {}).get("media", [])
            logger.debug(f"AniList search returned {len(results)} results for '{query}'")
            
            return data
            
        except requests.RequestException as e:
            logger.debug(f"AniList search API request failed: {e}")
            return None
        except Exception as e:
            logger.debug(f"Unexpected error in AniList search: {e}")
            return None

    @classmethod
    def fetch_characters(
        cls,
        media_id: int,
        media_type: str,
        per_page: int = None
    ) -> Optional[List[Dict]]:
        """
        Fetch all characters for a given Anime/Manga from AniList API.
        Handles pagination automatically.

        Args:
            media_id: AniList media ID
            media_type: "ANIME" or "MANGA"
            per_page: Number of results per page (default: 25)

        Returns:
            List of character edge dictionaries (containing role and node), 
            or None if request fails
        """
        if per_page is None:
            per_page = cls.DEFAULT_PER_PAGE

        all_characters = []
        page = 1

        logger.debug(f"Fetching characters for AniList {media_type} ID {media_id}")

        while True:
            try:
                variables = {
                    "id": media_id,
                    "type": media_type,
                    "page": page,
                    "perPage": per_page
                }

                response = requests.post(
                    cls.API_URL,
                    headers={
                        "Content-Type": "application/json",
                        "Accept": "application/json",
                    },
                    json={
                        "query": cls.CHARACTERS_QUERY,
                        "variables": variables
                    },
                    timeout=cls.TIMEOUT
                )

                if response.status_code != 200:
                    logger.warning(
                        f"AniList API returned status {response.status_code} for {media_type} {media_id}"
                    )
                    return None

                data = response.json()
                
                # Check for GraphQL errors
                if "errors" in data:
                    logger.warning(f"AniList API returned errors: {data['errors']}")
                    return None

                media_data = data.get("data", {}).get("Media")
                if not media_data:
                    logger.warning(f"No media data returned for {media_type} {media_id}")
                    return None

                characters_data = media_data.get("characters", {})
                edges = characters_data.get("edges", [])
                page_info = characters_data.get("pageInfo", {})

                all_characters.extend(edges)

                logger.debug(
                    f"Fetched page {page} for {media_type} {media_id}: "
                    f"{len(edges)} characters"
                )

                if not page_info.get("hasNextPage", False):
                    break
                page += 1

            except requests.RequestException as e:
                logger.warning(f"AniList API request failed for {media_type} {media_id}: {e}")
                return None
            except Exception as e:
                logger.warning(f"Unexpected error fetching AniList characters: {e}")
                return None

        logger.info(f"Fetched {len(all_characters)} characters for {media_type} {media_id}")
        return all_characters

    @classmethod
    def fetch_image_as_base64(
        cls,
        image_url: str,
        thumbnail_size: tuple = None
    ) -> Optional[str]:
        """
        Download an image from URL, resize to thumbnail, and convert to base64 string.

        Uses shared image utilities for consistent image processing.

        Args:
            image_url: URL of the image to download
            thumbnail_size: Tuple of (width, height) for thumbnail. Defaults to (80, 100)

        Returns:
            Base64-encoded JPEG image string with data URI prefix, or None on failure
        """
        if thumbnail_size is None:
            thumbnail_size = cls.THUMBNAIL_SIZE
        
        return _fetch_image_as_base64(
            image_url=image_url,
            thumbnail_size=thumbnail_size,
            timeout=cls.TIMEOUT,
            output_format='JPEG',
            jpeg_quality=85
        )

    @staticmethod
    def strip_spoiler_tags(text: str) -> str:
        """
        Remove AniList spoiler tags from text.
        
        Uses shared spoiler utilities for consistent handling.
        
        Args:
            text: Text potentially containing spoiler tags
            
        Returns:
            Text with spoiler tags removed (content preserved)
        """
        return strip_anilist_spoiler_tags(text)

    @staticmethod
    def has_spoiler_tags(text: str) -> bool:
        """
        Check if text contains AniList spoiler tags.
        
        Uses shared spoiler utilities for consistent handling.
        
        Args:
            text: Text to check for spoiler tags
            
        Returns:
            True if text contains spoiler tags, False otherwise
        """
        return has_anilist_spoiler_tags(text)

    @classmethod
    def format_character_for_translation(
        cls,
        edge: Dict,
        max_spoiler: int = 0,
        preserve_spoiler_metadata: bool = False
    ) -> Optional[Dict]:
        """
        Format a character's data for use in translation context.

        Args:
            edge: Character edge dictionary from AniList API (contains role and node)
            max_spoiler: Maximum spoiler level (0=none, 1=minor, 2=major)
            preserve_spoiler_metadata: If True, preserves description even with spoiler tags

        Returns:
            Formatted character dictionary, or None if character should be filtered
        """
        role_raw = edge.get("role", "BACKGROUND")
        char = edge.get("node", {})
        
        if not char:
            return None

        # Map AniList role to VNDB-compatible format
        role = cls.ROLE_MAP.get(role_raw, "side")

        # Get name information
        name_info = char.get("name", {})
        full_name = name_info.get("full", "")
        native_name = name_info.get("native", "")
        alternative_names = name_info.get("alternative", []) or []

        # Build the result
        result = {
            "id": char.get("id"),
            "name": full_name,
            "name_original": native_name,
            "aliases": alternative_names,
            "role": role,
        }

        # Handle description with spoiler tags
        description = char.get("description")
        if description:
            has_spoilers = cls.has_spoiler_tags(description)
            
            if preserve_spoiler_metadata:
                # Always include description, we'll filter at display time
                result["description"] = description
                result["description_has_spoilers"] = has_spoilers
            else:
                if max_spoiler == 0 and has_spoilers:
                    # Strip spoiler content for spoiler-free mode
                    result["description"] = cls.strip_spoiler_tags(description)
                else:
                    result["description"] = description

        # Map gender to sex field (for VNDB compatibility)
        gender = char.get("gender")
        if gender:
            gender_map = {
                "Male": "male",
                "Female": "female",
                "Non-binary": "non-binary",
            }
            result["sex"] = gender_map.get(gender, gender.lower())

        # Add age if available
        age = char.get("age")
        if age:
            result["age"] = str(age)

        # Add image as base64 thumbnail
        image_info = char.get("image", {})
        if image_info:
            # Prefer medium size for thumbnails, fallback to large
            image_url = image_info.get("medium") or image_info.get("large")
            if image_url:
                result["image_url"] = image_url
                # Fetch, resize to thumbnail, and convert to base64
                image_base64 = cls.fetch_image_as_base64(image_url)
                if image_base64:
                    result["image_base64"] = image_base64

        return result

    @classmethod
    def process_media_characters(
        cls,
        media_id: int,
        media_type: str,
        max_spoiler: int = 0,
        include_minor: bool = False,
        preserve_spoiler_metadata: bool = False
    ) -> Optional[Dict]:
        """
        Fetch and process all characters for an Anime/Manga.

        This is the main entry point for fetching character data.
        Character images are automatically fetched and stored as 80x100 thumbnails.

        Args:
            media_id: AniList media ID
            media_type: "ANIME" or "MANGA"
            max_spoiler: Maximum spoiler level (0=none, 1=minor, 2=major)
            include_minor: Whether to include background/minor characters
            preserve_spoiler_metadata: If True, stores descriptions with spoiler level info

        Returns:
            Dictionary with media info and categorized characters, or None on failure:
            {
                "media_id": 149544,
                "media_type": "MANGA",
                "character_count": 15,
                "characters": {
                    "main": [...],
                    "primary": [...],
                    "side": [...]
                }
            }
        """
        logger.debug(f"Processing characters for AniList {media_type} ID {media_id}")
        
        edges = cls.fetch_characters(media_id, media_type)

        if edges is None:
            logger.warning(f"Failed to fetch characters for {media_type} {media_id}")
            return None

        logger.debug(f"Found {len(edges)} characters for {media_type} {media_id}")

        # Process and categorize characters
        processed: Dict[str, List[Dict]] = {
            "main": [],      # Protagonist (MAIN)
            "primary": [],   # Main characters (SUPPORTING)
            "side": [],      # Side characters (BACKGROUND)
        }

        for edge in edges:
            formatted = cls.format_character_for_translation(
                edge, max_spoiler, preserve_spoiler_metadata
            )
            if formatted is None:
                continue

            role = formatted.get("role", "side")
            if role in processed:
                processed[role].append(formatted)
            else:
                processed["side"].append(formatted)

        # Filter out minor characters if requested
        if not include_minor:
            # Keep side characters but they're optional - user can choose
            pass

        # Remove empty categories
        processed = {k: v for k, v in processed.items() if v}

        result = {
            "media_id": media_id,
            "media_type": media_type,
            "character_count": sum(len(v) for v in processed.values()),
            "characters": processed,
        }

        logger.info(
            f"Processed {result['character_count']} characters for {media_type} {media_id}"
        )
        return result

    @staticmethod
    def create_translation_context(data: Dict) -> str:
        """
        Create a compact text summary for use in translation prompts.

        Args:
            data: Dictionary from process_media_characters()

        Returns:
            Markdown-formatted string with character information
        """
        media_type = data.get('media_type', 'Media')
        media_id = data.get('media_id', 'Unknown')
        lines = [f"# Character Reference for {media_type} {media_id}\n"]

        role_labels = {
            "main": "Protagonist",
            "primary": "Main Characters",
            "side": "Side Characters",
        }

        for role, label in role_labels.items():
            chars = data.get("characters", {}).get(role, [])
            if not chars:
                continue

            lines.append(f"\n## {label}")
            for char in chars:
                name = char.get("name", "Unknown")
                orig = char.get("name_original")
                name_str = f"{name} ({orig})" if orig else name

                parts = [name_str]

                if char.get("sex"):
                    parts.append(char["sex"])

                if char.get("age"):
                    parts.append(f"age {char['age']}")

                if len(parts) > 1:
                    lines.append(f"- {parts[0]}: " + "; ".join(parts[1:]))
                else:
                    lines.append(f"- {parts[0]}")

                # Add description as a separate indented line if available
                if char.get("description"):
                    # Truncate long descriptions for the summary
                    desc = char["description"]
                    # Strip spoiler tags for summary
                    desc = AniListApiClient.strip_spoiler_tags(desc)
                    if len(desc) > 200:
                        desc = desc[:197] + "..."
                    lines.append(f"  Description: {desc}")

        return "\n".join(lines)
