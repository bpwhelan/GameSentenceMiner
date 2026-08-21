from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlsplit

from GameSentenceMiner.util.config.configuration import get_app_directory

HOSHIDICTS_AUDIO_PROFILE_FILE = "audio-profile.json"
HOSHIDICTS_AUDIO_PROFILE_VERSION = 1
MAX_PROFILE_BYTES = 64 * 1024
MAX_AUDIO_SOURCES = 32
MAX_URL_LENGTH = 4096

CUSTOM_SOURCE_TYPES = frozenset({"custom", "custom-json"})
TTS_SOURCE_TYPES = frozenset({"text-to-speech", "text-to-speech-reading"})
AUDIO_SOURCE_TYPES = CUSTOM_SOURCE_TYPES | TTS_SOURCE_TYPES
DOWNLOADABLE_SOURCE_TYPES = CUSTOM_SOURCE_TYPES
PLACEHOLDER_PATTERN = re.compile(r"\{([^{}]*)\}")


class HoshidictsAudioError(Exception):
    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.status_code = status_code


def profile_string(value: Any, label: str, maximum: int) -> str:
    if not isinstance(value, str) or "\x00" in value or len(value) > maximum:
        raise HoshidictsAudioError(f"{label} is invalid.")
    return value


def validate_http_url(url: str, *, label: str = "Hoshidicts audio URL") -> str:
    if not url or any(ord(character) < 32 for character in url):
        raise HoshidictsAudioError(f"{label} must be an absolute HTTP(S) URL.")
    try:
        parsed = urlsplit(url)
        hostname = parsed.hostname
        port = parsed.port
    except ValueError as exc:
        raise HoshidictsAudioError(f"{label} must be an absolute HTTP(S) URL.") from exc
    if (
        parsed.scheme.lower() not in {"http", "https"}
        or not hostname
        or parsed.username is not None
        or parsed.password is not None
        # urlsplit already rejects ports above 65535; this catches port 0.
        or (port is not None and not 1 <= port <= 65535)
    ):
        raise HoshidictsAudioError(f"{label} must be an absolute HTTP(S) URL without a username or password.")
    if "{" in parsed.netloc or "}" in parsed.netloc:
        raise HoshidictsAudioError(f"{label} cannot use placeholders in its authority.")
    return url


def substitute_custom_url(url: str, term: str, reading: str) -> str:
    values = {
        "term": quote(term, safe=""),
        "expression": quote(term, safe=""),
        "reading": quote(reading, safe=""),
        "language": "ja",
    }
    return PLACEHOLDER_PATTERN.sub(lambda match: values.get(match.group(1), match.group(0)), url)


def default_hoshidicts_audio_profile() -> dict[str, Any]:
    return {
        "version": HOSHIDICTS_AUDIO_PROFILE_VERSION,
        "autoPlay": False,
        "sources": [],
    }


def get_hoshidicts_audio_profile_path() -> Path:
    return Path(get_app_directory()) / "dictionaries" / "hoshidicts" / HOSHIDICTS_AUDIO_PROFILE_FILE


def load_hoshidicts_audio_profile(profile_path: Path | None = None) -> dict[str, Any]:
    path = profile_path or get_hoshidicts_audio_profile_path()
    try:
        stat = path.stat()
    except FileNotFoundError:
        return default_hoshidicts_audio_profile()
    if not path.is_file() or stat.st_size <= 0 or stat.st_size > MAX_PROFILE_BYTES:
        raise HoshidictsAudioError("Hoshidicts audio profile has an invalid size.")
    try:
        parsed = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError) as exc:
        raise HoshidictsAudioError(f"Could not read the Hoshidicts audio profile: {exc}") from exc
    if not isinstance(parsed, dict):
        raise HoshidictsAudioError("Hoshidicts audio profile must be an object.")
    # Electron writes this file from an already-validated profile, so only the
    # shape the audio pipeline indexes through is checked here.
    auto_play = parsed.get("autoPlay", False)
    if not isinstance(auto_play, bool):
        raise HoshidictsAudioError("Hoshidicts audio autoplay setting is invalid.")
    raw_sources = parsed.get("sources", [])
    if not isinstance(raw_sources, list):
        raise HoshidictsAudioError("Hoshidicts audio sources are invalid.")
    sources: list[dict[str, str]] = []
    for raw_source in raw_sources:
        if not isinstance(raw_source, dict):
            raise HoshidictsAudioError("Hoshidicts audio source is invalid.")
        source_type = raw_source.get("type")
        if not isinstance(source_type, str) or source_type not in AUDIO_SOURCE_TYPES:
            continue
        if not isinstance(raw_source.get("id"), str):
            raise HoshidictsAudioError("Hoshidicts audio source is invalid.")
        sources.append(
            {
                "id": raw_source["id"],
                "type": source_type,
                "url": str(raw_source.get("url") or ""),
                "voice": str(raw_source.get("voice") or ""),
            }
        )
    return {
        "version": HOSHIDICTS_AUDIO_PROFILE_VERSION,
        "autoPlay": auto_play,
        "sources": sources,
    }


def load_hoshidicts_audio_profile_or_default(profile_path: Path | None = None) -> dict[str, Any]:
    try:
        return load_hoshidicts_audio_profile(profile_path)
    except (HoshidictsAudioError, OSError):
        return default_hoshidicts_audio_profile()


def find_source(profile: dict[str, Any], source_id: Any) -> dict[str, str]:
    source = next((item for item in profile["sources"] if item["id"] == source_id), None)
    if source is None:
        raise HoshidictsAudioError("Hoshidicts audio source does not exist.", 404)
    return source
