"""
IGDB API client.

Game metadata and search resolve directly through IGDB via GSM Cloud.
"""

from __future__ import annotations

import base64
import io
from typing import Any, Dict, Iterable, List, Optional
from urllib.parse import urlparse

import requests
from PIL import Image

from GameSentenceMiner.util.clients.gsm_cloud_igdb_client import GSMCloudIGDBClient
from GameSentenceMiner.util.config.configuration import logger
from GameSentenceMiner.util.shared.base_api_client import BaseApiClient
from GameSentenceMiner.util.shared.image_utils import convert_image_to_rgb


class IGDBApiClient(BaseApiClient):
    """IGDB wrapper over GSM Cloud lookups."""

    BASE_URL = "https://www.igdb.com"
    TIMEOUT = 15
    USER_AGENT = (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36"
    )

    @classmethod
    def search_game(cls, query: str, **kwargs) -> Optional[Dict]:
        """Implementation of BaseApiClient.search_game()."""
        return cls.search_games(query, limit=kwargs.get("limit", 10))

    @classmethod
    def get_game_details(cls, game_id: str, **kwargs) -> Optional[Dict]:
        """Implementation of BaseApiClient.get_game_details()."""
        return cls.fetch_game_metadata(game_id, result_type=kwargs.get("result_type"))

    @classmethod
    def get_characters(cls, game_id: str, **kwargs) -> Optional[List[Dict]]:
        """IGDB metadata path does not expose character data in GSM."""
        logger.debug(f"IGDB has no character data for {game_id} in this client")
        return []

    @classmethod
    def _request(cls, url: str, **kwargs) -> requests.Response:
        headers = {
            "User-Agent": cls.USER_AGENT,
            "Accept": kwargs.pop("accept", "text/html,application/xhtml+xml"),
        }
        return requests.get(url, headers=headers, timeout=cls.TIMEOUT, **kwargs)

    @classmethod
    def _normalize_igdb_url(cls, url_or_path: str) -> str:
        """Normalize a slug or game URL into a canonical IGDB page URL."""
        value = str(url_or_path or "").strip()
        if not value:
            return ""

        if value.startswith("http://") or value.startswith("https://"):
            try:
                parsed = urlparse(value)
            except ValueError:
                return ""

            slug = cls._extract_slug_from_path(parsed.path)
            return cls._build_igdb_page_url(slug) if slug else ""

        try:
            parsed = urlparse(value)
            if parsed.path:
                slug = cls._extract_slug_from_path(parsed.path)
                if slug:
                    return cls._build_igdb_page_url(slug)
        except ValueError:
            pass

        slug = cls._extract_slug_from_path(value)
        return cls._build_igdb_page_url(slug) if slug else ""

    @staticmethod
    def _normalize_image_url(image_url: Optional[str]) -> Optional[str]:
        if not image_url:
            return None
        if image_url.startswith("//"):
            image_url = f"https:{image_url}"
        if image_url.startswith("/"):
            image_url = f"https://images.igdb.com{image_url}"
        if "t_cover_big_2x" in image_url:
            return image_url
        if "t_cover_big/" in image_url:
            return image_url.replace("t_cover_big/", "t_cover_big_2x/")
        return image_url

    @staticmethod
    def _build_link(url: str, link_type: int = 1) -> Dict[str, Any]:
        return {"url": url, "linkType": link_type}

    @classmethod
    def _build_igdb_page_url(cls, slug: str) -> str:
        normalized = str(slug or "").strip().strip("/")
        return f"{cls.BASE_URL}/games/{normalized}" if normalized else ""

    @staticmethod
    def _extract_slug_from_path(value: str) -> str:
        parts = [part for part in str(value or "").split("/") if part]
        try:
            games_index = parts.index("games")
            if games_index + 1 < len(parts):
                return parts[games_index + 1].strip()
        except ValueError:
            pass

        if len(parts) == 1:
            return parts[0].strip()
        return ""

    @classmethod
    def _dedupe_links(cls, values: Iterable[Any]) -> List[Dict[str, Any]]:
        deduped = []
        seen = set()
        for value in values:
            if isinstance(value, dict):
                url = str(value.get("url", "")).strip()
                normalized = dict(value)
            else:
                url = str(value or "").strip()
                normalized = cls._build_link(url)
            if not url:
                continue
            key = url.casefold()
            if key in seen:
                continue
            if "linkType" not in normalized:
                normalized["linkType"] = 1
            deduped.append(normalized)
            seen.add(key)
        return deduped

    @staticmethod
    def _first_number(*values: Any) -> Optional[float]:
        for value in values:
            if isinstance(value, bool):
                continue
            if isinstance(value, (int, float)):
                return float(value)
        return None

    @classmethod
    def extract_igdb_url(cls, links: List[Any]) -> Optional[str]:
        """Extract the first canonical IGDB game URL from stored links."""
        for link in links or []:
            url = link if isinstance(link, str) else (link.get("url", "") if isinstance(link, dict) else "")
            normalized = cls._normalize_igdb_url(url)
            if normalized and "/games/" in normalized:
                return normalized
        return None

    @classmethod
    def search_games(cls, query: str, limit: int = 10) -> Optional[Dict]:
        """Search IGDB via GSM Cloud and return GSM-normalized result data."""
        try:
            payload = GSMCloudIGDBClient.search_games(query, limit=limit)
            if not payload:
                logger.warning(f"IGDB search returned no data for '{query}'")
                return None

            results = []
            for item in payload.get("results", []):
                title = str(item.get("title", "")).strip()
                igdb_slug = str(item.get("igdb_slug", "")).strip()
                igdb_url = cls._normalize_igdb_url(item.get("igdb_url") or igdb_slug)
                igdb_id = str(item.get("igdb_id", "")).strip()
                results.append(
                    {
                        "id": igdb_id,
                        "igdb_id": igdb_id,
                        "igdb_slug": igdb_slug,
                        "slug": igdb_slug,
                        "source_url": igdb_url,
                        "igdb_url": igdb_url,
                        "title": title,
                        "title_original": str(item.get("title_original", "")).strip() or title,
                        "title_romaji": str(item.get("title_romaji", "")).strip() or title,
                        "title_english": str(item.get("title_english", "")).strip() or title,
                        "year": str(item.get("year", "")).strip(),
                        "result_type": str(item.get("result_type", "")).strip() or "Game",
                        "platforms": list(item.get("platforms", []) or []),
                        "cover_url": cls._normalize_image_url(item.get("cover_url")),
                    }
                )

            return {"results": results, "total": payload.get("total", len(results))}

        except Exception as exc:
            logger.warning(f"Unexpected IGDB search error for '{query}': {exc}")
            return None

    @classmethod
    def fetch_game_metadata(cls, url_or_slug: str, result_type: Optional[str] = None) -> Optional[Dict]:
        """Fetch detailed metadata via IGDB and return GSM-normalized result data."""
        try:
            normalized_lookup = cls._normalize_igdb_url(url_or_slug)
            if not normalized_lookup:
                logger.warning(f"Unable to normalize IGDB lookup target from '{url_or_slug}'")
                return None

            igdb_metadata = GSMCloudIGDBClient.fetch_igdb_game(normalized_lookup)
            if not igdb_metadata:
                logger.warning(f"IGDB metadata returned no result for '{url_or_slug}'")
                return None

            title = str(igdb_metadata.get("title", "")).strip()
            igdb_slug = str(igdb_metadata.get("igdb_slug", "")).strip()
            igdb_url = cls._normalize_igdb_url(igdb_metadata.get("igdb_url") or igdb_slug or normalized_lookup)
            links = cls._dedupe_links([cls._build_link(igdb_url)] + list(igdb_metadata.get("links", []) or []))
            ratings = igdb_metadata.get("ratings", {}) or {}
            igdb_id = str(igdb_metadata.get("igdb_id", "")).strip()

            metadata = {
                "id": igdb_id,
                "igdb_id": igdb_id,
                "slug": igdb_slug,
                "parent_game_slug": "",
                "source_url": igdb_url,
                "igdb_url": igdb_url,
                "title_original": title,
                "title_romaji": title,
                "title_english": title,
                "description": str(igdb_metadata.get("description_candidate", "")).strip(),
                "release_date": str(igdb_metadata.get("release_date", "")).strip(),
                "cover_url": cls._normalize_image_url(igdb_metadata.get("cover_url")),
                "genres": list(igdb_metadata.get("genres", []) or []),
                "platforms": list(igdb_metadata.get("platforms", []) or []),
                "developers": list(igdb_metadata.get("developers", []) or []),
                "publishers": list(igdb_metadata.get("publishers", []) or []),
                "rating": cls._first_number(
                    ratings.get("rating"),
                    ratings.get("total_rating"),
                    ratings.get("aggregated_rating"),
                ),
                "rating_count": cls._first_number(
                    ratings.get("rating_count"),
                    ratings.get("total_rating_count"),
                    ratings.get("aggregated_rating_count"),
                ),
                "links": links,
                "tags": list(igdb_metadata.get("tags", []) or []),
                "result_type": result_type or str(igdb_metadata.get("result_type", "")).strip() or "Game",
                "media_type_string": str(igdb_metadata.get("media_type_string", "")).strip() or "Game",
            }
            logger.info(f"Direct IGDB normalized metadata: {metadata}")
            return metadata

        except Exception as exc:
            logger.warning(f"Unexpected IGDB metadata error for '{url_or_slug}': {exc}")
            return None

    @classmethod
    def download_cover_image(cls, image_url_or_page_url: str) -> Optional[str]:
        """Download a game cover image as base64 PNG."""
        image_url = image_url_or_page_url
        if image_url and "/games/" in image_url:
            metadata = cls.fetch_game_metadata(image_url)
            image_url = metadata.get("cover_url") if metadata else None

        image_url = cls._normalize_image_url(image_url)
        if not image_url:
            logger.info("IGDB cover download skipped: no image URL available")
            return None

        try:
            response = cls._request(
                image_url,
                accept="image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
            )
            if response.status_code != 200:
                logger.info(f"IGDB cover download failed with status {response.status_code} for {image_url}")
                return None

            image = Image.open(io.BytesIO(response.content))
            image = convert_image_to_rgb(image)
            image.thumbnail(cls.COVER_IMAGE_SIZE, Image.Resampling.LANCZOS)

            buffer = io.BytesIO()
            image.save(buffer, format="PNG", optimize=True)
            buffer.seek(0)

            image_base64 = base64.b64encode(buffer.getvalue()).decode("utf-8")
            logger.info(f"IGDB cover download succeeded for {image_url}")
            return f"data:image/png;base64,{image_base64}"
        except requests.RequestException as exc:
            logger.info(f"IGDB cover download request failed for {image_url}: {exc}")
            return None
        except Exception as exc:
            logger.info(f"IGDB cover download processing failed for {image_url}: {exc}")
            return None
