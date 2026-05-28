from __future__ import annotations

import copy
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, ClassVar

from GameSentenceMiner.util.config import configuration
from GameSentenceMiner.util.config.configuration import (
    get_master_config,
    logger,
    switch_profile_and_save,
)


@dataclass
class ProfileSwitcher:
    scene_profile_switch_resume_profile: str | None = None
    _instance: ClassVar[ProfileSwitcher | None] = None

    @classmethod
    def instance(cls) -> ProfileSwitcher:
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    def switch_profile(self, profile_name: str, *, settings_window: Any | None = None) -> None:
        current_profile = get_master_config().current_profile
        self.record_manual_profile_switch(current_profile, profile_name)
        self._switch_profile_and_save(profile_name)
        self._reload_settings_window(settings_window)

    def sync_profile_for_scene(
        self,
        scene: str,
        *,
        interactive: bool,
        settings_window: Any | None = None,
        on_profile_switched: Callable[[], None] | None = None,
    ) -> str | None:
        if self.is_scene_profile_switch_paused():
            return None

        switch_to = self.resolve_profile_for_scene(scene, interactive=interactive)
        if not switch_to or switch_to == get_master_config().current_profile:
            return switch_to

        self._switch_profile_and_save(switch_to)
        if on_profile_switched:
            on_profile_switched()
        self._reload_settings_window(settings_window, suppress_profile_change_hooks=True)
        return switch_to

    @staticmethod
    def create_profile(profile_name: str) -> bool:
        """Create a new profile cloned from the Default profile. Returns True if created."""
        profile_name = str(profile_name or "").strip()
        if not profile_name:
            return False
        master = get_master_config()
        if profile_name in master.configs:
            return False

        new_config = copy.deepcopy(master.get_default_config())
        new_config.name = profile_name
        new_config.scenes = []
        master.configs[profile_name] = new_config
        master.save()
        logger.info(f"Created new profile '{profile_name}'.")
        return True

    @staticmethod
    def associate_scene_with_profile(scene: str, profile_name: str, *, exclusive: bool = True) -> bool:
        """Associate an OBS scene with a profile.

        When ``exclusive`` is True the scene is removed from every other profile so
        that each scene maps to exactly one profile. Returns True if anything changed.
        """
        scene = str(scene or "").strip()
        profile_name = str(profile_name or "").strip()
        if not scene or not profile_name:
            return False

        master = get_master_config()
        if profile_name not in master.configs:
            logger.warning(f"Cannot relate scene '{scene}': profile '{profile_name}' not found.")
            return False

        changed = False
        for name, config in master.configs.items():
            scenes = [str(s or "").strip() for s in (getattr(config, "scenes", []) or [])]
            scenes = [s for s in scenes if s]
            if name == profile_name:
                if scene not in scenes:
                    config.scenes = scenes + [scene]
                    changed = True
            elif exclusive and scene in scenes:
                config.scenes = [s for s in scenes if s != scene]
                changed = True

        if changed:
            master.save()
            logger.info(f"Related scene '{scene}' with profile '{profile_name}'.")
        return changed

    @staticmethod
    def get_matching_profiles_for_scene(scene: str) -> list[str]:
        normalized_scene = str(scene or "").strip()
        if not normalized_scene:
            return []

        matching_profiles = []
        for name, config in get_master_config().configs.items():
            configured_scenes = {
                str(configured_scene or "").strip() for configured_scene in getattr(config, "scenes", [])
            }
            configured_scenes.discard("")
            if normalized_scene in configured_scenes:
                matching_profiles.append(str(name).strip())
        return matching_profiles

    def resolve_profile_for_scene(self, scene: str, *, interactive: bool) -> str | None:
        matching_profiles = self.get_matching_profiles_for_scene(scene)
        current_profile = get_master_config().current_profile

        if len(matching_profiles) > 1:
            if current_profile in matching_profiles:
                return current_profile
            if not interactive:
                logger.info(f"Skipping ambiguous profile switch for scene '{scene}': {matching_profiles}")
                return None

            from GameSentenceMiner.ui.qt_main import launch_scene_selection

            return launch_scene_selection(matching_profiles) or None

        if matching_profiles:
            return matching_profiles[0]
        if get_master_config().switch_to_default_if_not_found:
            return configuration.DEFAULT_CONFIG
        return None

    def record_manual_profile_switch(self, previous_profile_name: str, new_profile_name: str) -> None:
        previous_profile_name = str(previous_profile_name or "").strip()
        new_profile_name = str(new_profile_name or "").strip()
        if not new_profile_name or new_profile_name == previous_profile_name:
            return

        resume_profile = self.scene_profile_switch_resume_profile
        if resume_profile:
            if new_profile_name == resume_profile:
                self.scene_profile_switch_resume_profile = None
                logger.info(
                    f"Resuming automatic scene profile switching after manual switch back to '{resume_profile}'."
                )
            return

        if previous_profile_name:
            self.scene_profile_switch_resume_profile = previous_profile_name
            logger.info(
                "Pausing automatic scene profile switching after manual switch from "
                f"'{previous_profile_name}' to '{new_profile_name}'. Switch back to "
                f"'{previous_profile_name}' or restart GSM to resume."
            )

    def is_scene_profile_switch_paused(self) -> bool:
        resume_profile = self.scene_profile_switch_resume_profile
        if not resume_profile:
            return False

        logger.debug(
            "Skipping automatic scene profile switch while manual profile override is active; "
            f"switch back to '{resume_profile}' or restart GSM to resume."
        )
        return True

    @staticmethod
    def _switch_profile_and_save(profile_name: str) -> None:
        logger.info(f"Switching to profile: {profile_name}")
        get_master_config().current_profile = profile_name
        switch_profile_and_save(profile_name)

    @staticmethod
    def _reload_settings_window(
        settings_window: Any | None,
        *,
        suppress_profile_change_hooks: bool = False,
    ) -> None:
        if not settings_window:
            return
        if suppress_profile_change_hooks:
            settings_window.reload_settings(suppress_profile_change_hooks=True)
        else:
            settings_window.reload_settings()


def get_profile_switcher() -> ProfileSwitcher:
    return ProfileSwitcher.instance()
