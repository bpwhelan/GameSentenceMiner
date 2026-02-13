"""
VNDB API Client

Fetch character information from VNDB for use in AI translation context.
Extracts names, personality traits, roles, and other relevant attributes.
"""

import requests
from typing import Optional, Dict, List, Tuple

from GameSentenceMiner.util.config.configuration import logger
from GameSentenceMiner.util.shared.base_api_client import BaseApiClient
from GameSentenceMiner.util.shared.image_utils import (
    download_cover_image,
    fetch_image_as_base64 as _fetch_image_as_base64,
)
from GameSentenceMiner.util.shared.spoiler_utils import (
    has_vndb_spoiler_tags,
    strip_vndb_spoiler_content,
)


class VNDBApiClient(BaseApiClient):
    """
    Client for VNDB API interactions.

    Provides methods for:
    - Fetching all characters for a VN with automatic pagination
    - Categorizing traits by group with spoiler filtering
    - Determining character role for target VN
    - Formatting character data for translation context
    - Creating compact text summaries for AI prompts
    """

    API_URL = "https://api.vndb.org/kana/character"
    TIMEOUT = 10
    DEFAULT_RESULTS_PER_PAGE = 100

    @staticmethod
    def normalize_vndb_id(vn_id: str) -> str:
        """
        Normalize VN ID to format 'v12345'.

        Args:
            vn_id: VNDB visual novel ID (e.g., "v56650" or "56650")

        Returns:
            Normalized VN ID with 'v' prefix
        """
        vn_id = str(vn_id).strip().lower()
        if vn_id.startswith("v"):
            return vn_id
        return f"v{vn_id}"

    # Implementation of abstract methods from BaseApiClient
    @classmethod
    def search_game(cls, query: str, **kwargs) -> Optional[Dict]:
        """
        Search for games/media by title.
        
        This is an implementation of the BaseApiClient abstract method.
        Delegates to search_vn() for backward compatibility.
        
        Args:
            query: Search query string
            **kwargs: Additional parameters (e.g., limit)
            
        Returns:
            Dictionary with search results, or None if request fails
        """
        limit = kwargs.get('limit', 10)
        return cls.search_vn(query, limit)
    
    @classmethod
    def get_game_details(cls, game_id: str, **kwargs) -> Optional[Dict]:
        """
        Fetch detailed metadata for a specific game/media.
        
        This is an implementation of the BaseApiClient abstract method.
        Delegates to fetch_vn_metadata() for backward compatibility.
        
        Args:
            game_id: Game/media identifier (VNDB ID)
            **kwargs: Additional parameters
            
        Returns:
            Dictionary with game metadata, or None if request fails
        """
        return cls.fetch_vn_metadata(game_id)
    
    @classmethod
    def get_characters(cls, game_id: str, **kwargs) -> Optional[List[Dict]]:
        """
        Fetch all characters for a specific game/media.
        
        This is an implementation of the BaseApiClient abstract method.
        Delegates to fetch_characters() for backward compatibility.
        
        Args:
            game_id: Game/media identifier (VNDB ID)
            **kwargs: Additional parameters
            
        Returns:
            List of character dictionaries, or None if request fails
        """
        return cls.fetch_characters(game_id, **kwargs)

    @classmethod
    def search_vn(
        cls,
        query: str,
        limit: int = 10
    ) -> Optional[Dict]:
        """
        Search VNDB for visual novels by title.
        
        Rate limit: 200 requests per 5 minutes.
        
        Args:
            query: Search query string
            limit: Maximum number of results (default: 10, max: 100)
        
        Returns:
            Dictionary with search results from VNDB API, or None if request fails.
            Response structure:
            {
                "results": [
                    {
                        "id": "v17",
                        "title": "Steins;Gate",
                        "alttitle": "シュタインズ・ゲート",
                        "released": "2009-10-15",
                        "rating": 87.5,
                        "description": "...",
                        "image": {"url": "..."},
                        "developers": [{"name": "5pb."}]
                    },
                    ...
                ],
                "more": false
            }
        """
        try:
            payload = {
                "filters": ["search", "=", query],
                "fields": "id, title, alttitle, released, rating, description, image.url, developers.name",
                "sort": "rating",
                "reverse": True,
                "results": min(limit, 100)  # VNDB max is 100
            }
            
            logger.debug(f"Searching VNDB for: {query}")
            
            response = requests.post(
                "https://api.vndb.org/kana/vn",
                headers={"Content-Type": "application/json"},
                json=payload,
                timeout=cls.TIMEOUT
            )
            
            if response.status_code != 200:
                logger.debug(f"VNDB search API returned status {response.status_code}")
                return None
            
            data = response.json()
            results = data.get("results", [])
            logger.debug(f"VNDB search returned {len(results)} results for '{query}'")
            
            return data
            
        except requests.RequestException as e:
            logger.debug(f"VNDB search API request failed: {e}")
            return None
        except Exception as e:
            logger.debug(f"Unexpected error in VNDB search: {e}")
            return None

    @classmethod
    def fetch_characters(
        cls,
        vn_id: str,
        results_per_page: int = None
    ) -> Optional[List[Dict]]:
        """
        Fetch all characters for a given VN from VNDB API.
        Handles pagination automatically.

        Args:
            vn_id: VNDB visual novel ID (e.g., "v56650" or "56650")
            results_per_page: Number of results per API request (default: 100)

        Returns:
            List of character dictionaries, or None if request fails
        """
        if results_per_page is None:
            results_per_page = cls.DEFAULT_RESULTS_PER_PAGE

        vn_id = cls.normalize_vndb_id(vn_id)
        all_characters = []
        page = 1

        logger.debug(f"Fetching characters for VN {vn_id} from VNDB")

        while True:
            try:
                payload = {
                    "filters": ["vn", "=", ["id", "=", vn_id]],
                    "fields": ",".join([
                        "id",
                        "name",
                        "original",
                        "aliases",
                        "description",
                        "blood_type",
                        "height",
                        "weight",
                        "age",
                        "birthday",
                        "sex",
                        "gender",
                        "image.url",
                        "vns.role",
                        "vns.spoiler",
                        "vns.id",
                        "traits.id",
                        "traits.name",
                        "traits.group_name",
                        "traits.spoiler",
                    ]),
                    "results": results_per_page,
                    "page": page,
                }

                response = requests.post(
                    cls.API_URL,
                    headers={"Content-Type": "application/json"},
                    json=payload,
                    timeout=cls.TIMEOUT
                )

                if response.status_code != 200:
                    logger.warning(
                        f"VNDB API returned status {response.status_code} for VN {vn_id}"
                    )
                    return None

                data = response.json()
                all_characters.extend(data.get("results", []))

                if not data.get("more", False):
                    break
                page += 1

            except requests.RequestException as e:
                logger.warning(f"VNDB API request failed for VN {vn_id}: {e}")
                return None
            except Exception as e:
                logger.warning(f"Unexpected error fetching VNDB characters: {e}")
                return None

        logger.info(f"Fetched {len(all_characters)} characters for VN {vn_id}")
        return all_characters

    # Thumbnail size for character images
    THUMBNAIL_SIZE = (80, 100)
    
    # Cover image size (larger for game covers)
    COVER_IMAGE_SIZE = (300, 400)

    @classmethod
    def download_cover_image(
        cls,
        vn_id: str
    ) -> Optional[str]:
        """
        Download the cover image for a visual novel from VNDB.
        
        Uses shared image utilities for consistent image processing.
        
        Args:
            vn_id: VNDB visual novel ID (e.g., "v56650" or "56650")
            
        Returns:
            Base64-encoded PNG image string with data URI prefix, or None on failure
        """
        vn_id = cls.normalize_vndb_id(vn_id)
        
        try:
            # First, fetch VN info to get the cover image URL
            payload = {
                "filters": ["id", "=", vn_id],
                "fields": "id, title, image.url",
                "results": 1
            }
            
            response = requests.post(
                "https://api.vndb.org/kana/vn",
                headers={"Content-Type": "application/json"},
                json=payload,
                timeout=cls.TIMEOUT
            )
            
            if response.status_code != 200:
                logger.debug(f"VNDB API returned status {response.status_code} for cover fetch")
                return None
            
            data = response.json()
            results = data.get("results", [])
            
            if not results:
                logger.debug(f"No VN found for ID {vn_id}")
                return None
            
            vn_data = results[0]
            image_info = vn_data.get("image")
            
            if not image_info or not isinstance(image_info, dict):
                logger.debug(f"No cover image info for VN {vn_id}")
                return None
            
            image_url = image_info.get("url")
            if not image_url:
                logger.debug(f"No cover image URL for VN {vn_id}")
                return None
            
            # Use shared utility for image download and processing
            result = download_cover_image(
                image_url=image_url,
                cover_size=cls.COVER_IMAGE_SIZE,
                timeout=cls.TIMEOUT
            )
            if result:
                logger.success(f"Downloaded VNDB cover image for {vn_id}")
            return result
            
        except requests.RequestException as e:
            logger.debug(f"Failed to fetch VNDB cover image for {vn_id}: {e}")
            return None
        except Exception as e:
            logger.debug(f"Unexpected error downloading VNDB cover: {e}")
            return None

    @classmethod
    def fetch_vn_metadata(
        cls,
        vn_id: str
    ) -> Optional[Dict]:
        """
        Fetch full metadata for a visual novel from VNDB.
        
        Args:
            vn_id: VNDB visual novel ID (e.g., "v56650" or "56650")
            
        Returns:
            Dictionary with VN metadata, or None on failure
        """
        vn_id = cls.normalize_vndb_id(vn_id)
        
        try:
            payload = {
                "filters": ["id", "=", vn_id],
                "fields": "id, title, alttitle, released, rating, description, image.url, developers.name, length_minutes, tags.name, tags.category, tags.rating",
                "results": 1
            }
            
            response = requests.post(
                "https://api.vndb.org/kana/vn",
                headers={"Content-Type": "application/json"},
                json=payload,
                timeout=cls.TIMEOUT
            )
            
            if response.status_code != 200:
                logger.debug(f"VNDB API returned status {response.status_code} for metadata fetch")
                return None
            
            data = response.json()
            results = data.get("results", [])
            
            if not results:
                logger.debug(f"No VN found for ID {vn_id}")
                return None
            
            vn_data = results[0]
            
            # Normalize the data
            image_info = vn_data.get("image", {})
            developers = vn_data.get("developers", [])
            tags_data = vn_data.get("tags", [])
            
            # Extract tag names from tag objects
            # VNDB doesn't have separate genres - it uses a comprehensive tag system
            # We store all tags without filtering since Jiten data takes priority
            tags = [tag.get("name", "") for tag in tags_data if tag.get("name")]
            
            return {
                "vndb_id": vn_id,
                "title_romaji": vn_data.get("title", ""),
                "title_original": vn_data.get("alttitle", ""),
                "description": vn_data.get("description", ""),
                "release_date": vn_data.get("released"),
                "rating": vn_data.get("rating"),
                "length_minutes": vn_data.get("length_minutes"),
                "cover_url": image_info.get("url") if isinstance(image_info, dict) else None,
                "developers": [d.get("name", "") for d in developers if d.get("name")],
                "media_type": "Visual Novel",
                "tags": tags,  # List of tag names
                "genres": []   # VNDB uses tags instead of separate genres
            }
            
        except requests.RequestException as e:
            logger.debug(f"Failed to fetch VNDB metadata for {vn_id}: {e}")
            return None
        except Exception as e:
            logger.debug(f"Unexpected error fetching VNDB metadata: {e}")
            return None

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
    def has_spoiler_tags(text: str) -> bool:
        """
        Check if text contains VNDB spoiler tags.
        
        Uses shared spoiler utilities for consistent handling.
        
        Args:
            text: Text to check for spoiler tags
            
        Returns:
            True if text contains spoiler tags, False otherwise
        """
        return has_vndb_spoiler_tags(text)

    @staticmethod
    def strip_spoiler_content(text: str) -> str:
        """
        Remove spoiler content from text.
        
        Uses shared spoiler utilities for consistent handling.
        
        Args:
            text: Text potentially containing spoiler tags
            
        Returns:
            Text with spoiler content removed
        """
        return strip_vndb_spoiler_content(text)

    @staticmethod
    def categorize_traits(
        traits: List[Dict],
        max_spoiler: int = 0
    ) -> Dict[str, List[str]]:
        """
        Organize traits by their group (Personality, Role, etc.).
        Filters by spoiler level.

        Args:
            traits: List of trait dictionaries from VNDB
            max_spoiler: Maximum spoiler level (0=none, 1=minor, 2=major)

        Returns:
            Dictionary mapping group names to lists of trait names
        """
        categorized = {}

        for trait in traits:
            if trait.get("spoiler", 0) > max_spoiler:
                continue

            group = trait.get("group_name", "Other")
            name = trait.get("name", "")

            if group not in categorized:
                categorized[group] = []
            if name and name not in categorized[group]:
                categorized[group].append(name)

        return categorized

    @staticmethod
    def categorize_traits_with_spoilers(
        traits: List[Dict]
    ) -> Dict[str, List[Dict]]:
        """
        Organize traits by their group, preserving spoiler level metadata.
        Does NOT filter by spoiler level - stores all traits with their metadata.

        Args:
            traits: List of trait dictionaries from VNDB

        Returns:
            Dictionary mapping group names to lists of trait objects with:
            - name: trait name
            - spoiler: spoiler level (0=none, 1=minor, 2=major)
        """
        categorized = {}

        for trait in traits:
            group = trait.get("group_name", "Other")
            name = trait.get("name", "")
            spoiler_level = trait.get("spoiler", 0)

            if group not in categorized:
                categorized[group] = []
            
            # Store trait with spoiler metadata
            trait_obj = {
                "name": name,
                "spoiler": spoiler_level
            }
            
            # Avoid duplicates
            if name and not any(t["name"] == name for t in categorized[group]):
                categorized[group].append(trait_obj)

        return categorized

    @classmethod
    def get_character_role(
        cls,
        vns: List[Dict],
        target_vn_id: str
    ) -> Tuple[str, int]:
        """
        Get the character's role and spoiler level for the target VN.

        Args:
            vns: List of VN associations for the character
            target_vn_id: VNDB visual novel ID to match

        Returns:
            Tuple of (role, spoiler_level) where role is one of:
            main, primary, side, appears, unknown
        """
        target_vn_id = cls.normalize_vndb_id(target_vn_id)

        for vn in vns:
            if vn.get("id") == target_vn_id:
                return vn.get("role", "unknown"), vn.get("spoiler", 0)

        # Fallback to first entry
        if vns:
            return vns[0].get("role", "unknown"), vns[0].get("spoiler", 0)
        return "unknown", 0

    @classmethod
    def format_character_for_translation(
        cls,
        char: Dict,
        target_vn_id: str,
        max_spoiler: int = 0,
        preserve_spoiler_metadata: bool = False
    ) -> Optional[Dict]:
        """
        Format a character's data for use in translation context.

        Args:
            char: Character dictionary from VNDB API
            target_vn_id: VNDB visual novel ID
            max_spoiler: Maximum spoiler level (0=none, 1=minor, 2=major)
            preserve_spoiler_metadata: If True, stores traits with spoiler levels instead of filtering

        Returns:
            Formatted character dictionary, or None if character is a spoiler
        """
        role, char_spoiler = cls.get_character_role(
            char.get("vns", []), target_vn_id
        )

        # Skip characters that are spoilers themselves
        if char_spoiler > max_spoiler:
            return None

        # Get sex/gender info
        sex_info = char.get("sex")
        sex = None
        if sex_info and isinstance(sex_info, list) and len(sex_info) >= 1:
            sex = sex_info[0]  # Non-spoiler sex

        gender_info = char.get("gender")
        gender = None
        if gender_info and isinstance(gender_info, list) and len(gender_info) >= 1:
            gender = gender_info[0]  # Non-spoiler gender

        # Categorize traits - use metadata-preserving version if requested
        if preserve_spoiler_metadata:
            traits = cls.categorize_traits_with_spoilers(char.get("traits", []))
        else:
            traits = cls.categorize_traits(char.get("traits", []), max_spoiler)

        # Build the result
        result = {
            "id": char.get("id"),
            "name": char.get("name"),
            "name_original": char.get("original"),
            "aliases": char.get("aliases", []),
            "role": role,  # main, primary, side, appears
        }

        # Add description - include even if it has spoiler tags when preserving metadata
        description = char.get("description")
        if description:
            if preserve_spoiler_metadata:
                # Always include description, we'll filter at display time
                result["description"] = description
            else:
                # Handle description based on spoiler level
                if max_spoiler == 0 and cls.has_spoiler_tags(description):
                    # Level 0 (No spoilers): Skip descriptions with spoiler tags
                    pass  # Don't include description with spoiler content
                elif max_spoiler == 1 and cls.has_spoiler_tags(description):
                    # Level 1 only (Minor spoilers): Include description but strip spoiler content
                    result["description"] = cls.strip_spoiler_content(description)
                else:
                    # Level 2 (Major spoilers) or no spoiler tags: Include description as-is
                    result["description"] = description

        # Add optional fields only if they have values
        sex_map = {"m": "male", "f": "female", "b": "both", "n": "sexless"}
        if sex:
            result["sex"] = sex_map.get(sex, sex)

        gender_map = {"m": "male", "f": "female", "o": "non-binary", "a": "ambiguous"}
        if gender:
            result["gender"] = gender_map.get(gender, gender)

        if char.get("age"):
            result["age"] = char.get("age")

        # Add physical characteristics if available
        if char.get("blood_type"):
            result["blood_type"] = char.get("blood_type")

        if char.get("height"):
            result["height"] = char.get("height")

        if char.get("weight"):
            result["weight"] = char.get("weight")

        if char.get("birthday"):
            result["birthday"] = char.get("birthday")

        # Add image as base64 thumbnail
        image_info = char.get("image")
        if image_info and isinstance(image_info, dict):
            image_url = image_info.get("url")
            if image_url:
                # Store the original URL for reference
                result["image_url"] = image_url
                # Fetch, resize to thumbnail, and convert to base64
                image_base64 = cls.fetch_image_as_base64(image_url)
                if image_base64:
                    result["image_base64"] = image_base64

        # Add personality traits (most useful for translation)
        if "Personality" in traits:
            result["personality"] = traits["Personality"]

        # Add role/occupation traits
        if "Role" in traits:
            result["roles"] = traits["Role"]

        # Add other potentially useful trait categories
        for category in ["Engages in", "Subject of"]:
            if category in traits:
                key = category.lower().replace(" ", "_")
                result[key] = traits[category]

        return result

    @classmethod
    def process_vn_characters(
        cls,
        vn_id: str,
        max_spoiler: int = 0,
        include_minor: bool = False,
        preserve_spoiler_metadata: bool = False
    ) -> Optional[Dict]:
        """
        Fetch and process all characters for a VN.

        This is the main entry point for fetching character data.
        Character images are automatically fetched and stored as 80x100 thumbnails.

        Args:
            vn_id: VNDB visual novel ID (e.g., "v56650" or "56650")
            max_spoiler: Maximum spoiler level (0=none, 1=minor, 2=major)
            include_minor: Whether to include minor/appears characters
            preserve_spoiler_metadata: If True, stores traits with spoiler levels for runtime filtering

        Returns:
            Dictionary with VN info and categorized characters, or None on failure:
            {
                "vn_id": "v56650",
                "character_count": 15,
                "characters": {
                    "main": [...],
                    "primary": [...],
                    "side": [...]
                }
            }
        """
        vn_id = cls.normalize_vndb_id(vn_id)

        logger.debug(f"Processing characters for VN {vn_id}")
        characters = cls.fetch_characters(vn_id)

        if characters is None:
            logger.warning(f"Failed to fetch characters for VN {vn_id}")
            return None

        logger.debug(f"Found {len(characters)} characters for VN {vn_id}")

        # Process and categorize characters
        processed: Dict[str, List[Dict]] = {
            "main": [],      # Protagonist
            "primary": [],   # Main characters
            "side": [],      # Side characters
            "appears": [],   # Minor appearances
        }

        for char in characters:
            formatted = cls.format_character_for_translation(
                char, vn_id, max_spoiler, preserve_spoiler_metadata
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
            processed.pop("appears", None)

        # Remove empty categories
        processed = {k: v for k, v in processed.items() if v}

        result = {
            "vn_id": vn_id,
            "character_count": sum(len(v) for v in processed.values()),
            "characters": processed,
        }

        logger.info(
            f"Processed {result['character_count']} characters for VN {vn_id}"
        )
        return result

    @staticmethod
    def create_translation_context(data: Dict) -> str:
        """
        Create a compact text summary for use in translation prompts.

        Args:
            data: Dictionary from process_vn_characters()

        Returns:
            Markdown-formatted string with character information
        """
        lines = [f"# Character Reference for {data['vn_id']}\n"]

        role_labels = {
            "main": "Protagonist",
            "primary": "Main Characters",
            "side": "Side Characters",
            "appears": "Minor Characters",
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

                if char.get("personality"):
                    parts.append(f"personality: {', '.join(char['personality'])}")

                if char.get("roles"):
                    parts.append(f"role: {', '.join(char['roles'])}")

                if len(parts) > 1:
                    lines.append(f"- {parts[0]}: " + "; ".join(parts[1:]))
                else:
                    lines.append(f"- {parts[0]}")

                # Add description as a separate indented line if available
                if char.get("description"):
                    # Truncate long descriptions for the summary
                    desc = char["description"]
                    if len(desc) > 200:
                        desc = desc[:197] + "..."
                    lines.append(f"  Description: {desc}")

        return "\n".join(lines)
