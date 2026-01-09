"""
Yomitan dictionary builder package.

This package provides components for building Yomitan-compatible dictionary files
from VNDB character data.

Components:
- YomitanDictBuilder: Main orchestrating class for building dictionaries
- NameParser: Handles Japanese name parsing and reading generation
- ImageHandler: Manages image decoding and formatting
- ContentBuilder: Builds Yomitan structured content for character cards
"""

from .dict_builder import YomitanDictBuilder
from .name_parser import NameParser
from .image_handler import ImageHandler
from .content_builder import ContentBuilder

__all__ = [
    'YomitanDictBuilder',
    'NameParser',
    'ImageHandler',
    'ContentBuilder',
]
