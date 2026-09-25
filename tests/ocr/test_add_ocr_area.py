import json
import os
import sys
import threading
import time
from types import SimpleNamespace
from unittest.mock import Mock

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import pytest
from PIL import Image
from PyQt6.QtCore import QPoint, QRect, Qt
from PyQt6.QtTest import QTest
from PyQt6.QtWidgets import QApplication

from GameSentenceMiner.ocr import gsm_ocr
from GameSentenceMiner.ocr import owocr_area_selector_qt as selector_module


@pytest.fixture
def selector_factory(tmp_path, monkeypatch):
    app = QApplication.instance() or QApplication([])
    scene = {"name": "Scene"}
    monkeypatch.setattr(selector_module.obs, "get_current_scene", lambda: scene["name"])
    monkeypatch.setattr(selector_module, "get_ocr_config_path", lambda: str(tmp_path))
    monkeypatch.setattr(
        selector_module,
        "get_scene_ocr_config_path",
        lambda *_args: str(tmp_path / f"{scene['name']}.json"),
    )
    monkeypatch.setattr(selector_module, "read_overlay_scene_settings", dict)
    monkeypatch.setattr(selector_module.OWOCRAreaSelectorWidget, "_connect_to_obs", lambda _self: None)

    def capture(selector):
        selector.screenshot_img = Image.new("RGB", (400, 300))
        selector.bounding_box = {"left": 0, "top": 0, "width": 400, "height": 300}
        selector.target_window_geometry = {"left": 0, "top": 0, "width": 800, "height": 600}
        selector.bounding_box_original = selector.target_window_geometry.copy()
        selector.scale_factor_w = selector.scale_factor_h = 2.0
        selector.monitors = [{"index": 0, **selector.target_window_geometry}]
        selector.reference_screen_geometry = QRect(0, 0, 1280, 960)

    monkeypatch.setattr(selector_module.OWOCRAreaSelectorWidget, "_init_obs_screenshot", capture)
    widgets = []

    def create(single_area_mode=True):
        completed = Mock()
        selector = selector_module.OWOCRAreaSelectorWidget(
            "", use_obs_screenshot=True, single_area_mode=single_area_mode, on_complete=completed
        )
        widgets.append(selector)
        return selector, completed

    yield create, tmp_path / "Scene.json", scene
    for widget in widgets:
        try:
            widget.close()
        except RuntimeError:
            pass
    app.processEvents()


def draw_box(selector, modifiers=Qt.KeyboardModifier.NoModifier, size=None):
    if size is None:
        size = QPoint(80, 60)
    image_rect = selector._image_rect()
    start = image_rect.topLeft() + QPoint(40, 40)
    QTest.mousePress(selector, Qt.MouseButton.LeftButton, modifiers, start)
    QTest.mouseRelease(selector, Qt.MouseButton.LeftButton, modifiers, start + size)


@pytest.mark.parametrize("secondary", [False, True])
def test_add_area_appends_one_box_and_preserves_existing_config(selector_factory, secondary):
    create, path, scene = selector_factory
    existing = {
        "coordinate_system": "percentage",
        "scene": "Scene",
        "language": "ja",
        "custom_setting": {"keep": True},
        "rectangles": [{"monitor": {"index": 0}, "coordinates": [0.123456, 0.234567, 0.31, 0.27], "is_excluded": True}],
    }
    path.write_text(json.dumps(existing), encoding="utf-8")
    selector, completed = create()
    # An OBS scene switch while drawing must not redirect the write.
    scene["name"] = "Other Scene"
    draw_box(selector, Qt.KeyboardModifier.ControlModifier if secondary else Qt.KeyboardModifier.NoModifier)

    saved = json.loads(path.read_text(encoding="utf-8"))
    assert saved["rectangles"][:-1] == existing["rectangles"]
    assert saved["rectangles"][-1]["is_secondary"] is secondary
    assert saved["rectangles"][-1]["coordinates"] == pytest.approx([0.1, 40 / 300, 0.2, 0.2])
    assert saved["custom_setting"] == existing["custom_setting"]
    assert saved["language"] == "ja"
    assert not path.with_name("Other Scene.json").exists()
    assert not selector.isVisible()
    assert completed.call_count == 1
    assert completed.call_args.args[0]


