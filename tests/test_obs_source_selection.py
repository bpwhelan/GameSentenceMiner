import asyncio
import base64
import contextlib
import io
import threading

from PIL import Image
from types import SimpleNamespace

import pytest

import GameSentenceMiner.obs as obs
import GameSentenceMiner.obs as obs_module
import GameSentenceMiner.obs.actions as obs_actions_module
import GameSentenceMiner.obs.launch as obs_launch_module
import GameSentenceMiner.obs.service as obs_service_module


def _valid_test_image():
    img = Image.new("L", (4, 4), 0)
    img.putpixel((0, 0), 255)
    return img


def _valid_test_image_rgb():
    img = Image.new("RGB", (4, 4), (0, 0, 0))
    img.putpixel((0, 0), (255, 255, 255))
    return img


def _make_obs_service(monkeypatch):
    class _DummyConnectionPool:
        def __init__(self, *args, **kwargs):
            pass

        def connect_all(self):
            pass

    monkeypatch.setattr(obs_service_module, "OBSConnectionPool", _DummyConnectionPool)
    monkeypatch.setattr(obs_service_module.obs, "EventClient", lambda *args, **kwargs: object())
    monkeypatch.setattr(obs_service_module.OBSService, "_register_default_handlers", lambda self: None)
    monkeypatch.setattr(obs_service_module.OBSService, "_initialize_state", lambda self: None)
    return obs_service_module.OBSService("localhost", 4455, "", check_output=False)


def test_sort_video_sources_by_preference_prefers_game_capture():
    sources = [
        {"sourceName": "Window Source", "inputKind": "window_capture"},
        {"sourceName": "Game Source", "inputKind": "game_capture"},
    ]

    sorted_sources = obs.sort_video_sources_by_preference(sources)

    assert [item["sourceName"] for item in sorted_sources] == [
        "Game Source",
        "Window Source",
    ]


def test_sort_video_sources_by_preference_falls_back_when_game_capture_inactive():
    sources = [
        {"sourceName": "Game Source", "inputKind": "game_capture"},
        {"sourceName": "Window Source", "inputKind": "window_capture"},
    ]

    sorted_sources = obs.sort_video_sources_by_preference(
        sources,
        input_active_by_name={"Game Source": False, "Window Source": True},
        input_show_by_name={"Window Source": True},
    )

    assert sorted_sources[0]["sourceName"] == "Window Source"


def test_get_video_scene_items_filters_out_application_audio_sources():
    items = [
        {"sourceName": "Window Source", "inputKind": "window_capture"},
        {
            "sourceName": "Audio Source",
            "inputKind": "wasapi_process_output_capture",
        },
        {"sourceName": "Game Source", "inputKind": "game_capture"},
    ]

    filtered = obs.get_video_scene_items(items)

    assert [item["sourceName"] for item in filtered] == [
        "Window Source",
        "Game Source",
    ]


def test_reconcile_capture_source_visibility_prefers_game_capture(monkeypatch):
    service = obs.OBSService.__new__(obs.OBSService)
    service._state_lock = threading.Lock()
    service._capture_source_settled = False
    service.state = obs.OBSState(
        current_scene="Test Scene",
        scene_items_by_scene={
            "Test Scene": [
                {
                    "sourceName": "Game Source",
                    "inputKind": "game_capture",
                    "sceneItemEnabled": False,
                    "sceneItemId": 1,
                },
                {
                    "sourceName": "Window Source",
                    "inputKind": "window_capture",
                    "sceneItemEnabled": True,
                    "sceneItemId": 2,
                },
            ]
        },
    )

    monkeypatch.setattr(
        service,
        "_probe_source_has_output",
        lambda source_name: source_name == "Game Source",
    )

    updates = []
    monkeypatch.setattr(
        service,
        "_set_scene_items_enabled",
        lambda scene_name, items, enabled: updates.append(
            (scene_name, tuple(item["sourceName"] for item in items), enabled)
        ),
    )

    result = service._reconcile_capture_source_visibility("Test Scene")

    assert result is True
    assert updates == [
        ("Test Scene", ("Game Source",), True),
        ("Test Scene", ("Window Source",), False),
    ]


def test_reconcile_capture_source_visibility_falls_back_to_window_capture(monkeypatch):
    service = obs.OBSService.__new__(obs.OBSService)
    service._state_lock = threading.Lock()
    service._capture_source_settled = False
    service.state = obs.OBSState(
        current_scene="Test Scene",
        scene_items_by_scene={
            "Test Scene": [
                {
                    "sourceName": "Game Source",
                    "inputKind": "game_capture",
                    "sceneItemEnabled": True,
                    "sceneItemId": 1,
                },
                {
                    "sourceName": "Window Source",
                    "inputKind": "window_capture",
                    "sceneItemEnabled": False,
                    "sceneItemId": 2,
                },
            ]
        },
    )

    monkeypatch.setattr(
        service,
        "_probe_source_has_output",
        lambda source_name: source_name == "Window Source",
    )

    updates = []
    monkeypatch.setattr(
        service,
        "_set_scene_items_enabled",
        lambda scene_name, items, enabled: updates.append(
            (scene_name, tuple(item["sourceName"] for item in items), enabled)
        ),
    )

    result = service._reconcile_capture_source_visibility("Test Scene")

    assert result is True
    assert updates == [
        ("Test Scene", ("Game Source",), False),
        ("Test Scene", ("Window Source",), True),
    ]


def test_reconcile_capture_source_visibility_disables_window_same_tick_when_game_recovers(
    monkeypatch,
):
    """When game_capture starts disabled but the probe succeeds (OBS can
    screenshot disabled sources), the reconciler should enable game_capture
    and disable window_capture in the same tick."""
    service = obs.OBSService.__new__(obs.OBSService)
    service._state_lock = threading.Lock()
    service._capture_source_settled = False
    service.state = obs.OBSState(
        current_scene="Test Scene",
        scene_items_by_scene={
            "Test Scene": [
                {
                    "sourceName": "Game Source",
                    "inputKind": "game_capture",
                    "sceneItemEnabled": False,
                    "sceneItemId": 1,
                },
                {
                    "sourceName": "Window Source",
                    "inputKind": "window_capture",
                    "sceneItemEnabled": True,
                    "sceneItemId": 2,
                },
            ]
        },
    )

    updates = []

    def fake_set_scene_items_enabled(scene_name, items, enabled):
        updates.append((scene_name, tuple(item["sourceName"] for item in items), enabled))
        for item in items:
            item["sceneItemEnabled"] = enabled

    # OBS can screenshot disabled sources, so probe always returns True here.
    monkeypatch.setattr(
        service,
        "_probe_source_has_output",
        lambda source_name: source_name == "Game Source",
    )
    monkeypatch.setattr(service, "_set_scene_items_enabled", fake_set_scene_items_enabled)

    result = service._reconcile_capture_source_visibility("Test Scene")

    assert result is True
    assert updates == [
        ("Test Scene", ("Game Source",), True),
        ("Test Scene", ("Window Source",), False),
    ]


