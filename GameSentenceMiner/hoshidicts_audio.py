from __future__ import annotations

import hashlib
import ipaddress
import json
import re
import socket
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass
from html.parser import HTMLParser
from typing import Any
from urllib.parse import urljoin, urlencode, urlsplit

import requests

from GameSentenceMiner.hoshidicts_audio_profile import (
    DOWNLOADABLE_SOURCE_TYPES,
    HoshidictsAudioError,
    MAX_AUDIO_SOURCES,
    MAX_URL_LENGTH,
    TTS_SOURCE_TYPES,
    find_source,
    load_hoshidicts_audio_profile,
    normalize_hoshidicts_audio_profile,
    profile_string,
    substitute_custom_url,
    validate_http_url,
)

MAX_AUDIO_REQUEST_BYTES = 32 * 1024
MAX_TERM_LENGTH = 4096
MAX_CANDIDATE_NAME_LENGTH = 255
MAX_DISCOVERY_BYTES = 2 * 1024 * 1024
MAX_CUSTOM_JSON_BYTES = 256 * 1024
MAX_AUDIO_BYTES = 16 * 1024 * 1024
MAX_REDIRECTS = 3
REQUEST_TIMEOUT_SECONDS = (3.05, 8.0)
MAX_PROVIDER_REQUEST_SECONDS = 7.0
MAX_MINING_AUDIO_SECONDS = 8.0
MAX_MINING_AUDIO_ATTEMPTS = 32
CANDIDATE_CACHE_SECONDS = 5 * 60.0
MEDIA_CACHE_SECONDS = 30 * 60.0

_CANDIDATE_ID_PATTERN = re.compile(r"^[a-f0-9]{64}$")
_INVALID_JPOD101_DIGEST = "ae6398b5a27bc8c0a771df6c907ade794be15518174773c58c7c7ddd17098906"
_REDIRECT_STATUSES = frozenset({301, 302, 303, 307, 308})


@dataclass(frozen=True)
class AudioMedia:
    data: bytes
    content_type: str
    extension: str


def _url_origin(url: str) -> str:
    parsed = urlsplit(url)
    scheme = parsed.scheme.lower()
    hostname = (parsed.hostname or "").rstrip(".").casefold()
    try:
        is_loopback = ipaddress.ip_address(hostname).is_loopback
    except ValueError:
        is_loopback = hostname == "localhost"
    if is_loopback:
        hostname = "loopback"
    port = parsed.port or (443 if scheme == "https" else 80)
    host = f"[{hostname}]" if ":" in hostname else hostname
    return f"{scheme}://{host}:{port}"


def _private_network_origin(url: str) -> str | None:
    """Trust private destinations only at an explicitly configured origin."""
    hostname = (urlsplit(url).hostname or "").rstrip(".").casefold()
    if hostname == "localhost":
        return _url_origin(url)
    try:
        return _url_origin(url) if not ipaddress.ip_address(hostname).is_global else None
    except ValueError:
        return None


def _resolved_addresses(url: str) -> list[ipaddress.IPv4Address | ipaddress.IPv6Address]:
    parsed = urlsplit(url)
    hostname = parsed.hostname or ""
    port = parsed.port or (443 if parsed.scheme.lower() == "https" else 80)
    try:
        records = socket.getaddrinfo(hostname, port, type=socket.SOCK_STREAM)
    except OSError as exc:
        raise HoshidictsAudioError("Hoshidicts audio provider hostname could not be resolved.", 502) from exc
    addresses = []
    for record in records:
        raw_address = str(record[4][0]).split("%", 1)[0]
        try:
            address = ipaddress.ip_address(raw_address)
        except ValueError as exc:
            raise HoshidictsAudioError("Hoshidicts audio provider resolved to an invalid address.", 502) from exc
        if address not in addresses:
            addresses.append(address)
    if not addresses:
        raise HoshidictsAudioError("Hoshidicts audio provider hostname could not be resolved.", 502)
    return addresses


def _validate_network_target(
    url: str,
    *,
    private_network_origin: str | None,
) -> tuple[str, list[ipaddress.IPv4Address | ipaddress.IPv6Address]]:
    url = validate_http_url(url)
    addresses = _resolved_addresses(url)
    if any(not address.is_global for address in addresses) and _url_origin(url) != private_network_origin:
        raise HoshidictsAudioError(
            "Hoshidicts audio providers cannot access a private network from this source.",
            403,
        )
    return url, addresses


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

    def clear(self) -> None:
        with self._lock:
            self._items.clear()
            self._bytes = 0

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


