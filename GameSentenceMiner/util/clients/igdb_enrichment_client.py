"""
IGDB enrichment helpers for imported game metadata.

This module is intentionally standalone and is not wired into the existing
import flow. It is a probe client that shows:

1. What extra metadata can be resolved from IGDB.
2. Which of those fields can be merged into the current GSM schema without
   changing any existing models or routes.
3. Which fields are only useful for future schema/UI work.
"""

from __future__ import annotations

import json
import os
from datetime import UTC, datetime, timedelta
from typing import Any, Dict, Iterable, List, Optional
from urllib.parse import urlparse

import requests

from GameSentenceMiner.util.clients.igdb_api_client import IGDBApiClient
from GameSentenceMiner.util.config.configuration import logger


class IGDBEnrichmentClient:
    """Resolve richer IGDB metadata for an imported game."""

    OAUTH_URL = "https://id.twitch.tv/oauth2/token"
    BASE_URL = "https://api.igdb.com/v4"
    TIMEOUT = 20
    ENV_CLIENT_ID = "IGDB_CLIENT_ID"
    ENV_CLIENT_SECRET = "IGDB_CLIENT_SECRET"
    GAME_FIELDS = (
        "fields "
        "name,slug,summary,storyline,url,"
        "genres.name,themes.name,keywords.name,game_modes.name,player_perspectives.name,"
        "platforms.name,"
        "involved_companies.company.name,involved_companies.developer,involved_companies.publisher,"
        "collections.name,franchises.name,"
        "first_release_date,release_dates.date,release_dates.human,release_dates.platform.name,"
        "websites.url,websites.category,"
        "screenshots.image_id,artworks.image_id,videos.video_id,"
        "aggregated_rating,aggregated_rating_count,rating,rating_count,total_rating,total_rating_count;"
    )
    IMAGE_BASE_URL = "https://images.igdb.com/igdb/image/upload"
    WEBSITE_CATEGORY_LABELS = {
        1: "Official",
        2: "Wikia",
        3: "Wikipedia",
        4: "Facebook",
        5: "Twitter",
        6: "Twitch",
        8: "Instagram",
        9: "YouTube",
        10: "iPhone",
        11: "iPad",
        12: "Android",
        13: "Steam",
        14: "Reddit",
        15: "Itch",
        16: "Epic Games",
        17: "GOG",
        18: "Discord",
        19: "Bluesky",
    }

    def __init__(
        self,
        client_id: Optional[str] = None,
        client_secret: Optional[str] = None,
        session: Optional[requests.Session] = None,
    ):
        self.client_id = client_id or os.getenv(self.ENV_CLIENT_ID, "").strip()
        self.client_secret = client_secret or os.getenv(self.ENV_CLIENT_SECRET, "").strip()
        self.session = session or requests.Session()
        self._access_token: Optional[str] = None
        self._access_token_expires_at: Optional[datetime] = None

    def build_import_probe(self, url_or_slug: str) -> Dict[str, Any]:
        """
        Build an exploratory IGDB enrichment payload for imported metadata.

        Returns a dictionary with:
        - source_metadata: normalized imported metadata
        - igdb: normalized IGDB metadata
        - merge_candidate: fields that fit the current GSM schema
        - future_candidates: fields that would need schema/UI work
        """
        source_metadata = IGDBApiClient.fetch_game_metadata(url_or_slug)
        if not source_metadata:
            return {
                "source_metadata": None,
                "igdb": None,
                "merge_candidate": None,
                "future_candidates": None,
                "error": "Source metadata could not be fetched.",
            }

        igdb_game = self.fetch_game_for_import(source_metadata)
        if not igdb_game:
            return {
                "source_metadata": source_metadata,
                "igdb": None,
                "merge_candidate": None,
                "future_candidates": None,
                "error": "No IGDB match could be resolved from imported metadata.",
            }

        igdb_metadata = self.normalize_igdb_game(igdb_game)
        return {
            "source_metadata": source_metadata,
            "igdb": igdb_metadata,
            "merge_candidate": self.build_merge_candidate(source_metadata, igdb_metadata),
            "future_candidates": self.build_future_candidates(igdb_metadata),
            "error": None,
        }

    def fetch_game_for_import(self, source_metadata: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Fetch the best IGDB game match for normalized imported metadata."""
        igdb_slug = self.extract_igdb_slug(source_metadata.get("links"))
        if igdb_slug:
            game = self.fetch_game_by_slug(igdb_slug)
            if game:
                return game

        title = source_metadata.get("title_original") or source_metadata.get("title_english") or ""
        release_year = None
        release_date = source_metadata.get("release_date") or ""
        if len(release_date) >= 4 and release_date[:4].isdigit():
            release_year = int(release_date[:4])

        return self.search_best_game_match(title=title, release_year=release_year)

    def fetch_game_by_slug(self, slug: str) -> Optional[Dict[str, Any]]:
        """Fetch a single IGDB game by slug."""
        if not slug:
            return None
        query = f'{self.GAME_FIELDS} where slug = "{self._escape_apicalypse_string(slug)}"; limit 1;'
        items = self._post("games", query)
        return items[0] if items else None

    def search_best_game_match(self, title: str, release_year: Optional[int] = None) -> Optional[Dict[str, Any]]:
        """Fallback search when imported metadata does not expose a usable IGDB slug."""
        if not title:
            return None

        escaped_title = self._escape_apicalypse_string(title)
        query = f'{self.GAME_FIELDS} search "{escaped_title}"; where version_parent = null; limit 10;'
        items = self._post("games", query)
        if not items:
            return None

        scored_items = sorted(
            items,
            key=lambda item: self._score_search_match(item, title=title, release_year=release_year),
            reverse=True,
        )
        best = scored_items[0]
        return best if self._score_search_match(best, title=title, release_year=release_year) > 0 else None

    def normalize_igdb_game(self, game: Dict[str, Any]) -> Dict[str, Any]:
        """Normalize an IGDB game into GSM-friendly exploratory metadata."""
        developers = []
        publishers = []
        for company in game.get("involved_companies", []):
            company_name = company.get("company", {}).get("name", "").strip()
            if not company_name:
                continue
            if company.get("developer"):
                developers.append(company_name)
            if company.get("publisher"):
                publishers.append(company_name)

        genres = self._collect_names(game.get("genres"))
        themes = self._collect_names(game.get("themes"))
        keywords = self._collect_names(game.get("keywords"))
        game_modes = self._collect_names(game.get("game_modes"))
        player_perspectives = self._collect_names(game.get("player_perspectives"))
        platforms = self._collect_names(game.get("platforms"))
        collections = self._collect_names(game.get("collections"))
        franchises = self._collect_names(game.get("franchises"))

        tags = self._dedupe_strings(
            [f"Theme: {value}" for value in themes]
            + [f"Keyword: {value}" for value in keywords]
            + [f"Mode: {value}" for value in game_modes]
            + [f"Perspective: {value}" for value in player_perspectives]
            + [f"Collection: {value}" for value in collections]
            + [f"Franchise: {value}" for value in franchises]
            + [f"Platform: {value}" for value in platforms]
        )

        screenshot_urls = [
            self.build_image_url(item.get("image_id"), size="screenshot_big")
            for item in game.get("screenshots", [])
            if item.get("image_id")
        ]
        artwork_urls = [
            self.build_image_url(item.get("image_id"), size="1080p")
            for item in game.get("artworks", [])
            if item.get("image_id")
        ]
        video_urls = [
            f"https://www.youtube.com/watch?v={item.get('video_id')}"
            for item in game.get("videos", [])
            if item.get("video_id")
        ]

        links = []
        if game.get("url"):
            links.append({"url": game["url"], "linkType": 1})
        for website in game.get("websites", []):
            url = str(website.get("url", "")).strip()
            if not url:
                continue
            links.append({"url": url, "linkType": 1})

        release_dates = sorted(
            [
                {
                    "human": item.get("human", ""),
                    "iso_date": self._unix_to_iso_date(item.get("date")),
                    "platform": item.get("platform", {}).get("name", ""),
                }
                for item in game.get("release_dates", [])
                if item.get("date")
            ],
            key=lambda item: item["iso_date"],
        )

        normalized = {
            "igdb_slug": game.get("slug", ""),
            "igdb_url": game.get("url", ""),
            "title": game.get("name", ""),
            "summary": game.get("summary", ""),
            "storyline": game.get("storyline", ""),
            "description_candidate": game.get("summary", "") or game.get("storyline", ""),
            "release_date": self._unix_to_iso_date(game.get("first_release_date")),
            "release_dates": release_dates,
            "genres": genres,
            "tags": tags,
            "links": self._dedupe_links(links),
            "platforms": platforms,
            "developers": self._dedupe_strings(developers),
            "publishers": self._dedupe_strings(publishers),
            "collections": collections,
            "franchises": franchises,
            "game_modes": game_modes,
            "player_perspectives": player_perspectives,
            "themes": themes,
            "keywords": keywords,
            "ratings": {
                "aggregated_rating": game.get("aggregated_rating"),
                "aggregated_rating_count": game.get("aggregated_rating_count"),
                "rating": game.get("rating"),
                "rating_count": game.get("rating_count"),
                "total_rating": game.get("total_rating"),
                "total_rating_count": game.get("total_rating_count"),
            },
            "assets": {
                "screenshots": screenshot_urls,
                "artworks": artwork_urls,
                "videos": video_urls,
            },
            "website_categories": self._collect_website_categories(game.get("websites")),
        }
        logger.info(f"IGDB normalized enrichment: {json.dumps(normalized, ensure_ascii=False)}")
        return normalized

    @classmethod
    def build_merge_candidate(
        cls,
        source_metadata: Dict[str, Any],
        igdb_metadata: Dict[str, Any],
    ) -> Dict[str, Any]:
        """Build the subset of IGDB metadata that fits the current GSM schema."""
        source_description = str(source_metadata.get("description", "")).strip()
        igdb_description = str(igdb_metadata.get("description_candidate", "")).strip()

        description = source_description
        if len(igdb_description) > len(source_description):
            description = igdb_description

        return {
            "description": description,
            "release_date": igdb_metadata.get("release_date") or source_metadata.get("release_date", ""),
            "genres": cls._dedupe_strings(
                list(source_metadata.get("genres", [])) + list(igdb_metadata.get("genres", []))
            ),
            "tags": cls._dedupe_strings(list(source_metadata.get("tags", [])) + list(igdb_metadata.get("tags", []))),
            "links": cls._dedupe_links(list(source_metadata.get("links", [])) + list(igdb_metadata.get("links", []))),
        }

    @classmethod
    def apply_merge_candidate(
        cls,
        source_metadata: Dict[str, Any],
        igdb_metadata: Dict[str, Any],
    ) -> Dict[str, Any]:
        """Return imported metadata with schema-compatible IGDB fields merged in."""
        merged = dict(source_metadata)
        merge_candidate = cls.build_merge_candidate(source_metadata, igdb_metadata)
        for field_name in ("description", "release_date", "genres", "tags", "links"):
            if merge_candidate.get(field_name):
                merged[field_name] = merge_candidate[field_name]
        return merged

    @staticmethod
    def build_future_candidates(igdb_metadata: Dict[str, Any]) -> Dict[str, Any]:
        """Build fields that are useful but do not fit the current GSM schema."""
        return {
            "developers": igdb_metadata.get("developers", []),
            "publishers": igdb_metadata.get("publishers", []),
            "platforms": igdb_metadata.get("platforms", []),
            "collections": igdb_metadata.get("collections", []),
            "franchises": igdb_metadata.get("franchises", []),
            "game_modes": igdb_metadata.get("game_modes", []),
            "player_perspectives": igdb_metadata.get("player_perspectives", []),
            "themes": igdb_metadata.get("themes", []),
            "keywords": igdb_metadata.get("keywords", []),
            "ratings": igdb_metadata.get("ratings", {}),
            "assets": igdb_metadata.get("assets", {}),
            "website_categories": igdb_metadata.get("website_categories", []),
        }

    @classmethod
    def extract_igdb_slug(cls, links: Optional[Iterable[Any]]) -> str:
        """Extract an IGDB slug from a GSM links array."""
        for link in links or []:
            if isinstance(link, dict):
                url = str(link.get("url", "")).strip()
            else:
                url = str(link).strip()
            if not url or "igdb.com/games/" not in url:
                continue

            parsed = urlparse(url)
            parts = [part for part in parsed.path.split("/") if part]
            try:
                games_index = parts.index("games")
            except ValueError:
                continue

            if games_index + 1 < len(parts):
                return parts[games_index + 1]
        return ""

    @classmethod
    def build_image_url(cls, image_id: str, size: str = "screenshot_big") -> str:
        """Construct an IGDB CDN image URL from an image id."""
        if not image_id:
            return ""
        return f"{cls.IMAGE_BASE_URL}/t_{size}/{image_id}.jpg"

    def _get_access_token(self) -> str:
        """Get or refresh an IGDB OAuth token."""
        if not self.client_id or not self.client_secret:
            raise ValueError(
                "IGDB credentials are required. Set IGDB_CLIENT_ID and IGDB_CLIENT_SECRET or pass them explicitly."
            )

        now = datetime.now(UTC)
        if self._access_token and self._access_token_expires_at and now < self._access_token_expires_at:
            return self._access_token

        response = self.session.post(
            self.OAUTH_URL,
            params={
                "client_id": self.client_id,
                "client_secret": self.client_secret,
                "grant_type": "client_credentials",
            },
            timeout=self.TIMEOUT,
        )
        response.raise_for_status()
        payload = response.json()

        self._access_token = payload["access_token"]
        expires_in = int(payload.get("expires_in", 0))
        self._access_token_expires_at = now + timedelta(seconds=max(expires_in - 60, 0))
        return self._access_token

    def _post(self, endpoint: str, query: str) -> List[Dict[str, Any]]:
        """Run a POST request against an IGDB endpoint."""
        token = self._get_access_token()
        response = self.session.post(
            f"{self.BASE_URL}/{endpoint}",
            headers={
                "Client-ID": self.client_id,
                "Authorization": f"Bearer {token}",
                "Accept": "application/json",
            },
            data=query,
            timeout=self.TIMEOUT,
        )
        response.raise_for_status()
        return response.json()

    @classmethod
    def _score_search_match(cls, item: Dict[str, Any], title: str, release_year: Optional[int]) -> int:
        """Score a fallback IGDB search match."""
        score = 0
        item_name = str(item.get("name", "")).strip().lower()
        wanted_name = str(title).strip().lower()
        if not item_name or not wanted_name:
            return score

        if item_name == wanted_name:
            score += 100
        elif item_name.startswith(wanted_name) or wanted_name.startswith(item_name):
            score += 70
        elif wanted_name in item_name or item_name in wanted_name:
            score += 50

        if release_year:
            item_release_date = cls._unix_to_iso_date(item.get("first_release_date"))
            if len(item_release_date) >= 4 and item_release_date[:4].isdigit():
                item_year = int(item_release_date[:4])
                if item_year == release_year:
                    score += 25
                elif abs(item_year - release_year) == 1:
                    score += 10

        return score

    @classmethod
    def _collect_names(cls, items: Optional[Iterable[Dict[str, Any]]]) -> List[str]:
        return cls._dedupe_strings(
            [
                str(item.get("name", "")).strip()
                for item in items or []
                if isinstance(item, dict) and str(item.get("name", "")).strip()
            ]
        )

    @classmethod
    def _collect_website_categories(cls, items: Optional[Iterable[Dict[str, Any]]]) -> List[str]:
        values = []
        for item in items or []:
            category = item.get("category")
            if category is None:
                continue
            label = cls.WEBSITE_CATEGORY_LABELS.get(category, f"Category {category}")
            values.append(label)
        return cls._dedupe_strings(values)

    @staticmethod
    def _escape_apicalypse_string(value: str) -> str:
        return str(value).replace("\\", "\\\\").replace('"', '\\"')

    @staticmethod
    def _unix_to_iso_date(value: Any) -> str:
        if value in (None, ""):
            return ""
        try:
            return datetime.fromtimestamp(int(value), tz=UTC).strftime("%Y-%m-%d")
        except (TypeError, ValueError, OSError):
            return ""

    @staticmethod
    def _dedupe_strings(values: Iterable[str]) -> List[str]:
        deduped = []
        seen = set()
        for value in values:
            normalized = str(value).strip()
            if not normalized:
                continue
            key = normalized.casefold()
            if key in seen:
                continue
            deduped.append(normalized)
            seen.add(key)
        return deduped

    @staticmethod
    def _dedupe_links(values: Iterable[Any]) -> List[Dict[str, Any]]:
        deduped = []
        seen = set()
        for value in values:
            if isinstance(value, dict):
                url = str(value.get("url", "")).strip()
                normalized = dict(value)
            else:
                url = str(value).strip()
                normalized = {"url": url, "linkType": 1}
            if not url:
                continue
            key = url.lower()
            if key in seen:
                continue
            if "linkType" not in normalized:
                normalized["linkType"] = 1
            deduped.append(normalized)
            seen.add(key)
        return deduped
