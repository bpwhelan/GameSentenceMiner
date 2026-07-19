import sys

import pytest


if sys.platform != "win32":
    pytest.skip("Windows window monitor behavior", allow_module_level=True)

from GameSentenceMiner.util.platform import windows_window_monitor


def test_client_click_position_is_converted_to_screen_coordinates(monkeypatch):
    monkeypatch.setattr(
        windows_window_monitor,
        "get_window_client_physical_geometry",
        lambda _hwnd: (320, 180, 1280, 720),
    )

    monitor = windows_window_monitor.WindowsWindowStateMonitor.__new__(windows_window_monitor.WindowsWindowStateMonitor)

    assert monitor._get_client_screen_position(1234, 8, 8) == (328, 188)
