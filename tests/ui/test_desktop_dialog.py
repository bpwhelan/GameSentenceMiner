import asyncio
import json
import os
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import create_autospec

import pytest

from GameSentenceMiner.ui import desktop_dialog


def test_only_desktop_can_request_a_window():
    with pytest.raises(PermissionError):
        asyncio.run(desktop_dialog.handle_dialog({"src": "ocr", "data": {"dialog": "settings"}}))


def test_saved_area_notifies_desktop_through_the_existing_connection(monkeypatch):
    from PyQt6.QtCore import QObject, pyqtSignal

    from GameSentenceMiner.ocr import owocr_area_selector_qt
    from GameSentenceMiner.util.communication import bus_client

    class Window(QObject):
        config_saved = pyqtSignal()

    window = Window()
    sent = []
    client = SimpleNamespace(connected=True, publish=lambda *message: sent.append(message))
    monkeypatch.setattr(bus_client, "is_bus_available", lambda: True)
    monkeypatch.setattr(bus_client, "get_bus", lambda: client)
    monkeypatch.setattr(owocr_area_selector_qt, "show_area_selector", lambda **kwargs: window)
    assert desktop_dialog.open_dialog({"dialog": "areaSelector"}, lambda value: None, standalone=False) is window
    assert not sent
    window.config_saved.emit()
    assert sent == [(bus_client.MAIN, "gui.ocrAreaSaved")]


@pytest.mark.parametrize(
    "name,accept,expected",
    [
        ("textInput", True, "日本語"),
        ("textInput", False, None),
        ("sessionReview", False, None),
        ("settings", False, None),
        ("promptHelp", False, None),
        ("syncSettings", False, None),
        ("recommendedAnkiSetup", False, None),
        ("ankiFieldGrouping", False, None),
        ("ankiFieldGrouping", True, {"target_note_id": 10, "order": "back", "delete_duplicate": False}),
        ("sceneSelection", True, "日本語"),
        ("furiganaPreview", True, 4),
        ("minimumCharacterSize", True, 4),
        ("ankiConfirmation", False, None),
        (
            "ankiConfirmation",
            True,
            [
                False,
                "編集した台詞",
                "A revised line",
                None,
                None,
                True,
                None,
                {
                    "selected_lines": [],
                    "line_selection_changed": False,
                    "audio_result": None,
                    "translation_regenerated": False,
                    "translation_pending": False,
                    "audio_edit_range": None,
                },
            ],
        ),
        ("screenshotSelector", False, None),
        ("screenCropper", False, None),
        ("monitorSelector", False, []),
        ("areaSelector", False, None),
    ],
)
def test_real_window_worker_returns_after_accept_cancel_or_close(tmp_path, name, accept, expected):
    request, result = tmp_path / "request.json", tmp_path / "result.json"
    args = {
        "textInput": {"title": "Fixture", "label": "Fixture"},
        "sceneSelection": {"matched_configs": ["日本語"]},
        "ankiFieldGrouping": {"expression": "語", "candidates": [{"note_id": 10, "sentence": "日本語"}]},
        "screenCropper": {"transparent_mode": True},
        "areaSelector": {"window_name": "Fixture", "use_obs_screenshot": True, "single_area_mode": True},
    }.get(name, {})
    if name == "ankiConfirmation":
        args = {"expression": "語", "sentence": "日本語"}
    if name == "screenshotSelector":
        source = tmp_path / "fixture.mkv"
        source.touch()
        args = {"video_path": str(source), "timestamp": 0}
    if name in ("furiganaPreview", "minimumCharacterSize"):
        from PIL import Image

        image = tmp_path / "capture.png"
        Image.new("RGB", (48, 32)).save(image)
        field = "current_sensitivity" if name == "furiganaPreview" else "current_size"
        args = {field: 4, "image_path": str(image)}
    request.write_text(json.dumps({"dialog": name, **args}))
    subprocess.run(
        [sys.executable, __file__, str(request), str(result), str(int(accept))],
        env={
            **os.environ,
            "QT_QPA_PLATFORM": "offscreen",
            "GSM_DATA_DIR": str(tmp_path),
            "GAME_SENTENCE_MINER_TESTING": "1",
            "GSM_TEST_DATA_ROOT": str(tmp_path),
        },
        timeout=30,
        check=True,
    )
    assert json.loads(result.read_text(encoding="utf-8")) == {"value": expected}
    if name == "screenshotSelector":
        assert (tmp_path / "decoder-stopped").is_file()


