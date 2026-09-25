"""Choose one or more still screenshots from paged frames in a saved replay."""

import itertools
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from collections import OrderedDict
from fractions import Fraction
from pathlib import Path
from queue import PriorityQueue
from uuid import uuid4

from PyQt6.QtCore import QSize, Qt, QThread, pyqtSignal
from PyQt6.QtGui import QIcon, QKeySequence, QPixmap, QShortcut
from PyQt6.QtWidgets import (
    QApplication,
    QDialog,
    QFrame,
    QGridLayout,
    QHBoxLayout,
    QLabel,
    QMessageBox,
    QPushButton,
    QScrollArea,
    QToolButton,
    QVBoxLayout,
    QWidget,
)

from GameSentenceMiner.ui import WindowId, window_state_manager
from GameSentenceMiner.util.config.configuration import (
    ffmpeg_base_command_list,
    get_config,
    get_ffprobe_path,
    logger,
)
from GameSentenceMiner.util.media import ffmpeg
from GameSentenceMiner.util.media.screenshot_selection import ScreenshotChoice, export_choices

FRAME_COUNT = 25
FRAME_INTERVAL = 0.5
THUMBNAIL_MIN_WIDTH = 280
_screenshot_selector_instance = None
_extra_dialogs = set()


def _relative(position, reference):
    return f"{position - reference:+.3f}s"


class FrameButton(QToolButton):
    def __init__(self):
        super().__init__()
        self.setToolButtonStyle(Qt.ToolButtonStyle.ToolButtonTextUnderIcon)
        self.setIconSize(QSize(THUMBNAIL_MIN_WIDTH, round(THUMBNAIL_MIN_WIDTH * 9 / 16)))
        self.setCheckable(True)
        self.setCursor(Qt.CursorShape.PointingHandCursor)
        self.setStyleSheet("QToolButton:checked { border: 2px solid #409ad6; background: #285575; color: white; }")

    def resizeEvent(self, event):
        super().resizeEvent(event)
        self.setIconSize(QSize(max(1, self.width() - 12), max(1, self.height() - 30)))