def test_probe_source_has_output_skips_screenshot_when_target_window_is_missing(monkeypatch):
    service = obs.OBSService.__new__(obs.OBSService)
    service._state_lock = threading.Lock()
    service.state = obs.OBSState()
    service._get_input_settings_for_source = lambda source_name: {"window": "Game Window:UnrealWindow:game.exe"}

    monkeypatch.setattr(obs_service_module, "_window_target_exists", lambda target: False)
    monkeypatch.setattr(
        obs_service_module,
        "get_screenshot_PIL_from_source",
        lambda *args, **kwargs: pytest.fail(
            "Screenshot probe should be skipped when the OBS target window is missing."
        ),
        raising=False,
    )

    assert service._probe_source_has_output("Window Source") is False


def test_get_scene_target_running_state_falls_back_to_window_capture_target(monkeypatch):
    service = obs.OBSService.__new__(obs.OBSService)
    service._state_lock = threading.Lock()
    service.state = obs.OBSState()

    settings_by_source = {
        "Game Source": {},
        "Window Source": {"window": "Nioh 1.24.08:NIOH:nioh.exe"},
    }
    service._get_input_settings_for_source = lambda source_name: settings_by_source.get(source_name)

    window_targets = []
    monkeypatch.setattr(
        obs_service_module,
        "_window_target_exists",
        lambda target: window_targets.append(target) or False,
    )

    result = service._get_scene_target_running_state(
        [
            {"sourceName": "Game Source"},
            {"sourceName": "Window Source"},
        ]
    )

    assert result is False
    assert window_targets == ["Nioh 1.24.08:NIOH:nioh.exe"]


def test_parse_obs_window_target_preserves_colons_in_title():
    parsed = obs.parse_obs_window_target("Game: Chapter 1:UnrealWindow:game.exe")

    assert parsed == {
        "title": "Game: Chapter 1",
        "window_class": "UnrealWindow",
        "exe": "game.exe",
    }


def test_build_scheduled_tick_options_respects_intervals():
    service = obs.OBSService.__new__(obs.OBSService)
    service._capture_source_settled = False
    service.tick_intervals = obs.OBSTickIntervals(
        refresh_current_scene_seconds=1.0,
        refresh_scene_items_seconds=2.0,
        fit_to_screen_seconds=30.0,
        capture_source_switch_seconds=5.0,
        output_probe_seconds=5.0,
        replay_buffer_seconds=1.0,
        full_state_refresh_seconds=60.0,
    )
    service._tick_last_run_by_operation = {
        "refresh_current_scene": 100.0,
        "refresh_scene_items": 199.0,
        "fit_to_screen": 190.0,
        "capture_source_switch": 194.0,
        "output_probe": 198.0,
        "manage_replay_buffer": 198.5,
        "full_state_refresh": 150.0,
    }
    service._fit_to_screen_grace_deadline = 250.0

    options = service.build_scheduled_tick_options(now=200.0)

    assert options.refresh_current_scene is True
    assert options.refresh_scene_items is False
    assert options.fit_to_screen is False
    assert options.capture_source_switch is True
    assert options.output_probe is False
    assert options.manage_replay_buffer is True
    assert options.refresh_full_state is False


def test_build_scheduled_tick_options_skips_fit_to_screen_outside_grace_window():
    service = obs.OBSService.__new__(obs.OBSService)
    service._capture_source_settled = False
    service.tick_intervals = obs.OBSTickIntervals(fit_to_screen_seconds=20.0)
    service._tick_last_run_by_operation = {"fit_to_screen": 100.0}
    service._fit_to_screen_grace_deadline = 150.0

    options = service.build_scheduled_tick_options(now=200.0)

    assert options.fit_to_screen is False


def test_initialize_state_opens_fit_to_screen_window_on_first_success(monkeypatch):
    class _FakeClient:
        def get_current_program_scene(self):
            return SimpleNamespace(scene_name="Boot Scene")

        def get_output_list(self):
            return SimpleNamespace(outputs=[])

    class _FakePool:
        def call(self, operation, retries=0):
            assert retries >= 0
            return operation(_FakeClient())

    service = obs.OBSService.__new__(obs.OBSService)
    service._state_lock = threading.Lock()
    service.state = obs.OBSState()
    service.connection_pool = _FakePool()
    service.check_output = False
    service.initialized = False
    service._fit_to_screen_grace_deadline = 0.0
    service._refresh_scene_items = lambda scene_name, client=None: None
    service._update_output_cache = lambda outputs: None

    monkeypatch.setattr(obs_module.time, "time", lambda: 100.0)

    service._initialize_state()

    assert service.initialized is True
    assert service._fit_to_screen_grace_deadline == 160.0


def test_refresh_scene_items_ignores_unexpected_response_shape(monkeypatch):
    service = obs.OBSService.__new__(obs.OBSService)
    service._state_lock = threading.Lock()
    service.state = obs.OBSState(
        current_scene="Test Scene",
        current_source_name="Existing Source",
        scene_items_by_scene={"Test Scene": [{"sourceName": "Existing Source", "inputKind": "window_capture"}]},
    )

    warning_calls = []
    bad_response = type("GetInputSettingsDataclass", (), {"input_settings": {"window": "bad"}})
    client = SimpleNamespace(get_scene_item_list=lambda name: bad_response)

    monkeypatch.setattr(obs_service_module.logger, "warning", lambda message: warning_calls.append(message))

    service._refresh_scene_items("Test Scene", client=client)

    assert service.state.scene_items_by_scene["Test Scene"] == [
        {"sourceName": "Existing Source", "inputKind": "window_capture"}
    ]
    assert service.state.current_source_name == "Existing Source"
    assert warning_calls == [
        "OBS returned unexpected scene item list response for 'Test Scene': GetInputSettingsDataclass"
    ]


