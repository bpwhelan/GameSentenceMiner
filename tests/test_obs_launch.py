from __future__ import annotations

from types import SimpleNamespace

import GameSentenceMiner.obs as obs_module


def test_cleanup_obs_startup_artifacts_removes_sentinel_and_scene_switcher_running_file(tmp_path) -> None:
    app_dir = tmp_path / "GameSentenceMiner"
    sentinel_dir = app_dir / "obs-studio" / "config" / "obs-studio" / ".sentinel"
    sentinel_dir.mkdir(parents=True)
    running_file = (
        app_dir / "obs-studio" / "config" / "obs-studio" / "plugin_config" / "advanced-scene-switcher" / ".running"
    )
    running_file.parent.mkdir(parents=True, exist_ok=True)
    running_file.write_text("running", encoding="utf-8")

    obs_module._cleanup_obs_startup_artifacts(str(app_dir))

    assert not sentinel_dir.exists()
    assert not running_file.exists()


def test_build_obs_launch_command_disables_updates_by_default() -> None:
    config = SimpleNamespace(
        obs=SimpleNamespace(
            disable_recording=False,
            allow_automatic_updates=False,
        )
    )

    obs_cmd = obs_module._build_obs_launch_command(["obs64.exe"], config_override=config)

    assert "--disable-updater" in obs_cmd
    assert "--startreplaybuffer" in obs_cmd


def test_build_obs_launch_command_can_allow_obs_updates() -> None:
    config = SimpleNamespace(
        obs=SimpleNamespace(
            disable_recording=True,
            allow_automatic_updates=True,
        )
    )

    obs_cmd = obs_module._build_obs_launch_command(["obs64.exe"], config_override=config)

    assert "--disable-updater" not in obs_cmd
    assert "--startreplaybuffer" not in obs_cmd
