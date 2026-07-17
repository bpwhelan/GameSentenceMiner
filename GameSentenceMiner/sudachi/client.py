from __future__ import annotations

import json
import os
import re
import threading
from collections import OrderedDict
from collections.abc import Callable, Sequence
from typing import Any

from websockets.sync.client import connect

from .furigana import format_output
from .kana import to_hiragana, to_katakana
from .types import PartOfSpeech, SudachiToken


DEFAULT_INPUT_SERVER_URL = "ws://127.0.0.1:7276"
DEFAULT_DICTIONARY = "small"


class SudachiUnavailableError(RuntimeError):
    pass


def escape_text(text: str) -> str:
    """Remove markup and control syntax before morphological analysis."""

    text = str(text).replace("\n", " ").replace("\uff5e", "~")
    text = re.sub(r"<[^<>]+>", "", text)
    text = re.sub(r"\[sound:[^]]+]", "", text)
    text = re.sub(r"\[\[type:[^]]+]]", "", text)
    return text.strip()


class SudachiClient:
    """Synchronous, thread-safe client for GSM's shared Rust Sudachi service."""

    def __init__(
        self,
        *,
        endpoint: str | None = None,
        dictionary: str | None = None,
        cache_max_size: int = 1024,
        connect_factory: Callable[..., Any] = connect,
    ) -> None:
        self.endpoint = endpoint or os.getenv("GSM_INPUT_SERVER_URL", DEFAULT_INPUT_SERVER_URL)
        self.dictionary = (dictionary or os.getenv("GSM_SUDACHI_DICT_KIND", DEFAULT_DICTIONARY)).lower()
        if self.dictionary not in {"small", "core", "full"}:
            self.dictionary = DEFAULT_DICTIONARY
        self._cache_max_size = max(0, cache_max_size)
        self._cache: OrderedDict[str, tuple[SudachiToken, ...]] = OrderedDict()
        self._connect_factory = connect_factory
        self._socket: Any | None = None
        self._request_id = 0
        self._acquire_feature = True
        self._lock = threading.RLock()

    def close(self) -> None:
        with self._lock:
            socket, self._socket = self._socket, None
            if socket is not None:
                try:
                    socket.close()
                except Exception:
                    pass

    def configure(self, *, dictionary: str | None = None, acquire_feature: bool = True) -> None:
        """Set GSM-owned Sudachi options without loading the dictionary yet."""
        with self._lock:
            normalized_dictionary = self.dictionary
            if dictionary is not None:
                candidate = str(dictionary).strip().lower()
                normalized_dictionary = candidate if candidate in {"small", "core", "full"} else DEFAULT_DICTIONARY

            acquire_feature = bool(acquire_feature)
            dictionary_changed = normalized_dictionary != self.dictionary
            mode_changed = acquire_feature != self._acquire_feature
            if dictionary_changed or mode_changed:
                self.close()
            if dictionary_changed or not acquire_feature:
                self._cache.clear()

            self.dictionary = normalized_dictionary
            self._acquire_feature = acquire_feature

    def is_available_without_loading(self) -> bool:
        """Check for an existing Sudachi lease without acquiring one."""
        with self._lock:
            # Drop any lease acquired by this client before probing. This keeps
            # a previous tokenization-enabled request from making Sudachi look
            # externally available after tokenization has been disabled.
            self.close()
            socket: Any | None = None
            try:
                socket = self._connect_factory(
                    self.endpoint,
                    open_timeout=2,
                    close_timeout=1,
                    max_size=16 * 1024 * 1024,
                )
                payload = json.loads(socket.recv(timeout=2))
                while payload.get("type") != "service_info":
                    payload = json.loads(socket.recv(timeout=2))
                enabled = payload.get("features", {}).get("enabled", [])
                return "sudachi" in enabled
            except Exception:
                return False
            finally:
                if socket is not None:
                    try:
                        socket.close()
                    except Exception:
                        pass

    def _receive_type(self, expected_type: str, *, request_id: int | None = None) -> dict[str, Any]:
        if self._socket is None:
            raise ConnectionError("Sudachi service is not connected")
        while True:
            payload = json.loads(self._socket.recv(timeout=180))
            if payload.get("type") != expected_type:
                continue
            response_id = payload.get("requestId")
            if request_id is not None and response_id is not None and response_id != request_id:
                continue
            return payload

    def _connect(self) -> None:
        try:
            self._socket = self._connect_factory(
                self.endpoint,
                open_timeout=2,
                close_timeout=1,
                max_size=16 * 1024 * 1024,
            )
            service_info = self._receive_type("service_info")
            if not self._acquire_feature:
                enabled = service_info.get("features", {}).get("enabled", [])
                if "sudachi" not in enabled:
                    raise SudachiUnavailableError("The shared Sudachi capability is not enabled")
                return
            self._socket.send(json.dumps({"type": "configure_features", "features": ["sudachi"]}))
            self._socket.send(
                json.dumps(
                    {
                        "type": "configure_sudachi",
                        "dictionary": self.dictionary,
                    }
                )
            )
            self._receive_type("sudachi_configuration")
        except Exception as exc:
            self.close()
            raise SudachiUnavailableError(f"Unable to connect to Sudachi service at {self.endpoint}: {exc}") from exc

    def _request_tokens(self, text: str) -> tuple[SudachiToken, ...]:
        last_error: Exception | None = None
        for _attempt in range(2):
            if self._socket is None:
                self._connect()
            self._request_id += 1
            request_id = self._request_id
            try:
                request = {
                    "type": "tokenize",
                    "text": text,
                    "requestId": request_id,
                }
                if self._acquire_feature:
                    request["dictionary"] = self.dictionary
                self._socket.send(json.dumps(request, ensure_ascii=False))
                payload = self._receive_type("tokens", request_id=request_id)
                if payload.get("featureDisabled") or not payload.get("sudachiAvailable"):
                    raise SudachiUnavailableError("The shared Sudachi capability is unavailable")
                return tuple(self._parse_token(token) for token in payload.get("tokens", []))
            except SudachiUnavailableError:
                raise
            except Exception as exc:
                last_error = exc
                self.close()
        raise SudachiUnavailableError(f"Sudachi tokenization failed: {last_error}") from last_error

    @staticmethod
    def _parse_token(payload: dict[str, Any]) -> SudachiToken:
        word = str(payload.get("word") or "")
        headword = str(payload.get("headword") or word)
        reading = str(payload.get("reading") or "") or None
        return SudachiToken(
            word=word,
            headword=headword,
            katakana_reading=reading,
            part_of_speech=PartOfSpeech.from_sudachi(payload.get("pos")),
            start=int(payload.get("start") or 0),
            end=int(payload.get("end") or 0),
        )

    def translate(self, expression: str) -> Sequence[SudachiToken]:
        text = escape_text(expression)
        if not text:
            return ()
        with self._lock:
            cached = self._cache.get(text)
            if cached is not None:
                self._cache.move_to_end(text)
                return cached
            tokens = self._request_tokens(text)
            if self._cache_max_size:
                self._cache[text] = tokens
                self._cache.move_to_end(text)
                while len(self._cache) > self._cache_max_size:
                    self._cache.popitem(last=False)
            return tokens

    def reading(self, expression: str) -> str:
        output: list[str] = []
        for token in self.translate(expression):
            reading = token.katakana_reading
            if reading and to_katakana(reading) != to_katakana(token.word):
                output.append(format_output(token.word, to_hiragana(reading)))
            else:
                output.append(token.word)
        return "".join(output)

    def to_hiragana(self, expression: str) -> str:
        return "".join(to_hiragana(token.katakana_reading or token.word) for token in self.translate(expression))
