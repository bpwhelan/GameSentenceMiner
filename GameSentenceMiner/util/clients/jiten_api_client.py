"""
Jiten.moe API Client

Centralized client for interacting with the jiten.moe API.
Provides both search and detail endpoints with consistent error handling and logging.
"""

import base64
import re
import requests
import time
from typing import Optional, Dict, List

from GameSentenceMiner.util.config.configuration import logger


class JitenLinkType:
    """
    Jiten.moe external link types from Jiten.Core LinkType enum.
    
    Used to query decks by external service IDs via the by-link-id endpoint.
    """
    WEB = 1          # Generic web link
    VNDB = 2         # Visual Novel Database
    TMDB = 3         # The Movie Database
    ANILIST = 4      # AniList
    MAL = 5          # MyAnimeList
    GOOGLE_BOOKS = 6 # Google Books
    IMDB = 7         # Internet Movie Database
    IGDB = 8         # Internet Games Database
    SYOSETSU = 9     # Syosetu (Japanese web novels)


class JitenApiClient:
    """
    Centralized client for jiten.moe API interactions.

    Provides methods for:
    - Searching media decks by title
    - Getting detailed deck information by deck_id
    - Downloading and encoding cover images
    """

    BASE_URL = "https://api.jiten.moe/api/media-deck"
    TIMEOUT = 10

    @classmethod
    def search_media_decks(
        cls,
        title_filter: str,
        sort_by: str = "title",
        sort_order: int = 0,
        offset: int = 0,
    ) -> Optional[Dict]:
        """
        Search jiten.moe media decks by title.

        Args:
            title_filter: Title to search for
            sort_by: Sort field (default: 'title')
            sort_order: Sort order (default: 0)
            offset: Pagination offset (default: 0)

        Returns:
            Dictionary with search results, or None if request fails
        """
        try:
            url = f"{cls.BASE_URL}/get-media-decks"
            params = {
                "titleFilter": title_filter,
                "sortBy": sort_by,
                "sortOrder": sort_order,
                "offset": offset,
            }

            logger.info(f"Searching jiten.moe for title: '{title_filter}'")
            logger.debug(f"Jiten search URL: {url}")
            logger.debug(f"Jiten search params: {params}")
            
            response = requests.get(url, params=params, timeout=cls.TIMEOUT)
            
            logger.debug(f"Jiten search final URL: {response.url}")
            logger.debug(f"Jiten search status code: {response.status_code}")

            if response.status_code != 200:
                logger.warning(f"Jiten search API returned status {response.status_code} for query '{title_filter}'")
                return None

            data = response.json()
            result_count = len(data.get('data', []))
            total_items = data.get('totalItems', 0)
            logger.info(f"Jiten search for '{title_filter}' returned {result_count} results (total: {total_items})")
            
            if result_count > 0:
                logger.debug(f"First result: {data['data'][0].get('originalTitle', 'N/A')}")
            else:
                logger.warning(f"Jiten search for '{title_filter}' returned 0 results")
            
            return data

        except requests.RequestException as e:
            logger.debug(f"Jiten search API request failed: {e}")
            return None
        except Exception as e:
            logger.debug(f"Unexpected error in jiten search: {e}")
            return None

    @classmethod
    def get_deck_detail(cls, deck_id: int, offset: int = 0) -> Optional[Dict]:
        """
        Get detailed information for a specific deck by deck_id.

        Args:
            deck_id: The jiten.moe deck ID
            offset: Pagination offset (default: 0)

        Returns:
            Dictionary with deck details, or None if request fails
        """
        try:
            url = f"{cls.BASE_URL}/{deck_id}/detail"
            params = {"offset": offset}

            logger.debug(f"Fetching jiten.moe deck detail for deck_id: {deck_id}")
            response = requests.get(url, params=params, timeout=cls.TIMEOUT)

            if response.status_code != 200:
                logger.debug(
                    f"Jiten detail API returned status {response.status_code} for deck {deck_id}"
                )
                return None

            data = response.json()
            logger.debug(f"Successfully fetched deck detail for deck_id: {deck_id}")
            return data

        except requests.RequestException as e:
            logger.debug(f"Jiten detail API request failed for deck {deck_id}: {e}")
            return None
        except Exception as e:
            logger.debug(
                f"Unexpected error fetching deck detail for deck {deck_id}: {e}"
            )
            return None

    @classmethod
    def normalize_deck_data(cls, deck_data: Dict) -> Dict:
        """
        Normalize deck data from jiten.moe API response to consistent format.

        Args:
            deck_data: Raw deck data from API

        Returns:
            Normalized deck data with snake_case keys
        """
        # Map media type integer to human-readable string
        # Based on jiten.moe MediaType enum:
        # Anime=1, Drama=2, Movie=3, Novel=4, NonFiction=5, VideoGame=6, VisualNovel=7, WebNovel=8, Manga=9
        media_type_raw = deck_data.get("mediaType")
        media_type_map = {
            1: "Anime",
            2: "Drama",
            3: "Movie",
            4: "Novel",
            5: "NonFiction",
            6: "VideoGame",
            7: "Visual Novel",
            8: "WebNovel",
            9: "Manga",
        }
        media_type_string = media_type_map.get(media_type_raw, f"Type {media_type_raw}" if media_type_raw else "")
        
        # Map genre integers to human-readable names
        genre_map = {
            1: "Action",
            2: "Adventure",
            3: "Comedy",
            4: "Drama",
            5: "Ecchi",
            6: "Fantasy",
            7: "Horror",
            8: "Mecha",
            9: "Music",
            10: "Mystery",
            11: "Psychological",
            12: "Romance",
            13: "SciFi",
            14: "Slice of Life",
            15: "Sports",
            16: "Supernatural",
            17: "Thriller",
            18: "NSFW"
        }
        
        # Transform genres from integers to names
        genres_raw = deck_data.get("genres", [])
        genres = [genre_map.get(g, f"Unknown-{g}") for g in genres_raw] if genres_raw else []
        
        # Extract tag names from tag objects
        tags_raw = deck_data.get("tags", [])
        tags = [tag["name"] for tag in tags_raw if isinstance(tag, dict) and "name" in tag] if tags_raw else []
        
        return {
            "deck_id": deck_data.get("deckId"),
            "title_original": deck_data.get("originalTitle", ""),
            "title_romaji": deck_data.get("romajiTitle", ""),
            "title_english": deck_data.get("englishTitle", ""),
            "description": deck_data.get("description", ""),
            "cover_name": deck_data.get("coverName", ""),
            "media_type": media_type_raw,  # Keep raw integer for backend processing
            "media_type_string": media_type_string,  # Add human-readable string
            "character_count": deck_data.get("characterCount", 0),
            "difficulty": deck_data.get("difficulty", 0),
            "difficulty_raw": deck_data.get("difficultyRaw", 0),
            "links": deck_data.get("links", []),
            "aliases": deck_data.get("aliases", []),
            "release_date": deck_data.get("releaseDate", ""),
            "genres": genres,  # List of genre names
            "tags": tags,      # List of tag names
        }

    @classmethod
    def download_cover_image(cls, cover_url: str) -> Optional[str]:
        """
        Download and encode cover image from jiten.moe.

        Args:
            cover_url: URL of the cover image

        Returns:
            Base64 encoded image with data URI prefix, or None if download fails

        Note:
            Jiten.moe guarantees JPG format, so we assume image/jpeg MIME type.
        """
        try:
            logger.debug(f"Downloading cover image: {cover_url}")
            response = requests.get(cover_url, timeout=cls.TIMEOUT)

            if response.status_code != 200:
                logger.debug(
                    f"Failed to download cover image: HTTP {response.status_code}"
                )
                return None

            # Encode to base64 - jiten.moe guarantees JPG format
            img_base64 = base64.b64encode(response.content).decode("utf-8")
            data_uri = f"data:image/jpeg;base64,{img_base64}"

            logger.debug(f"Successfully downloaded and encoded cover image")
            return data_uri

        except Exception as e:
            logger.debug(f"Failed to download cover image: {e}")
            return None

    @classmethod
    def extract_vndb_id(cls, links: List) -> Optional[str]:
        """
        Extract VNDB VN ID from jiten.moe links array.
        
        Args:
            links: List of link strings or dictionaries from jiten.moe data
            
        Returns:
            VN ID string with 'v' prefix (e.g., "v1234") or None if not found
        """
        for link in links:
            # Handle both string and dict formats for backward compatibility
            url = link if isinstance(link, str) else (link.get("url", "") if isinstance(link, dict) else "")
            if "vndb.org/v" in url:
                # Extract VN ID from URL like https://vndb.org/v1234
                match = re.search(r"vndb\.org/v(\d+)", url)
                if match:
                    return f"v{match.group(1)}"
        return None

    @classmethod
    def extract_anilist_id(cls, links: List) -> Optional[tuple]:
        """
        Extract AniList media ID and type from jiten.moe links array.
        
        Args:
            links: List of link strings or dictionaries from jiten.moe data
            
        Returns:
            Tuple of (media_id, media_type) or None if not found
            media_type is "ANIME" or "MANGA"
        """
        for link in links:
            # Handle both string and dict formats for backward compatibility
            url = link if isinstance(link, str) else (link.get("url", "") if isinstance(link, dict) else "")
            if "anilist.co/" in url:
                match = re.search(r"anilist\.co/(anime|manga)/(\d+)", url)
                if match:
                    return int(match.group(2)), match.group(1).upper()
        return None

    @classmethod
    def get_deck_by_link_id(cls, link_type: int, external_id: str) -> List[int]:
        """
        Get deck IDs by external link type and ID.
        
        This allows looking up Jiten.moe decks using external service IDs like
        VNDB VN IDs or AniList media IDs.
        
        Args:
            link_type: Link type from JitenLinkType enum (e.g., JitenLinkType.VNDB)
            external_id: External service ID (e.g., "v17" for Steins;Gate on VNDB,
                        or "9253" for Steins;Gate anime on AniList)
        
        Returns:
            List of deck_ids if found, empty list if not found or on error
            
        Example:
            # Find Jiten deck for Steins;Gate VN
            deck_ids = JitenApiClient.get_deck_by_link_id(JitenLinkType.VNDB, "v17")
            
            # Find Jiten deck for Steins;Gate anime
            deck_ids = JitenApiClient.get_deck_by_link_id(JitenLinkType.ANILIST, "9253")
        """
        try:
            # Use the external_id as-is
            # For VNDB, the 'v' prefix must be preserved (e.g., "v2002" for Steins;Gate)
            # The Jiten API requires the full ID format from each service
            url = f"{cls.BASE_URL}/by-link-id/{link_type}/{external_id}"
            
            logger.debug(f"Looking up Jiten deck by link: type={link_type}, external_id={external_id}, url={url}")
            response = requests.get(url, timeout=cls.TIMEOUT)
            
            if response.status_code == 404:
                logger.debug(f"No Jiten deck found for link type={link_type}, id={external_id}")
                return []
            
            if response.status_code != 200:
                logger.debug(
                    f"Jiten by-link-id API returned status {response.status_code} "
                    f"for link type={link_type}, id={external_id}"
                )
                return []
            
            data = response.json()
            
            # Response could be a list of integers (deck IDs) or list of dicts
            if isinstance(data, list):
                deck_ids = []
                for item in data:
                    if isinstance(item, int):
                        # API returns list of integers like [283]
                        deck_ids.append(item)
                    elif isinstance(item, dict) and item.get("deckId"):
                        # Fallback for dict format like [{"deckId": 283}]
                        deck_ids.append(item.get("deckId"))
            elif isinstance(data, dict):
                deck_id = data.get("deckId")
                deck_ids = [deck_id] if deck_id else []
            else:
                deck_ids = []
            
            logger.debug(f"Found {len(deck_ids)} Jiten deck(s) for link type={link_type}, id={external_id}")
            return deck_ids
            
        except requests.RequestException as e:
            logger.debug(f"Jiten by-link-id API request failed: {e}")
            return []
        except Exception as e:
            logger.debug(f"Unexpected error in get_deck_by_link_id: {e}")
            return []