def clear_audio_cache() -> None:
    _candidate_cache.clear()
    _media_cache.clear()


def _read_limited_response(response: requests.Response, maximum: int, deadline: float) -> bytes:
    raw_length = response.headers.get("Content-Length")
    if raw_length is not None:
        try:
            if int(raw_length) > maximum:
                raise HoshidictsAudioError("Hoshidicts audio provider response is too large.", 502)
        except ValueError:
            pass
    chunks = []
    total = 0
    for chunk in response.iter_content(chunk_size=64 * 1024):
        _remaining_request_seconds(deadline)
        if not chunk:
            continue
        total += len(chunk)
        if total > maximum:
            raise HoshidictsAudioError("Hoshidicts audio provider response is too large.", 502)
        chunks.append(chunk)
    return b"".join(chunks)


class _PinnedAddressAdapter(requests.adapters.HTTPAdapter):
    """Connect to an approved address while retaining the original HTTP/TLS host."""

    def __init__(self, address: ipaddress.IPv4Address | ipaddress.IPv6Address, server_hostname: str):
        self._address = str(address)
        self._server_hostname = server_hostname
        super().__init__(max_retries=0)

    def get_connection_with_tls_context(self, request, verify, proxies=None, cert=None):
        host_params, pool_kwargs = self.build_connection_pool_key_attributes(
            request,
            verify,
            cert,
        )
        host_params["host"] = self._address
        if host_params["scheme"] == "https":
            pool_kwargs["assert_hostname"] = self._server_hostname
            pool_kwargs["server_hostname"] = self._server_hostname
        return self.poolmanager.connection_from_host(
            **host_params,
            pool_kwargs=pool_kwargs,
        )


def _pinned_request(
    method: str,
    url: str,
    *,
    address: ipaddress.IPv4Address | ipaddress.IPv6Address,
    data: dict[str, str] | None,
    headers: dict[str, str],
    timeout: requests.adapters.TimeoutSauce,
) -> requests.Response:
    parsed = urlsplit(url)
    hostname = (parsed.hostname or "").encode("idna").decode("ascii")
    host_header = f"[{hostname}]" if ":" in hostname else hostname
    if parsed.port is not None:
        host_header = f"{host_header}:{parsed.port}"
    session = requests.Session()
    session.trust_env = False
    session.mount(
        f"{parsed.scheme.lower()}://",
        _PinnedAddressAdapter(address, hostname),
    )
    try:
        response = session.request(
            method,
            url,
            data=data,
            headers={**headers, "Host": host_header},
            timeout=timeout,
            stream=True,
            allow_redirects=False,
        )
    except Exception:
        session.close()
        raise
    setattr(response, "_hoshidicts_session", session)
    return response


def _close_response(response: requests.Response) -> None:
    response.close()
    session = getattr(response, "_hoshidicts_session", None)
    if session is not None:
        session.close()


def _request_bytes(
    method: str,
    url: str,
    *,
    maximum: int,
    data: dict[str, str] | None = None,
    accept: str = "*/*",
    private_network_origin: str | None = None,
    deadline: float | None = None,
) -> tuple[bytes, str, str]:
    if deadline is None:
        deadline = time.monotonic() + MAX_PROVIDER_REQUEST_SECONDS
    current_url = validate_http_url(url)
    current_method = method.upper()
    current_data = data
    for redirect_count in range(MAX_REDIRECTS + 1):
        _remaining_request_seconds(deadline)
        current_url, approved_addresses = _validate_network_target(
            current_url,
            private_network_origin=private_network_origin,
        )
        response = None
        for address in approved_addresses:
            remaining = _remaining_request_seconds(deadline)
            try:
                response = _pinned_request(
                    current_method,
                    current_url,
                    address=address,
                    data=current_data,
                    headers={
                        "Accept": accept,
                        "Accept-Encoding": "identity",
                        "User-Agent": "GameSentenceMiner-Hoshidicts-Audio/1",
                    },
                    timeout=requests.adapters.TimeoutSauce(
                        total=remaining,
                        connect=min(REQUEST_TIMEOUT_SECONDS[0], remaining),
                        read=min(REQUEST_TIMEOUT_SECONDS[1], remaining),
                    ),
                )
                break
            except requests.RequestException:
                continue
        if response is None:
            raise HoshidictsAudioError("Hoshidicts audio provider request failed.", 502) from None
        try:
            if response.status_code in _REDIRECT_STATUSES:
                location = response.headers.get("Location")
                if redirect_count >= MAX_REDIRECTS or not location:
                    raise HoshidictsAudioError("Hoshidicts audio provider redirected too many times.", 502)
                current_url = validate_http_url(urljoin(current_url, location))
                if response.status_code in {301, 302, 303} and current_method == "POST":
                    current_method = "GET"
                    current_data = None
                continue
            if not 200 <= response.status_code < 300:
                raise HoshidictsAudioError(
                    f"Hoshidicts audio provider returned HTTP {response.status_code}.",
                    502,
                )
            body = _read_limited_response(response, maximum, deadline)
            content_type = response.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
            return body, content_type, current_url
        except requests.RequestException:
            raise HoshidictsAudioError("Hoshidicts audio provider response failed.", 502) from None
        finally:
            _close_response(response)
    raise HoshidictsAudioError("Hoshidicts audio provider redirected too many times.", 502)


