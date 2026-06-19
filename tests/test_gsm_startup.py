import asyncio
import gc
import sys
import threading
import time
from types import ModuleType, SimpleNamespace

import pytest

import GameSentenceMiner.gsm as gsm_module
from GameSentenceMiner.util import text_log


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
    wait_calls = []
    previous_line_refreshes = []

    async def _fake_wait_for_obs_ready(**kwargs):
        wait_calls.append(kwargs)
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
    monkeypatch.setattr(gsm_module, "get_config", lambda: SimpleNamespace(obs=SimpleNamespace(open_obs=True)))
    monkeypatch.setattr(gsm_module, "check_obs_folder_is_correct", _fake_check_obs_folder_is_correct)
    monkeypatch.setattr(app, "register_scene_switcher_callback", _fake_register_scene_switcher_callback)
    monkeypatch.setattr(app, "get_previous_lines_for_game", lambda: previous_line_refreshes.append(True))
    monkeypatch.setattr(app, "on_config_changed", lambda: connect_calls.append({"config_changed": True}))
    monkeypatch.setattr(gsm_module.gsm_status, "obs_connected", False, raising=False)
    monkeypatch.setattr(gsm_module.gsm_state, "keep_running", True, raising=False)

    gsm_module.asyncio.run(app._connect_obs_when_available())

    assert wait_calls == [{"interval": 0.5}]
    assert connect_calls[0]["connections"] == 2
    assert connect_calls[0]["check_output"] is True
    assert connect_calls[0]["start_manager"] is True
    assert connect_calls[0]["initial_connect_delay"] == pytest.approx(2.0)
    assert previous_line_refreshes == [True]


def test_launch_obs_early_skips_python_launch_under_electron(monkeypatch):
    app = gsm_module.GSMApplication.__new__(gsm_module.GSMApplication)
    app._obs_launch_thread = None
    calls = []

    monkeypatch.setenv("GSM_ELECTRON", "1")
    monkeypatch.setattr(gsm_module.obs, "start_obs", lambda: calls.append("start_obs"))
    monkeypatch.setattr(gsm_module.logger, "info", lambda *_args, **_kwargs: None)

    gsm_module.GSMApplication._launch_obs_early(app)

    assert app._obs_launch_thread is None
    assert calls == []


def test_switch_profile_delegates_to_profile_switcher():
    app = gsm_module.GSMApplication.__new__(gsm_module.GSMApplication)
    settings_window = object()
    calls = []

    class _FakeProfileSwitcher:
        def switch_profile(self, profile_name, *, settings_window=None):
            calls.append((profile_name, settings_window))

    app.state = SimpleNamespace(settings_window=settings_window)
    app.profile_switcher = _FakeProfileSwitcher()

    gsm_module.GSMApplication.switch_profile(app, "Default")

    assert calls == [("Default", settings_window)]


def test_check_profile_for_scene_tick_delegates_to_profile_switcher():
    app = gsm_module.GSMApplication.__new__(gsm_module.GSMApplication)
    settings_window = object()
    calls = []
    refreshes = []

    class _FakeProfileSwitcher:
        def sync_profile_for_scene(
            self,
            scene,
            *,
            interactive,
            settings_window=None,
            on_profile_switched=None,
        ):
            calls.append((scene, interactive, settings_window, on_profile_switched))
            on_profile_switched()

    app.state = SimpleNamespace(settings_window=settings_window)
    app.profile_switcher = _FakeProfileSwitcher()
    app.get_previous_lines_for_game = lambda: refreshes.append(True)

    gsm_module.GSMApplication._check_profile_for_scene_tick(app, "Dorm")

    assert calls == [("Dorm", False, settings_window, app.get_previous_lines_for_game)]
    assert refreshes == [True]


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


