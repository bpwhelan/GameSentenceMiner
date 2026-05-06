import sys
import types
import queue

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
    fake_ui_pkg = types.ModuleType("GameSentenceMiner.ui")
    fake_ui_pkg.qt_main = fake_qt_main
    monkeypatch.setitem(sys.modules, "GameSentenceMiner.ui", fake_ui_pkg)
    monkeypatch.setitem(sys.modules, "GameSentenceMiner.ui.qt_main", fake_qt_main)

    qt_main_module = gsm_ocr.initialize_qt_runtime_for_ocr()

    assert qt_main_module is fake_qt_main
    assert fake_qt_main.get_qt_app_calls == 1
    assert fake_qt_main.get_config_window_calls == 0


def test_run_qt_event_loop_for_ocr_uses_qt_app_exec(monkeypatch):
    fake_app = _FakeApp(result=123)
    fake_qt_main = _make_fake_qt_main_module(fake_app)
    fake_ui_pkg = types.ModuleType("GameSentenceMiner.ui")
    fake_ui_pkg.qt_main = fake_qt_main
    monkeypatch.setitem(sys.modules, "GameSentenceMiner.ui", fake_ui_pkg)
    monkeypatch.setitem(sys.modules, "GameSentenceMiner.ui.qt_main", fake_qt_main)

    result = gsm_ocr.run_qt_event_loop_for_ocr(qt_main_module=fake_qt_main)

    assert result == 123
    assert fake_qt_main.get_qt_app_calls == 1
    assert fake_qt_main.get_config_window_calls == 0
    assert fake_app.exec_calls == 1


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
    fake_ui_pkg = types.ModuleType("GameSentenceMiner.ui")
    fake_ui_pkg.qt_main = fake_qt_main
    monkeypatch.setitem(sys.modules, "GameSentenceMiner.ui", fake_ui_pkg)
    monkeypatch.setitem(sys.modules, "GameSentenceMiner.ui.qt_main", fake_qt_main)

    fake_qtwidgets = types.ModuleType("PyQt6.QtWidgets")
    fake_qtwidgets.QApplication = _FakeQApplication
    monkeypatch.setitem(sys.modules, "PyQt6.QtWidgets", fake_qtwidgets)

    monkeypatch.setattr(gsm_ocr, "_get_hotkey_manager", lambda: fake_hotkeys)
    monkeypatch.setattr(gsm_ocr, "second_ocr_queue", queue.Queue())
    monkeypatch.setattr(gsm_ocr, "websocket_server_thread", None)
    monkeypatch.setattr(gsm_ocr, "shutdown_requested", False)
    monkeypatch.setattr(gsm_ocr, "done", False)

    gsm_ocr.request_clean_shutdown("test")

    assert gsm_ocr.shutdown_requested is True
    assert gsm_ocr.done is True
    assert fake_hotkeys.clear_calls == 1
    assert fake_qt_main.shutdown_calls == 1
    assert _FakeQApplication._instance.quit_calls == 1
