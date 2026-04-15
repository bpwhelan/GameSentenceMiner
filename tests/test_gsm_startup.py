from types import SimpleNamespace

import GameSentenceMiner.gsm as gsm_module


def test_main_skips_run_when_existing_instance_detected(monkeypatch):
    calls = []

    class _FakeApp:
        async def check_if_script_is_running(self):
            calls.append("check")
            return True

        async def log_current_pid(self):
            calls.append("log")

        def run(self):
            calls.append("run")

    monkeypatch.setattr(gsm_module, "GSMApplication", _FakeApp)
    monkeypatch.setattr(gsm_module, "_acquire_single_instance_lock", lambda: True)
    monkeypatch.setattr(gsm_module.logger, "info", lambda *_args, **_kwargs: None)

    gsm_module.main()

    assert calls == ["check"]


def test_main_logs_pid_before_run_when_no_existing_instance(monkeypatch):
    calls = []

    class _FakeApp:
        async def check_if_script_is_running(self):
            calls.append("check")
            return False

        async def log_current_pid(self):
            calls.append("log")

        def run(self):
            calls.append("run")

    monkeypatch.setattr(gsm_module, "GSMApplication", _FakeApp)
    monkeypatch.setattr(gsm_module, "_acquire_single_instance_lock", lambda: True)
    monkeypatch.setattr(gsm_module.logger, "info", lambda *_args, **_kwargs: None)

    gsm_module.main()

    assert calls == ["check", "log", "run"]


def test_connect_obs_when_available_uses_single_connection(monkeypatch):
    app = gsm_module.GSMApplication()
    connect_calls = []

    async def _fake_wait_for_obs_ready():
        return True

    async def _fake_connect_to_obs(**kwargs):
        connect_calls.append(kwargs)
        gsm_module.gsm_status.obs_connected = True

    async def _fake_register_scene_switcher_callback():
        connect_calls.append({"registered": True})

    async def _fake_check_obs_folder_is_correct():
        connect_calls.append({"checked_folder": True})

    monkeypatch.setattr(gsm_module.obs, "wait_for_obs_ready", _fake_wait_for_obs_ready)
    monkeypatch.setattr(gsm_module.obs, "connect_to_obs", _fake_connect_to_obs)
    monkeypatch.setattr(gsm_module, "check_obs_folder_is_correct", _fake_check_obs_folder_is_correct)
    monkeypatch.setattr(app, "register_scene_switcher_callback", _fake_register_scene_switcher_callback)
    monkeypatch.setattr(app, "on_config_changed", lambda: connect_calls.append({"config_changed": True}))
    monkeypatch.setattr(gsm_module.gsm_status, "obs_connected", False, raising=False)
    monkeypatch.setattr(gsm_module.gsm_state, "keep_running", True, raising=False)

    gsm_module.asyncio.run(app._connect_obs_when_available())

    assert connect_calls[0]["connections"] == 2
    assert connect_calls[0]["check_output"] is True
    assert connect_calls[0]["start_manager"] is True


def test_sync_profile_for_scene_switches_to_matching_profile_without_prompt(monkeypatch):
    app = gsm_module.GSMApplication.__new__(gsm_module.GSMApplication)
    app.state = SimpleNamespace(settings_window=None)
    previous_line_refreshes = []
    app.get_previous_lines_for_game = lambda: previous_line_refreshes.append(True)

    master_config = SimpleNamespace(
        configs={
            "Default": SimpleNamespace(scenes=[]),
            "Persona 3": SimpleNamespace(scenes=["Dorm"]),
        },
        current_profile="Default",
        switch_to_default_if_not_found=True,
    )
    saved_profiles = []

    monkeypatch.setattr(gsm_module, "get_master_config", lambda: master_config)
    monkeypatch.setattr(gsm_module, "switch_profile_and_save", lambda profile_name: saved_profiles.append(profile_name))

    result = gsm_module.GSMApplication._sync_profile_for_scene(app, "Dorm", interactive=False)

    assert result == "Persona 3"
    assert master_config.current_profile == "Persona 3"
    assert saved_profiles == ["Persona 3"]
    assert previous_line_refreshes == [True]


def test_sync_profile_for_scene_skips_ambiguous_matches_during_periodic_checks(monkeypatch):
    app = gsm_module.GSMApplication.__new__(gsm_module.GSMApplication)
    app.state = SimpleNamespace(settings_window=None)
    app.get_previous_lines_for_game = lambda: None

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

    monkeypatch.setattr(gsm_module, "get_master_config", lambda: master_config)
    monkeypatch.setattr(gsm_module, "switch_profile_and_save", lambda profile_name: saved_profiles.append(profile_name))

    result = gsm_module.GSMApplication._sync_profile_for_scene(app, "Shared Scene", interactive=False)

    assert result is None
    assert master_config.current_profile == "Default"
    assert saved_profiles == []


def test_register_scene_observed_profile_check_registers_handler_and_checks_current_scene(monkeypatch):
    app = gsm_module.GSMApplication.__new__(gsm_module.GSMApplication)
    seen_scenes = []
    app._check_profile_for_scene_tick = lambda scene: seen_scenes.append(scene)

    handlers = []
    fake_service = SimpleNamespace(
        state=SimpleNamespace(current_scene="Boot Scene"),
        on_scene_observed=lambda handler: handlers.append(handler),
    )

    monkeypatch.setattr(gsm_module.obs, "obs_service", fake_service, raising=False)

    gsm_module.GSMApplication._register_scene_observed_profile_check(app)

    assert handlers == [app._check_profile_for_scene_tick]
    assert seen_scenes == ["Boot Scene"]


def test_main_exits_when_single_instance_lock_is_unavailable(monkeypatch):
    constructed = []

    class _FakeApp:
        def __init__(self):
            constructed.append(True)

    monkeypatch.setattr(gsm_module, "GSMApplication", _FakeApp)
    monkeypatch.setattr(gsm_module, "_acquire_single_instance_lock", lambda: False)
    monkeypatch.setattr(gsm_module.logger, "info", lambda *_args, **_kwargs: None)

    gsm_module.main()

    assert constructed == []
