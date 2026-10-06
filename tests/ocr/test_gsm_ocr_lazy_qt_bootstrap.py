import sys
import types
import queue

import pytest

import GameSentenceMiner.ocr.gsm_ocr as gsm_ocr


class _FakeApp:
    def __init__(self, result=0):
        self.result = result
        self.exec_calls = 0

    def exec(self):
        self.exec_calls += 1
        return self.result


def _make_fake_qt_main_module(app):
    module = types.ModuleType("GameSentenceMiner.ui.qt_main")
    module.get_qt_app_calls = 0
    module.get_config_window_calls = 0

    def _get_qt_app():
        module.get_qt_app_calls += 1
        return app

    def _get_config_window():
        module.get_config_window_calls += 1
        raise AssertionError("OCR startup should not create ConfigWindow")

    module.get_qt_app = _get_qt_app
    module.get_config_window = _get_config_window
    return module


def test_initialize_qt_runtime_for_ocr_does_not_create_config_window(monkeypatch):
    fake_app = _FakeApp()
    fake_qt_main = _make_fake_qt_main_module(fake_app)
    # Patch the lazy loader so already-imported UI packages cannot bypass the fake.
    monkeypatch.setattr(gsm_ocr, "_get_qt_main_module", lambda: fake_qt_main)

    qt_main_module = gsm_ocr.initialize_qt_runtime_for_ocr()

    assert qt_main_module is fake_qt_main
    assert fake_qt_main.get_qt_app_calls == 1
    assert fake_qt_main.get_config_window_calls == 0


@pytest.mark.parametrize("provide_qt_main", [True, False], ids=["provided", "lazy"])
def test_run_qt_event_loop_for_ocr_uses_qt_app_exec(monkeypatch, provide_qt_main):
    fake_app = _FakeApp(result=123)
    fake_qt_main = _make_fake_qt_main_module(fake_app)
    monkeypatch.setattr(gsm_ocr, "_get_qt_main_module", lambda: fake_qt_main)
    cleanup_calls = []
    monkeypatch.setattr(gsm_ocr, "cleanup_ocr_runtime", lambda: cleanup_calls.append(True))

    result = gsm_ocr.run_qt_event_loop_for_ocr(qt_main_module=fake_qt_main if provide_qt_main else None)

    assert result == 123
    assert fake_qt_main.get_qt_app_calls == 1
    assert fake_qt_main.get_config_window_calls == 0
    assert fake_app.exec_calls == 1
    assert cleanup_calls == [True]


def test_request_clean_shutdown_quits_qt_app_without_config_window(monkeypatch):
    class _FakeQtApp:
        def __init__(self):
            self.quit_calls = 0

        def quit(self):
            self.quit_calls += 1

    class _FakeQApplication:
        _instance = _FakeQtApp()

        @staticmethod
        def instance():
            return _FakeQApplication._instance

    class _FakeHotkeyManager:
        def __init__(self):
            self.clear_calls = 0

        def clear(self):
            self.clear_calls += 1

    fake_hotkeys = _FakeHotkeyManager()
    fake_qt_main = types.ModuleType("GameSentenceMiner.ui.qt_main")
    fake_qt_main.shutdown_calls = 0

    def _shutdown_qt_app():
        fake_qt_main.shutdown_calls += 1

    fake_qt_main.shutdown_qt_app = _shutdown_qt_app
    monkeypatch.setattr(gsm_ocr, "_get_qt_main_module", lambda: fake_qt_main)

    fake_qtwidgets = types.ModuleType("PyQt6.QtWidgets")
    fake_qtwidgets.QApplication = _FakeQApplication
    monkeypatch.setitem(sys.modules, "PyQt6.QtWidgets", fake_qtwidgets)

    monkeypatch.setattr(gsm_ocr, "_get_hotkey_manager", lambda: fake_hotkeys)
    monkeypatch.setattr(gsm_ocr, "second_ocr_queue", queue.Queue())

    monkeypatch.setattr(gsm_ocr, "shutdown_requested", False)
    monkeypatch.setattr(gsm_ocr, "done", False)
    monkeypatch.setattr(gsm_ocr.ocr_runtime, "terminated", False, raising=False)
    monkeypatch.setattr(gsm_ocr, "_queue_qt_quit_for_ocr", _FakeQApplication._instance.quit)

    gsm_ocr.request_clean_shutdown("test")

    assert gsm_ocr.shutdown_requested is True
    assert gsm_ocr.done is True
    assert gsm_ocr.ocr_runtime.terminated is True
    assert fake_hotkeys.clear_calls == 0  # Blocking joins belong to main-thread cleanup.
    assert fake_qt_main.shutdown_calls == 1
    assert _FakeQApplication._instance.quit_calls == 1


