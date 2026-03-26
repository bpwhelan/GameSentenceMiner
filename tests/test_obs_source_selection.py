import base64
import contextlib
import io
import threading

from PIL import Image
from types import SimpleNamespace

import pytest

import GameSentenceMiner.obs as obs
import GameSentenceMiner.obs as obs_module


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

    monkeypatch.setattr(obs_module, "OBSConnectionPool", _DummyConnectionPool)
    monkeypatch.setattr(obs_module.obs, "EventClient", lambda *args, **kwargs: object())
    monkeypatch.setattr(obs_module.OBSService, "_register_default_handlers", lambda self: None)
    monkeypatch.setattr(obs_module.OBSService, "_initialize_state", lambda self: None)
    return obs_module.OBSService("localhost", 4455, "", check_output=False)


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
    service = obs.OBSService.__new__(obs.OBSService)
    service._state_lock = threading.Lock()
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

    def fake_probe_source_has_output(source_name):
        if source_name == "Game Source":
            return bool(service.state.scene_items_by_scene["Test Scene"][0]["sceneItemEnabled"])
        return source_name == "Window Source"

    monkeypatch.setattr(service, "_set_scene_items_enabled", fake_set_scene_items_enabled)
    monkeypatch.setattr(service, "_probe_source_has_output", fake_probe_source_has_output)

    result = service._reconcile_capture_source_visibility("Test Scene")

    assert result is True
    assert updates == [
        ("Test Scene", ("Game Source",), True),
        ("Test Scene", ("Window Source",), False),
    ]


