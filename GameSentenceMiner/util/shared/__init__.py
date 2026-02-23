"""
Shared utilities for API clients.

This package contains common functionality used by both VNDB and AniList API clients,
extracted to eliminate code duplication and improve maintainability.
"""

from .base_api_client import BaseApiClient
from .game_update_service import GameUpdateService
from .image_utils import (
    fetch_image_as_base64,
    download_cover_image,
    resize_image_if_needed,
    convert_image_to_rgb,
)
from .spoiler_utils import (
    SpoilerFormat,
    contains_spoiler_content,
    strip_spoiler_content,
    mask_spoiler_content,
    # Convenience functions
    has_vndb_spoiler_tags,
    strip_vndb_spoiler_content,
    has_anilist_spoiler_tags,
    strip_anilist_spoiler_tags,
)

__all__ = [
    # Base class
    "BaseApiClient",
    
    # Image utilities
    "fetch_image_as_base64",
    "download_cover_image",
    "resize_image_if_needed",
    "convert_image_to_rgb",
    
    # Spoiler utilities
    "SpoilerFormat",
    "contains_spoiler_content",
    "strip_spoiler_content",
    "mask_spoiler_content",
    "has_vndb_spoiler_tags",
    "strip_vndb_spoiler_content",
    "has_anilist_spoiler_tags",
    "strip_anilist_spoiler_tags",
    
    # Game update service
    "GameUpdateService",
]
