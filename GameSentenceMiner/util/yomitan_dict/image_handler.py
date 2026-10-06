"""Image handling for Yomitan dictionary creation."""

import base64
import hashlib
import io
import uuid
from pathlib import Path
from typing import Tuple

from PIL import Image

from GameSentenceMiner.util.config.configuration import logger
from GameSentenceMiner.util.data_directory import get_app_directory
from GameSentenceMiner.util.shared.image_utils import THUMBNAIL_SIZE, fetch_original_image_as_base64


class ImageHandler:
    """
    Handles image processing for Yomitan dictionaries.

    This class manages:
    - Decoding base64-encoded images
    - Determining image format from data URI
    - Creating image filenames for ZIP storage
    - Recovering original portraits for previously stored thumbnails
    """

    def get_character_image(self, char: dict) -> tuple[str, bytes] | None:
        """Use saved originals, recovering legacy thumbnails from their source URL."""
        saved_image = None
        if char.get("image_base64"):
            saved_image = self.decode_image(char["image_base64"], char["id"])

        image_url = char.get("image_url")
        if not image_url:
            return saved_image

        if saved_image:
            try:
                with Image.open(io.BytesIO(saved_image[1])) as image:
                    if image.width > THUMBNAIL_SIZE[0] or image.height > THUMBNAIL_SIZE[1]:
                        return saved_image
            except OSError:
                pass

        original = self._fetch_cached_original(image_url)
        return self.decode_image(original, char["id"]) if original else saved_image

    def _fetch_cached_original(self, image_url: str) -> str | None:
        """Cache recovered portraits across dictionary downloads and app restarts."""
        cache_path = None
        try:
            cache_key = hashlib.sha256(image_url.encode("utf-8")).hexdigest()
            cache_path = Path(get_app_directory()) / "cache" / "character_images" / f"{cache_key}.data-uri"
            cached = cache_path.read_text(encoding="ascii")
            _, image_bytes = self.decode_image(cached, "cache")
            with Image.open(io.BytesIO(image_bytes)) as image:
                image.verify()
            return cached
        except (OSError, ValueError):
            pass

        original = fetch_original_image_as_base64(image_url)
        if original and cache_path:
            temporary = cache_path.with_suffix(f".{uuid.uuid4().hex}.tmp")
            try:
                cache_path.parent.mkdir(parents=True, exist_ok=True)
                temporary.write_text(original, encoding="ascii")
                temporary.replace(cache_path)
            except OSError as error:
                logger.debug(f"Failed to cache character image: {error}")
            finally:
                try:
                    temporary.unlink(missing_ok=True)
                except OSError as error:
                    logger.debug(f"Failed to clean up temporary character image: {error}")
        return original

    def decode_image(self, base64_data: str, char_id: str) -> Tuple[str, bytes]:
        """
        Decode a base64-encoded image.

        Args:
            base64_data: Base64 string, may include data URI prefix
            char_id: Character ID for generating filename

        Returns:
            Tuple of (filename, image_bytes)
        """
        # Strip "data:image/jpeg;base64," or similar prefix if present
        if "," in base64_data:
            # Handle data URI format: "data:image/jpeg;base64,..."
            header, base64_data = base64_data.split(",", 1)
            # Determine extension from header
            if "png" in header.lower():
                ext = "png"
            elif "gif" in header.lower():
                ext = "gif"
            elif "webp" in header.lower():
                ext = "webp"
            else:
                ext = "jpg"  # Default to jpg
        else:
            ext = "jpg"  # Default extension

        # Decode base64 to bytes
        image_bytes = base64.b64decode(base64_data)
        filename = f"c{char_id}.{ext}"

        return filename, image_bytes

    def create_image_content(self, image_path: str) -> dict:
        """
        Create Yomitan structured content for an image.

        Args:
            image_path: Path to image within ZIP (e.g., "img/c12345.jpg")

        Returns:
            Yomitan image content dictionary
        """
        return {
            "tag": "img",
            "path": image_path,
            "width": 80,
            "height": 100,
            "sizeUnits": "px",
            "collapsible": False,
            "collapsed": False,
            "background": False,
        }

    def validate_image(self, base64_data: str) -> bool:
        """
        Validate that a base64 string represents a valid image.

        Args:
            base64_data: Base64 string to validate

        Returns:
            True if valid, False otherwise
        """
        if not base64_data:
            return False

        try:
            # Try to decode the base64
            if "," in base64_data:
                _, actual_data = base64_data.split(",", 1)
            else:
                actual_data = base64_data

            base64.b64decode(actual_data)
            return True
        except Exception:
            return False
