from __future__ import annotations

import contextlib
import hashlib
import json
import re
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

import requests

from GameSentenceMiner.hoshidicts_audio_profile import (
    DOWNLOADABLE_SOURCE_TYPES,
    MAX_URL_LENGTH,
    TTS_SOURCE_TYPES,
    HoshidictsAudioError,
    find_source,
    load_hoshidicts_audio_profile,
    profile_string,
    substitute_custom_url,
    validate_http_url,
)

MAX_AUDIO_REQUEST_BYTES = 32 * 1024
MAX_TERM_LENGTH = 4096
MAX_CANDIDATE_NAME_LENGTH = 255
MAX_REDIRECTS = 3
REQUEST_TIMEOUT_SECONDS = (3.05, 8.0)
MAX_PROVIDER_REQUEST_SECONDS = 7.0
MAX_MINING_AUDIO_SECONDS = 8.0
CANDIDATE_CACHE_SECONDS = 5 * 60.0
MEDIA_CACHE_SECONDS = 30 * 60.0

_CANDIDATE_ID_PATTERN = re.compile(r"^[a-f0-9]{64}$")


@dataclass(frozen=True)
class AudioMedia:
    data: bytes
    content_type: str
    extension: str


def _remaining_request_seconds(deadline: float) -> float:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise HoshidictsAudioError("Hoshidicts audio provider request timed out.", 504)
    return remaining


class _BoundedTTLCache:
    def __init__(self, *, max_entries: int, max_bytes: int):
        self._max_entries = max_entries
        self._max_bytes = max_bytes
        self._items: OrderedDict[Any, tuple[float, Any, int]] = OrderedDict()
        self._bytes = 0
        self._lock = threading.Lock()

    def get(self, key: Any) -> Any | None:
        now = time.monotonic()
        with self._lock:
            item = self._items.pop(key, None)
            if item is None:
                return None
            expires_at, value, size = item
            if expires_at <= now:
                self._bytes -= size
                return None
            self._items[key] = item
            return value

    def put(self, key: Any, value: Any, *, ttl: float, size: int) -> None:
        if size > self._max_bytes:
            return
        with self._lock:
            old = self._items.pop(key, None)
            if old is not None:
                self._bytes -= old[2]
            self._items[key] = (time.monotonic() + ttl, value, size)
            self._bytes += size
            while len(self._items) > self._max_entries or self._bytes > self._max_bytes:
                _, (_, _, removed_size) = self._items.popitem(last=False)
                self._bytes -= removed_size


_candidate_cache = _BoundedTTLCache(max_entries=256, max_bytes=2 * 1024 * 1024)
_media_cache = _BoundedTTLCache(max_entries=64, max_bytes=64 * 1024 * 1024)


def _read_response(response: requests.Response, deadline: float) -> bytes:
    chunks = []
    for chunk in response.iter_content(chunk_size=64 * 1024):
        _remaining_request_seconds(deadline)
        if not chunk:
            continue
        chunks.append(chunk)
    return b"".join(chunks)


def _provider_request(
    method: str,
    url: str,
    *,
    data: dict[str, str] | None,
    headers: dict[str, str],
    timeout: tuple[float, float],
) -> requests.Response:
    """The single seam for provider HTTP, so tests can stub the network."""
    return requests.request(method, url, data=data, headers=headers, timeout=timeout, stream=True, allow_redirects=True)


def _request_bytes(
    method: str,
    url: str,
    *,
    data: dict[str, str] | None = None,
    accept: str = "*/*",
    deadline: float | None = None,
) -> tuple[bytes, str, str]:
    if deadline is None:
        deadline = time.monotonic() + MAX_PROVIDER_REQUEST_SECONDS
    remaining = _remaining_request_seconds(deadline)
    response = None
    try:
        response = _provider_request(
            method.upper(),
            validate_http_url(url),
            data=data,
            headers={
                "Accept": accept,
                "Accept-Encoding": "identity",
                "User-Agent": "GameSentenceMiner-Hoshidicts-Audio/1",
            },
            timeout=(
                min(REQUEST_TIMEOUT_SECONDS[0], remaining),
                min(REQUEST_TIMEOUT_SECONDS[1], remaining),
            ),
        )
        if not 200 <= response.status_code < 300:
            raise HoshidictsAudioError(
                f"Hoshidicts audio provider returned HTTP {response.status_code}.",
                502,
            )
        if len(getattr(response, "history", ())) > MAX_REDIRECTS:
            raise HoshidictsAudioError("Hoshidicts audio provider redirected too many times.", 502)
        # Redirects skip the pre-request check, so re-validate what actually served us.
        final_url = validate_http_url(getattr(response, "url", None) or url)
        body = _read_response(response, deadline)
        content_type = response.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
        return body, content_type, final_url
    except requests.RequestException:
        raise HoshidictsAudioError("Hoshidicts audio provider request failed.", 502) from None
    finally:
        if response is not None:
            with contextlib.suppress(Exception):
                response.close()