def test_stop_command_relays_initiating_reason_to_clean_shutdown(monkeypatch):
    shutdown_reasons = []

    monkeypatch.setattr(gsm_ocr, "request_clean_shutdown", shutdown_reasons.append)
    monkeypatch.setattr(gsm_ocr.ocr_ipc, "announce_stopped", lambda: None)

    response = gsm_ocr.handle_ipc_command(
        {
            "command": "stop",
            "data": {"reason": "auto-launcher-scene-inactive"},
        }
    )

    assert response["success"] is True
    assert shutdown_reasons == ["ipc-stop-command: auto-launcher-scene-inactive"]


def test_qt_loop_error_still_cleans_up_runtime(monkeypatch):
    cleanup_calls = []

    def fail():
        raise RuntimeError("Qt loop failed")

    fake_app = types.SimpleNamespace(exec=fail)
    fake_qt_main = _make_fake_qt_main_module(fake_app)
    monkeypatch.setattr(gsm_ocr, "cleanup_ocr_runtime", lambda: cleanup_calls.append(True))

    with pytest.raises(RuntimeError, match="Qt loop failed"):
        gsm_ocr.run_qt_event_loop_for_ocr(fake_qt_main)
    assert cleanup_calls == [True]


def test_cleanup_continues_after_hotkey_failure_and_runs_once(monkeypatch):
    calls = []

    def fail_hotkeys():
        calls.append("hotkeys")
        raise RuntimeError("hotkeys failed")

    scheduler = object()
    monkeypatch.setattr(gsm_ocr, "_ocr_cleanup_complete", False)
    monkeypatch.setattr(gsm_ocr, "_ocr_deadline_scheduler", scheduler)
    monkeypatch.setattr(gsm_ocr, "request_clean_shutdown", lambda _reason: calls.append("stop"))
    monkeypatch.setattr(gsm_ocr, "_get_hotkey_manager", lambda: types.SimpleNamespace(clear=fail_hotkeys))
    monkeypatch.setattr(gsm_ocr.ocr_ipc, "stop_ipc_listener", lambda: calls.append("ipc"))
    monkeypatch.setattr(gsm_ocr.obs, "disconnect_from_obs", lambda: calls.append("obs"))
    monkeypatch.setattr(gsm_ocr, "release_runtime_scheduler", lambda target: calls.append(target))
    monkeypatch.setitem(
        sys.modules,
        "GameSentenceMiner.util.database.db",
        types.SimpleNamespace(gsm_db=types.SimpleNamespace(close=lambda: calls.append("db"))),
    )

    gsm_ocr.cleanup_ocr_runtime()
    gsm_ocr.cleanup_ocr_runtime()

    assert calls == ["stop", "hotkeys", "ipc", "obs", scheduler, "db"]
    assert gsm_ocr._ocr_deadline_scheduler is None


def test_second_ocr_queue_keeps_latest_task_without_precrop(monkeypatch):
    monkeypatch.setattr(gsm_ocr, "second_ocr_queue", queue.Queue(maxsize=1))
    monkeypatch.setattr(gsm_ocr, "SAVE_OCR_DEBUG_IMAGES", False)
    monkeypatch.setattr(gsm_ocr.ocr_runtime, "set_last_image", lambda _image: None)

    gsm_ocr._queue_second_pass_callback("old", None, "old-crop", None, pre_crop_image="old-full")
    gsm_ocr._queue_second_pass_callback("new", None, "new-crop", None, pre_crop_image="new-full")

    task = gsm_ocr.second_ocr_queue.get_nowait()
    assert task[0] == "new"
    assert task[2] == "new-crop"
    assert task[4] is None