def test_set_scene_items_enabled_forces_helper_sources_disabled():
    calls = []

    class _FakeClient:
        def set_scene_item_enabled(self, scene_name, item_id, enabled):
            calls.append((scene_name, item_id, enabled))

    class _FakePool:
        def call(self, operation, retries=0, retryable=True):
            assert retries >= 0
            return operation(_FakeClient())

    service = obs.OBSService.__new__(obs.OBSService)
    service._state_lock = threading.Lock()
    helper_item = {
        "sourceName": "capture_card_getter",
        "inputKind": "dshow_input",
        "sceneItemEnabled": True,
        "sceneItemId": 11,
    }
    regular_item = {
        "sourceName": "Regular Source",
        "inputKind": "window_capture",
        "sceneItemEnabled": False,
        "sceneItemId": 12,
    }
    service.state = obs.OBSState(
        scene_items_by_scene={
            "Regular Scene": [helper_item.copy(), regular_item.copy()],
        }
    )
    service.connection_pool = _FakePool()

    service._set_scene_items_enabled("Regular Scene", [helper_item, regular_item], True)

    assert calls == [
        ("Regular Scene", 11, False),
        ("Regular Scene", 12, True),
    ]
    assert helper_item["sceneItemEnabled"] is False
    assert regular_item["sceneItemEnabled"] is True
    assert service.state.scene_items_by_scene["Regular Scene"][0]["sceneItemEnabled"] is False
    assert service.state.scene_items_by_scene["Regular Scene"][1]["sceneItemEnabled"] is True


def test_enforce_helper_scene_items_disabled_reverts_enabled_helper_inputs(monkeypatch):
    service = obs.OBSService.__new__(obs.OBSService)
    service._state_lock = threading.Lock()
    helper_item = {
        "sourceName": "audio_input_getter",
        "inputKind": "wasapi_input_capture",
        "sceneItemEnabled": True,
        "sceneItemId": 21,
    }
    regular_item = {
        "sourceName": "Regular Source",
        "inputKind": "window_capture",
        "sceneItemEnabled": True,
        "sceneItemId": 22,
    }
    service.state = obs.OBSState(
        scene_items_by_scene={
            "Regular Scene": [helper_item, regular_item],
        }
    )

    updates = []

    def fake_set_scene_items_enabled(scene_name, items, enabled):
        updates.append((scene_name, tuple(item["sourceName"] for item in items), enabled))

    monkeypatch.setattr(service, "_set_scene_items_enabled", fake_set_scene_items_enabled)

    service._enforce_helper_scene_items_disabled("Regular Scene")

    assert updates == [
        ("Regular Scene", ("audio_input_getter",), False),
    ]


def test_obs_service_constructor_initializes_flag_before_state_bootstrap(monkeypatch):
    class _FakeClient:
        def get_current_program_scene(self):
            return SimpleNamespace(scene_name="Boot Scene")

        def get_output_list(self):
            return SimpleNamespace(outputs=[])

    class _FakePool:
        def __init__(self, *args, **kwargs):
            pass

        def connect_all(self):
            pass

        def call(self, operation, retries=0):
            assert retries >= 0
            return operation(_FakeClient())

    class _FakeEventClient:
        def __init__(self, *args, **kwargs):
            self.callback = SimpleNamespace(register=lambda handler: None)

    monkeypatch.setattr(obs_service_module, "OBSConnectionPool", _FakePool)
    monkeypatch.setattr(obs_service_module.obs, "EventClient", _FakeEventClient)
    monkeypatch.setattr(obs_service_module.time, "time", lambda: 100.0)
    monkeypatch.setattr(
        obs_service_module.OBSService, "_refresh_scene_items", lambda self, scene_name, client=None: None
    )
    monkeypatch.setattr(obs_service_module.OBSService, "_update_output_cache", lambda self, outputs: None)
    monkeypatch.setattr(obs_service_module.gsm_state, "current_game", None, raising=False)

    service = obs_service_module.OBSService("localhost", 4455, "", check_output=False)

    assert service.initialized is True
    assert service.state.current_scene == "Boot Scene"
    assert service._fit_to_screen_grace_deadline == 160.0


def test_replay_buffer_stop_request_survives_non_matching_state_event(monkeypatch):
    service = _make_obs_service(monkeypatch)
    clock = {"now": 100.0}
    warning_calls = []

    monkeypatch.setattr(obs_module.time, "time", lambda: clock["now"])
    monkeypatch.setattr(obs_module.time, "monotonic", lambda: clock["now"])
    monkeypatch.setattr(obs_module.logger, "warning", lambda message: warning_calls.append(message))

    service.mark_replay_buffer_action(False)
    clock["now"] = 101.0
    service._handle_replay_buffer_state_changed(SimpleNamespace(output_active=True))

    assert service._replay_buffer_action_pending is False
    assert warning_calls == []


def test_replay_buffer_stop_event_is_not_treated_as_external_when_delayed(monkeypatch):
    service = _make_obs_service(monkeypatch)
    clock = {"now": 100.0}
    info_calls = []

    monkeypatch.setattr(obs_module.time, "time", lambda: clock["now"])
    monkeypatch.setattr(obs_module.time, "monotonic", lambda: clock["now"])
    monkeypatch.setattr(obs_module.logger, "info", lambda message: info_calls.append(message))

    service.mark_replay_buffer_action(False)
    clock["now"] = 105.0
    service._handle_replay_buffer_state_changed(SimpleNamespace(output_active=False))

    assert service._auto_start_paused_by_external_replay_stop is False
    assert service.state.replay_buffer_active is False
    assert (
        "Replay buffer was stopped outside GSM; auto-start is paused until replay buffer is started again."
        not in info_calls
    )


def test_get_best_source_for_screenshot_falls_back_to_window_capture(monkeypatch):
    sources = [
        {"sourceName": "Game Source", "inputKind": "game_capture"},
        {"sourceName": "Window Source", "inputKind": "window_capture"},
    ]

    monkeypatch.setattr(obs_actions_module, "get_active_video_sources", lambda: sources)
    monkeypatch.setattr(
        obs_actions_module,
        "get_screenshot_PIL_from_source",
        lambda source_name, *args, **kwargs: (
            Image.new("L", (4, 4), 0) if source_name == "Game Source" else _valid_test_image()
        ),
    )

    best_source = obs.get_best_source_for_screenshot()

    assert best_source["sourceName"] == "Window Source"


def test_get_best_source_for_screenshot_prefers_game_capture_when_it_has_output(monkeypatch):
    sources = [
        {"sourceName": "Window Source", "inputKind": "window_capture"},
        {"sourceName": "Game Source", "inputKind": "game_capture"},
    ]

    monkeypatch.setattr(obs_actions_module, "get_active_video_sources", lambda: sources)
    monkeypatch.setattr(
        obs_actions_module,
        "get_screenshot_PIL_from_source",
        lambda source_name, *args, **kwargs: (
            _valid_test_image() if source_name == "Game Source" else Image.new("L", (4, 4), 0)
        ),
    )

    best_source = obs.get_best_source_for_screenshot()

    assert best_source["sourceName"] == "Game Source"