def test_add_area_cancel_and_small_drag_do_not_save(selector_factory):
    create, path, _scene = selector_factory
    selector, completed = create()
    draw_box(selector, size=QPoint(5, 5))
    assert selector.isVisible()
    assert not path.exists()
    selector.save_and_quit()  # No valid new box yet.
    assert not path.exists()
    QTest.keyClick(selector, Qt.Key.Key_Escape)
    completed.assert_called_once_with(None)
    assert not path.exists()


def test_add_area_save_failure_stays_open_and_can_retry(selector_factory, monkeypatch):
    create, path, _scene = selector_factory
    selector, completed = create()
    writer = selector_module.write_ocr_config
    monkeypatch.setattr(selector_module, "write_ocr_config", Mock(side_effect=OSError("disk full")))
    error_dialog = Mock()
    monkeypatch.setattr(selector_module.QMessageBox, "critical", error_dialog)
    draw_box(selector)
    assert selector.isVisible()
    completed.assert_not_called()
    error_dialog.assert_called_once()
    assert not path.exists()
    monkeypatch.setattr(selector_module, "write_ocr_config", writer)
    draw_box(selector)
    assert len(json.loads(path.read_text(encoding="utf-8"))["rectangles"]) == 1
    assert completed.call_count == 1


def test_regular_selector_keeps_editing_after_drawing(selector_factory):
    create, path, _scene = selector_factory
    selector, completed = create(single_area_mode=False)
    draw_box(selector)
    assert selector.isVisible()
    assert not path.exists()
    completed.assert_not_called()


@pytest.mark.parametrize("result,expected", [([{"x": 0.1}], True), (None, False)])
def test_add_area_runtime_reloads_only_after_save(monkeypatch, result, expected):
    launch = Mock(return_value=result)
    monkeypatch.setitem(sys.modules, "GameSentenceMiner.ui.qt_main", SimpleNamespace(launch_area_selector=launch))
    reload_config = Mock()
    announced = Mock()
    monkeypatch.setattr(gsm_ocr, "apply_ipc_config_reload", reload_config)
    monkeypatch.setattr(gsm_ocr.ocr_ipc, "announce_config_reloaded", announced)

    assert gsm_ocr.add_ocr_area() is expected
    launch.assert_called_once_with("", use_obs_screenshot=True, single_area_mode=True)
    if expected:
        reload_config.assert_called_once_with({"reload_area": True, "reload_electron": False, "force": True})
        announced.assert_called_once_with()
    else:
        reload_config.assert_not_called()
        announced.assert_not_called()


def test_add_area_ignores_repeated_triggers_while_selector_is_open(monkeypatch):
    def while_open(*_args, **_kwargs):
        assert gsm_ocr.add_ocr_area() is False

    launch = Mock(side_effect=while_open)
    monkeypatch.setitem(sys.modules, "GameSentenceMiner.ui.qt_main", SimpleNamespace(launch_area_selector=launch))
    assert gsm_ocr.add_ocr_area() is False
    launch.assert_called_once()


def test_add_area_command_dispatches_without_blocking_ipc(monkeypatch):
    thread = Mock()
    monkeypatch.setattr(gsm_ocr.threading, "Thread", thread)
    response = gsm_ocr.handle_ipc_command({"command": "add_ocr_area"})
    assert response["success"] is True
    thread.assert_called_once_with(target=gsm_ocr.add_ocr_area, daemon=True)
    thread.return_value.start.assert_called_once_with()


