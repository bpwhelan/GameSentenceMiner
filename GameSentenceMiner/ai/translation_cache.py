from __future__ import annotations

import re
import threading
from collections import OrderedDict
from collections.abc import Callable, Hashable
from concurrent.futures import Future
from html import unescape


def normalize_translation_source(text: str) -> str:
    """Match a dialogue line to its Anki markup without discarding punctuation."""
    text = re.sub(r"{{c\d+::(.*?)(?:::[^{}]*)?}}", r"\1", text or "", flags=re.DOTALL)
    text = re.sub(r"<br\s*/?>|</(?:p|div)\s*>", "\n", text, flags=re.IGNORECASE)
    text = re.sub(r"<[^>]+>", "", text)
    return "\n".join(part.strip() for part in unescape(text).splitlines()).strip()


def is_successful_translation(text: str) -> bool:
    return (
        isinstance(text, str)
        and bool(text.strip())
        and not text.lstrip().startswith(("Processing failed:", "Invalid input."))
    )


class TranslationCache:
    """Bounded per-line results shared by reader, Anki, and concurrent requests."""

    def __init__(self, max_entries: int = 10_000):
        self._max_entries = max(1, max_entries)
        self._results: OrderedDict[Hashable, str] = OrderedDict()
        self._pending: dict[Hashable, Future[str]] = {}
        self._lock = threading.Lock()

    def get_or_translate(self, key: Hashable, generate: Callable[[], str], *, force_refresh: bool = False) -> str:
        with self._lock:
            future = self._pending.get(key)
            owner = future is None
            if owner:
                if not force_refresh and key in self._results:
                    self._results.move_to_end(key)
                    return self._results[key]
                future = Future()
                self._pending[key] = future

        if not owner:
            return future.result()

        try:
            result = generate()
            if is_successful_translation(result):
                with self._lock:
                    self._results[key] = result
                    self._results.move_to_end(key)
                    while len(self._results) > self._max_entries:
                        self._results.popitem(last=False)
            future.set_result(result)
            return result
        except BaseException as exc:
            # Release every waiter even if the owner is interrupted.
            future.set_exception(exc)
            raise
        finally:
            with self._lock:
                self._pending.pop(key, None)


line_translation_cache = TranslationCache()
