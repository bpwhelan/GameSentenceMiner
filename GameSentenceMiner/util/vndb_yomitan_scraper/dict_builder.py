"""Build Yomitan dictionary from scraped VNDB data."""

import argparse
import base64
import json
import os
from pathlib import Path
from typing import Dict, List, Optional, Iterator

from GameSentenceMiner.util.yomitan_dict import YomitanDictBuilder


class VNDBDictBuilder:
    """
    Build a Yomitan dictionary from scraped VNDB data.

    Processes JSON files from the scraper and creates a Yomitan-compatible
    ZIP file containing all character names.
    """

    DICT_TITLE = "VNDB Characters"
    BATCH_SIZE = 100  # Process VNs in batches for memory efficiency

    def __init__(self, data_dir: str = None):
        """
        Initialize the dictionary builder.

        Args:
            data_dir: Directory containing scraped data (default: vndb_scrape_data/)
        """
        if data_dir is None:
            gsm_root = Path(__file__).parent.parent.parent.parent
            data_dir = gsm_root / "vndb_scrape_data"

        self.data_dir = Path(data_dir)
        self.vns_dir = self.data_dir / "vns"
        self.images_dir = self.data_dir / "images"
        self.output_dir = self.data_dir / "output"

        # Ensure output directory exists
        self.output_dir.mkdir(parents=True, exist_ok=True)

    def _iter_vn_files(self) -> Iterator[Path]:
        """Iterate over all VN JSON files."""
        if not self.vns_dir.exists():
            return

        for filepath in sorted(self.vns_dir.glob("v*.json")):
            yield filepath

    def _load_vn(self, filepath: Path) -> Optional[Dict]:
        """Load a VN JSON file."""
        try:
            with open(filepath, 'r', encoding='utf-8') as f:
                return json.load(f)
        except (json.JSONDecodeError, IOError) as e:
            print(f"Error loading {filepath}: {e}")
            return None

    def _load_image_as_base64(self, image_path: str) -> Optional[str]:
        """
        Load an image file and convert to base64 data URI.

        Args:
            image_path: Relative path like "images/c12345.jpg"

        Returns:
            Base64 data URI string or None on failure
        """
        if not image_path:
            return None

        filepath = self.data_dir / image_path
        if not filepath.exists():
            return None

        try:
            with open(filepath, 'rb') as f:
                image_bytes = f.read()

            # Determine MIME type from extension
            ext = filepath.suffix.lower()
            mime_types = {
                '.jpg': 'image/jpeg',
                '.jpeg': 'image/jpeg',
                '.png': 'image/png',
                '.gif': 'image/gif',
                '.webp': 'image/webp'
            }
            mime_type = mime_types.get(ext, 'image/jpeg')

            # Create data URI
            b64_data = base64.b64encode(image_bytes).decode('ascii')
            return f"data:{mime_type};base64,{b64_data}"

        except IOError as e:
            print(f"Error loading image {filepath}: {e}")
            return None

    def _convert_character(self, char: Dict, game_title: str) -> Dict:
        """
        Convert scraped character format to YomitanDictBuilder format.

        Args:
            char: Character data from scraped JSON
            game_title: Title of the VN

        Returns:
            Character dict in format expected by YomitanDictBuilder
        """
        # Load image as base64 if available
        image_base64 = None
        if char.get("image_path"):
            image_base64 = self._load_image_as_base64(char["image_path"])

        return {
            "id": char.get("id", ""),
            "name": char.get("name", ""),
            "name_original": char.get("name_original", ""),
            "aliases": char.get("aliases", []),
            "role": char.get("role", "side"),
            "description": char.get("description"),
            "image_base64": image_base64,
            # Convert traits to the expected format
            "traits": char.get("traits", [])
        }

    def count_stats(self) -> Dict[str, int]:
        """Count total VNs and characters in scraped data."""
        vn_count = 0
        char_count = 0

        for filepath in self._iter_vn_files():
            vn_data = self._load_vn(filepath)
            if vn_data:
                vn_count += 1
                char_count += len(vn_data.get("characters", []))

        return {
            "vns": vn_count,
            "characters": char_count
        }

    def build(self, output_filename: str = "vndb_characters.zip",
              include_images: bool = True,
              skip_existing: bool = False) -> str:
        """
        Build the Yomitan dictionary from scraped data.

        Args:
            output_filename: Name of the output ZIP file
            include_images: Whether to include character images
            skip_existing: Skip if output file already exists

        Returns:
            Path to the generated ZIP file
        """
        output_path = self.output_dir / output_filename

        if skip_existing and output_path.exists():
            print(f"Output file already exists: {output_path}")
            return str(output_path)

        # Count files first
        vn_files = list(self._iter_vn_files())
        total_vns = len(vn_files)

        if total_vns == 0:
            print("No VN data found. Run the scraper first.")
            return ""

        print(f"Building dictionary from {total_vns} VNs...")

        # Create builder with custom title
        builder = YomitanDictBuilder(
            game_count=total_vns
        )
        builder.title = self.DICT_TITLE

        # Process VNs
        processed = 0
        char_count = 0

        for filepath in vn_files:
            vn_data = self._load_vn(filepath)
            if vn_data is None:
                continue

            # Get game title
            game_title = (
                vn_data.get("title_original") or
                vn_data.get("title") or
                vn_data.get("id", "Unknown")
            )

            # Process characters
            for char in vn_data.get("characters", []):
                converted = self._convert_character(char, game_title)

                # Skip image if requested
                if not include_images:
                    converted["image_base64"] = None

                builder.add_character(converted, game_title)
                char_count += 1

            processed += 1

            # Progress update every 100 VNs
            if processed % 100 == 0:
                print(f"  Processed {processed}/{total_vns} VNs ({char_count} characters)...")

        print(f"  Processed {processed} VNs with {char_count} characters")
        print(f"  Generated {len(builder.entries)} dictionary entries")

        # Export
        print(f"Exporting to {output_path}...")
        builder.export(str(output_path))

        print(f"Dictionary saved to: {output_path}")
        return str(output_path)


def main():
    """CLI entry point."""
    parser = argparse.ArgumentParser(
        description="Build Yomitan dictionary from scraped VNDB data"
    )
    parser.add_argument(
        "--data-dir",
        type=str,
        default=None,
        help="Directory containing scraped data (default: vndb_scrape_data/)"
    )
    parser.add_argument(
        "--output",
        type=str,
        default="vndb_characters.zip",
        help="Output filename (default: vndb_characters.zip)"
    )
    parser.add_argument(
        "--no-images",
        action="store_true",
        help="Don't include character images (smaller file size)"
    )
    parser.add_argument(
        "--stats",
        action="store_true",
        help="Just show statistics, don't build dictionary"
    )

    args = parser.parse_args()

    builder = VNDBDictBuilder(data_dir=args.data_dir)

    if args.stats:
        stats = builder.count_stats()
        print(f"VNs: {stats['vns']}")
        print(f"Characters: {stats['characters']}")
    else:
        builder.build(
            output_filename=args.output,
            include_images=not args.no_images
        )


if __name__ == "__main__":
    main()
