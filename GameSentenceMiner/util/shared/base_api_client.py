"""
Base API Client

Abstract base class for external API clients (VNDB, AniList, etc.).
Provides common functionality for image processing and character data
formatting while allowing API-specific implementations.
"""

from abc import ABC, abstractmethod
from typing import Optional, Dict, List

from GameSentenceMiner.util.config.configuration import logger
from GameSentenceMiner.util.shared.image_utils import (
    fetch_image_as_base64 as _fetch_image_as_base64,
    download_cover_image as _download_cover_image,
    THUMBNAIL_SIZE as _THUMBNAIL_SIZE,
    COVER_IMAGE_SIZE as _COVER_IMAGE_SIZE,
)


class BaseApiClient(ABC):
    """
    Abstract base class for API clients.
    
    Provides common functionality for:
    - Image fetching and processing
    - Common error handling patterns
    - Translation context creation
    
    Subclasses must implement:
    - search_game(query) -> search results
    - get_game_details(game_id) -> game metadata
    - get_characters(game_id) -> character list
    """
    
    # Common constants (can be overridden by subclasses)
    TIMEOUT: int = 10
    THUMBNAIL_SIZE: tuple = _THUMBNAIL_SIZE
    COVER_IMAGE_SIZE: tuple = _COVER_IMAGE_SIZE
    
    # ========================================================================
    # Abstract Methods - Must be implemented by subclasses
    # ========================================================================
    
    @abstractmethod
    def search_game(self, query: str, **kwargs) -> Optional[Dict]:
        """
        Search for games/media by title.
        
        Args:
            query: Search query string
            **kwargs: Additional API-specific parameters
            
        Returns:
            Dictionary with search results, or None if request fails
        """
        pass
    
    @abstractmethod
    def get_game_details(self, game_id: str, **kwargs) -> Optional[Dict]:
        """
        Fetch detailed metadata for a specific game/media.
        
        Args:
            game_id: Game/media identifier
            **kwargs: Additional API-specific parameters
            
        Returns:
            Dictionary with game metadata, or None if request fails
        """
        pass
    
    @abstractmethod
    def get_characters(self, game_id: str, **kwargs) -> Optional[List[Dict]]:
        """
        Fetch all characters for a specific game/media.
        
        Args:
            game_id: Game/media identifier
            **kwargs: Additional API-specific parameters
            
        Returns:
            List of character dictionaries, or None if request fails
        """
        pass
    
    # ========================================================================
    # Common Image Processing Methods
    # ========================================================================
    
    @classmethod
    def fetch_image_as_base64(
        cls,
        image_url: str,
        thumbnail_size: tuple = None
    ) -> Optional[str]:
        """
        Download an image from URL, resize to thumbnail, and convert to base64.
        
        Uses shared image utilities for consistent image processing across all clients.
        
        Args:
            image_url: URL of the image to download
            thumbnail_size: Tuple of (width, height) for thumbnail. 
                          Defaults to cls.THUMBNAIL_SIZE
            
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
    
    @classmethod
    def download_cover_image_from_url(
        cls,
        image_url: str,
        cover_size: tuple = None
    ) -> Optional[str]:
        """
        Download and process a cover image from a direct URL.
        
        This is a helper method that uses shared utilities. Subclasses should
        implement their own download_cover_image() method that fetches the URL
        from the API and then calls this method.
        
        Args:
            image_url: Direct URL to the cover image
            cover_size: Tuple of (width, height) for cover. 
                       Defaults to cls.COVER_IMAGE_SIZE
            
        Returns:
            Base64-encoded PNG image string with data URI prefix, or None on failure
        """
        if cover_size is None:
            cover_size = cls.COVER_IMAGE_SIZE
        
        return _download_cover_image(
            image_url=image_url,
            cover_size=cover_size,
            timeout=cls.TIMEOUT,
            output_format='PNG'
        )
    
    # ========================================================================
    # Common Translation Context Creation
    # ========================================================================
    
    @staticmethod
    def create_translation_context(
        data: Dict,
        role_labels: Optional[Dict[str, str]] = None
    ) -> str:
        """
        Create a compact text summary for use in translation prompts.
        
        This provides a consistent format for character context across different
        API sources (VNDB, AniList, etc.).
        
        Args:
            data: Dictionary from process_*_characters() containing:
                 - character_count: Total number of characters
                 - characters: Dict mapping role to list of character dicts
            role_labels: Optional custom labels for roles. If not provided, uses defaults.
            
        Returns:
            Markdown-formatted string with character information
        """
        if role_labels is None:
            role_labels = {
                "main": "Protagonist",
                "primary": "Main Characters",
                "side": "Side Characters",
                "appears": "Minor Characters",
            }
        
        # Extract identifier for header (can be vn_id, media_id, etc.)
        identifier = data.get("vn_id") or data.get("media_id") or "Unknown"
        media_type = data.get("media_type", "")
        
        if media_type:
            lines = [f"# Character Reference for {media_type} {identifier}\n"]
        else:
            lines = [f"# Character Reference for {identifier}\n"]
        
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
    
    # ========================================================================
    # Utility Methods
    # ========================================================================
    
    @classmethod
    def log_request(cls, endpoint: str, params: Dict = None):
        """
        Log an API request for debugging purposes.
        
        Args:
            endpoint: API endpoint being called
            params: Request parameters
        """
        logger.debug(f"API Request to {endpoint}" + (f" with params: {params}" if params else ""))
    
    @classmethod
    def log_response(cls, endpoint: str, success: bool, details: str = ""):
        """
        Log an API response for debugging purposes.
        
        Args:
            endpoint: API endpoint that was called
            success: Whether the request was successful
            details: Additional details about the response
        """
        level = logger.info if success else logger.warning
        status = "succeeded" if success else "failed"
        level(f"API Request to {endpoint} {status}" + (f": {details}" if details else ""))