def test_get_best_source_for_screenshot_handles_rgb_image_validation(monkeypatch):
    sources = [
        {"sourceName": "Game Source", "inputKind": "game_capture"},
        {"sourceName": "Window Source", "inputKind": "window_capture"},
    ]

    monkeypatch.setattr(obs_actions_module, "get_active_video_sources", lambda: sources)
    monkeypatch.setattr(
        obs_actions_module,
        "get_screenshot_PIL_from_source",
        lambda source_name, *args, **kwargs: (
            Image.new("RGB", (4, 4), (0, 0, 0)) if source_name == "Game Source" else _valid_test_image_rgb()
        ),
    )

    best_source = obs.get_best_source_for_screenshot()

    assert best_source["sourceName"] == "Window Source"


def test_get_best_source_for_screenshot_does_not_select_single_source_without_renderable_output(monkeypatch):
    sources = [{"sourceName": "Window Source", "inputKind": "window_capture"}]

    monkeypatch.setattr(obs_actions_module, "get_active_video_sources", lambda: sources)
    monkeypatch.setattr(obs_actions_module, "get_screenshot_PIL_from_source", lambda *args, **kwargs: None)

    best_source = obs.get_best_source_for_screenshot()

    assert best_source is None


def test_obs_service_tick_applies_fit_before_screenshot_probe(monkeypatch):
    service = obs.OBSService.__new__(obs.OBSService)
    service.initialized = True
    service.check_output = True
    service._tick_running = False
    service._capture_source_settled = False
    service._state_lock = threading.Lock()
    service.state = obs.OBSState(current_scene="Test Scene")
    service._initialize_state = lambda: None
    service._is_output_active_from_screenshot = lambda: None
    service._tick_last_run_by_operation = {}
    service.tick_intervals = obs.OBSTickIntervals()
    service._pending_scene_item_refresh = None
    service._scene_item_refresh_deadline = 0.0
    service._scene_item_debounce_seconds = 2.0

    fit_calls = []
    monkeypatch.setattr(
        obs_actions_module,
        "set_fit_to_screen_for_scene_items",
        lambda scene_name: fit_calls.append(scene_name),
    )

    service.tick(
        obs.OBSTickOptions(
            refresh_current_scene=False,
            refresh_scene_items=False,
            fit_to_screen=True,
            capture_source_switch=False,
            output_probe=True,
            manage_replay_buffer=False,
            refresh_full_state=False,
            force=True,
        )
    )

    assert fit_calls == ["Test Scene"]


def test_obs_service_tick_notifies_scene_observers_when_scene_is_unchanged(monkeypatch):
    service = obs.OBSService.__new__(obs.OBSService)
    service.initialized = True
    service.check_output = False
    service._tick_running = False
    service._capture_source_settled = False
    service._state_lock = threading.Lock()
    service.state = obs.OBSState(current_scene="Boot Scene")
    service._initialize_state = lambda: None
    service._tick_last_run_by_operation = {}
    service.tick_intervals = obs.OBSTickIntervals()
    service._scene_observed_handlers = []

    seen_scenes = []
    service.on_scene_observed(seen_scenes.append)

    monkeypatch.setattr(obs_actions_module, "get_current_scene", lambda: "Boot Scene")

    service.tick(
        obs.OBSTickOptions(
            refresh_current_scene=True,
            refresh_scene_items=False,
            fit_to_screen=False,
            capture_source_switch=False,
            output_probe=False,
            manage_replay_buffer=False,
            refresh_full_state=False,
            force=True,
        )
    )

    assert seen_scenes == ["Boot Scene"]


def test_get_best_source_for_screenshot_can_suppress_missing_source_logs(monkeypatch):
    logger_errors = []
    kwargs_seen = []

    def fake_get_active_video_sources(**kwargs):
        kwargs_seen.append(kwargs)
        return None

    monkeypatch.setattr(obs_actions_module, "get_active_video_sources", fake_get_active_video_sources)
    monkeypatch.setattr(obs_actions_module.logger, "error", lambda message: logger_errors.append(message))

    best_source = obs.get_best_source_for_screenshot(
        log_missing_source=False,
        suppress_errors=True,
    )

    assert best_source is None
    assert kwargs_seen == [{"_suppress_obs_errors": True}]
    assert logger_errors == []


def test_get_active_video_sources_can_suppress_connection_errors(monkeypatch):
    class _BrokenConnectionPool:
        @contextlib.contextmanager
        def get_client(self):
            raise ConnectionError("OBS Client unavailable")
            yield

        def call(self, operation, retries=0, retryable=True):
            with self.get_client() as client:
                return operation(client)

    logger_errors = []
    original_connection_pool = obs.connection_pool
    monkeypatch.setattr(obs.logger, "error", lambda message: logger_errors.append(message))
    monkeypatch.setattr(obs, "connection_pool", _BrokenConnectionPool())

    try:
        sources = obs.get_active_video_sources(_suppress_obs_errors=True)
    finally:
        monkeypatch.setattr(obs, "connection_pool", original_connection_pool)

    assert sources is None
    assert logger_errors == []


def test_with_obs_client_retries_retryable_connection_errors(monkeypatch):
    attempts = []
    logger_errors = []

    class _RetryPool:
        @contextlib.contextmanager
        def get_client(self):
            attempts.append("get_client")
            if len(attempts) == 1:
                raise ConnectionError("socket is already closed")
            yield SimpleNamespace(answer="recovered")

        def call(self, operation, retries=0, retryable=True):
            max_attempts = 1 + (retries if retryable else 0)
            last_exc = None
            for i in range(max_attempts):
                try:
                    with self.get_client() as client:
                        return operation(client)
                except Exception as e:
                    last_exc = e
                    if not retryable or i >= max_attempts - 1:
                        raise
            raise last_exc

    monkeypatch.setattr(obs_module, "connection_pool", _RetryPool())
    monkeypatch.setattr(obs_service_module.time, "sleep", lambda _seconds: None)
    monkeypatch.setattr(obs_actions_module.logger, "error", lambda message: logger_errors.append(message))

    @obs_module.with_obs_client(default="fallback", error_msg="Retryable test call")
    def _decorated(client):
        return client.answer

    assert _decorated() == "recovered"
    assert attempts == ["get_client", "get_client"]
    assert logger_errors == []


