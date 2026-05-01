"""Qt window listing the batch-review queue.

Each row in the queue corresponds to a card that was auto-accepted into Anki
using the VAD outcome at capture time and snapshotted for later review.
This window lets the user re-open the standard Anki confirmation dialog for
any entry, approve as-is, or discard it.

The window itself is a singleton on the Qt main thread; review actions are
dispatched onto background threads so the modal confirmation dialog (which
blocks via ``exec()``) does not block the rest of the UI.
"""

from __future__ import annotations

import datetime as _dt
import threading

from PyQt6.QtCore import Qt, QTimer, pyqtSignal
from PyQt6.QtGui import QIcon, QPixmap
from PyQt6.QtWidgets import (
    QApplication,
    QHBoxLayout,
    QLabel,
    QListWidget,
    QListWidgetItem,
    QMainWindow,
    QMessageBox,
    QPushButton,
    QSplitter,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)

from GameSentenceMiner.ui import WindowId, window_state_manager
from GameSentenceMiner.util import pending_reviews
from GameSentenceMiner.util.config.configuration import logger
from GameSentenceMiner.util.database.pending_reviews_table import PendingReviewsTable


_ENTRY_ROLE = Qt.ItemDataRole.UserRole + 1
_REFRESH_INTERVAL_MS = 5000

_pending_reviews_window_instance: "PendingReviewsWindow | None" = None


def _format_timestamp(ts: float) -> str:
    if not ts:
        return ""
    try:
        return _dt.datetime.fromtimestamp(ts).strftime("%H:%M:%S")
    except (OverflowError, OSError, ValueError):
        return ""


def _entry_label(row: PendingReviewsTable) -> str:
    bits = [_format_timestamp(row.created_at) or "?"]
    if row.expression:
        bits.append(row.expression)
    if row.game:
        bits.append(row.game)
    preview = (row.sentence_preview or "").strip()
    if preview:
        if len(preview) > 60:
            preview = preview[:59] + "\u2026"
        bits.append(preview)
    label = " · ".join(bits)
    if row.status != pending_reviews.STATUS_PENDING:
        label = f"[{row.status}] {label}"
    return label


