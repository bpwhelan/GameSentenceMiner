"""Exact sentence exclusions, stored by OBS game/scene outside settings profiles."""

import json
import threading
from pathlib import Path

from GameSentenceMiner.util.data_directory import get_app_directory
from GameSentenceMiner.util.logging_config import logger


def _normalize(text: str) -> str:
    return text.replace("\r\n", "\n").replace("\r", "\n").strip()


class SentenceExclusions:
    def __init__(self, path: Path):
        self.path = path
        self._revision = None
        self._games: dict[str, set[str]] = {}
        self._lock = threading.Lock()

    def contains(self, text: str, game: str) -> bool:
        if not text or not game:
            return False
        with self._lock:
            try:
                stat = self.path.stat()
                revision = (stat.st_mtime_ns, stat.st_size, stat.st_ino)
                if revision != self._revision:
                    data = json.loads(self.path.read_text(encoding="utf-8"))
                    if (
                        not isinstance(data, dict)
                        or data.get("version") != 1
                        or not isinstance(data.get("games"), dict)
                    ):
                        raise ValueError("Invalid sentence exclusions file")
                    games = data["games"]
                    if any(
                        not isinstance(items, list) or any(not isinstance(item, str) for item in items)
                        for items in games.values()
                    ):
                        raise ValueError("Invalid sentence exclusions list")
                    self._games = {
                        name: {_normalize(item) for item in items if item.strip()} for name, items in games.items()
                    }
                    self._revision = revision
            except FileNotFoundError:
                self._games = {}
                self._revision = None
            except (OSError, ValueError) as error:
                # Keep the last valid list during a transient read failure.
                logger.debug(f"Could not reload sentence exclusions: {error}")
            return _normalize(text) in self._games.get(game, set())


_exclusions = None


def is_sentence_excluded(text: str, game: str) -> bool:
    global _exclusions
    if _exclusions is None:
        _exclusions = SentenceExclusions(Path(get_app_directory()) / "sentence_exclusions.json")
    return _exclusions.contains(text, game)
