"""
Spoiler handling utilities for API clients.

Common spoiler detection and processing functionality used by both VNDB and
AniList API clients. Different APIs use different spoiler tag formats:
- VNDB: [spoiler]content[/spoiler]
- AniList: ~!content!~
"""

import re
from enum import Enum


class SpoilerFormat(Enum):
    """Enumeration of supported spoiler tag formats."""
    
    VNDB = "vndb"
    """VNDB format: [spoiler]content[/spoiler]"""
    
    ANILIST = "anilist"
    """AniList format: ~!content!~"""


# Spoiler character mappings for different formats
SPOILER_PATTERNS = {
    SpoilerFormat.VNDB: r'\[spoiler\].*?\[/spoiler\]',
    SpoilerFormat.ANILIST: r'~!.+?!~',
}

# Patterns for tag removal (keeping content)
SPOILER_TAG_PATTERNS = {
    SpoilerFormat.VNDB: (r'\[spoiler\]', r'\[/spoiler\]'),
    SpoilerFormat.ANILIST: (r'~!', r'!~'),
}


def contains_spoiler_content(
    text: str,
    spoiler_format: SpoilerFormat = SpoilerFormat.VNDB
) -> bool:
    """
    Check if text contains spoiler markers for the specified format.
    
    Args:
        text: Text to check for spoiler tags
        spoiler_format: Format of spoiler tags to detect (default: VNDB)
        
    Returns:
        True if text contains spoiler tags, False otherwise
        
    Example:
        >>> text = "This is [spoiler]a secret[/spoiler] info"
        >>> contains_spoiler_content(text, SpoilerFormat.VNDB)
        True
        >>> text2 = "This is ~!a secret!~ info"
        >>> contains_spoiler_content(text2, SpoilerFormat.ANILIST)
        True
    """
    if not text:
        return False
    
    pattern = SPOILER_PATTERNS.get(spoiler_format)
    if not pattern:
        return False
    
    return bool(re.search(pattern, text, re.IGNORECASE | re.DOTALL))


def strip_spoiler_content(
    text: str,
    spoiler_format: SpoilerFormat = SpoilerFormat.VNDB,
    keep_content: bool = False
) -> str:
    """
    Remove spoiler markers from text, with option to keep or remove the content.
    
    Different APIs handle spoilers differently:
    - VNDB typically removes both tags and content (keep_content=False)
    - AniList typically removes just the markers (keep_content=True)
    
    Args:
        text: Text potentially containing spoiler tags
        spoiler_format: Format of spoiler tags to process
        keep_content: If True, remove only the tags and keep content.
                     If False, remove both tags and content.
        
    Returns:
        Text with spoiler tags processed according to keep_content setting
        
    Example:
        >>> text = "Start [spoiler]secret info[/spoiler] end"
        >>> strip_spoiler_content(text, SpoilerFormat.VNDB, keep_content=False)
        'Start  end'
        >>> strip_spoiler_content(text, SpoilerFormat.VNDB, keep_content=True)
        'Start secret info end'
    """
    if not text:
        return text
    
    if keep_content:
        # Remove only the tags, keep the content
        if spoiler_format == SpoilerFormat.VNDB:
            # Replace [spoiler] and [/spoiler] with empty string
            text = re.sub(r'\[spoiler\]', '', text, flags=re.IGNORECASE)
            text = re.sub(r'\[/spoiler\]', '', text, flags=re.IGNORECASE)
        elif spoiler_format == SpoilerFormat.ANILIST:
            # Replace ~! and !~ but keep content: ~!content!~ -> content
            text = re.sub(r'~!(.+?)!~', r'\1', text, flags=re.DOTALL)
    else:
        # Remove both tags and content
        pattern = SPOILER_PATTERNS.get(spoiler_format)
        if pattern:
            text = re.sub(pattern, '', text, flags=re.IGNORECASE | re.DOTALL)
    
    return text.strip()


def mask_spoiler_content(
    text: str,
    spoiler_format: SpoilerFormat = SpoilerFormat.VNDB,
    mask_text: str = "[SPOILER]"
) -> str:
    """
    Replace spoiler content with a placeholder mask.
    
    This is useful for displaying text where spoilers should be hidden but
    their presence should be indicated.
    
    Args:
        text: Text potentially containing spoiler tags
        spoiler_format: Format of spoiler tags to detect
        mask_text: Replacement text for spoiler content (default: "[SPOILER]")
        
    Returns:
        Text with spoiler content replaced by mask_text
        
    Example:
        >>> text = "The killer is [spoiler]the butler[/spoiler]!"
        >>> mask_spoiler_content(text, SpoilerFormat.VNDB)
        'The killer is [SPOILER]!'
        >>> text2 = "The ending: ~!everyone dies!~"
        >>> mask_spoiler_content(text2, SpoilerFormat.ANILIST, "[REDACTED]")
        'The ending: [REDACTED]'
    """
    if not text:
        return text
    
    pattern = SPOILER_PATTERNS.get(spoiler_format)
    if not pattern:
        return text
    
    return re.sub(pattern, mask_text, text, flags=re.IGNORECASE | re.DOTALL)


def has_vndb_spoiler_tags(text: str) -> bool:
    """
    Convenience function to check for VNDB spoiler tags.
    
    Args:
        text: Text to check
        
    Returns:
        True if text contains VNDB-style spoiler tags
    """
    return contains_spoiler_content(text, SpoilerFormat.VNDB)


def strip_vndb_spoiler_content(text: str) -> str:
    """
    Convenience function to remove VNDB spoiler tags and content.
    
    Args:
        text: Text potentially containing spoiler tags
        
    Returns:
        Text with VNDB spoiler content removed
    """
    return strip_spoiler_content(text, SpoilerFormat.VNDB, keep_content=False)


def has_anilist_spoiler_tags(text: str) -> bool:
    """
    Convenience function to check for AniList spoiler tags.
    
    Args:
        text: Text to check
        
    Returns:
        True if text contains AniList-style spoiler tags
    """
    return contains_spoiler_content(text, SpoilerFormat.ANILIST)


def strip_anilist_spoiler_tags(text: str) -> str:
    """
    Convenience function to remove AniList spoiler markers (keeping content).
    
    Args:
        text: Text potentially containing spoiler tags
        
    Returns:
        Text with AniList spoiler markers removed but content preserved
    """
    return strip_spoiler_content(text, SpoilerFormat.ANILIST, keep_content=True)