def test_add_area_keyboard_and_gamepad_share_action_and_refresh_binding(monkeypatch):
    manager = Mock()
    monkeypatch.setattr(gsm_ocr, "_get_hotkey_manager", lambda: manager)
    monkeypatch.setattr(gsm_ocr, "add_area_ocr_hotkey", "")
    gsm_ocr.add_ss_hotkey()
    getter = next(call.args[0] for call in manager.register.call_args_list if call.args[1] is gsm_ocr.add_ocr_area)
    assert getter() == ""
    monkeypatch.setattr(gsm_ocr, "get_ocr_add_area_ocr_hotkey", lambda: "Alt+N")
    gsm_ocr.refresh_runtime_hotkey_settings_from_config()
    assert getter() == "alt+n"
    manager.register_gamepad.assert_any_call(gsm_ocr.get_ocr_add_area_ocr_gamepad, gsm_ocr.add_ocr_area)


def test_add_area_qt_handoff_updates_running_capture_config(selector_factory, monkeypatch):
    import GameSentenceMiner
    from GameSentenceMiner.ocr import gsm_ocr_config

    # Restore lazy UI imports after this test; the bootstrap tests replace the
    # modules in sys.modules and require no stale package attributes.
    monkeypatch.setattr(GameSentenceMiner, "ui", getattr(GameSentenceMiner, "ui", None), raising=False)
    for module_name in ("GameSentenceMiner.ui", "GameSentenceMiner.ui.qt_main"):
        previous_module = sys.modules.get(module_name)
        monkeypatch.setitem(sys.modules, module_name, previous_module)
        if previous_module is None:
            del sys.modules[module_name]
    from GameSentenceMiner.ui import qt_main

    _create, path, _scene = selector_factory
    app = QApplication.instance()
    manager = qt_main.DialogManager()
    monkeypatch.setattr(qt_main, "_qt_app", app)
    monkeypatch.setattr(qt_main, "_dialog_manager", manager)
    monkeypatch.setattr(gsm_ocr_config, "get_ocr_config_path", lambda: str(path.parent))
    monkeypatch.setattr(gsm_ocr.obs, "update_current_game", lambda: None)
    monkeypatch.setattr(gsm_ocr.obs, "get_current_game", lambda: "Scene")
    monkeypatch.setattr(gsm_ocr, "ocr_config", None)
    monkeypatch.setattr(gsm_ocr_config, "scene_ocr_config", None)
    reset = Mock()
    monkeypatch.setattr(gsm_ocr, "reset_callback_vars", reset)
    cache_clear = Mock()
    monkeypatch.setattr(gsm_ocr.ocr_runtime, "clear_scaled_ocr_config_cache", cache_clear)
    capture = SimpleNamespace(width=800, height=600, ocr_config=None, init_config=Mock())
    monkeypatch.setattr(gsm_ocr.ocr_runtime, "obs_screenshot_thread", capture, raising=False)
    monkeypatch.setattr(gsm_ocr.ocr_runtime, "screenshot_thread", None, raising=False)
    announced = Mock()
    monkeypatch.setattr(gsm_ocr.ocr_ipc, "announce_config_reloaded", announced)
    results = []
    worker = threading.Thread(target=lambda: results.append(gsm_ocr.add_ocr_area()), daemon=True)
    worker.start()
    deadline = time.monotonic() + 3
    while getattr(manager, "_area_selector", None) is None and time.monotonic() < deadline:
        app.processEvents()
    selector = manager._area_selector
    assert selector.isVisible()
    draw_box(selector)
    worker.join(timeout=3)

    assert not worker.is_alive()
    assert results == [True]
    assert manager._area_selector is None
    assert len(capture.ocr_config.rectangles) == 1
    assert capture.ocr_config.rectangles[0].coordinates == [80, 80, 160, 120]
    capture.init_config.assert_not_called()
    cache_clear.assert_called_once_with()
    reset.assert_called_once_with()
    announced.assert_called_once_with()