def test_get_screenshot_pil_from_source_retries_transient_failures(monkeypatch):
    attempts = []
    image_buffer = io.BytesIO()
    Image.new("RGB", (2, 2), (255, 0, 0)).save(image_buffer, format="PNG")
    encoded_image = "data:image/png;base64," + base64.b64encode(image_buffer.getvalue()).decode("ascii")

    class _RetryingClient:
        def get_source_screenshot(self, **_kwargs):
            attempts.append("get_source_screenshot")
            if len(attempts) == 1:
                raise ConnectionError("socket is already closed")
            return SimpleNamespace(image_data=encoded_image)

    class _RetryPool:
        @contextlib.contextmanager
        def get_client(self):
            yield _RetryingClient()

        def call(self, operation, retries=0, retryable=True):
            max_attempts = 1 + (retries if retryable else 0)
            last_exc = None
            for i in range(max_attempts):
                try:
                    with self.get_client() as client:
                        return operation(client)
                except Exception as e:
                    last_exc = e
                    if not retryable or i >= max_attempts - 1:
                        raise
            raise last_exc

    monkeypatch.setattr(obs_module, "connection_pool", _RetryPool())
    monkeypatch.setattr(obs_service_module.time, "sleep", lambda _seconds: None)

    image = obs_module.get_screenshot_PIL_from_source("Game Source", retry=2)

    assert image is not None
    assert image.size == (2, 2)
    assert attempts == ["get_source_screenshot", "get_source_screenshot"]


def test_get_screenshot_pil_from_source_retries_render_failures(monkeypatch):
    attempts = []
    logger_errors = []
    image_buffer = io.BytesIO()
    Image.new("RGB", (2, 2), (255, 0, 0)).save(image_buffer, format="PNG")
    encoded_image = "data:image/png;base64," + base64.b64encode(image_buffer.getvalue()).decode("ascii")

    class _RetryingClient:
        def get_source_screenshot(self, **_kwargs):
            attempts.append("get_source_screenshot")
            if len(attempts) == 1:
                raise obs_actions_module.obs.error.OBSSDKRequestError(
                    "GetSourceScreenshot",
                    702,
                    "Failed to render screenshot.",
                )
            return SimpleNamespace(image_data=encoded_image)

    class _RetryPool:
        @contextlib.contextmanager
        def get_client(self):
            yield _RetryingClient()

        def call(self, operation, retries=0, retryable=True):
            max_attempts = 1 + (retries if retryable else 0)
            last_exc = None
            for i in range(max_attempts):
                try:
                    with self.get_client() as client:
                        return operation(client)
                except Exception as e:
                    last_exc = e
                    if not retryable or i >= max_attempts - 1 or not obs_service_module._is_retryable_obs_exception(e):
                        raise
            raise last_exc

    monkeypatch.setattr(obs_module, "connection_pool", _RetryPool())
    monkeypatch.setattr(obs_service_module.time, "sleep", lambda _seconds: None)
    monkeypatch.setattr(obs_actions_module.logger, "error", lambda message: logger_errors.append(message))

    image = obs_module.get_screenshot_PIL_from_source("Game Source", retry=2)

    assert image is not None
    assert image.size == (2, 2)
    assert attempts == ["get_source_screenshot", "get_source_screenshot"]
    assert logger_errors == []


def test_obs_connection_pool_recreates_client_after_failed_use(monkeypatch):
    created_clients = []

    class _FakeClient:
        def __init__(self, **_kwargs):
            self.client_id = len(created_clients)
            self.disconnected = False
            created_clients.append(self)

        def get_version(self):
            return SimpleNamespace(obs_version="30.0.0")

        def disconnect(self):
            self.disconnected = True

    monkeypatch.setattr(obs_service_module.obs, "ReqClient", _FakeClient)
    monkeypatch.setattr(obs_service_module.time, "sleep", lambda _seconds: None)

    pool = obs_module.OBSConnectionPool(host="localhost", port=4455, password="", timeout=1)
    pool.min_reconnect_interval = 0  # Allow immediate reconnect in tests

    with pytest.raises(RuntimeError):
        with pool.get_client() as client:
            first_client_id = client.client_id
            raise RuntimeError("boom")

    with pool.get_client() as client:
        second_client_id = client.client_id

    assert first_client_id == 0
    assert second_client_id == 1
    assert created_clients[0].disconnected is True


def test_obs_connection_pool_healthcheck_client_is_independent(monkeypatch):
    created_clients = []

    class _FakeClient:
        def __init__(self, **_kwargs):
            created_clients.append(self)

        def get_version(self):
            return SimpleNamespace(obs_version="30.0.0")

        def disconnect(self):
            return None

    monkeypatch.setattr(obs_service_module.obs, "ReqClient", _FakeClient)

    pool = obs_service_module.OBSConnectionPool(
        host="localhost",
        port=4455,
        password="",
        timeout=1,
    )

    # Healthcheck client is a separate instance
    hc = pool.get_healthcheck_client()
    assert hc is not None
    assert len(created_clients) == 1

    # Reset creates a new one next time
    pool.reset_healthcheck_client()
    hc2 = pool.get_healthcheck_client()
    assert hc2 is not hc
    assert len(created_clients) == 2


def test_wait_for_obs_ready_disconnects_probe_client(monkeypatch):
    disconnected = []

    class _FakeClient:
        def __init__(self, **_kwargs):
            pass

        def get_version(self):
            return SimpleNamespace(obs_version="30.0.0")

        def get_scene_list(self):
            return SimpleNamespace(scenes=[{"sceneName": "Boot Scene"}])

        def disconnect(self):
            disconnected.append(True)

    import obsws_python as _obsws

    monkeypatch.setattr(obs_launch_module, "is_obs_websocket_reachable", lambda **_kwargs: True)
    monkeypatch.setattr(_obsws, "ReqClient", _FakeClient)

    assert asyncio.run(obs_launch_module.wait_for_obs_ready(timeout=0.1, interval=0)) is True
    assert disconnected == [True]


def test_connect_to_obs_sync_creates_service_and_manager(monkeypatch):
    """Verify connect_to_obs_sync creates OBSService and starts OBSConnectionManager."""

    class _FakePool:
        def __init__(self, *args, **kwargs):
            pass

        def connect_all(self):
            pass

        def call(self, operation, retries=0, retryable=True):
            return None

    class _FakeEventClient:
        def __init__(self, *args, **kwargs):
            self.callback = SimpleNamespace(register=lambda handler: None)

    class _FakeManager:
        def __init__(self, **kwargs):
            self.started = False
            self.check_output = kwargs.get("check_output", False)

        def start(self):
            self.started = True

    monkeypatch.setattr(obs_service_module, "OBSConnectionPool", _FakePool)
    monkeypatch.setattr(obs_service_module.obs, "EventClient", _FakeEventClient)
    monkeypatch.setattr(obs_service_module, "OBSConnectionManager", _FakeManager)
    monkeypatch.setattr(obs_service_module.OBSService, "_register_default_handlers", lambda self: None)
    monkeypatch.setattr(obs_service_module.OBSService, "_initialize_state", lambda self: None)
    monkeypatch.setattr(obs_actions_module, "update_current_game", lambda: None)
    monkeypatch.setattr(obs_actions_module, "apply_obs_performance_settings", lambda **kwargs: None)

    # Reset module state
    monkeypatch.setattr(obs_module, "obs_service", None)
    monkeypatch.setattr(obs_module, "connection_pool", None)
    monkeypatch.setattr(obs_module, "event_client", None)
    monkeypatch.setattr(obs_module, "connecting", False)
    monkeypatch.setattr(obs_module, "obs_connection_manager", None)

    obs_service_module.connect_to_obs_sync(retry=1, connections=2, check_output=False)

    assert obs_module.obs_service is not None
    assert obs_module.connection_pool is not None
    assert obs_module.obs_connection_manager is not None
    assert obs_module.obs_connection_manager.started is True
    assert obs_module.gsm_status.obs_connected is True