_VOID_HTML_TAGS = frozenset(
    {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}
)


class _LanguagePod101Parser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self._stack: list[str] = []
        self._row_depth: int | None = None
        self._reading_depth: int | None = None
        self._row: dict[str, str] | None = None
        self.rows: list[dict[str, str]] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = dict(attrs)
        classes = set((attributes.get("class") or "").split())
        depth = len(self._stack)
        if self._row is None and "dc-result-row" in classes:
            self._row = {"reading": "", "url": ""}
            self._row_depth = depth
        if self._row is not None:
            if "dc-vocab_kana" in classes:
                self._reading_depth = depth
            if tag == "source" and not self._row["url"]:
                self._row["url"] = attributes.get("src") or ""
        if tag not in _VOID_HTML_TAGS:
            self._stack.append(tag)

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.handle_starttag(tag, attrs)
        if tag not in _VOID_HTML_TAGS:
            self.handle_endtag(tag)

    def handle_data(self, data: str) -> None:
        if self._row is not None and self._reading_depth is not None:
            self._row["reading"] += data

    def handle_endtag(self, tag: str) -> None:
        try:
            depth = len(self._stack) - 1 - self._stack[::-1].index(tag)
        except ValueError:
            return
        if self._reading_depth is not None and depth <= self._reading_depth:
            self._reading_depth = None
        if self._row is not None and self._row_depth is not None and depth <= self._row_depth:
            self._row["reading"] = self._row["reading"].strip()
            self.rows.append(self._row)
            self._row = None
            self._row_depth = None
        del self._stack[depth:]


class _JishoAudioParser(HTMLParser):
    def __init__(self, target_id: str):
        super().__init__(convert_charrefs=True)
        self._target_id = target_id
        self._stack: list[str] = []
        self._audio_depth: int | None = None
        self.url = ""

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = dict(attrs)
        depth = len(self._stack)
        if tag == "audio" and attributes.get("id") == self._target_id:
            self._audio_depth = depth
        elif tag == "source" and self._audio_depth is not None and not self.url:
            self.url = attributes.get("src") or ""
        if tag not in _VOID_HTML_TAGS:
            self._stack.append(tag)

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.handle_starttag(tag, attrs)
        if tag not in _VOID_HTML_TAGS:
            self.handle_endtag(tag)

    def handle_endtag(self, tag: str) -> None:
        try:
            depth = len(self._stack) - 1 - self._stack[::-1].index(tag)
        except ValueError:
            return
        if self._audio_depth is not None and depth <= self._audio_depth:
            self._audio_depth = None
        del self._stack[depth:]


def _is_entirely_kana(value: str) -> bool:
    return bool(value) and all("\u3040" <= character <= "\u30ff" or character == "ー" for character in value)


