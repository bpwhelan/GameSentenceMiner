from __future__ import annotations

from types import SimpleNamespace

import GameSentenceMiner.profile_switcher as profile_switcher_module
from GameSentenceMiner.profile_switcher import ProfileSwitcher


def _patch_config(monkeypatch, master_config, saved_profiles: list[str]) -> None:
    monkeypatch.setattr(profile_switcher_module, "get_master_config", lambda: master_config)
    monkeypatch.setattr(
        profile_switcher_module,
        "switch_profile_and_save",
        lambda profile_name: saved_profiles.append(profile_name),
    )


def test_sync_profile_for_scene_switches_to_matching_profile_without_prompt(monkeypatch):
    switcher = ProfileSwitcher()
    previous_line_refreshes = []

    master_config = SimpleNamespace(
        configs={
            "Default": SimpleNamespace(scenes=[]),
            "Persona 3": SimpleNamespace(scenes=["Dorm"]),
        },
        current_profile="Default",
        switch_to_default_if_not_found=True,
    )
    saved_profiles = []

    _patch_config(monkeypatch, master_config, saved_profiles)

    result = switcher.sync_profile_for_scene(
        "Dorm",
        interactive=False,
        on_profile_switched=lambda: previous_line_refreshes.append(True),
    )

    assert result == "Persona 3"
    assert master_config.current_profile == "Persona 3"
    assert saved_profiles == ["Persona 3"]
    assert previous_line_refreshes == [True]


def test_sync_profile_for_scene_does_not_record_automatic_switch_as_manual(monkeypatch):
    switcher = ProfileSwitcher()
    previous_line_refreshes = []

    master_config = SimpleNamespace(
        configs={
            "Default": SimpleNamespace(scenes=[]),
            "Persona 3": SimpleNamespace(scenes=["Dorm"]),
        },
        current_profile="Default",
        switch_to_default_if_not_found=True,
    )
    saved_profiles = []
    reload_suppressions = []

    class _FakeSettingsWindow:
        def reload_settings(self, suppress_profile_change_hooks=False):
            reload_suppressions.append(suppress_profile_change_hooks)
            if not suppress_profile_change_hooks:
                switcher.record_manual_profile_switch("Default", "Persona 3")

    _patch_config(monkeypatch, master_config, saved_profiles)

    result = switcher.sync_profile_for_scene(
        "Dorm",
        interactive=False,
        settings_window=_FakeSettingsWindow(),
        on_profile_switched=lambda: previous_line_refreshes.append(True),
    )

    assert result == "Persona 3"
    assert switcher.scene_profile_switch_resume_profile is None
    assert reload_suppressions == [True]
    assert master_config.current_profile == "Persona 3"
    assert saved_profiles == ["Persona 3"]
    assert previous_line_refreshes == [True]


def test_sync_profile_for_scene_skips_ambiguous_matches_during_periodic_checks(monkeypatch):
    switcher = ProfileSwitcher()
    master_config = SimpleNamespace(
        configs={
            "Default": SimpleNamespace(scenes=[]),
            "VN A": SimpleNamespace(scenes=["Shared Scene"]),
            "VN B": SimpleNamespace(scenes=["Shared Scene"]),
        },
        current_profile="Default",
        switch_to_default_if_not_found=True,
    )
    saved_profiles = []

    _patch_config(monkeypatch, master_config, saved_profiles)

    result = switcher.sync_profile_for_scene("Shared Scene", interactive=False)

    assert result is None
    assert master_config.current_profile == "Default"
    assert saved_profiles == []


def test_manual_profile_switch_pauses_automatic_scene_profile_switching(monkeypatch):
    switcher = ProfileSwitcher()
    master_config = SimpleNamespace(
        configs={
            "Default": SimpleNamespace(scenes=[]),
            "Persona 3": SimpleNamespace(scenes=["Dorm"]),
        },
        current_profile="Persona 3",
        switch_to_default_if_not_found=True,
    )
    saved_profiles = []

    _patch_config(monkeypatch, master_config, saved_profiles)

    switcher.record_manual_profile_switch("Persona 3", "Default")
    master_config.current_profile = "Default"

    result = switcher.sync_profile_for_scene("Dorm", interactive=False)

    assert result is None
    assert master_config.current_profile == "Default"
    assert saved_profiles == []
    assert switcher.scene_profile_switch_resume_profile == "Persona 3"