def test_disconnect_from_obs_clears_module_state(monkeypatch):
    disconnected = []

    class _FakeService:
        def disconnect(self):
            disconnected.append(True)

    monkeypatch.setattr(obs_module, "obs_service", _FakeService())
    monkeypatch.setattr(obs_module, "connection_pool", "some-pool")
    monkeypatch.setattr(obs_module, "event_client", "some-event")

    obs_service_module.disconnect_from_obs()

    assert disconnected == [True]
    assert obs_module.obs_service is None
    assert obs_module.connection_pool is None
    assert obs_module.event_client is None


def test_toggle_replay_buffer_does_not_retry_non_idempotent_calls(monkeypatch):
    attempts = []
    logger_errors = []

    class _BrokenPool:
        @contextlib.contextmanager
        def get_client(self):
            attempts.append("get_client")
            raise ConnectionError("socket is already closed")
            yield

        def call(self, operation, retries=0, retryable=True):
            with self.get_client() as client:
                return operation(client)

    monkeypatch.setattr(obs_module, "connection_pool", _BrokenPool())
    monkeypatch.setattr(obs_module, "obs_service", None)
    monkeypatch.setattr(obs_actions_module, "_is_obs_recording_disabled", lambda *args, **kwargs: False)
    monkeypatch.setattr(obs_service_module.time, "sleep", lambda _seconds: None)
    monkeypatch.setattr(obs_actions_module.logger, "error", lambda message: logger_errors.append(message))

    obs_module.toggle_replay_buffer()

    assert attempts == ["get_client"]
    assert logger_errors


def test_obs_connection_manager_refreshes_existing_service_on_recovery(monkeypatch):
    manager = obs_module.OBSConnectionManager(check_output=False)
    refresh_calls = []

    class _FakePool:
        def reset_healthcheck_client(self):
            pass

    fake_service = SimpleNamespace(
        connection_pool=_FakePool(),
        event_client="old-event",
    )

    def fake_refresh_after_reconnect():
        refresh_calls.append("refresh")
        fake_service.event_client = "new-event"
        fake_service.connection_pool = _FakePool()
        return True

    fake_service.refresh_after_reconnect = fake_refresh_after_reconnect

    monkeypatch.setattr(obs_module, "obs_service", fake_service)
    monkeypatch.setattr(obs_module, "connection_pool", fake_service.connection_pool)
    monkeypatch.setattr(obs_module, "event_client", "stale-event")
    monkeypatch.setattr(obs_module, "connecting", False)
    monkeypatch.setattr(obs_module.gsm_status, "obs_connected", False, raising=False)

    assert manager._recover_obs_connection() is True
    assert refresh_calls == ["refresh"]
    assert obs_module.event_client == "new-event"
    assert obs_module.gsm_status.obs_connected is True


def test_obs_connection_manager_retries_with_fresh_healthcheck_client_before_recovery(monkeypatch):
    manager = obs_module.OBSConnectionManager(check_output=False)
    reset_calls = []
    recovery_calls = []

    class _StaleClient:
        def get_version(self):
            raise TimeoutError("stale healthcheck socket")

    class _FreshClient:
        def get_version(self):
            return SimpleNamespace(obs_version="30.0.0")

    class _FakePool:
        def __init__(self):
            self.calls = 0

        def get_healthcheck_client(self):
            self.calls += 1
            if self.calls == 1:
                return _StaleClient()
            return _FreshClient()

        def reset_healthcheck_client(self):
            reset_calls.append("reset")

    monkeypatch.setattr(obs_module, "connection_pool", _FakePool())
    monkeypatch.setattr(obs_module, "obs_service", object())
    monkeypatch.setattr(obs_module, "connecting", False)
    monkeypatch.setattr(obs_module.gsm_status, "obs_connected", True, raising=False)
    monkeypatch.setattr(manager, "_recover_obs_connection", lambda: recovery_calls.append("recover") or False)

    assert manager._check_obs_connection() is True
    assert reset_calls == ["reset"]
    assert recovery_calls == []
    assert obs_module.gsm_status.obs_connected is True


def test_recover_obs_service_clients_sync_serializes_refresh_attempts(monkeypatch):
    refresh_calls = []
    release_refresh = threading.Event()
    refresh_started = threading.Event()

    class _FakeService:
        def __init__(self):
            self.connection_pool = "new-pool"
            self.event_client = "new-event"

        def refresh_after_reconnect(self):
            refresh_calls.append("refresh")
            refresh_started.set()
            release_refresh.wait(timeout=1)
            return True

    fake_service = _FakeService()
    results = []

    monkeypatch.setattr(obs_module, "obs_service", fake_service)
    monkeypatch.setattr(obs_module, "connection_pool", None)
    monkeypatch.setattr(obs_module, "event_client", None)
    monkeypatch.setattr(obs_module, "connecting", False)
    monkeypatch.setattr(obs_module.gsm_status, "obs_connected", False, raising=False)
    monkeypatch.setattr(obs_service_module, "_last_obs_service_refresh_attempt", 0.0)

    def _run_recovery():
        results.append(obs_service_module._recover_obs_service_clients_sync())

    first = threading.Thread(target=_run_recovery)
    second = threading.Thread(target=_run_recovery)

    first.start()
    assert refresh_started.wait(timeout=1), "refresh did not start"
    second.start()
    release_refresh.set()
    first.join(timeout=1)
    second.join(timeout=1)

    assert refresh_calls == ["refresh"]
    assert sorted(results) == [False, True]
    assert obs_module.connection_pool == "new-pool"
    assert obs_module.event_client == "new-event"
    assert obs_module.gsm_status.obs_connected is True


def test_get_current_scene_returns_cached_scene_when_obs_is_unavailable(monkeypatch):
    class _BrokenPool:
        def call(self, operation, retries=0, retryable=True):
            raise ConnectionError("OBS Client unavailable")

    monkeypatch.setattr(obs_module, "connection_pool", _BrokenPool())
    monkeypatch.setattr(obs_module, "connecting", False)
    monkeypatch.setattr(obs_module.gsm_status, "obs_connected", False, raising=False)
    monkeypatch.setattr(obs_module.gsm_state, "current_game", "Cached Scene", raising=False)
    monkeypatch.setattr(obs_module, "obs_service", None)

    assert obs_module.get_current_scene() == "Cached Scene"


