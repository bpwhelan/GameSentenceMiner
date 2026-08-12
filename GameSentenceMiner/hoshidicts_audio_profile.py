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
MAX_SOURCE_ID_LENGTH = 128
MAX_URL_LENGTH = 4096
MAX_VOICE_LENGTH = 255

SOURCE_TYPES = frozenset(
    {
        "jpod101",
        "language-pod-101",
        "jisho",
        "custom",
        "custom-json",
        "text-to-speech",
        "text-to-speech-reading",
    }
)
BUILTIN_SOURCE_TYPES = frozenset({"jpod101", "language-pod-101", "jisho"})
CUSTOM_SOURCE_TYPES = frozenset({"custom", "custom-json"})
TTS_SOURCE_TYPES = frozenset({"text-to-speech", "text-to-speech-reading"})
DOWNLOADABLE_SOURCE_TYPES = BUILTIN_SOURCE_TYPES | CUSTOM_SOURCE_TYPES
SOURCE_ID_PATTERN = re.compile(r"^[A-Za-z0-9._-]+$")
PLACEHOLDER_PATTERN = re.compile(r"\{([^{}]*)\}")


class HoshidictsAudioError(Exception):
    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.status_code = status_code


def profile_string(value: Any, label: str, maximum: int) -> str:
    if not isinstance(value, str) or "\x00" in value or len(value) > maximum:
        raise HoshidictsAudioError(f"{label} is invalid.")
    return value


def _optional_string(value: Any, label: str, maximum: int) -> str:
    return profile_string("" if value is None else value, label, maximum).strip()


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
        or port is not None
        and not 1 <= port <= 65535
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
        "enabled": True,
        "autoPlay": False,
        "volume": 100,
        "sources": [
            {"id": source_type, "type": source_type, "url": "", "voice": ""}
            for source_type in ("jpod101", "language-pod-101", "jisho")
        ],
    }


def get_hoshidicts_audio_profile_path() -> Path:
    return Path(get_app_directory()) / "dictionaries" / "hoshidicts" / HOSHIDICTS_AUDIO_PROFILE_FILE


def _normalize_source(raw_source: Any, source_ids: set[str]) -> dict[str, str]:
    if not isinstance(raw_source, dict):
        raise HoshidictsAudioError("Hoshidicts audio source is invalid.")
    source_id = profile_string(
        raw_source.get("id", ""),
        "Hoshidicts audio source ID",
        MAX_SOURCE_ID_LENGTH,
    ).strip()
    if not source_id or SOURCE_ID_PATTERN.fullmatch(source_id) is None:
        raise HoshidictsAudioError("Hoshidicts audio source ID is invalid.")
    if source_id in source_ids:
        raise HoshidictsAudioError("Hoshidicts audio source IDs must be unique.")
    source_ids.add(source_id)

    source_type = raw_source.get("type")
    if not isinstance(source_type, str) or source_type not in SOURCE_TYPES:
        raise HoshidictsAudioError("Hoshidicts audio source type is invalid.")
    url = _optional_string(raw_source.get("url", ""), "Hoshidicts audio source URL", MAX_URL_LENGTH)
    voice = _optional_string(raw_source.get("voice", ""), "Hoshidicts audio source voice", MAX_VOICE_LENGTH)
    if source_type in BUILTIN_SOURCE_TYPES and (url or voice):
        raise HoshidictsAudioError("Built-in Hoshidicts audio sources cannot define a URL or voice.")
    if source_type in TTS_SOURCE_TYPES and url:
        raise HoshidictsAudioError("Hoshidicts text-to-speech sources cannot define a URL.")
    if source_type in CUSTOM_SOURCE_TYPES:
        if voice:
            raise HoshidictsAudioError("Custom Hoshidicts audio sources cannot define a voice.")
        if url:
            if set("{}") & set(PLACEHOLDER_PATTERN.sub("", url)):
                raise HoshidictsAudioError("Hoshidicts audio source URL is invalid.")
            for candidate in (url, substitute_custom_url(url, "term", "reading")):
                validate_http_url(candidate, label="Hoshidicts audio source URL")
    return {"id": source_id, "type": source_type, "url": url, "voice": voice}


def normalize_hoshidicts_audio_profile(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise HoshidictsAudioError("Hoshidicts audio profile must be an object.")
    version = value.get("version", HOSHIDICTS_AUDIO_PROFILE_VERSION)
    if isinstance(version, bool) or version != HOSHIDICTS_AUDIO_PROFILE_VERSION:
        raise HoshidictsAudioError("Hoshidicts audio profile version is unsupported.")

    enabled = value.get("enabled", True)
    auto_play = value.get("autoPlay", False)
    volume = value.get("volume", 100)
    if volume is None:
        volume = 100
    if not isinstance(enabled, bool):
        raise HoshidictsAudioError("Hoshidicts audio enabled setting is invalid.")
    if not isinstance(auto_play, bool):
        raise HoshidictsAudioError("Hoshidicts audio autoplay setting is invalid.")
    if not isinstance(volume, int) or isinstance(volume, bool) or not 0 <= volume <= 100:
        raise HoshidictsAudioError("Hoshidicts audio volume is invalid.")

    raw_sources = value.get("sources")
    if raw_sources is None:
        raw_sources = default_hoshidicts_audio_profile()["sources"]
    if not isinstance(raw_sources, list) or len(raw_sources) > MAX_AUDIO_SOURCES:
        raise HoshidictsAudioError("Hoshidicts audio sources are invalid.")
    source_ids: set[str] = set()
    return {
        "version": HOSHIDICTS_AUDIO_PROFILE_VERSION,
        "enabled": enabled,
        "autoPlay": auto_play,
        "volume": volume,
        "sources": [_normalize_source(raw_source, source_ids) for raw_source in raw_sources],
    }


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
    return normalize_hoshidicts_audio_profile(parsed)


def load_hoshidicts_audio_profile_or_default(profile_path: Path | None = None) -> dict[str, Any]:
    try:
        return load_hoshidicts_audio_profile(profile_path)
    except (HoshidictsAudioError, OSError):
        return default_hoshidicts_audio_profile()


def find_source(profile: dict[str, Any], source_id: Any) -> dict[str, str]:
    if (
        not isinstance(source_id, str)
        or len(source_id) > MAX_SOURCE_ID_LENGTH
        or SOURCE_ID_PATTERN.fullmatch(source_id) is None
    ):
        raise HoshidictsAudioError("Hoshidicts audio source ID is invalid.")
    source = next((item for item in profile["sources"] if item["id"] == source_id), None)
    if source is None:
        raise HoshidictsAudioError("Hoshidicts audio source does not exist.", 404)
    return source