def test_manual_switch_back_to_original_profile_resumes_scene_profile_switching(monkeypatch):
    switcher = ProfileSwitcher(scene_profile_switch_resume_profile="Persona 3")
    master_config = SimpleNamespace(
        configs={
            "Default": SimpleNamespace(scenes=[]),
            "Persona 3": SimpleNamespace(scenes=["Dorm"]),
            "Persona 4": SimpleNamespace(scenes=["Classroom"]),
        },
        current_profile="Default",
        switch_to_default_if_not_found=True,
    )
    saved_profiles = []

    _patch_config(monkeypatch, master_config, saved_profiles)

    switcher.record_manual_profile_switch("Default", "Persona 3")
    master_config.current_profile = "Persona 3"
    result = switcher.sync_profile_for_scene("Classroom", interactive=False)

    assert result == "Persona 4"
    assert switcher.scene_profile_switch_resume_profile is None
    assert master_config.current_profile == "Persona 4"
    assert saved_profiles == ["Persona 4"]


def test_associate_scene_with_profile_moves_scene_exclusively(monkeypatch):
    save_calls = []
    master_config = SimpleNamespace(
        configs={
            "Default": SimpleNamespace(scenes=["Shared Scene"]),
            "Persona 3": SimpleNamespace(scenes=["Dorm"]),
        },
        current_profile="Default",
        switch_to_default_if_not_found=True,
        save=lambda: save_calls.append(True),
    )
    monkeypatch.setattr(profile_switcher_module, "get_master_config", lambda: master_config)

    changed = ProfileSwitcher.associate_scene_with_profile("Shared Scene", "Persona 3")

    assert changed is True
    assert master_config.configs["Persona 3"].scenes == ["Dorm", "Shared Scene"]
    assert master_config.configs["Default"].scenes == []
    assert save_calls == [True]


def test_associate_scene_with_profile_is_noop_when_already_linked(monkeypatch):
    save_calls = []
    master_config = SimpleNamespace(
        configs={
            "Default": SimpleNamespace(scenes=[]),
            "Persona 3": SimpleNamespace(scenes=["Dorm"]),
        },
        current_profile="Default",
        switch_to_default_if_not_found=True,
        save=lambda: save_calls.append(True),
    )
    monkeypatch.setattr(profile_switcher_module, "get_master_config", lambda: master_config)

    changed = ProfileSwitcher.associate_scene_with_profile("Dorm", "Persona 3")

    assert changed is False
    assert master_config.configs["Persona 3"].scenes == ["Dorm"]
    assert save_calls == []


def test_associate_scene_with_profile_unknown_profile_does_nothing(monkeypatch):
    save_calls = []
    master_config = SimpleNamespace(
        configs={"Default": SimpleNamespace(scenes=[])},
        current_profile="Default",
        switch_to_default_if_not_found=True,
        save=lambda: save_calls.append(True),
    )
    monkeypatch.setattr(profile_switcher_module, "get_master_config", lambda: master_config)

    changed = ProfileSwitcher.associate_scene_with_profile("Dorm", "Missing")

    assert changed is False
    assert save_calls == []


def test_create_profile_clones_default_and_saves(monkeypatch):
    save_calls = []
    default_profile = SimpleNamespace(name="Default", scenes=["Dorm"])
    master_config = SimpleNamespace(
        configs={"Default": default_profile},
        current_profile="Default",
        switch_to_default_if_not_found=True,
        save=lambda: save_calls.append(True),
        get_default_config=lambda: default_profile,
    )
    monkeypatch.setattr(profile_switcher_module, "get_master_config", lambda: master_config)

    created = ProfileSwitcher.create_profile("Persona 3")

    assert created is True
    assert "Persona 3" in master_config.configs
    assert master_config.configs["Persona 3"].name == "Persona 3"
    assert master_config.configs["Persona 3"].scenes == []
    # Cloning must not mutate the Default profile.
    assert default_profile.scenes == ["Dorm"]
    assert save_calls == [True]


def test_create_profile_existing_name_is_noop(monkeypatch):
    save_calls = []
    master_config = SimpleNamespace(
        configs={"Default": SimpleNamespace(name="Default", scenes=[])},
        current_profile="Default",
        switch_to_default_if_not_found=True,
        save=lambda: save_calls.append(True),
        get_default_config=lambda: SimpleNamespace(name="Default", scenes=[]),
    )
    monkeypatch.setattr(profile_switcher_module, "get_master_config", lambda: master_config)

    created = ProfileSwitcher.create_profile("Default")

    assert created is False
    assert save_calls == []


def test_switch_profile_records_manual_profile_override(monkeypatch):
    switcher = ProfileSwitcher()
    master_config = SimpleNamespace(current_profile="Persona 3")
    saved_profiles = []

    _patch_config(monkeypatch, master_config, saved_profiles)

    switcher.switch_profile("Default")

    assert switcher.scene_profile_switch_resume_profile == "Persona 3"
    assert master_config.current_profile == "Default"
    assert saved_profiles == ["Default"]