def test_get_window_info_from_source_ignores_empty_scene_name_without_logging(monkeypatch):
    class _PassiveConnectionPool:
        @contextlib.contextmanager
        def get_client(self):
            yield object()

        def call(self, operation, retries=0, retryable=True):
            with self.get_client() as client:
                return operation(client)

    logger_errors = []
    original_connection_pool = obs_module.connection_pool
    monkeypatch.setattr(obs_module, "connection_pool", _PassiveConnectionPool())
    monkeypatch.setattr(obs_module, "connecting", False)
    monkeypatch.setattr(obs_module.gsm_status, "obs_connected", True, raising=False)
    monkeypatch.setattr(obs_actions_module.logger, "error", lambda message: logger_errors.append(message))

    try:
        result = obs_module.get_window_info_from_source(scene_name="")
    finally:
        monkeypatch.setattr(obs_module, "connection_pool", original_connection_pool)

    assert result is None
    assert logger_errors == []


class _ExplodingImage:
    def getextrema(self):
        raise AssertionError("image validation should have been skipped")


class _UniformImage:
    def getextrema(self):
        return (7, 7)


class _NonUniformImage:
    def getextrema(self):
        return (0, 255)


def test_get_screenshot_pil_skips_validation_for_helper_scene(monkeypatch):
    helper_image = _ExplodingImage()
    fallback_image = _NonUniformImage()
    warning_calls = []

    monkeypatch.setattr(
        obs_actions_module,
        "get_active_video_sources",
        lambda: [
            {"sourceName": "some_helper_capture", "inputKind": "window_capture"},
            {"sourceName": "fallback_capture", "inputKind": "game_capture"},
        ],
    )
    monkeypatch.setattr(
        obs_actions_module,
        "get_screenshot_PIL_from_source",
        lambda source_name, *_args, **_kwargs: helper_image if source_name == "some_helper_capture" else fallback_image,
    )
    monkeypatch.setattr(obs_actions_module, "_apply_ocr_preprocessing", lambda img, **_kwargs: img)
    monkeypatch.setattr(obs_module.gsm_state, "current_game", "GSM Helper - DONT TOUCH", raising=False)
    monkeypatch.setattr(obs_module, "obs_service", None)
    monkeypatch.setattr(obs_actions_module.logger, "warning", lambda message: warning_calls.append(message))

    result = obs_module.get_screenshot_PIL()

    assert result is helper_image
    assert warning_calls == []


def test_get_screenshot_pil_skips_validation_for_helper_sources(monkeypatch):
    helper_image = _ExplodingImage()
    fallback_image = _NonUniformImage()
    warning_calls = []

    monkeypatch.setattr(
        obs_actions_module,
        "get_active_video_sources",
        lambda: [
            {"sourceName": "window_getter", "inputKind": "window_capture"},
            {"sourceName": "fallback_capture", "inputKind": "game_capture"},
        ],
    )
    monkeypatch.setattr(
        obs_actions_module,
        "get_screenshot_PIL_from_source",
        lambda source_name, *_args, **_kwargs: helper_image if source_name == "window_getter" else fallback_image,
    )
    monkeypatch.setattr(obs_actions_module, "_apply_ocr_preprocessing", lambda img, **_kwargs: img)
    monkeypatch.setattr(obs_module.gsm_state, "current_game", "Regular Scene", raising=False)
    monkeypatch.setattr(
        obs_module, "obs_service", SimpleNamespace(state=SimpleNamespace(current_scene="Regular Scene"))
    )
    monkeypatch.setattr(obs_actions_module.logger, "warning", lambda message: warning_calls.append(message))

    result = obs_module.get_screenshot_PIL()

    assert result is helper_image
    assert warning_calls == []


def test_get_screenshot_pil_keeps_validation_for_regular_sources(monkeypatch):
    uniform_image = _UniformImage()
    valid_image = _NonUniformImage()

    monkeypatch.setattr(
        obs_actions_module,
        "get_active_video_sources",
        lambda: [
            {"sourceName": "blank_capture", "inputKind": "window_capture"},
            {"sourceName": "game_capture", "inputKind": "game_capture"},
        ],
    )
    monkeypatch.setattr(
        obs_actions_module,
        "get_screenshot_PIL_from_source",
        lambda source_name, *_args, **_kwargs: uniform_image if source_name == "blank_capture" else valid_image,
    )
    monkeypatch.setattr(obs_actions_module, "_apply_ocr_preprocessing", lambda img, **_kwargs: img)
    monkeypatch.setattr(obs_module.gsm_state, "current_game", "Regular Scene", raising=False)
    monkeypatch.setattr(
        obs_module, "obs_service", SimpleNamespace(state=SimpleNamespace(current_scene="Regular Scene"))
    )

    result = obs_module.get_screenshot_PIL()

    assert result is valid_image


# ---------------------------------------------------------------------------
# Game-capture failure counting & graduated response
# ---------------------------------------------------------------------------


def _make_reconcile_service(monkeypatch, scene_items, probe_results, scene_target_running_state=True):
    """Build a minimal OBSService for reconciliation tests.

    *probe_results* maps source name → bool (whether probe returns output).
    """
    service = obs.OBSService.__new__(obs.OBSService)
    service._state_lock = threading.Lock()
    service.state = obs.OBSState(
        current_scene="Test Scene",
        scene_items_by_scene={"Test Scene": scene_items},
    )
    service._capture_source_settled = False

    monkeypatch.setattr(
        service,
        "_probe_source_has_output",
        lambda source_name: probe_results.get(source_name, False),
    )
    monkeypatch.setattr(
        service,
        "_get_scene_target_running_state",
        lambda _scene_items: scene_target_running_state,
        raising=False,
    )

    updates = []

    def fake_set_enabled(scene_name, items, enabled):
        updates.append((scene_name, tuple(item["sourceName"] for item in items), enabled))
        for item in items:
            item["sceneItemEnabled"] = enabled

    monkeypatch.setattr(service, "_set_scene_items_enabled", fake_set_enabled)

    removals = []

    class _FakePool:
        def call(self, fn, retries=0):
            removals.append(fn)

    service.connection_pool = _FakePool()

    return service, updates, removals


def _default_scene_items():
    return [
        {
            "sourceName": "Game Source",
            "inputKind": "game_capture",
            "sceneItemEnabled": True,
            "sceneItemId": 1,
        },
        {
            "sourceName": "Window Source",
            "inputKind": "window_capture",
            "sceneItemEnabled": True,
            "sceneItemId": 2,
        },
    ]


