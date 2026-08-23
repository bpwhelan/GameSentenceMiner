from PyQt6.QtCore import QRect

from GameSentenceMiner.ui import WindowStateManager


class _WindowProbe:
    def __init__(self, geometry: QRect) -> None:
        self._geometry = QRect(geometry)
        self.resize_calls = []
        self.move_calls = []

    def geometry(self) -> QRect:
        return QRect(self._geometry)

    def resize(self, size) -> None:
        self.resize_calls.append(size)

    def move(self, point) -> None:
        self.move_calls.append(point)


def test_ensure_geometry_visible_recovers_reused_window_after_monitor_change(tmp_path, monkeypatch):
    manager = WindowStateManager(str(tmp_path / "window-layout.json"))
    stale_geometry = QRect(2200, 100, 900, 700)
    recovered_geometry = QRect(100, 50, 900, 700)
    window = _WindowProbe(stale_geometry)
    monkeypatch.setattr(manager, "_fit_rect_to_screens", lambda _rect: recovered_geometry)

    assert manager.ensure_geometry_visible(window) is True
    assert window.resize_calls == [recovered_geometry.size()]
    assert window.move_calls == [recovered_geometry.topLeft()]
