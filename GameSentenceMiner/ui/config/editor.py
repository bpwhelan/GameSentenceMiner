from __future__ import annotations

import copy
from typing import Any, Callable, Dict, List, Tuple

from GameSentenceMiner.util.config import configuration
from GameSentenceMiner.util.config.configuration import Config

Path = Tuple[str, ...]


class ConfigEditor:
    def __init__(self, load_func: Callable[[], Config] | None = None):
        self._load_func = load_func or configuration.load_config
        self.master_config: Config = self._load_func()
        self.profile_name = self.master_config.current_profile
        self.profile = copy.deepcopy(self.master_config.get_config())
        self.default_master = Config.new()
        self.default_profile = self.default_master.get_config()
        self.dirty = False
        self._listeners: Dict[Path, List[Callable[[Any], None]]] = {}

    def replace_master_config(self, new_master: Config) -> None:
        self.master_config = new_master
        self.profile_name = new_master.current_profile
        self.profile = copy.deepcopy(new_master.get_config())
        self.dirty = False
        self.notify_all()

    def set_current_profile(self, profile_name: str) -> None:
        if profile_name not in self.master_config.configs:
            return
        self.profile_name = profile_name
        self.profile = copy.deepcopy(self.master_config.configs[profile_name])
        self.dirty = False
        self.notify_all()

    def get_value(self, path: Path) -> Any:
        root = path[0]
        obj: Any = self.master_config if root == "master" else self.profile
        for part in path[1:]:
            obj = getattr(obj, part)
        return obj

    def set_value(self, path: Path, value: Any) -> None:
        root = path[0]
        obj: Any = self.master_config if root == "master" else self.profile
        for part in path[1:-1]:
            obj = getattr(obj, part)
        field = path[-1]
        old_value = getattr(obj, field)
        if old_value == value:
            return
        setattr(obj, field, value)
        self.dirty = True
        self._notify(path, value)

    def subscribe(self, path: Path, callback: Callable[[Any], None]) -> None:
        self._listeners.setdefault(path, []).append(callback)

    def notify_all(self) -> None:
        for path in list(self._listeners.keys()):
            self._notify(path, self.get_value(path))

    def _notify(self, path: Path, value: Any) -> None:
        for callback in self._listeners.get(path, []):
            callback(value)

    def clear_listeners(self) -> None:
        self._listeners.clear()