def test_reconcile_disables_game_capture_on_first_failure(monkeypatch):
    items = _default_scene_items()
    items[1]["sceneItemEnabled"] = False  # window_capture starts disabled
    service, updates, _ = _make_reconcile_service(
        monkeypatch,
        items,
        {"Game Source": False, "Window Source": True},
    )

    result = service._reconcile_capture_source_visibility("Test Scene")

    assert result is True
    # game_capture should be disabled, window_capture enabled
    assert ("Test Scene", ("Game Source",), False) in updates
    assert ("Test Scene", ("Window Source",), True) in updates
    assert service.state.game_capture_fail_count.get("Test Scene") == 1


def test_reconcile_resets_fail_count_when_game_capture_works(monkeypatch):
    items = _default_scene_items()
    service, updates, _ = _make_reconcile_service(
        monkeypatch,
        items,
        {"Game Source": True, "Window Source": True},
    )
    # Simulate prior failures
    service.state.game_capture_fail_count["Test Scene"] = 3

    result = service._reconcile_capture_source_visibility("Test Scene")

    assert result is True
    assert service.state.game_capture_fail_count.get("Test Scene", 0) == 0
    assert service._capture_source_settled is True


def test_reconcile_removes_game_capture_after_threshold(monkeypatch):
    items = _default_scene_items()
    service, updates, removals = _make_reconcile_service(
        monkeypatch,
        items,
        {"Game Source": False, "Window Source": True},
    )
    # Set fail count just below threshold
    service.state.game_capture_fail_count["Test Scene"] = obs.GAME_CAPTURE_REMOVAL_THRESHOLD - 1

    result = service._reconcile_capture_source_visibility("Test Scene")

    assert result is True
    # game_capture should have been removed
    assert "Test Scene" in service.state.game_capture_removed_scenes
    assert len(removals) == 1  # one removal call
    # Cached scene items should no longer include game_capture
    cached = service.state.scene_items_by_scene["Test Scene"]
    assert all(item.get("inputKind") != "game_capture" for item in cached)


def test_reconcile_skips_probe_for_already_removed_scenes(monkeypatch):
    items = _default_scene_items()
    probe_calls = []

    service, updates, _ = _make_reconcile_service(
        monkeypatch,
        items,
        {"Game Source": True, "Window Source": True},
    )
    original_probe = service._probe_source_has_output
    monkeypatch.setattr(
        service,
        "_probe_source_has_output",
        lambda name: (probe_calls.append(name), original_probe(name))[1],
    )
    service.state.game_capture_removed_scenes.add("Test Scene")

    result = service._reconcile_capture_source_visibility("Test Scene")

    # game_capture should never be probed
    assert "Game Source" not in probe_calls
    assert result is True


def test_reconcile_does_not_enable_game_capture_before_probing(monkeypatch):
    """Regression: the old code re-enabled game_capture before probing, causing
    a black flash.  The new code must NOT enable it."""
    items = _default_scene_items()
    items[0]["sceneItemEnabled"] = False  # game_capture starts disabled

    enable_calls = []

    service, updates, _ = _make_reconcile_service(
        monkeypatch,
        items,
        {"Game Source": False, "Window Source": True},
    )
    # Track all enable calls
    orig = service._set_scene_items_enabled

    def track_enable(scene_name, scene_items, enabled):
        for si in scene_items:
            enable_calls.append((si["sourceName"], enabled))
        # Don't actually call through — just track
        for si in scene_items:
            si["sceneItemEnabled"] = enabled

    monkeypatch.setattr(service, "_set_scene_items_enabled", track_enable)

    service._reconcile_capture_source_visibility("Test Scene")

    # game_capture should never be enabled (only disabled or left alone)
    assert ("Game Source", True) not in enable_calls


def test_reconcile_neither_output_keeps_window_enabled_game_disabled(monkeypatch):
    items = _default_scene_items()
    items[1]["sceneItemEnabled"] = False  # window_capture starts disabled
    service, updates, _ = _make_reconcile_service(
        monkeypatch,
        items,
        {"Game Source": False, "Window Source": False},
    )

    result = service._reconcile_capture_source_visibility("Test Scene")

    assert result is False
    # game_capture must be disabled, window_capture must be enabled
    assert ("Test Scene", ("Game Source",), False) in updates
    assert ("Test Scene", ("Window Source",), True) in updates


def test_reconcile_neither_output_keeps_game_capture_enabled_when_target_not_running(monkeypatch):
    items = _default_scene_items()
    items[1]["sceneItemEnabled"] = False  # window_capture starts disabled
    service, updates, removals = _make_reconcile_service(
        monkeypatch,
        items,
        {"Game Source": False, "Window Source": False},
        scene_target_running_state=False,
    )
    service.state.game_capture_fail_count["Test Scene"] = obs.GAME_CAPTURE_REMOVAL_THRESHOLD - 1

    result = service._reconcile_capture_source_visibility("Test Scene")

    assert result is False
    assert ("Test Scene", ("Game Source",), False) not in updates
    assert ("Test Scene", ("Window Source",), True) in updates
    assert items[0]["sceneItemEnabled"] is True
    assert service.state.game_capture_fail_count.get("Test Scene", 0) == 0
    assert removals == []
    assert "Test Scene" not in service.state.game_capture_removed_scenes


# ---------------------------------------------------------------------------
# is_image_empty tolerance
# ---------------------------------------------------------------------------


def test_is_image_empty_pure_black():
    img = Image.new("RGB", (4, 4), (0, 0, 0))
    assert obs_launch_module.is_image_empty(img) is True


def test_is_image_empty_near_black_within_tolerance():
    """JPEG compression artefacts may introduce small variation."""
    img = Image.new("RGB", (4, 4), (0, 0, 0))
    img.putpixel((0, 0), (3, 2, 1))  # within default tolerance=5
    assert obs_launch_module.is_image_empty(img) is True


def test_is_image_empty_beyond_tolerance():
    img = Image.new("RGB", (4, 4), (0, 0, 0))
    img.putpixel((0, 0), (10, 10, 10))  # beyond default tolerance=5
    assert obs_launch_module.is_image_empty(img) is False


def test_is_image_empty_grayscale():
    img = Image.new("L", (4, 4), 0)
    img.putpixel((0, 0), 4)
    assert obs_launch_module.is_image_empty(img) is True
    img.putpixel((1, 1), 20)
    assert obs_launch_module.is_image_empty(img) is False


def test_is_image_empty_explicit_zero_tolerance():
    img = Image.new("RGB", (4, 4), (0, 0, 0))
    img.putpixel((0, 0), (1, 0, 0))
    assert obs_launch_module.is_image_empty(img, tolerance=0) is False