def _validate_custom_audio_list(value: Any) -> list[dict[str, str]]:
    if not isinstance(value, dict) or set(value) != {"type", "audioSources"}:
        raise HoshidictsAudioError("Hoshidicts custom JSON audio response is invalid.", 502)
    raw_sources = value.get("audioSources")
    if value.get("type") != "audioSourceList" or not isinstance(raw_sources, list):
        raise HoshidictsAudioError("Hoshidicts custom JSON audio response is invalid.", 502)
    candidates = []
    # Yomitan's schema and local audio server do not cap this list. Preserve
    # source priority while limiting Hoshidicts to the recordings it can expose.
    for item in raw_sources[:MAX_AUDIO_SOURCES]:
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
    if source_type == "jpod101":
        if reading == term and _is_entirely_kana(term):
            term = ""
        parameters = {}
        if term:
            parameters["kanji"] = term
        if reading:
            parameters["kana"] = reading
        url = f"https://assets.languagepod101.com/dictionary/japanese/audiomp3.php?{urlencode(parameters)}"
        return [{"url": url, "name": ""}]

    if source_type == "language-pod-101":
        fetch_url = "https://www.japanesepod101.com/learningcenter/reference/dictionary_post"
        body, _content_type, response_url = _request_bytes(
            "POST",
            fetch_url,
            maximum=MAX_DISCOVERY_BYTES,
            data={
                "post": "dictionary_reference",
                "match_type": "exact",
                "search_query": term,
                "vulgar": "true",
            },
            accept="text/html",
            deadline=deadline,
        )
        parser = _LanguagePod101Parser()
        parser.feed(body.decode("utf-8", errors="replace"))
        output = []
        seen = set()
        for row in parser.rows:
            if not row["url"] or reading != term and row["reading"] != reading:
                continue
            url = validate_http_url(urljoin(response_url, row["url"]))
            if url not in seen:
                seen.add(url)
                output.append({"url": url, "name": ""})
            if len(output) >= MAX_AUDIO_SOURCES:
                break
        return output

    if source_type == "jisho":
        fetch_url = f"https://jisho.org/search/{term}"
        body, _content_type, response_url = _request_bytes(
            "GET",
            fetch_url,
            maximum=MAX_DISCOVERY_BYTES,
            accept="text/html",
            deadline=deadline,
        )
        parser = _JishoAudioParser(f"audio_{term}:{reading}")
        parser.feed(body.decode("utf-8", errors="replace"))
        if not parser.url:
            return []
        return [{"url": validate_http_url(urljoin(response_url, parser.url)), "name": ""}]

    if source_type == "custom":
        url = source["url"]
        if not url:
            return []
        return [
            {
                "url": validate_http_url(substitute_custom_url(url, term, reading)),
                "name": "",
                "privateNetworkOrigin": _private_network_origin(url),
            }
        ]

    if source_type == "custom-json":
        url = source["url"]
        if not url:
            return []
        body, _content_type, _response_url = _request_bytes(
            "GET",
            substitute_custom_url(url, term, reading),
            maximum=MAX_CUSTOM_JSON_BYTES,
            accept="application/json",
            private_network_origin=_private_network_origin(url),
            deadline=deadline,
        )
        try:
            value = json.loads(body.decode("utf-8-sig"))
        except (UnicodeDecodeError, ValueError) as exc:
            raise HoshidictsAudioError("Hoshidicts custom JSON audio response is invalid.", 502) from exc
        private_network_origin = _private_network_origin(url)
        return [
            {**candidate, "privateNetworkOrigin": private_network_origin}
            for candidate in _validate_custom_audio_list(value)
        ]

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
    if not profile["enabled"]:
        raise HoshidictsAudioError("Hoshidicts audio is disabled.", 503)
    source = find_source(profile, source_id)
    if source["type"] not in DOWNLOADABLE_SOURCE_TYPES:
        raise HoshidictsAudioError(
            "This Hoshidicts audio source is available only through local speech synthesis.", 422
        )
    cache_key = (json.dumps(source, sort_keys=True, separators=(",", ":")), term, reading)
    cached = _candidate_cache.get(cache_key)
    if cached is None:
        resolved = _resolve_source_candidates(source, term, reading, deadline=deadline)
        cached = tuple(
            (
                item["url"],
                item["name"],
                item.get("privateNetworkOrigin"),
            )
            for item in resolved[:MAX_AUDIO_SOURCES]
        )
        size = sum(len(url.encode()) + len(name.encode()) for url, name, _private_origin in cached)
        _candidate_cache.put(cache_key, cached, ttl=CANDIDATE_CACHE_SECONDS, size=size)
    candidates = []
    for index, (url, name, private_network_origin) in enumerate(cached):
        candidate_id_payload = json.dumps(
            {
                "source": source,
                "term": term,
                "reading": reading,
                "index": index,
                "url": url,
                "privateNetworkOrigin": private_network_origin,
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
                "privateNetworkOrigin": private_network_origin,
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
    normalized_profile = (
        normalize_hoshidicts_audio_profile(profile) if profile is not None else load_hoshidicts_audio_profile()
    )
    _source, candidates = _private_candidates(
        normalized_profile,
        term,
        reading,
        source_id,
        deadline=_deadline,
    )
    return [{"index": item["index"], "name": item["name"], "candidateId": item["candidateId"]} for item in candidates]


def _has_mp3_frame(data: bytes) -> bool:
    offset = 0
    if len(data) >= 10 and data.startswith(b"ID3"):
        if any(byte & 0x80 for byte in data[6:10]):
            return False
        tag_size = sum(byte << shift for byte, shift in zip(data[6:10], (21, 14, 7, 0), strict=True))
        offset = 10 + tag_size + (10 if data[5] & 0x10 else 0)
    bitrate_v1_l3 = (0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0)
    bitrate_v2_l3 = (0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0)
    sample_rates = {
        0b11: (44100, 48000, 32000),
        0b10: (22050, 24000, 16000),
        0b00: (11025, 12000, 8000),
    }
    scan_end = min(len(data) - 4, offset + 4096)
    for index in range(offset, max(offset, scan_end) + 1):
        header = int.from_bytes(data[index : index + 4], "big")
        if header >> 21 != 0x7FF:
            continue
        version = (header >> 19) & 0b11
        layer = (header >> 17) & 0b11
        bitrate_index = (header >> 12) & 0xF
        sample_index = (header >> 10) & 0b11
        padding = (header >> 9) & 1
        if version == 0b01 or layer != 0b01 or sample_index == 0b11:
            continue
        sample_rate = sample_rates[version][sample_index]
        bitrate = (bitrate_v1_l3 if version == 0b11 else bitrate_v2_l3)[bitrate_index] * 1000
        if bitrate == 0:
            continue
        coefficient = 144 if version == 0b11 else 72
        frame_length = coefficient * bitrate // sample_rate + padding
        if frame_length >= 24 and index + frame_length <= len(data):
            return True
    return False


def _has_wave_audio(data: bytes) -> bool:
    if len(data) < 44 or not (data.startswith(b"RIFF") and data[8:12] == b"WAVE"):
        return False
    offset = 12
    valid_format = False
    valid_data = False
    while offset + 8 <= len(data):
        chunk_type = data[offset : offset + 4]
        chunk_size = int.from_bytes(data[offset + 4 : offset + 8], "little")
        chunk_start = offset + 8
        chunk_end = min(len(data), chunk_start + chunk_size)
        if chunk_type == b"fmt " and chunk_end - chunk_start >= 16:
            channels = int.from_bytes(data[chunk_start + 2 : chunk_start + 4], "little")
            sample_rate = int.from_bytes(data[chunk_start + 4 : chunk_start + 8], "little")
            valid_format = channels > 0 and sample_rate > 0
        elif chunk_type == b"data":
            valid_data = chunk_size > 0 and chunk_end > chunk_start
        offset = chunk_start + chunk_size + (chunk_size & 1)
    return valid_format and valid_data


def _has_flac_audio(data: bytes) -> bool:
    if len(data) < 42 or not data.startswith(b"fLaC"):
        return False
    block_type = data[4] & 0x7F
    block_length = int.from_bytes(data[5:8], "big")
    if block_type != 0 or block_length != 34 or len(data) < 8 + block_length:
        return False
    stream_bits = int.from_bytes(data[18:26], "big")
    sample_rate = (stream_bits >> 44) & 0xFFFFF
    channels = ((stream_bits >> 41) & 0x7) + 1
    total_samples = stream_bits & ((1 << 36) - 1)
    return sample_rate > 0 and channels > 0 and total_samples > 0


def _has_ogg_audio(data: bytes) -> bool:
    if len(data) < 28 or not data.startswith(b"OggS") or data[4] != 0:
        return False
    segment_count = data[26]
    if segment_count == 0 or len(data) < 27 + segment_count:
        return False
    packet_length = sum(data[27 : 27 + segment_count])
    packet_start = 27 + segment_count
    packet = data[packet_start : packet_start + packet_length]
    return packet.startswith((b"OpusHead", b"\x01vorbis", b"\x7fFLAC"))


def _has_aiff_audio(data: bytes) -> bool:
    if len(data) < 32 or not (data.startswith(b"FORM") and data[8:12] in {b"AIFF", b"AIFC"}):
        return False
    return b"COMM" in data[12:] and b"SSND" in data[12:]


def _has_mp4_audio(data: bytes) -> bool:
    if len(data) < 32 or data[4:8] != b"ftyp":
        return False
    has_audio_handler = False
    search_start = 0
    while True:
        handler = data.find(b"hdlr", search_start)
        if handler < 0:
            break
        if handler + 16 <= len(data) and data[handler + 12 : handler + 16] == b"soun":
            has_audio_handler = True
            break
        search_start = handler + 4
    return has_audio_handler and b"mdat" in data


def _has_webm_audio(data: bytes) -> bool:
    return (
        len(data) >= 32
        and data.startswith(b"\x1aE\xdf\xa3")
        and any(codec in data for codec in (b"A_OPUS", b"A_VORBIS", b"A_AAC", b"A_FLAC"))
    )


def _detect_audio_format(data: bytes) -> tuple[str, str] | None:
    if _has_mp3_frame(data):
        return "audio/mpeg", "mp3"
    if _has_ogg_audio(data):
        return "audio/ogg", "ogg"
    if _has_flac_audio(data):
        return "audio/flac", "flac"
    if _has_wave_audio(data):
        return "audio/wav", "wav"
    if _has_aiff_audio(data):
        return "audio/aiff", "aiff"
    if _has_mp4_audio(data):
        return "audio/mp4", "m4a"
    if _has_webm_audio(data):
        return "audio/webm", "webm"
    return None


def _download_candidate(
    candidate: dict[str, Any],
    source: dict[str, str],
    *,
    deadline: float | None = None,
) -> AudioMedia:
    private_network_origin = candidate.get("privateNetworkOrigin")
    cache_key = (source["type"], candidate["url"], private_network_origin)
    cached = _media_cache.get(cache_key)
    if cached is not None:
        return AudioMedia(
            data=cached[0],
            content_type=cached[1],
            extension=cached[2],
        )
    data, response_content_type, _response_url = _request_bytes(
        "GET",
        candidate["url"],
        maximum=MAX_AUDIO_BYTES,
        accept="audio/*,application/octet-stream",
        private_network_origin=private_network_origin,
        deadline=deadline,
    )
    detected = _detect_audio_format(data)
    allowed_content_type = (
        not response_content_type
        or response_content_type.startswith("audio/")
        or response_content_type in {"application/octet-stream", "binary/octet-stream", "application/ogg", "video/mp4"}
    )
    if detected is None or not allowed_content_type:
        raise HoshidictsAudioError("Hoshidicts provider did not return valid audio.", 502)
    if source["type"] == "jpod101" and hashlib.sha256(data).hexdigest() == _INVALID_JPOD101_DIGEST:
        raise HoshidictsAudioError("JapanesePod101 has no audio for this term.", 404)
    content_type, extension = detected
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
    if (
        not isinstance(candidate_index, int)
        or isinstance(candidate_index, bool)
        or not 0 <= candidate_index < MAX_AUDIO_SOURCES
    ):
        raise HoshidictsAudioError("Hoshidicts audio candidate index is invalid.")
    normalized_profile = (
        normalize_hoshidicts_audio_profile(profile) if profile is not None else load_hoshidicts_audio_profile()
    )
    if candidate_id is not None and (
        not isinstance(candidate_id, str) or _CANDIDATE_ID_PATTERN.fullmatch(candidate_id) is None
    ):
        raise HoshidictsAudioError("Hoshidicts audio candidate ID is invalid.")
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
    normalized_profile = (
        normalize_hoshidicts_audio_profile(profile) if profile is not None else load_hoshidicts_audio_profile()
    )
    if not normalized_profile["enabled"]:
        raise HoshidictsAudioError("Hoshidicts audio is disabled.", 503)

    deadline = time.monotonic() + MAX_MINING_AUDIO_SECONDS
    attempts = 0
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
            if attempts >= MAX_MINING_AUDIO_ATTEMPTS:
                raise HoshidictsAudioError("Pronunciation audio lookup reached its attempt limit.", 504)
            attempts += 1
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
        if (
            not isinstance(candidate_index, int)
            or isinstance(candidate_index, bool)
            or not 0 <= candidate_index < MAX_AUDIO_SOURCES
        ):
            raise HoshidictsAudioError("Hoshidicts audio candidate index is invalid.")
        candidate_id = value["candidateId"]
        if not isinstance(candidate_id, str) or _CANDIDATE_ID_PATTERN.fullmatch(candidate_id) is None:
            raise HoshidictsAudioError("Hoshidicts audio candidate ID is invalid.")
    return value
