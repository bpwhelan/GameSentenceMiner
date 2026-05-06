"""
GSM Cloud-backed IGDB client.

This client keeps IGDB credentials off end-user machines by calling GSM Cloud
worker endpoints that perform IGDB lookup server-side.
"""

from __future__ import annotations

from typing import Any, Dict, Optional
from urllib.parse import urlparse

import requests
from GameSentenceMiner.util.config.configuration import get_config, get_current_version, logger


class GSMCloudIGDBClient:
    """Fetch normalized IGDB metadata from GSM Cloud."""

    GAME_ENDPOINT_PATH = "/api/cloud/igdb/game"
    SEARCH_ENDPOINT_PATH = "/api/cloud/igdb/search"
    TIMEOUT = 8
    MARKER_CLIENT = "gsm-desktop"

    @classmethod
    def search_games(cls, query: str, limit: int = 10) -> Optional[Dict[str, Any]]:
        """Search IGDB through GSM Cloud and return normalized results."""
        normalized_query = str(query or "").strip()
        if not normalized_query:
            return {"results": []}

        payload = cls._post_json(
            cls.SEARCH_ENDPOINT_PATH,
            {"query": normalized_query, "limit": max(1, min(int(limit or 10), 20))},
        )
        if not payload:
            return None

        results = payload.get("results")
        if not isinstance(results, list):
            return None

        return {
            "results": results,
            "total": payload.get("total", len(results)),
            "source": payload.get("source", "igdb"),
        }

    @classmethod
    def fetch_igdb_game(cls, url_or_slug: str) -> Optional[Dict[str, Any]]:
        """Fetch normalized IGDB metadata from GSM Cloud by slug or IGDB URL."""
        igdb_slug = cls.extract_igdb_slug(url_or_slug)
        if not igdb_slug:
            return None

        payload = cls._post_json(cls.GAME_ENDPOINT_PATH, {"igdb_slug": igdb_slug})
        if not payload:
            return None

        igdb_metadata = payload.get("igdb")
        if not isinstance(igdb_metadata, dict):
            return None

        return igdb_metadata

    @classmethod
    def enrich_igdb_metadata(cls, game_metadata: Dict[str, Any]) -> Dict[str, Any]:
        """Return IGDB metadata enriched with schema-compatible IGDB fields when available."""
        from GameSentenceMiner.util.clients.igdb_enrichment_client import IGDBEnrichmentClient

        base_metadata = dict(game_metadata)
        if not base_metadata.get("tags") and base_metadata.get("platforms"):
            base_metadata["tags"] = [f"Platform: {platform}" for platform in base_metadata["platforms"]]

        igdb_metadata = cls.fetch_related_igdb_metadata(base_metadata)
        if not igdb_metadata:
            return base_metadata

        return IGDBEnrichmentClient.apply_merge_candidate(base_metadata, igdb_metadata)

    @classmethod
    def fetch_related_igdb_metadata(cls, game_metadata: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Fetch related IGDB metadata for an existing normalized metadata payload."""
        from GameSentenceMiner.util.clients.igdb_enrichment_client import IGDBEnrichmentClient

        igdb_slug = IGDBEnrichmentClient.extract_igdb_slug(game_metadata.get("links"))
        if not igdb_slug:
            return None

        igdb_metadata = cls.fetch_igdb_game(igdb_slug)
        if igdb_metadata:
            logger.info(f"GSM Cloud IGDB enrichment succeeded for slug '{igdb_slug}'")
        return igdb_metadata

    @classmethod
    def extract_igdb_slug(cls, url_or_slug: str) -> str:
        """Extract an IGDB slug from a bare slug or IGDB URL."""
        value = str(url_or_slug or "").strip()
        if not value:
            return ""

        if "://" not in value:
            return value if cls._is_valid_slug(value) else ""

        try:
            parsed = urlparse(value)
        except ValueError:
            return ""

        parts = [part for part in parsed.path.split("/") if part]
        try:
            games_index = parts.index("games")
        except ValueError:
            return ""

        if games_index + 1 >= len(parts):
            return ""

        candidate = parts[games_index + 1]
        return candidate if cls._is_valid_slug(candidate) else ""

    @staticmethod
    def _is_valid_slug(value: str) -> bool:
        normalized = str(value or "").strip()
        if not normalized:
            return False
        return all(char.isalnum() or char == "-" for char in normalized)

    @classmethod
    def _post_json(cls, endpoint_path: str, payload: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        url = f"{cls._get_base_url()}{endpoint_path}"
        try:
            response = requests.post(
                url,
                json=payload,
                headers=cls._build_headers(),
                timeout=cls.TIMEOUT,
            )
        except requests.RequestException as exc:
            logger.debug(f"GSM Cloud IGDB request failed for '{endpoint_path}': {exc}")
            return None

        if response.status_code != 200:
            logger.debug(
                f"GSM Cloud IGDB request returned status {response.status_code} for '{endpoint_path}': "
                f"{response.text[:200]}"
            )
            return None

        try:
            return response.json()
        except ValueError:
            logger.debug(f"GSM Cloud IGDB request returned invalid JSON for '{endpoint_path}'")
            return None

    @classmethod
    def _build_headers(cls) -> Dict[str, str]:
        version = cls._get_version()
        return {
            "Content-Type": "application/json",
            "User-Agent": f"GameSentenceMiner/{version}",
            "X-GSM-Client": cls.MARKER_CLIENT,
            "X-GSM-Version": version,
        }

    @classmethod
    def _get_base_url(cls) -> str:
        current = get_config()
        base_url = str(current.ai.gsm_cloud_api_url or "").strip().rstrip("/")
        if not base_url:
            base_url = "https://api.gamesentenceminer.com"
        return base_url

    @staticmethod
    def _get_version() -> str:
        return get_current_version() or "dev"
