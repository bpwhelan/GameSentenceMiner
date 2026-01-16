"""
VNDB Yomitan Dictionary Scraper.

This package provides tools to scrape ALL visual novels from VNDB and generate
a Yomitan dictionary containing character names.

Components:
- VNDBScraper: Main scraping class that fetches VN and character data
- RateLimiter: Handles VNDB API rate limiting with persistence for resumability
- VNDBDictBuilder: Builds the final Yomitan dictionary from scraped data

Usage:
    # Start/resume scraping
    python -m GameSentenceMiner.util.vndb_yomitan_scraper.scraper

    # Build dictionary from scraped data
    python -m GameSentenceMiner.util.vndb_yomitan_scraper.dict_builder
"""

from .scraper import VNDBScraper
from .rate_limiter import RateLimiter


def __getattr__(name):
    """Lazy import for VNDBDictBuilder to avoid loading heavy dependencies."""
    if name == "VNDBDictBuilder":
        from .dict_builder import VNDBDictBuilder
        return VNDBDictBuilder
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


__all__ = [
    'VNDBScraper',
    'RateLimiter',
    'VNDBDictBuilder',
]