class PendingReviewsWindow(QMainWindow):
    """Singleton window listing pending batch-review entries."""

    _refresh_signal = pyqtSignal()

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setWindowTitle("GSM — Pending Reviews")
        self.resize(900, 520)
        try:
            from GameSentenceMiner.util.gsm_utils import get_pickaxe_png_path

            self.setWindowIcon(QIcon(get_pickaxe_png_path()))
        except Exception:
            pass

        self._build_ui()

        # Periodic refresh in case other threads enqueue or finalize entries.
        self._refresh_timer = QTimer(self)
        self._refresh_timer.setInterval(_REFRESH_INTERVAL_MS)
        self._refresh_timer.timeout.connect(self.refresh)
        self._refresh_timer.start()

        self._refresh_signal.connect(self.refresh)

        window_state_manager.restore_geometry(self, WindowId.PENDING_REVIEWS)
        self.refresh()

    # ----- UI construction -------------------------------------------------

    def _build_ui(self) -> None:
        central = QWidget(self)
        outer = QVBoxLayout(central)
        outer.setContentsMargins(8, 8, 8, 8)

        self._header = QLabel("0 cards waiting for review")
        outer.addWidget(self._header)

        splitter = QSplitter(Qt.Orientation.Horizontal, central)
        outer.addWidget(splitter, 1)

        # Left: list
        left = QWidget(splitter)
        left_layout = QVBoxLayout(left)
        left_layout.setContentsMargins(0, 0, 0, 0)
        self._list = QListWidget(left)
        self._list.itemSelectionChanged.connect(self._on_selection_changed)
        left_layout.addWidget(self._list, 1)
        splitter.addWidget(left)

        # Right: detail
        right = QWidget(splitter)
        right_layout = QVBoxLayout(right)
        right_layout.setContentsMargins(8, 0, 0, 0)

        self._detail_header = QLabel("")
        self._detail_header.setWordWrap(True)
        right_layout.addWidget(self._detail_header)

        self._screenshot_label = QLabel()
        self._screenshot_label.setMinimumHeight(180)
        self._screenshot_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self._screenshot_label.setStyleSheet("background-color: #111;")
        right_layout.addWidget(self._screenshot_label, 1)

        self._sentence_view = QTextEdit()
        self._sentence_view.setReadOnly(True)
        self._sentence_view.setMaximumHeight(120)
        right_layout.addWidget(self._sentence_view)

        button_row = QHBoxLayout()
        self._review_btn = QPushButton("Review…")
        self._review_btn.clicked.connect(self._on_review_clicked)
        self._approve_btn = QPushButton("Approve as-is")
        self._approve_btn.clicked.connect(self._on_approve_clicked)
        self._discard_btn = QPushButton("Discard")
        self._discard_btn.clicked.connect(self._on_discard_clicked)
        for b in (self._review_btn, self._approve_btn, self._discard_btn):
            b.setEnabled(False)
            button_row.addWidget(b)
        button_row.addStretch(1)
        right_layout.addLayout(button_row)

        splitter.addWidget(right)
        splitter.setStretchFactor(0, 2)
        splitter.setStretchFactor(1, 3)

        self.setCentralWidget(central)

    # ----- refresh / selection --------------------------------------------

    def refresh(self) -> None:
        try:
            rows = pending_reviews.list_active()
        except Exception:
            logger.exception("Pending Reviews: failed to load rows")
            rows = []

        self._header.setText(f"{len(rows)} cards waiting for review")

        # Preserve selection if possible
        current_id = self._selected_entry_id()
        self._list.blockSignals(True)
        self._list.clear()
        for row in rows:
            item = QListWidgetItem(_entry_label(row))
            item.setData(_ENTRY_ROLE, row.entry_id)
            if row.status == pending_reviews.STATUS_FAILED:
                item.setForeground(Qt.GlobalColor.red)
            self._list.addItem(item)
        self._list.blockSignals(False)

        if current_id:
            for i in range(self._list.count()):
                if self._list.item(i).data(_ENTRY_ROLE) == current_id:
                    self._list.setCurrentRow(i)
                    break
        elif self._list.count() > 0:
            self._list.setCurrentRow(0)
        else:
            self._clear_detail()

    def _selected_entry_id(self) -> str | None:
        item = self._list.currentItem()
        if item is None:
            return None
        return item.data(_ENTRY_ROLE)

    def _selected_row(self) -> PendingReviewsTable | None:
        entry_id = self._selected_entry_id()
        if not entry_id:
            return None
        return pending_reviews.get(entry_id)

    def _on_selection_changed(self) -> None:
        row = self._selected_row()
        if row is None:
            self._clear_detail()
            return
        is_pending = row.status == pending_reviews.STATUS_PENDING
        self._review_btn.setEnabled(is_pending)
        self._approve_btn.setEnabled(is_pending)
        self._discard_btn.setEnabled(True)

        header_bits = []
        if row.expression:
            header_bits.append(f"<b>{row.expression}</b>")
        if row.game:
            header_bits.append(row.game)
        if row.status != pending_reviews.STATUS_PENDING:
            header_bits.append(f"<i>status: {row.status}</i>")
        if row.failure_reason:
            header_bits.append(f"<span style='color:#c33'>{row.failure_reason}</span>")
        self._detail_header.setText("<br/>".join(header_bits) or "—")

        self._sentence_view.setPlainText(row.sentence_preview or "")

        ss_path = row.screenshot_path or ""
        if ss_path:
            pix = QPixmap(ss_path)
            if not pix.isNull():
                self._screenshot_label.setPixmap(
                    pix.scaled(
                        self._screenshot_label.size(),
                        Qt.AspectRatioMode.KeepAspectRatio,
                        Qt.TransformationMode.SmoothTransformation,
                    )
                )
            else:
                self._screenshot_label.setText("(screenshot not available)")
        else:
            self._screenshot_label.clear()
            self._screenshot_label.setText("(no screenshot)")

    def _clear_detail(self) -> None:
        self._detail_header.setText("Select an entry to review")
        self._sentence_view.clear()
        self._screenshot_label.clear()
        for b in (self._review_btn, self._approve_btn, self._discard_btn):
            b.setEnabled(False)

    # ----- actions ---------------------------------------------------------

    def _on_review_clicked(self) -> None:
        entry_id = self._selected_entry_id()
        if not entry_id:
            return
        # Disable buttons during the (modal) review.
        for b in (self._review_btn, self._approve_btn, self._discard_btn):
            b.setEnabled(False)

        def _worker():
            try:
                pending_reviews.start_review_with_dialog(entry_id)
            except Exception:
                logger.exception("Review worker crashed")
            finally:
                # Refresh on the GUI thread.
                self._refresh_signal.emit()

        threading.Thread(target=_worker, daemon=True, name="PendingReviewWorker").start()

    def _on_approve_clicked(self) -> None:
        entry_id = self._selected_entry_id()
        if not entry_id:
            return
        try:
            pending_reviews.approve_as_is(entry_id)
        except Exception:
            logger.exception("approve_as_is failed")
        self.refresh()

    def _on_discard_clicked(self) -> None:
        entry_id = self._selected_entry_id()
        if not entry_id:
            return
        confirm = QMessageBox.question(
            self,
            "Discard pending review?",
            "The Anki note keeps its auto-applied media. Snapshot files will be deleted. Continue?",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
            QMessageBox.StandardButton.No,
        )
        if confirm != QMessageBox.StandardButton.Yes:
            return
        try:
            pending_reviews.discard(entry_id, cleanup_files=True)
        except Exception:
            logger.exception("discard failed")
        self.refresh()

    # ----- lifecycle -------------------------------------------------------

    def closeEvent(self, event) -> None:  # noqa: N802 (Qt naming)
        try:
            window_state_manager.save_geometry(self, WindowId.PENDING_REVIEWS)
        except Exception:
            logger.exception("Failed to save Pending Reviews window geometry")
        super().closeEvent(event)


def get_pending_reviews_window(parent: QWidget | None = None) -> PendingReviewsWindow:
    global _pending_reviews_window_instance
    if _pending_reviews_window_instance is not None:
        try:
            _ = _pending_reviews_window_instance.isVisible()
        except RuntimeError:
            _pending_reviews_window_instance = None
    if _pending_reviews_window_instance is None:
        _pending_reviews_window_instance = PendingReviewsWindow(parent)
        _pending_reviews_window_instance.setAttribute(Qt.WidgetAttribute.WA_DeleteOnClose, False)
    return _pending_reviews_window_instance


def show_pending_reviews_window() -> None:
    """Show / raise the Pending Reviews window. Must be called on the Qt main thread."""
    app = QApplication.instance()
    if app is None:
        logger.error("show_pending_reviews_window: no QApplication available")
        return
    window = get_pending_reviews_window()
    window.refresh()
    window.show()
    window.raise_()
    window.activateWindow()