def test_post_init_async_registers_scene_callbacks_and_refreshes_previous_lines_when_obs_connected(monkeypatch):
    app = gsm_module.GSMApplication.__new__(gsm_module.GSMApplication)
    app._obs_connect_task = None
    calls = []

    async def _fake_register_scene_switcher_callback():
        calls.append("register_scene_switcher_callback")

    async def _fake_check_obs_folder_is_correct():
        calls.append("check_obs_folder_is_correct")

    async def _fake_init_overlay_processor():
        calls.append("init_overlay_processor")

    async def _fake_connect_obs_when_available():
        calls.append("connect_obs_when_available")

    fake_sudachi_module = ModuleType("GameSentenceMiner.util.yomitan_dict.sudachi_user_dict")
    fake_sudachi_module.queue_wait_for_scene_dictionary = lambda *_args, **_kwargs: calls.append(
        "queue_wait_for_scene_dictionary"
    )

    app.register_scene_switcher_callback = _fake_register_scene_switcher_callback
    app._register_scene_observed_profile_check = lambda: calls.append("register_scene_observed_profile_check")
    app.get_previous_lines_for_game = lambda: calls.append("get_previous_lines_for_game")
    app.on_config_changed = lambda: calls.append("on_config_changed")
    app.start_file_watcher = lambda: calls.append("start_file_watcher")
    app._connect_obs_when_available = _fake_connect_obs_when_available

    monkeypatch.setattr(gsm_module.gsm_status, "obs_connected", True, raising=False)
    monkeypatch.setattr(gsm_module, "check_obs_folder_is_correct", _fake_check_obs_folder_is_correct)
    monkeypatch.setattr(
        gsm_module,
        "_get_overlay_coords_module",
        lambda: SimpleNamespace(init_overlay_processor=_fake_init_overlay_processor),
    )
    monkeypatch.setattr(
        gsm_module,
        "_get_window_state_monitor_module",
        lambda: SimpleNamespace(cleanup_suspended_processes=lambda: calls.append("cleanup_suspended_processes")),
    )
    monkeypatch.setattr(
        gsm_module, "_get_vad_processor", lambda: SimpleNamespace(init=lambda: calls.append("vad_init"))
    )
    monkeypatch.setitem(sys.modules, "GameSentenceMiner.util.yomitan_dict.sudachi_user_dict", fake_sudachi_module)

    gsm_module.asyncio.run(app.post_init_async())

    assert "register_scene_switcher_callback" in calls
    assert "register_scene_observed_profile_check" in calls
    assert "get_previous_lines_for_game" in calls


def test_get_previous_lines_for_game_normalizes_lines(monkeypatch):
    app = gsm_module.GSMApplication.__new__(gsm_module.GSMApplication)
    monkeypatch.setattr(
        gsm_module,
        "get_config",
        lambda: SimpleNamespace(
            overlay=SimpleNamespace(check_previous_lines_for_recycled_indicator=True),
        ),
    )
    monkeypatch.setattr(gsm_module.obs, "get_current_scene", lambda: "Scene A")
    monkeypatch.setattr(gsm_module.obs, "get_current_game", lambda: "Game A")
    monkeypatch.setattr(
        gsm_module.db.GameLinesTable,
        "get_all_lines_for_scene",
        lambda _scene: [
            SimpleNamespace(line_text="Hello, World!"),
            SimpleNamespace(line_text=" Hello  World "),
            SimpleNamespace(line_text="「テ ス、ト」"),
            SimpleNamespace(line_text="..."),
        ],
    )
    monkeypatch.setattr(gsm_module.logger, "info", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(text_log.game_log, "previous_lines", set())

    app.get_previous_lines_for_game()

    assert text_log.game_log.previous_lines == {"HelloWorld", "テスト"}


def test_get_previous_lines_for_game_clears_cache_when_disabled(monkeypatch):
    app = gsm_module.GSMApplication.__new__(gsm_module.GSMApplication)
    monkeypatch.setattr(
        gsm_module,
        "get_config",
        lambda: SimpleNamespace(
            overlay=SimpleNamespace(check_previous_lines_for_recycled_indicator=False),
        ),
    )
    monkeypatch.setattr(
        gsm_module.db.GameLinesTable,
        "get_all_lines_for_scene",
        lambda _scene: (_ for _ in ()).throw(AssertionError("db lookup should not run when disabled")),
    )
    monkeypatch.setattr(gsm_module.logger, "info", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(text_log.game_log, "previous_lines", {"existing"})

    app.get_previous_lines_for_game()

    assert text_log.game_log.previous_lines == set()


def test_async_runner_keeps_fire_and_forget_task_alive_through_gc():
    """A submitted task whose future the caller discards must not be GC-collected.

    Regression for the cron scheduler dying right after startup: discarding the
    future let the GC close the still-pending coroutine, running its `finally`
    (cron_scheduler.shutdown) early. The runner must retain a strong reference.
    """
    runner = gsm_module.AsyncBackgroundRunner("gsm-test-async")
    runner.start()

    finally_ran = threading.Event()

    async def long_lived():
        try:
            await asyncio.Event().wait()
        finally:
            finally_ran.set()

    try:
        # Fire-and-forget: deliberately drop the returned future.
        runner.submit(long_lived())

        # Force aggressive collection of any orphaned cycle.
        for _ in range(3):
            gc.collect()
        time.sleep(0.2)

        assert not finally_ran.is_set(), "task was collected mid-flight and ran its finally early"
        assert len(runner._futures) == 1
    finally:
        runner.stop()


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