def _validate_custom_audio_list(value: Any) -> list[dict[str, str]]:
    if not isinstance(value, dict) or set(value) != {"type", "audioSources"}:
        raise HoshidictsAudioError("Hoshidicts custom JSON audio response is invalid.", 502)
    raw_sources = value.get("audioSources")
    if value.get("type") != "audioSourceList" or not isinstance(raw_sources, list):
        raise HoshidictsAudioError("Hoshidicts custom JSON audio response is invalid.", 502)
    candidates = []
    for item in raw_sources:
        if not isinstance(item, dict) or "url" not in item or not set(item) <= {"url", "name"}:
            raise HoshidictsAudioError("Hoshidicts custom JSON audio response is invalid.", 502)
        url = profile_string(item["url"], "Hoshidicts custom JSON audio URL", MAX_URL_LENGTH)
        name = profile_string(item.get("name", ""), "Hoshidicts audio candidate name", MAX_CANDIDATE_NAME_LENGTH)
        validate_http_url(url, label="Hoshidicts custom JSON audio URL")
        candidates.append({"url": url, "name": name})
    return candidates


def _resolve_source_candidates(
    source: dict[str, str],
    term: str,
    reading: str,
    *,
    deadline: float | None = None,
) -> list[dict[str, Any]]:
    source_type = source["type"]
    if source_type == "custom":
        url = source["url"]
        if not url:
            return []
        return [
            {
                "url": validate_http_url(substitute_custom_url(url, term, reading)),
                "name": "",
            }
        ]

    if source_type == "custom-json":
        url = source["url"]
        if not url:
            return []
        body, _content_type, _response_url = _request_bytes(
            "GET",
            substitute_custom_url(url, term, reading),
            accept="application/json",
            deadline=deadline,
        )
        try:
            value = json.loads(body.decode("utf-8-sig"))
        except (UnicodeDecodeError, ValueError) as exc:
            raise HoshidictsAudioError("Hoshidicts custom JSON audio response is invalid.", 502) from exc
        return [{**candidate} for candidate in _validate_custom_audio_list(value)]

    if source_type in TTS_SOURCE_TYPES:
        return []
    raise HoshidictsAudioError("Hoshidicts audio source type is invalid.")


def _request_term(value: Any, label: str, *, allow_empty: bool) -> str:
    if not isinstance(value, str) or "\x00" in value or len(value) > MAX_TERM_LENGTH or not allow_empty and not value:
        raise HoshidictsAudioError(f"{label} is invalid.")
    return value


