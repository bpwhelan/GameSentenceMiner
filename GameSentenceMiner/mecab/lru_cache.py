# Copyright: Ajatt-Tools and contributors; https://github.com/Ajatt-Tools
# License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

from collections import OrderedDict
from collections.abc import Hashable
from typing import Generic, TypeVar

K = TypeVar("K", bound=Hashable)
V = TypeVar("V")


class LRUCache(Generic[K, V]):
    """
    This class is used to cache results of calls to mecab.translate() instead of functools.lru_cache().
    """

    _cache: OrderedDict[K, V]
    _capacity: int

    def __init__(self, capacity: int = 0) -> None:
        self._capacity = capacity
        self._cache = OrderedDict()

    def __getitem__(self, key: K) -> V:
        value = self._cache[key]
        self._cache.move_to_end(key)
        return value

    def __setitem__(self, key: K, value: V) -> None:
        self._cache[key] = value
        self._cache.move_to_end(key)
        self._clear_old_items()

    def set_capacity(self, capacity: int) -> None:
        self._capacity = capacity
        self._clear_old_items()

    def _clear_old_items(self) -> None:
        if self._capacity > 0:
            while len(self._cache) > self._capacity:
                self._cache.popitem(last=False)

    def setdefault(self, key: K, value: V) -> V:
        value = self._cache.setdefault(key, value)
        self._cache.move_to_end(key)
        return value
