from __future__ import annotations

from collections.abc import Sequence
from typing import Any, Protocol

from GameSentenceMiner.util.config.configuration import get_master_config


SUDACHI_BACKEND = "sudachi"
TOKENIZATION_BACKENDS = (SUDACHI_BACKEND,)
SUDACHI_DICTIONARIES = ("small", "core", "full")
DEFAULT_SUDACHI_DICTIONARY = "small"


class _TokenizerBackend(Protocol):
    def translate(self, expression: str) -> Sequence[Any]: ...

    def reading(self, expression: str) -> str: ...

    def to_hiragana(self, expression: str) -> str: ...


class _SudachiBackend(_TokenizerBackend, Protocol):
    def configure(self, *, dictionary: str | None = None, acquire_feature: bool = True) -> None: ...


def normalize_tokenization_backend(value: object) -> str:
    # Includes migration of saved MeCab selections. This never touches vocabulary data.
    return SUDACHI_BACKEND


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


def _load_sudachi() -> _SudachiBackend:
    from GameSentenceMiner.sudachi import sudachi

    return sudachi


def is_word_token(token: Any) -> bool:
    """Return whether a token should be persisted in GSM's word tables."""
    part_of_speech = getattr(token, "part_of_speech", None)
    is_word = getattr(part_of_speech, "is_word", None)
    if is_word is not None:
        return bool(is_word)
    return getattr(part_of_speech, "name", None) not in {"symbol", "whitespace", "other"}


class Tokenizer:
    """All Japanese features share Sudachi, including when word statistics are off."""

    def _call(self, method_name: str, expression: str):
        sudachi = _load_sudachi()
        sudachi.configure(dictionary=get_sudachi_dictionary(), acquire_feature=True)
        return getattr(sudachi, method_name)(expression)

    def translate(self, expression: str) -> Sequence[Any]:
        return self._call("translate", expression)

    def reading(self, expression: str) -> str:
        return self._call("reading", expression)

    def to_hiragana(self, expression: str) -> str:
        return self._call("to_hiragana", expression)


tokenizer = Tokenizer()


__all__ = [
    "DEFAULT_SUDACHI_DICTIONARY",
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