def _private_candidates(
    profile: dict[str, Any],
    term: str,
    reading: str,
    source_id: str,
    *,
    deadline: float | None = None,
) -> tuple[dict[str, str], list[dict[str, Any]]]:
    source = find_source(profile, source_id)
    if source["type"] not in DOWNLOADABLE_SOURCE_TYPES:
        raise HoshidictsAudioError(
            "This Hoshidicts audio source is available only through local speech synthesis.", 422
        )
    cache_key = (json.dumps(source, sort_keys=True, separators=(",", ":")), term, reading)
    cached = _candidate_cache.get(cache_key)
    if cached is None:
        resolved = _resolve_source_candidates(source, term, reading, deadline=deadline)
        cached = tuple((item["url"], item["name"]) for item in resolved)
        size = sum(len(url.encode()) + len(name.encode()) for url, name in cached)
        _candidate_cache.put(cache_key, cached, ttl=CANDIDATE_CACHE_SECONDS, size=size)
    candidates = []
    for index, (url, name) in enumerate(cached):
        candidate_id_payload = json.dumps(
            {
                "source": source,
                "term": term,
                "reading": reading,
                "index": index,
                "url": url,
            },
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
        candidates.append(
            {
                "index": index,
                "url": url,
                "name": name,
                "candidateId": hashlib.sha256(candidate_id_payload).hexdigest(),
            }
        )
    return source, candidates


def get_audio_candidates(
    term: Any,
    reading: Any,
    source_id: Any,
    *,
    profile: dict[str, Any] | None = None,
    _deadline: float | None = None,
) -> list[dict[str, Any]]:
    term = _request_term(term, "Hoshidicts audio term", allow_empty=False)
    reading = _request_term(reading, "Hoshidicts audio reading", allow_empty=True)
    # An explicit profile comes from a caller that already normalized it.
    normalized_profile = profile if profile is not None else load_hoshidicts_audio_profile()
    _source, candidates = _private_candidates(
        normalized_profile,
        term,
        reading,
        source_id,
        deadline=_deadline,
    )
    output = []
    for item in candidates:
        candidate = {
            "index": item["index"],
            "name": item["name"],
            "candidateId": item["candidateId"],
            "playbackUrl": item["url"],
        }
        output.append(candidate)
    return output


_CONTENT_TYPE_EXTENSIONS = {
    "audio/aac": "aac",
    "audio/aiff": "aiff",
    "audio/flac": "flac",
    "audio/mp4": "m4a",
    "audio/mpeg": "mp3",
    "audio/ogg": "ogg",
    "audio/wav": "wav",
    "audio/webm": "webm",
    "audio/x-wav": "wav",
    "application/ogg": "ogg",
}


def _url_extension(url: str) -> str | None:
    filename = urlsplit(url).path.rsplit("/", 1)[-1]
    if "." not in filename:
        return None
    extension = filename.rsplit(".", 1)[-1].lower()
    return extension if re.fullmatch(r"[a-z0-9]{1,10}", extension) else None


def _download_candidate(
    candidate: dict[str, Any],
    source: dict[str, str],
    *,
    deadline: float | None = None,
) -> AudioMedia:
    cache_key = (source["type"], candidate["url"])
    cached = _media_cache.get(cache_key)
    if cached is not None:
        return AudioMedia(
            data=cached[0],
            content_type=cached[1],
            extension=cached[2],
        )
    data, response_content_type, response_url = _request_bytes(
        "GET",
        candidate["url"],
        accept="audio/*,application/octet-stream",
        deadline=deadline,
    )
    content_type = response_content_type or "application/octet-stream"
    extension = (
        _CONTENT_TYPE_EXTENSIONS.get(content_type)
        or _url_extension(response_url)
        or _url_extension(candidate["url"])
        or "bin"
    )
    cached = (data, content_type, extension)
    _media_cache.put(cache_key, cached, ttl=MEDIA_CACHE_SECONDS, size=len(data))
    return AudioMedia(
        data=data,
        content_type=content_type,
        extension=extension,
    )


def get_audio_media(
    term: Any,
    reading: Any,
    source_id: Any,
    candidate_index: Any,
    candidate_id: Any = None,
    *,
    profile: dict[str, Any] | None = None,
    _deadline: float | None = None,
) -> AudioMedia:
    term = _request_term(term, "Hoshidicts audio term", allow_empty=False)
    reading = _request_term(reading, "Hoshidicts audio reading", allow_empty=True)
    if not isinstance(candidate_index, int) or isinstance(candidate_index, bool) or candidate_index < 0:
        raise HoshidictsAudioError("Hoshidicts audio candidate index is invalid.")
    # An explicit profile comes from a caller that already normalized it.
    normalized_profile = profile if profile is not None else load_hoshidicts_audio_profile()
    source, candidates = _private_candidates(
        normalized_profile,
        term,
        reading,
        source_id,
        deadline=_deadline,
    )
    candidate = next((item for item in candidates if item["index"] == candidate_index), None)
    if candidate is None:
        raise HoshidictsAudioError("Hoshidicts audio candidate does not exist.", 404)
    if candidate_id is not None and candidate["candidateId"] != candidate_id:
        raise HoshidictsAudioError("Hoshidicts audio candidate changed; play it again before mining.", 409)
    return _download_candidate(candidate, source, deadline=_deadline)


def get_mining_audio(
    term: str,
    reading: str,
    selection: dict[str, Any] | None = None,
    *,
    profile: dict[str, Any] | None = None,
) -> AudioMedia:
    # An explicit profile comes from a caller that already normalized it.
    normalized_profile = profile if profile is not None else load_hoshidicts_audio_profile()
    deadline = time.monotonic() + MAX_MINING_AUDIO_SECONDS
    errors: list[HoshidictsAudioError] = []
    if selection is not None:
        return get_audio_media(
            term,
            reading,
            selection["sourceId"],
            selection["candidateIndex"],
            selection["candidateId"],
            profile=normalized_profile,
            _deadline=deadline,
        )

    for source in normalized_profile["sources"]:
        if source["type"] not in DOWNLOADABLE_SOURCE_TYPES:
            continue
        try:
            candidates = get_audio_candidates(
                term,
                reading,
                source["id"],
                profile=normalized_profile,
                _deadline=deadline,
            )
        except HoshidictsAudioError as exc:
            errors.append(exc)
            continue
        for candidate in candidates:
            try:
                return get_audio_media(
                    term,
                    reading,
                    source["id"],
                    candidate["index"],
                    candidate["candidateId"],
                    profile=normalized_profile,
                    _deadline=deadline,
                )
            except HoshidictsAudioError as exc:
                errors.append(exc)

    if errors:
        if all(error.status_code < 500 for error in errors):
            raise HoshidictsAudioError("No pronunciation audio is available for this term.", 404)
        raise HoshidictsAudioError(f"Could not download pronunciation audio: {errors[-1]}", 502)
    raise HoshidictsAudioError("No pronunciation audio is available for this term.", 404)


def validate_audio_api_request(value: Any, *, include_candidate: bool) -> dict[str, Any]:
    required = {"term", "reading", "sourceId"}
    if include_candidate:
        required.update({"candidateIndex", "candidateId"})
    if not isinstance(value, dict) or set(value) != required:
        raise HoshidictsAudioError("Hoshidicts audio request contains unexpected or missing fields.")
    if include_candidate:
        candidate_index = value["candidateIndex"]
        if not isinstance(candidate_index, int) or isinstance(candidate_index, bool) or candidate_index < 0:
            raise HoshidictsAudioError("Hoshidicts audio candidate index is invalid.")
        candidate_id = value["candidateId"]
        if not isinstance(candidate_id, str) or _CANDIDATE_ID_PATTERN.fullmatch(candidate_id) is None:
            raise HoshidictsAudioError("Hoshidicts audio candidate ID is invalid.")
    return value