def test_build_scheduled_tick_options_respects_intervals():
    service = obs.OBSService.__new__(obs.OBSService)
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

    options = service.build_scheduled_tick_options(now=200.0)

    assert options.refresh_current_scene is True
    assert options.refresh_scene_items is False
    assert options.fit_to_screen is False
    assert options.capture_source_switch is True
    assert options.output_probe is False
    assert options.manage_replay_buffer is True
    assert options.refresh_full_state is False


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

    monkeypatch.setattr(obs, "get_active_video_sources", lambda: sources)
    monkeypatch.setattr(
        obs,
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

    monkeypatch.setattr(obs, "get_active_video_sources", lambda: sources)
    monkeypatch.setattr(
        obs,
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

    monkeypatch.setattr(obs, "get_active_video_sources", lambda: sources)
    monkeypatch.setattr(
        obs,
        "get_screenshot_PIL_from_source",
        lambda source_name, *args, **kwargs: (
            Image.new("RGB", (4, 4), (0, 0, 0)) if source_name == "Game Source" else _valid_test_image_rgb()
        ),
    )

    best_source = obs.get_best_source_for_screenshot()

    assert best_source["sourceName"] == "Window Source"


def test_obs_service_tick_applies_fit_before_screenshot_probe(monkeypatch):
    service = obs.OBSService.__new__(obs.OBSService)
    service.initialized = True
    service.check_output = True
    service._state_lock = threading.Lock()
    service.state = obs.OBSState(current_scene="Test Scene")
    service._initialize_state = lambda: None
    service._is_output_active_from_screenshot = lambda: None
    service._tick_last_run_by_operation = {}
    service.tick_intervals = obs.OBSTickIntervals()

    fit_calls = []
    monkeypatch.setattr(
        obs,
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


def test_get_best_source_for_screenshot_can_suppress_missing_source_logs(monkeypatch):
    logger_errors = []
    kwargs_seen = []

    def fake_get_active_video_sources(**kwargs):
        kwargs_seen.append(kwargs)
        return None

    monkeypatch.setattr(obs, "get_active_video_sources", fake_get_active_video_sources)
    monkeypatch.setattr(obs.logger, "error", lambda message: logger_errors.append(message))

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

    monkeypatch.setattr(obs_module, "connection_pool", _RetryPool())
    monkeypatch.setattr(obs_module.time, "sleep", lambda _seconds: None)
    monkeypatch.setattr(obs_module.logger, "error", lambda message: logger_errors.append(message))

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

    monkeypatch.setattr(obs_module, "connection_pool", _RetryPool())
    monkeypatch.setattr(obs_module.time, "sleep", lambda _seconds: None)

    image = obs_module.get_screenshot_PIL_from_source("Game Source", retry=2)

    assert image is not None
    assert image.size == (2, 2)
    assert attempts == ["get_source_screenshot", "get_source_screenshot"]


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

    monkeypatch.setattr(obs_module.obs, "ReqClient", _FakeClient)

    pool = obs_module.OBSConnectionPool(host="localhost", port=4455, password="", timeout=1)

    with pytest.raises(RuntimeError):
        with pool.get_client() as client:
            first_client_id = client.client_id
            raise RuntimeError("boom")

    with pool.get_client() as client:
        second_client_id = client.client_id

    assert first_client_id == 0
    assert second_client_id == 1
    assert created_clients[0].disconnected is True


def test_toggle_replay_buffer_does_not_retry_non_idempotent_calls(monkeypatch):
    attempts = []
    logger_errors = []

    class _BrokenPool:
        @contextlib.contextmanager
        def get_client(self):
            attempts.append("get_client")
            raise ConnectionError("socket is already closed")
            yield

    monkeypatch.setattr(obs_module, "connection_pool", _BrokenPool())
    monkeypatch.setattr(obs_module, "obs_service", None)
    monkeypatch.setattr(obs_module, "_is_obs_recording_disabled", lambda *args, **kwargs: False)
    monkeypatch.setattr(obs_module.time, "sleep", lambda _seconds: None)
    monkeypatch.setattr(obs_module.logger, "error", lambda message: logger_errors.append(message))

    obs_module.toggle_replay_buffer()

    assert attempts == ["get_client"]
    assert logger_errors


def test_obs_connection_manager_refreshes_existing_service_on_recovery(monkeypatch):
    manager = obs_module.OBSConnectionManager(check_output=False)
    refresh_calls = []

    class _FakePool:
        def ping(self):
            return True

    fake_service = SimpleNamespace(
        connection_pool=_FakePool(),
        event_client="old-event",
    )

    def fake_refresh_after_reconnect():
        refresh_calls.append("refresh")
        fake_service.event_client = "new-event"

    fake_service.refresh_after_reconnect = fake_refresh_after_reconnect

    monkeypatch.setattr(obs_module, "obs_service", fake_service)
    monkeypatch.setattr(obs_module, "connection_pool", fake_service.connection_pool)
    monkeypatch.setattr(obs_module, "event_client", "stale-event")
    monkeypatch.setattr(obs_module.gsm_status, "obs_connected", False, raising=False)

    assert manager._recover_obs_connection() is True
    assert refresh_calls == ["refresh"]
    assert obs_module.event_client == "new-event"
    assert obs_module.gsm_status.obs_connected is True


def test_get_current_scene_returns_cached_scene_when_obs_is_unavailable(monkeypatch):
    monkeypatch.setattr(obs_module, "connection_pool", object())
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

    logger_errors = []
    original_connection_pool = obs_module.connection_pool
    monkeypatch.setattr(obs_module, "connection_pool", _PassiveConnectionPool())
    monkeypatch.setattr(obs_module, "connecting", False)
    monkeypatch.setattr(obs_module.gsm_status, "obs_connected", True, raising=False)
    monkeypatch.setattr(obs_module.logger, "error", lambda message: logger_errors.append(message))

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
        obs_module,
        "get_active_video_sources",
        lambda: [
            {"sourceName": "some_helper_capture", "inputKind": "window_capture"},
            {"sourceName": "fallback_capture", "inputKind": "game_capture"},
        ],
    )
    monkeypatch.setattr(
        obs_module,
        "get_screenshot_PIL_from_source",
        lambda source_name, *_args, **_kwargs: helper_image if source_name == "some_helper_capture" else fallback_image,
    )
    monkeypatch.setattr(obs_module, "_apply_ocr_preprocessing", lambda img, **_kwargs: img)
    monkeypatch.setattr(obs_module.gsm_state, "current_game", "GSM Helper - DONT TOUCH", raising=False)
    monkeypatch.setattr(obs_module, "obs_service", None)
    monkeypatch.setattr(obs_module.logger, "warning", lambda message: warning_calls.append(message))

    result = obs_module.get_screenshot_PIL()

    assert result is helper_image
    assert warning_calls == []


def test_get_screenshot_pil_skips_validation_for_helper_sources(monkeypatch):
    helper_image = _ExplodingImage()
    fallback_image = _NonUniformImage()
    warning_calls = []

    monkeypatch.setattr(
        obs_module,
        "get_active_video_sources",
        lambda: [
            {"sourceName": "window_getter", "inputKind": "window_capture"},
            {"sourceName": "fallback_capture", "inputKind": "game_capture"},
        ],
    )
    monkeypatch.setattr(
        obs_module,
        "get_screenshot_PIL_from_source",
        lambda source_name, *_args, **_kwargs: helper_image if source_name == "window_getter" else fallback_image,
    )
    monkeypatch.setattr(obs_module, "_apply_ocr_preprocessing", lambda img, **_kwargs: img)
    monkeypatch.setattr(obs_module.gsm_state, "current_game", "Regular Scene", raising=False)
    monkeypatch.setattr(
        obs_module, "obs_service", SimpleNamespace(state=SimpleNamespace(current_scene="Regular Scene"))
    )
    monkeypatch.setattr(obs_module.logger, "warning", lambda message: warning_calls.append(message))

    result = obs_module.get_screenshot_PIL()

    assert result is helper_image
    assert warning_calls == []


def test_get_screenshot_pil_keeps_validation_for_regular_sources(monkeypatch):
    uniform_image = _UniformImage()
    valid_image = _NonUniformImage()

    monkeypatch.setattr(
        obs_module,
        "get_active_video_sources",
        lambda: [
            {"sourceName": "blank_capture", "inputKind": "window_capture"},
            {"sourceName": "game_capture", "inputKind": "game_capture"},
        ],
    )
    monkeypatch.setattr(
        obs_module,
        "get_screenshot_PIL_from_source",
        lambda source_name, *_args, **_kwargs: uniform_image if source_name == "blank_capture" else valid_image,
    )
    monkeypatch.setattr(obs_module, "_apply_ocr_preprocessing", lambda img, **_kwargs: img)
    monkeypatch.setattr(obs_module.gsm_state, "current_game", "Regular Scene", raising=False)
    monkeypatch.setattr(
        obs_module, "obs_service", SimpleNamespace(state=SimpleNamespace(current_scene="Regular Scene"))
    )

    result = obs_module.get_screenshot_PIL()

    assert result is valid_image