def _exercise_worker(request, result, accept):
    from PyQt6.QtCore import QTimer
    from PyQt6.QtWidgets import QApplication, QInputDialog

    open_dialog = desktop_dialog.open_dialog

    def choose(name):
        if name in ("screenCropper", "areaSelector", "monitorSelector"):
            kind = "ScreenCropperWidget" if name == "screenCropper" else "OWOCRAreaSelectorWidget"
            window = next(w for w in QApplication.topLevelWidgets() if type(w).__name__ == kind and w.isVisible())
            window.close()
            return
        active = QApplication.activeModalWidget()
        if name == "ankiConfirmation":
            from GameSentenceMiner.ui.anki_confirmation_qt import AnkiConfirmationDialog

            active = next(
                (
                    widget
                    for widget in QApplication.topLevelWidgets()
                    if isinstance(widget, AnkiConfirmationDialog) and widget.isVisible()
                ),
                None,
            )
            if active is None:
                QTimer.singleShot(10, lambda: choose(name))
                return
            if accept:
                active.sentence_text.setPlainText("編集した台詞")
                active.translation_text.setPlainText("A revised line")
                active.nsfw_tag_checkbox.setChecked(True)
                active._on_no_voice()
                return
        assert active is not None
        if name == "ankiFieldGrouping" and accept:
            active.order_combo.setCurrentIndex(active.order_combo.findData("back"))
            active.delete_duplicate_check.setChecked(False)
            active._accept_merge()
            return
        if name in ("textInput", "sceneSelection"):
            assert isinstance(active, QInputDialog)
            active.setTextValue("日本語")
        active.accept() if accept else active.reject()

    def open_and_choose(payload, *args, **kwargs):
        name = payload["dialog"]
        if name in ("screenCropper", "areaSelector", "monitorSelector"):
            _supply_capture_fixture(name)
        if name in ("furiganaPreview", "minimumCharacterSize"):
            from GameSentenceMiner.ui import furigana_filter_preview_qt

            furigana_filter_preview_qt._start_ocr_worker = lambda *args: None
        if name == "ankiConfirmation":
            from GameSentenceMiner.ui import anki_confirmation_qt

            anki_confirmation_qt.AnkiConfirmationDialog._show_exit_confirmation_message = lambda self: (
                anki_confirmation_qt.EXIT_CHOICE_DISCARD
            )
            anki_confirmation_qt._request_game_focus_restore = lambda *_: None
            anki_confirmation_qt.request_anki_confirmation_process_pause = lambda *_: False
        if name == "screenshotSelector":
            from PyQt6.QtCore import QThread

            from GameSentenceMiner.ui.screenshot_selector_qt import FrameWorker

            def decode(worker):
                worker.cancelled.wait(5)
                QThread.msleep(250)
                Path(worker.source_path).with_name("decoder-stopped").touch()

            FrameWorker.run = decode
        if name not in ("settings", "sessionReview"):
            QTimer.singleShot(0, lambda: choose(name))
        opened = open_dialog(payload, *args, **kwargs)
        if payload["dialog"] in ("settings", "sessionReview"):
            window, _watcher = opened
            assert window.isVisible()
            QTimer.singleShot(0, window.close)
        return opened

    desktop_dialog.open_dialog = open_and_choose
    desktop_dialog.run_worker(request, result)


