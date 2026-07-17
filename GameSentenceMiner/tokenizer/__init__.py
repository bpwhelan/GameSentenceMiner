from __future__ import annotations

import sys
from collections.abc import Sequence
from typing import Any, Protocol

from GameSentenceMiner.util.config.configuration import get_master_config, logger
from GameSentenceMiner.util.config.feature_flags import is_tokenization_enabled


MECAB_BACKEND = "mecab"
SUDACHI_BACKEND = "sudachi"
TOKENIZATION_BACKENDS = (SUDACHI_BACKEND, MECAB_BACKEND)
SUDACHI_DICTIONARIES = ("small", "core", "full")
DEFAULT_SUDACHI_DICTIONARY = "small"


class _TokenizerBackend(Protocol):
    def translate(self, expression: str) -> Sequence[Any]: ...

    def reading(self, expression: str) -> str: ...

    def to_hiragana(self, expression: str) -> str: ...


class _SudachiBackend(_TokenizerBackend, Protocol):
    def configure(self, *, dictionary: str | None = None, acquire_feature: bool = True) -> None: ...


def normalize_tokenization_backend(value: object) -> str:
    normalized = str(value or "").strip().lower()
    return MECAB_BACKEND if normalized == MECAB_BACKEND else SUDACHI_BACKEND


def get_tokenization_backend() -> str:
    master = get_master_config()
    experimental = getattr(master, "experimental", None) if master else None
    return normalize_tokenization_backend(getattr(experimental, "tokenization_backend", SUDACHI_BACKEND))


def normalize_sudachi_dictionary(value: object) -> str:
    normalized = str(value or "").strip().lower()
    return normalized if normalized in SUDACHI_DICTIONARIES else DEFAULT_SUDACHI_DICTIONARY


def get_sudachi_dictionary() -> str:
    master = get_master_config()
    experimental = getattr(master, "experimental", None) if master else None
    return normalize_sudachi_dictionary(
        getattr(experimental, "tokenization_sudachi_dictionary", DEFAULT_SUDACHI_DICTIONARY)
    )


def _load_mecab() -> _TokenizerBackend:
    from GameSentenceMiner.mecab import mecab

    return mecab


def _load_sudachi() -> _SudachiBackend:
    from GameSentenceMiner.sudachi import sudachi

    return sudachi


def _is_sudachi_available_without_loading() -> bool:
    from GameSentenceMiner.sudachi import sudachi

    return sudachi.is_available_without_loading()


def _release_own_sudachi_lease() -> None:
    sudachi_module = sys.modules.get("GameSentenceMiner.sudachi")
    sudachi_client = getattr(sudachi_module, "sudachi", None)
    if sudachi_client is not None:
        sudachi_client.close()


def is_word_token(token: Any) -> bool:
    """Return whether a token should be persisted in GSM's word tables."""
    part_of_speech = getattr(token, "part_of_speech", None)
    is_word = getattr(part_of_speech, "is_word", None)
    if is_word is not None:
        return bool(is_word)
    return getattr(part_of_speech, "name", None) not in {"symbol", "whitespace", "other"}


class Tokenizer:
    """Shared MeCab/Sudachi facade used by GSM's Python backend."""

    def _select_backend(self) -> tuple[str, _TokenizerBackend]:
        if is_tokenization_enabled():
            configured_backend = get_tokenization_backend()
            if configured_backend == SUDACHI_BACKEND:
                sudachi = _load_sudachi()
                sudachi.configure(dictionary=get_sudachi_dictionary(), acquire_feature=True)
                return SUDACHI_BACKEND, sudachi
            _release_own_sudachi_lease()
            return MECAB_BACKEND, _load_mecab()

        if _is_sudachi_available_without_loading():
            sudachi = _load_sudachi()
            sudachi.configure(acquire_feature=False)
            return SUDACHI_BACKEND, sudachi
        return MECAB_BACKEND, _load_mecab()

    def _call(self, method_name: str, expression: str):
        backend_name, backend = self._select_backend()
        try:
            return getattr(backend, method_name)(expression)
        except Exception as exc:
            if backend_name != SUDACHI_BACKEND:
                raise
            from GameSentenceMiner.sudachi import SudachiUnavailableError

            if not isinstance(exc, SudachiUnavailableError):
                raise
            logger.warning(f"Sudachi {method_name} failed; falling back to MeCab: {exc}")
            return getattr(_load_mecab(), method_name)(expression)

    def translate(self, expression: str) -> Sequence[Any]:
        return self._call("translate", expression)

    def reading(self, expression: str) -> str:
        return self._call("reading", expression)

    def to_hiragana(self, expression: str) -> str:
        return self._call("to_hiragana", expression)


tokenizer = Tokenizer()


__all__ = [
    "DEFAULT_SUDACHI_DICTIONARY",
    "MECAB_BACKEND",
    "SUDACHI_BACKEND",
    "SUDACHI_DICTIONARIES",
    "TOKENIZATION_BACKENDS",
    "Tokenizer",
    "get_sudachi_dictionary",
    "get_tokenization_backend",
    "is_word_token",
    "normalize_sudachi_dictionary",
    "normalize_tokenization_backend",
    "tokenizer",
]
