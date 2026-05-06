from __future__ import annotations

from PyQt6.QtCore import QEvent, QObject, QTimer
from PyQt6.QtGui import QCursor, QFont
from PyQt6.QtWidgets import QApplication, QToolTip, QWidget


class FastTooltipEventFilter(QObject):
    """
    Application-level event filter that makes tooltips appear near-instantly.

    Works by intercepting Enter/Leave/ToolTip events and showing the tooltip
    via ``QToolTip.showText`` directly, bypassing Qt's internal wake-up timer.
    This is immune to style/theme overrides (e.g. qdarktheme).
    """

    DELAY_MS = 0  # ms before showing tooltip (0 = truly instant)

    def __init__(self, parent: QObject | None = None) -> None:
        super().__init__(parent)
        self._timer = QTimer(self)
        self._timer.setSingleShot(True)
        self._timer.setInterval(self.DELAY_MS)
        self._timer.timeout.connect(self._show_pending_tooltip)
        self._pending_widget: QWidget | None = None

    # ------------------------------------------------------------------
    def _show_pending_tooltip(self) -> None:
        widget = self._pending_widget
        if widget is not None and widget.underMouse():
            tip = widget.toolTip()
            if tip:
                QToolTip.showText(QCursor.pos(), tip, widget)

    # ------------------------------------------------------------------
    def eventFilter(self, obj: QObject, event: QEvent) -> bool:  # noqa: N802
        etype = event.type()

        if etype == QEvent.Type.Enter:
            if isinstance(obj, QWidget) and obj.toolTip():
                self._pending_widget = obj
                self._timer.start()

        elif etype == QEvent.Type.Leave:
            if obj is self._pending_widget:
                self._timer.stop()
                self._pending_widget = None

        elif etype == QEvent.Type.ToolTip:
            # Suppress Qt's default (delayed) tooltip and show ours immediately
            if isinstance(obj, QWidget) and obj.toolTip():
                self._pending_widget = obj
                self._show_pending_tooltip()
                return True  # consume the event

        return False


# Tooltip stylesheet fragment — appended to the app stylesheet after theme setup.
TOOLTIP_STYLESHEET = """
QToolTip {
    font-size: 12pt;
    padding: 6px 8px;
    border-radius: 4px;
}
"""


def configure_tooltip_appearance(font_size: int = 12) -> None:
    """
    Set a larger, more readable font for all tooltips application-wide.

    * ``QToolTip.setFont`` – static Qt call, immune to stylesheet overrides.
    * Appends ``TOOLTIP_STYLESHEET`` to the QApplication stylesheet so the size
      is also reflected when qdarktheme re-applies its own sheet.

    Call this once *after* ``qdarktheme.setup_theme()`` so it wins.
    """
    font = QFont()
    font.setPointSize(font_size)
    QToolTip.setFont(font)

    app = QApplication.instance()
    if app is not None:
        existing = app.styleSheet() or ""
        if TOOLTIP_STYLESHEET not in existing:
            app.setStyleSheet(existing + TOOLTIP_STYLESHEET)