def _supply_capture_fixture(name):
    from contextlib import nullcontext

    from PIL import Image
    from PyQt6.QtCore import QRect

    geometry = {"left": 0, "top": 0, "width": 400, "height": 300}
    if name == "screenCropper":
        from GameSentenceMiner.ocr import ss_picker_qt

        ss_picker_qt.get_monitor_dpi_scale = lambda: {0: 1.0}
        ss_picker_qt.mss.mss = lambda: nullcontext(SimpleNamespace(monitors=[geometry, geometry]))
        return

    from GameSentenceMiner.ocr import owocr_area_selector_qt as area

    def capture(widget):
        widget.screenshot_img = Image.new("RGB", (400, 300))
        widget.bounding_box = widget.bounding_box_original = widget.target_window_geometry = geometry.copy()
        widget.monitor_geometry = geometry.copy()
        widget.monitors = [{"index": 0, **geometry}]
        widget.reference_screen_geometry = QRect(0, 0, 400, 300)

    area.obs.get_current_scene = lambda: "Fixture"
    area.OWOCRAreaSelectorWidget._connect_to_obs = lambda self: None
    area.OWOCRAreaSelectorWidget._init_obs_screenshot = capture
    area.OWOCRAreaSelectorWidget._init_monitor_capture = capture


@pytest.mark.parametrize(
    "name,launcher,params",
    [
        ("ankiConfirmation", "launch_anki_confirmation", {"expression": "語", "sentence": "日本語"}),
        ("ankiFieldGrouping", "launch_anki_field_grouping", {"expression": "語", "candidates": []}),
        ("screenshotSelector", "launch_screenshot_selector", {"video_path": "clip.mkv", "timestamp": 1.5}),
        ("sceneSelection", "launch_scene_selection", {"matched_configs": ["Game"]}),
        ("minimumCharacterSize", "launch_minimum_character_size_selector", {"current_size": 4, "for_overlay": True}),
        ("furiganaPreview", "launch_furigana_filter_preview", {"current_sensitivity": 2}),
    ],
)
def test_dialog_requests_match_widget_signatures(monkeypatch, name, launcher, params):
    from GameSentenceMiner.ui import qt_main

    show = create_autospec(getattr(qt_main, launcher), return_value="accepted")
    monkeypatch.setattr(qt_main, launcher, show)
    results = []
    desktop_dialog.open_dialog({"dialog": name, **params}, results.append, standalone=False)
    assert results == ["accepted"]
    if name == "ankiConfirmation":
        params = {**params, "screenshot_path": None, "previous_screenshot_path": None}
    show.assert_called_once_with(**params)


def test_confirmation_serializes_line_ids_without_following_cycles():
    from GameSentenceMiner.util.media.screenshot_selection import ScreenshotMedia, ScreenshotSelectionResult
    from GameSentenceMiner.util.text_log import GameLine

    line = GameLine("a", "会話", datetime(2026, 1, 1, tzinfo=UTC), None, None, scene="Game")
    line.prev = line.next = line
    selection = ScreenshotSelectionResult("clip.mkv", (ScreenshotMedia("a.webp", 1.125),))
    value = desktop_dialog._wire({"selected_lines": [line], "screenshots": selection})
    assert value["selected_lines"] == [
        {"id": "a", "text": "会話", "time": "2026-01-01T00:00:00+00:00", "scene": "Game"}
    ]
    assert value["screenshots"]["items"] == [{"path": "a.webp", "start": 1.125}]


def test_cropped_images_round_trip_as_files(tmp_path, monkeypatch):
    from PIL import Image

    from GameSentenceMiner.util.config import configuration

    monkeypatch.setattr(configuration, "get_temporary_directory", lambda: str(tmp_path))
    source = Image.new("RGB", (30, 10), "#ffc067")
    source._gsm_screen_crop_metadata = {"selection_left": -10, "virtual_top": -5, "transparent_mode": True}
    result = desktop_dialog._encode({"dialog": "screenCropper"}, source)
    assert result["metadata"] == source._gsm_screen_crop_metadata
    with Image.open(result["path"]) as reopened:
        assert reopened.tobytes() == source.tobytes()


if __name__ == "__main__":
    _exercise_worker(sys.argv[1], sys.argv[2], sys.argv[3] == "1")