class FrameGrid(QScrollArea):
    """Keep frames readable; use fewer columns and scrolling in smaller windows."""

    def __init__(self, buttons):
        super().__init__()
        self.buttons = buttons
        self._layout_size = None
        self.setWidgetResizable(True)
        self.setFrameShape(QFrame.Shape.NoFrame)
        container = QWidget()
        self.grid = QGridLayout(container)
        self.grid.setContentsMargins(0, 0, 0, 0)
        self.grid.setSpacing(6)
        self.grid.setAlignment(Qt.AlignmentFlag.AlignTop | Qt.AlignmentFlag.AlignLeft)
        for index, button in enumerate(buttons):
            self.grid.addWidget(button, index // 5, index % 5)
            button.setVisible(True)
        self.setWidget(container)
        self.relayout()

    def resizeEvent(self, event):
        super().resizeEvent(event)
        self.relayout()

    def relayout(self):
        visible = [button for button in self.buttons if not button.isHidden()]
        gap = self.grid.spacing()
        minimum = THUMBNAIL_MIN_WIDTH + 12
        available = self.viewport().width()
        columns = max(1, min(5, (available + gap) // (minimum + gap)))
        width = max(minimum, (available - gap * (columns - 1)) // columns)
        size = (columns, width, len(visible))
        if size == self._layout_size:
            return
        self._layout_size = size
        for button in self.buttons:
            self.grid.removeWidget(button)
        height = round((width - 12) * 9 / 16) + 30
        for index, button in enumerate(visible):
            button.setFixedSize(width, height)
            self.grid.addWidget(button, index // columns, index % columns)


class FrameWorker(QThread):
    probed = pyqtSignal(int, float, float, str)
    frame_ready = pyqtSignal(int, int, float, str, str)
    exported = pyqtSignal(int, object, str)

    def __init__(self, session, source_path):
        super().__init__()
        self.session = session
        self.source_path = source_path
        self.directory = tempfile.mkdtemp(prefix="gsm-screenshot-selector-")
        self.jobs = PriorityQueue()
        self.sequence = itertools.count()
        self.cancelled = threading.Event()
        self.latest_generation = 0
        self.duration = 0.0
        self.fps = 30.0
        self.cache = OrderedDict()
        self.pinned = set()

    def stop(self):
        self.cancelled.set()
        self.jobs.put((-1, next(self.sequence), "stop", 0, None))

    def request_page(self, generation, positions):
        self.latest_generation = generation
        self.jobs.put((1, next(self.sequence), "page", generation, tuple(positions)))

    def request_export(self, choices):
        self.jobs.put((-2, next(self.sequence), "export", 0, choices))

    def pin(self, path):
        self.pinned.add(path)

    def unpin(self, path):
        self.pinned.discard(path)

    def _probe(self):
        command = [
            get_ffprobe_path(),
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "format=duration:stream=avg_frame_rate",
            "-of",
            "json",
            self.source_path,
        ]
        result = subprocess.run(command, capture_output=True, text=True, check=True, timeout=30)
        info = json.loads(result.stdout)
        self.duration = float(info["format"]["duration"])
        if not math.isfinite(self.duration) or self.duration <= 0:
            raise ValueError("The source recording has no video duration")
        for stream in info.get("streams", []):
            rate = stream.get("avg_frame_rate")
            if rate and rate != "0/0":
                self.fps = float(Fraction(rate))
                break
        if not math.isfinite(self.fps) or self.fps <= 0:
            self.fps = 30.0

    def _obsolete(self, generation):
        return self.cancelled.is_set() or generation != self.latest_generation

    def _run_batch(self, command, generation):
        if self._obsolete(generation):
            return None
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        started = time.monotonic()
        try:
            while not self._obsolete(generation):
                if time.monotonic() - started > 60:
                    raise subprocess.TimeoutExpired(command, 60)
                try:
                    stdout, stderr = process.communicate(timeout=0.1)
                    return subprocess.CompletedProcess(command, process.returncode, stdout, stderr)
                except subprocess.TimeoutExpired:
                    continue
            return None
        finally:
            if process.poll() is None:
                process.kill()
                process.communicate()

    def _extract_page(self, positions, generation):
        if not positions or self._obsolete(generation):
            return []
        keys = [round(position, 6) for position in positions]
        if all(key in self.cache and Path(self.cache[key][0]).is_file() for key in keys):
            for key in keys:
                self.cache.move_to_end(key)
            return [(self.cache[key][1], self.cache[key][0]) for key in keys]

        config = get_config().screenshot
        # Seek/decode once for the entire page, as in the original selector.
        # Sampling before crop/scale also limits expensive filters to 25 frames.
        crop = ffmpeg.find_black_bars(self.source_path, positions[0]) if config.trim_black_bars_wip else ""
        filters = [f"fps={1 / FRAME_INTERVAL:g}:start_time=0:round=up:eof_action=pass"]
        if crop:
            filters.append(crop)
        try:
            width, height = int(config.width or 0), int(config.height or 0)
        except (TypeError, ValueError):
            width, height = 0, 0
        if width > 0 and height > 0:
            filters.append(f"scale={width}:{height}:force_original_aspect_ratio=decrease")
        elif width > 0:
            filters.append(f"scale={width}:-2")
        elif height > 0:
            filters.append(f"scale=-2:{height}")
        prefix = uuid4().hex
        pattern = os.path.join(self.directory, f"{prefix}_%02d.png")
        paths = [Path(pattern % (index + 1)) for index in range(len(positions))]
        command = ffmpeg_base_command_list.copy()
        command += ["-y", "-ss", f"{positions[0]:.6f}", "-i", self.source_path, "-an"]
        command += [
            "-vf",
            ",".join(filters),
            "-frames:v",
            str(len(positions)),
            "-fps_mode",
            "vfr",
            "-compression_level",
            "1",
            "-threads",
            "2",
            pattern,
        ]
        kept = set()
        try:
            result = self._run_batch(command, generation)
            if result is None or self._obsolete(generation):
                return []
            if result.returncode or not all(path.is_file() for path in paths):
                raise RuntimeError(result.stderr[-1200:] or "Could not decode the requested frames")
            for key, position, path in zip(keys, positions, paths):
                if key not in self.cache or not Path(self.cache[key][0]).is_file():
                    self.cache[key] = (str(path), position)
                    kept.add(path)
                self.cache.move_to_end(key)
            self._trim_cache()
            return [(self.cache[key][1], self.cache[key][0]) for key in keys]
        finally:
            for path in paths:
                if path not in kept:
                    path.unlink(missing_ok=True)

    def _trim_cache(self):
        # Keep two pages in addition to every selected frame. Selected files must
        # never make the cache evict the new frame before the UI receives it.
        unpinned = [key for key, (path, _) in self.cache.items() if path not in self.pinned]
        for old_key in unpinned[: max(0, len(unpinned) - FRAME_COUNT * 2)]:
            old_path, _ = self.cache.pop(old_key)
            Path(old_path).unlink(missing_ok=True)

    def run(self):
        try:
            self._probe()
            self.probed.emit(self.session, self.duration, self.fps, "")
        except Exception as exc:  # noqa: BLE001 - surface probe errors to the dialog
            self.probed.emit(self.session, 0.0, 0.0, str(exc))
            return
        while not self.cancelled.is_set():
            _, _, kind, serial, data = self.jobs.get()
            if kind == "stop" or self.cancelled.is_set():
                break
            if kind == "export":
                try:
                    result = export_choices(self.source_path, data, self.duration, cancelled=self.cancelled.is_set)
                    self.exported.emit(self.session, result, "")
                except Exception as exc:  # noqa: BLE001 - keep the current note untouched
                    self.exported.emit(self.session, None, str(exc))
                continue
            if self._obsolete(serial):
                continue
            try:
                frames = self._extract_page(data, serial)
                for index, (position, path) in enumerate(frames):
                    if self._obsolete(serial):
                        break
                    self.frame_ready.emit(self.session, serial * FRAME_COUNT + index, position, path, "")
            except Exception as exc:  # noqa: BLE001 - report decoder failures to the dialog
                if not self._obsolete(serial):
                    for index, position in enumerate(data):
                        self.frame_ready.emit(self.session, serial * FRAME_COUNT + index, position, "", str(exc))


class ScreenshotSelectorDialog(QDialog):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setWindowTitle("Select Screenshot")
        self.setModal(True)
        self.setWindowFlags(Qt.WindowType.WindowStaysOnTopHint | Qt.WindowType.Dialog)
        self.setMinimumSize(720, 520)
        self.resize(1400, 900)
        self._first_launch = True
        self._active = False
        self._session = 0
        self._worker = None
        self._retired = []
        self.selected_result = None
        self._thumb_serial = 0
        self._thumb_data = {}
        self._frame_errors = set()
        self._choices = ()
        self._exporting = False
        self._duration = 0.0
        self._reference = 0.0
        self._mode = "beginning"
        self._page = 0
        self._first_frame_index = 0
        self._min_frame_index = 0
        self._max_frame_index = 0
        self._positions = []
        self._source_path = ""

        layout = QVBoxLayout(self)
        self.hint = QLabel()
        self.hint.setWordWrap(True)
        layout.addWidget(self.hint)

        navigation = QHBoxLayout()
        self.earlier = QPushButton("← Earlier 25 frames")
        self.earlier.clicked.connect(lambda: self._move_page(-1))
        navigation.addWidget(self.earlier)
        self.boundary = QLabel("Checking recording bounds…")
        self.boundary.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.boundary.setWordWrap(True)
        navigation.addWidget(self.boundary, 1)
        self.later = QPushButton("Later 25 frames →")
        self.later.clicked.connect(lambda: self._move_page(1))
        navigation.addWidget(self.later)
        self.reference_button = QPushButton("Return to default")
        self.reference_button.clicked.connect(self._return_to_default)
        navigation.addWidget(self.reference_button)
        layout.addLayout(navigation)

        self.thumbnails = []
        for index in range(FRAME_COUNT):
            button = FrameButton()
            button.clicked.connect(lambda checked=False, i=index: self._candidate_clicked(i))
            button.setEnabled(False)
            button.setText("Loading…")
            self.thumbnails.append(button)
        self.grid_area = FrameGrid(self.thumbnails)
        self.grid_widget = self.grid_area.widget()
        layout.addWidget(self.grid_area, 1)

        self.tray_area = QScrollArea()
        self.tray_area.setWidgetResizable(True)
        self.tray_area.setFixedHeight(90)
        self.tray_area.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.tray_widget = QWidget()
        self.tray_layout = QHBoxLayout(self.tray_widget)
        self.tray_layout.setContentsMargins(4, 4, 4, 4)
        self.tray_layout.setAlignment(Qt.AlignmentFlag.AlignLeft)
        self.tray_area.setWidget(self.tray_widget)
        layout.addWidget(self.tray_area)

        actions = QHBoxLayout()
        self.status = QLabel()
        actions.addWidget(self.status, 1)
        self.clear_selection = QPushButton("Clear selection")
        self.clear_selection.clicked.connect(self._clear_selection)
        actions.addWidget(self.clear_selection)
        self.finish = QPushButton("Use screenshots")
        self.finish.clicked.connect(self._finish_multiple)
        actions.addWidget(self.finish)
        cancel = QPushButton("Cancel")
        cancel.clicked.connect(self.reject)
        actions.addWidget(cancel)
        layout.addLayout(actions)
        # Window shortcuts also work while a frame or action button has focus.
        for key, direction in ((Qt.Key.Key_Left, -1), (Qt.Key.Key_Right, 1)):
            shortcut = QShortcut(QKeySequence(key), self)
            shortcut.activated.connect(lambda d=direction: self._move_page(d))
        self._render_selection()
        self._update_navigation()

    def prepare_selection(self, source_path, timestamp, mode="beginning"):
        if not source_path or not Path(source_path).is_file():
            return False
        self._stop_worker()
        self._session += 1
        self._active = True
        self.selected_result = None
        self._source_path = str(source_path)
        self._duration = 0.0
        self._reference = max(0.0, float(timestamp))
        self._mode = mode
        self._page = 0
        self._choices = ()
        self._positions = []
        self._thumb_serial = 0
        self._thumb_data.clear()
        self._frame_errors.clear()
        self._exporting = False
        for button in self.thumbnails:
            button.setEnabled(False)
            button.setVisible(True)
            button.setIcon(QIcon())
            button.setText("Loading…")
            button.setToolTip("")
        self._render_selection()
        self._update_navigation()
        self.status.setText("Loading recording…")
        self.boundary.setText("Checking recording bounds…")
        self._worker = FrameWorker(self._session, self._source_path)
        self._worker.finished.connect(lambda worker=self._worker: self._cleanup_worker(worker))
        self._worker.probed.connect(self._on_probed)
        self._worker.frame_ready.connect(self._on_frame)
        self._worker.exported.connect(self._on_exported)
        self._worker.start()
        return True

    def _stop_worker(self):
        if self._worker:
            worker = self._worker
            self._worker = None
            worker.stop()
            self._retired.append(worker)
            if worker.isFinished():
                self._cleanup_worker(worker)

    def _cleanup_worker(self, worker):
        shutil.rmtree(worker.directory, ignore_errors=True)
        if worker in self._retired:
            self._retired.remove(worker)
        if self is not _screenshot_selector_instance and not self._active and not self._retired:
            _extra_dialogs.discard(self)

    def _on_probed(self, session, duration, fps, error):
        if session != self._session or not self._active:
            return
        if error:
            QMessageBox.critical(self, "Screenshot selector", f"Could not read recording: {error}")
            self.reject()
            return
        self._duration = duration
        last_frame = max(0.0, duration - 1 / fps)
        self._reference = min(self._reference, last_frame)
        # Anchor the half-second sampling to the default screenshot so it is
        # always available, including when its timestamp is between samples.
        self._min_frame_index = math.ceil(-self._reference / FRAME_INTERVAL)
        self._max_frame_index = math.floor((last_frame - self._reference) / FRAME_INTERVAL + 1e-9)
        offset = {"beginning": 0, "middle": FRAME_COUNT // 2, "end": FRAME_COUNT - 1}.get(self._mode, 0)
        self._first_frame_index = max(self._min_frame_index, min(-offset, self._max_frame_index - FRAME_COUNT + 1))
        self._page = 0
        self._refresh_thumbnails()

    def _positions_for_page(self, page):
        first = self._first_frame_index + page * FRAME_COUNT
        return [
            self._reference + index * FRAME_INTERVAL
            for index in range(max(first, self._min_frame_index), min(first + FRAME_COUNT, self._max_frame_index + 1))
        ]

    def _update_navigation(self):
        ready = self._duration > 0 and not self._exporting
        self.earlier.setEnabled(ready and bool(self._positions_for_page(self._page - 1)))
        self.later.setEnabled(ready and bool(self._positions_for_page(self._page + 1)))
        self.reference_button.setEnabled(ready and self._page != 0)

    def _move_page(self, direction):
        if self._exporting or self._duration <= 0 or not self._positions_for_page(self._page + direction):
            return
        self._page += direction
        self._refresh_thumbnails()

    def _return_to_default(self):
        if not self._exporting and self._duration > 0 and self._page != 0:
            self._page = 0
            self._refresh_thumbnails()

    def _refresh_thumbnails(self):
        if not self._worker or self._duration <= 0:
            return
        self._thumb_serial += 1
        self._thumb_data.clear()
        self._frame_errors.clear()
        self._positions = self._positions_for_page(self._page)
        for index, button in enumerate(self.thumbnails):
            button.setEnabled(False)
            button.setChecked(False)
            button.setIcon(QIcon())
            button.setToolTip("")
            button.setVisible(index < len(self._positions))
            if index < len(self._positions):
                position = self._positions[index]
                button.setText(_relative(position, self._reference))
        self.grid_area.relayout()
        self.grid_area.verticalScrollBar().setValue(0)
        self._worker.request_page(self._thumb_serial, self._positions)
        self._update_navigation()
        bounds = []
        if not self._positions_for_page(self._page - 1):
            bounds.append("Beginning of recording")
        if not self._positions_for_page(self._page + 1):
            bounds.append("End of recording")
        self.boundary.setText(
            f"{_relative(self._positions[0], self._reference)} to {_relative(self._positions[-1], self._reference)}"
            + ("\n" + " · ".join(bounds) if bounds else "\n0.5 seconds between frames")
        )
        self._update_status()

    def _on_frame(self, session, serial, position, path, error):
        if session != self._session or not self._active or serial // FRAME_COUNT != self._thumb_serial:
            return
        index = serial % FRAME_COUNT
        if index >= len(self._positions):
            return
        button = self.thumbnails[index]
        if error:
            self._frame_errors.add(index)
            button.setText(f"{_relative(position, self._reference)}\nUnavailable")
            button.setToolTip(error)
        else:
            self._thumb_data[index] = ScreenshotChoice(position, path)
            button.setIcon(QIcon(QPixmap(path)))
            button.setToolTip("Click to use this screenshot; Ctrl/Shift-click to select several")
            self._update_thumbnail(index)
        self._update_status()

    def _update_thumbnail(self, index):
        button = self.thumbnails[index]
        choice = self._thumb_data.get(index)
        selected = next((i + 1 for i, item in enumerate(self._choices) if choice and item.key() == choice.key()), 0)
        button.setChecked(bool(selected))
        button.setEnabled(choice is not None and not self._exporting)
        if choice:
            label = _relative(choice.start, self._reference)
            if abs(self._positions[index] - self._reference) < 1e-6:
                label = f"Default · {label}"
            button.setText(f"{selected}. {label}" if selected else label)

    def _candidate_clicked(self, index):
        choice = self._thumb_data.get(index)
        if not choice or self._exporting or not self._worker:
            return
        modifiers = QApplication.keyboardModifiers()
        collecting = bool(modifiers & (Qt.KeyboardModifier.ControlModifier | Qt.KeyboardModifier.ShiftModifier))
        if collecting or self._choices:
            selected = next((i for i, item in enumerate(self._choices) if item.key() == choice.key()), None)
            if selected is not None:
                self._remove_choice(selected)
            else:
                self._choices = (*self._choices, choice)
                self._worker.pin(choice.preview_path)
                self._render_selection()
        else:
            self._start_export((choice,))

    def _render_selection(self):
        while self.tray_layout.count():
            item = self.tray_layout.takeAt(0)
            if item.widget():
                item.widget().hide()
                item.widget().deleteLater()
        for index, choice in enumerate(self._choices):
            card = QFrame()
            row = QHBoxLayout(card)
            row.setContentsMargins(4, 4, 4, 4)
            image = QLabel()
            image.setPixmap(QPixmap(choice.preview_path).scaled(80, 45, Qt.AspectRatioMode.KeepAspectRatio))
            row.addWidget(image)
            row.addWidget(QLabel(f"{index + 1}. {_relative(choice.start, self._reference)}"))
            remove = QPushButton("Remove")
            remove.setAutoDefault(False)
            remove.setEnabled(not self._exporting)
            remove.clicked.connect(lambda checked=False, i=index: self._remove_choice(i))
            row.addWidget(remove)
            self.tray_layout.addWidget(card)
        for index in range(FRAME_COUNT):
            self._update_thumbnail(index)
        count = len(self._choices)
        self.tray_area.setVisible(count > 0)
        self.clear_selection.setVisible(count > 0)
        self.clear_selection.setEnabled(count > 0 and not self._exporting)
        self.finish.setVisible(count > 0)
        self.finish.setText(f"Use {count} screenshot{'s' if count != 1 else ''}")
        self.finish.setEnabled(count > 0 and not self._exporting)
        self.hint.setText(
            "Click frames to add or remove them, then use the selected screenshots. ← / → browse more frames."
            if count
            else "Click a frame to use it. Ctrl/Shift-click to select several. ← / → browse 25 frames at a time."
        )
        self._update_status()

    def _update_status(self):
        if self._exporting:
            return
        parts = [f"{len(self._choices)} selected"] if self._choices else []
        loaded = len(self._thumb_data) + len(self._frame_errors)
        if loaded < len(self._positions):
            parts.append(f"Loading frames… {loaded}/{len(self._positions)}")
        if self._frame_errors:
            parts.append(f"{len(self._frame_errors)} frame(s) unavailable")
        self.status.setText(" · ".join(parts))

    def _remove_choice(self, index):
        if self._exporting:
            return
        removed = self._choices[index]
        self._choices = self._choices[:index] + self._choices[index + 1 :]
        if self._worker and all(item.preview_path != removed.preview_path for item in self._choices):
            self._worker.unpin(removed.preview_path)
        self._render_selection()

    def _clear_selection(self):
        if self._exporting:
            return
        if self._worker:
            for choice in self._choices:
                self._worker.unpin(choice.preview_path)
        self._choices = ()
        self._render_selection()

    def _finish_multiple(self):
        if self._choices:
            self._start_export(self._choices)

    def _start_export(self, choices):
        if not self._worker or self._exporting:
            return
        self._exporting = True
        self._render_selection()
        self._update_navigation()
        self.status.setText(f"Exporting {len(choices)} screenshot(s)…")
        self._worker.request_export(choices)

    def _on_exported(self, session, result, error):
        if session != self._session or not self._active:
            return
        self._exporting = False
        if error:
            logger.error(f"Screenshot selection export failed: {error}")
            QMessageBox.critical(
                self,
                "Screenshot export failed",
                f"The note was not changed. Check the recording and export settings, then retry.\n\n{error}",
            )
            self._render_selection()
            self._update_navigation()
            self.status.setText("Export failed; choose or retry")
            return
        self.selected_result = result
        self.accept()

    def showEvent(self, event):
        if self._first_launch:
            if not window_state_manager.restore_geometry(self, WindowId.SCREENSHOT_SELECTOR):
                screen = QApplication.primaryScreen()
                if screen:
                    available = screen.availableGeometry()
                    self.resize(round(available.width() * 0.9), round(available.height() * 0.9))
                    self.move(available.center() - self.rect().center())
            self._first_launch = False
        super().showEvent(event)

    def done(self, result):
        self._active = False
        if result != QDialog.DialogCode.Accepted:
            self.selected_result = None
            self._choices = ()
        self._stop_worker()
        window_state_manager.save_geometry(self, WindowId.SCREENSHOT_SELECTOR)
        super().done(result)


def show_screenshot_selector(parent, video_path, timestamp, mode="beginning", on_complete=None):
    """Return an ordered exported collection, or None on cancellation."""
    global _screenshot_selector_instance
    if QApplication.instance() is None:
        QApplication(sys.argv)
    if _screenshot_selector_instance is None:
        _screenshot_selector_instance = ScreenshotSelectorDialog(parent)
    # Nested GUI requests must keep each recording and its results isolated.
    dialog = (
        ScreenshotSelectorDialog(parent) if _screenshot_selector_instance._active else _screenshot_selector_instance
    )
    if dialog is not _screenshot_selector_instance:
        _extra_dialogs.add(dialog)
    result = None
    try:
        if dialog.prepare_selection(video_path, timestamp, mode):
            if dialog.exec() == QDialog.DialogCode.Accepted:
                result = dialog.selected_result
        else:
            QMessageBox.critical(parent, "Screenshot selector", "The source recording is unavailable.")
    finally:
        if dialog is not _screenshot_selector_instance and not dialog._active and not dialog._retired:
            _extra_dialogs.discard(dialog)
        if on_complete:
            on_complete(result)
    return result
