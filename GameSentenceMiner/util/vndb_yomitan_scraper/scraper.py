"""Main scraper for fetching all VNDB visual novels and characters."""

import argparse
import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Optional, Dict, List, Any
from urllib.parse import urlparse

import requests

from .rate_limiter import RateLimiter


class VNDBScraper:
    """
    Scraper for fetching all VNDB visual novels and their characters.

    Features:
    - Resumable: Tracks progress in progress.json
    - Rate limited: Respects VNDB's 200 requests/5min limit
    - Stores data in JSON files for later dictionary building
    - Downloads character images to local files
    """

    API_BASE = "https://api.vndb.org/kana"
    TIMEOUT = 30
    MAX_CONSECUTIVE_NOT_FOUND = 100
    RESULTS_PER_PAGE = 100

    def __init__(self, output_dir: str = None):
        """
        Initialize the scraper.

        Args:
            output_dir: Directory to store scraped data.
                       Defaults to vndb_scrape_data/ next to the GameSentenceMiner package.
        """
        if output_dir is None:
            # Default to vndb_scrape_data/ in the GameSentenceMiner directory
            gsm_root = Path(__file__).parent.parent.parent.parent
            output_dir = gsm_root / "vndb_scrape_data"

        self.output_dir = Path(output_dir)
        self.vns_dir = self.output_dir / "vns"
        self.images_dir = self.output_dir / "images"
        self.output_subdir = self.output_dir / "output"
        self.progress_file = self.output_dir / "progress.json"

        # Create directories
        self.vns_dir.mkdir(parents=True, exist_ok=True)
        self.images_dir.mkdir(parents=True, exist_ok=True)
        self.output_subdir.mkdir(parents=True, exist_ok=True)

        # Initialize rate limiter
        self.rate_limiter = RateLimiter(self.progress_file)

        # Load or initialize progress
        self.progress = self._load_progress()

    def _load_progress(self) -> Dict[str, Any]:
        """Load progress from file or create new progress state."""
        if self.progress_file.exists():
            try:
                with open(self.progress_file, 'r', encoding='utf-8') as f:
                    return json.load(f)
            except (json.JSONDecodeError, IOError):
                pass

        return {
            "last_processed_id": 0,
            "total_vns_found": 0,
            "total_characters": 0,
            "started_at": datetime.now().isoformat(),
            "last_updated": datetime.now().isoformat(),
            "rate_limit_state": self.rate_limiter.get_state_for_progress()
        }

    def _save_progress(self) -> None:
        """Save current progress to file."""
        self.progress["last_updated"] = datetime.now().isoformat()
        self.progress["rate_limit_state"] = self.rate_limiter.get_state_for_progress()

        with open(self.progress_file, 'w', encoding='utf-8') as f:
            json.dump(self.progress, f, indent=2, ensure_ascii=False)

    def _make_request(self, endpoint: str, payload: dict, retry_count: int = 0) -> Optional[Dict]:
        """
        Make an API request with rate limiting and error handling.

        Args:
            endpoint: API endpoint (e.g., "vn" or "character")
            payload: JSON payload for POST request
            retry_count: Current retry attempt (for network errors)

        Returns:
            Response JSON or None on failure
        """
        url = f"{self.API_BASE}/{endpoint}"

        # Check rate limit before making request
        self.rate_limiter.wait_if_needed()

        try:
            response = requests.post(
                url,
                headers={"Content-Type": "application/json"},
                json=payload,
                timeout=self.TIMEOUT
            )

            # Record the request
            self.rate_limiter.record_request()

            if response.status_code == 200:
                self.rate_limiter.reset_retry_count()
                return response.json()

            elif response.status_code == 404:
                # VN not found
                return None

            elif response.status_code == 429:
                # Rate limited by server
                print(f"Received 429 rate limit response")
                self.rate_limiter.handle_rate_limit_error()
                # Retry the request
                return self._make_request(endpoint, payload, retry_count)

            else:
                print(f"API returned status {response.status_code}: {response.text[:200]}")
                return None

        except requests.Timeout:
            print(f"Request timeout for {endpoint}")
            if retry_count < 3:
                wait_time = (2 ** retry_count) * 5  # 5, 10, 20 seconds
                print(f"Retrying in {wait_time} seconds...")
                time.sleep(wait_time)
                return self._make_request(endpoint, payload, retry_count + 1)
            return None

        except requests.RequestException as e:
            print(f"Request error: {e}")
            if retry_count < 3:
                wait_time = (2 ** retry_count) * 5
                print(f"Retrying in {wait_time} seconds...")
                time.sleep(wait_time)
                return self._make_request(endpoint, payload, retry_count + 1)
            return None

    def _fetch_vn_metadata(self, vn_id: int) -> Optional[Dict]:
        """
        Fetch VN metadata from VNDB.

        Args:
            vn_id: Numeric VN ID

        Returns:
            VN data dict or None if not found
        """
        payload = {
            "filters": ["id", "=", f"v{vn_id}"],
            "fields": "id, title, alttitle, released, developers.name",
            "results": 1
        }

        data = self._make_request("vn", payload)
        if data is None:
            return None

        results = data.get("results", [])
        if not results:
            return None

        return results[0]

    def _fetch_characters(self, vn_id: int) -> List[Dict]:
        """
        Fetch all characters for a VN with pagination.

        Args:
            vn_id: Numeric VN ID

        Returns:
            List of character dictionaries
        """
        all_characters = []
        page = 1

        while True:
            payload = {
                "filters": ["vn", "=", ["id", "=", f"v{vn_id}"]],
                "fields": ",".join([
                    "id",
                    "name",
                    "original",
                    "aliases",
                    "description",
                    "image.url",
                    "vns.role",
                    "vns.id",
                    "traits.name",
                    "traits.group_name",
                    "traits.spoiler",
                ]),
                "results": self.RESULTS_PER_PAGE,
                "page": page,
            }

            data = self._make_request("character", payload)
            if data is None:
                break

            results = data.get("results", [])
            all_characters.extend(results)

            if not data.get("more", False):
                break

            page += 1

        return all_characters

    def _download_image(self, image_url: str, char_id: str) -> Optional[str]:
        """
        Download a character image and save it locally.

        Args:
            image_url: URL of the image
            char_id: Character ID (e.g., "c12345")

        Returns:
            Relative path to saved image or None on failure
        """
        if not image_url:
            return None

        try:
            # Determine file extension from URL
            parsed = urlparse(image_url)
            ext = Path(parsed.path).suffix.lower()
            if ext not in ['.jpg', '.jpeg', '.png', '.gif', '.webp']:
                ext = '.jpg'

            filename = f"{char_id}{ext}"
            filepath = self.images_dir / filename

            # Skip if already downloaded
            if filepath.exists():
                return f"images/{filename}"

            # Download image (this doesn't count against API rate limit)
            response = requests.get(image_url, timeout=30)
            if response.status_code != 200:
                return None

            with open(filepath, 'wb') as f:
                f.write(response.content)

            return f"images/{filename}"

        except Exception as e:
            print(f"Failed to download image for {char_id}: {e}")
            return None

    def _process_character(self, char: Dict, vn_id: int) -> Dict:
        """
        Process a character and download their image.

        Args:
            char: Raw character data from API
            vn_id: VN ID for determining role

        Returns:
            Processed character dict
        """
        char_id = char.get("id", "")

        # Get role for this VN
        role = "side"
        for vn in char.get("vns", []):
            if vn.get("id") == f"v{vn_id}":
                role = vn.get("role", "side")
                break

        # Download image
        image_path = None
        image_info = char.get("image")
        if image_info and isinstance(image_info, dict):
            image_url = image_info.get("url")
            if image_url:
                image_path = self._download_image(image_url, char_id)

        # Extract traits (filter out major spoilers)
        traits = []
        for trait in char.get("traits", []):
            if trait.get("spoiler", 0) <= 1:  # Include none and minor spoilers
                traits.append({
                    "name": trait.get("name"),
                    "group": trait.get("group_name"),
                    "spoiler": trait.get("spoiler", 0)
                })

        return {
            "id": char_id,
            "name": char.get("name"),
            "name_original": char.get("original"),
            "aliases": char.get("aliases", []),
            "role": role,
            "description": char.get("description"),
            "image_path": image_path,
            "traits": traits
        }

    def scrape_vn(self, vn_id: int) -> Optional[Dict]:
        """
        Scrape a single VN and its characters.

        Args:
            vn_id: Numeric VN ID

        Returns:
            VN data dict with characters, or None if VN doesn't exist
        """
        # Fetch VN metadata
        vn_data = self._fetch_vn_metadata(vn_id)
        if vn_data is None:
            return None

        # Fetch characters
        raw_characters = self._fetch_characters(vn_id)

        # Process characters and download images
        characters = []
        for char in raw_characters:
            processed = self._process_character(char, vn_id)
            characters.append(processed)

        # Extract developers
        developers = []
        for dev in vn_data.get("developers", []):
            if dev.get("name"):
                developers.append(dev["name"])

        return {
            "id": f"v{vn_id}",
            "title": vn_data.get("title"),
            "title_original": vn_data.get("alttitle"),
            "developers": developers,
            "release_date": vn_data.get("released"),
            "characters": characters
        }

    def _save_vn(self, vn_id: int, data: Dict) -> None:
        """Save VN data to JSON file."""
        filepath = self.vns_dir / f"v{vn_id}.json"
        with open(filepath, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2, ensure_ascii=False)

    def run(self, start_id: int = None, end_id: int = None) -> None:
        """
        Run the scraper.

        Args:
            start_id: Force start from this ID (overrides progress)
            end_id: Stop at this ID (for testing)
        """
        # Determine starting point
        if start_id is not None:
            current_id = start_id
        else:
            current_id = self.progress["last_processed_id"] + 1

        consecutive_not_found = 0

        print(f"Starting VNDB scrape from ID {current_id}")
        print(f"Output directory: {self.output_dir}")
        print(f"Press Ctrl+C to stop (progress will be saved)")
        print()

        try:
            while True:
                # Check end condition
                if end_id is not None and current_id > end_id:
                    print(f"\nReached end ID {end_id}")
                    break

                # Check for end of VNDB
                if consecutive_not_found >= self.MAX_CONSECUTIVE_NOT_FOUND:
                    print(f"\n{consecutive_not_found} consecutive VNs not found. Assuming end of VNDB.")
                    break

                # Progress indicator
                print(f"Processing v{current_id}...", end=" ", flush=True)

                # Scrape VN
                vn_data = self.scrape_vn(current_id)

                if vn_data is None:
                    print("not found")
                    consecutive_not_found += 1
                else:
                    # Reset counter on successful find
                    consecutive_not_found = 0

                    # Save VN data
                    self._save_vn(current_id, vn_data)

                    # Update stats
                    self.progress["total_vns_found"] += 1
                    self.progress["total_characters"] += len(vn_data.get("characters", []))

                    title = vn_data.get("title") or vn_data.get("title_original") or "Unknown"
                    char_count = len(vn_data.get("characters", []))
                    print(f"OK - {title[:40]} ({char_count} characters)")

                # Update progress
                self.progress["last_processed_id"] = current_id
                self._save_progress()

                current_id += 1

        except KeyboardInterrupt:
            print("\n\nInterrupted by user. Progress saved.")
            self._save_progress()

        except Exception as e:
            print(f"\n\nError: {e}")
            self._save_progress()
            raise

        # Final summary
        print("\n" + "=" * 50)
        print("Scraping complete!")
        print(f"Total VNs found: {self.progress['total_vns_found']}")
        print(f"Total characters: {self.progress['total_characters']}")
        print(f"Last processed ID: {self.progress['last_processed_id']}")
        print(f"Data saved to: {self.output_dir}")


def main():
    """CLI entry point."""
    parser = argparse.ArgumentParser(
        description="Scrape VNDB visual novels for Yomitan dictionary generation"
    )
    parser.add_argument(
        "--output-dir",
        type=str,
        default=None,
        help="Directory to store scraped data (default: vndb_scrape_data/)"
    )
    parser.add_argument(
        "--start-id",
        type=int,
        default=None,
        help="Force start from specific VN ID"
    )
    parser.add_argument(
        "--end-id",
        type=int,
        default=None,
        help="Stop at specific VN ID (for testing)"
    )

    args = parser.parse_args()

    scraper = VNDBScraper(output_dir=args.output_dir)
    scraper.run(start_id=args.start_id, end_id=args.end_id)


if __name__ == "__main__":
    main()
