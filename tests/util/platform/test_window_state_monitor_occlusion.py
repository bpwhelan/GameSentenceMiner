import importlib
import sys
from types import SimpleNamespace

import pytest


pytestmark = pytest.mark.skipif(sys.platform != "win32", reason="Windows-only window occlusion APIs")
wwm = (
    importlib.import_module("GameSentenceMiner.util.platform.windows_window_monitor")
    if sys.platform == "win32"
    else None
)


def make_monitor(monkeypatch, title, executable, *, other_cover=False):
    monitor = wwm.WindowsWindowStateMonitor.__new__(wwm.WindowsWindowStateMonitor)
    monkeypatch.setattr(monitor, "_get_window_class", lambda hwnd: "Chrome_WidgetWin_1")
    monkeypatch.setattr(monitor, "_get_window_title", lambda hwnd: title if hwnd == 2 else "Other application")
    monkeypatch.setattr(monitor, "_get_window_exe_name", lambda hwnd: executable if hwnd == 2 else "code.exe")
    next_window = {1: 2, 2: 3 if other_cover else 0, 3: 0}
    monkeypatch.setattr(
        wwm,
        "user32",
        SimpleNamespace(GetWindow=lambda hwnd, _direction: next_window[hwnd], IsWindowVisible=lambda _hwnd: True),
    )
    monkeypatch.setattr(wwm, "get_window_rect_physical", lambda _hwnd: (0, 0, 1920, 1080))
    return monitor


@pytest.mark.parametrize("executable", ["GameSentenceMiner.exe", "electron.exe", "gsm_overlay.exe"])
@pytest.mark.parametrize("title", ["GSM Texthooker", "GSM TextFeed", "GSM Text Feed"])
def test_installed_textfeed_window_does_not_obscure_the_game(monkeypatch, title, executable):
    monitor = make_monitor(monkeypatch, title, executable)
    assert monitor._is_overlay_window(2) is True
    assert monitor._is_window_obscured(1) is False


@pytest.mark.parametrize(
    ("title", "executable"),
    [
        ("GSM TextFeed", "chrome.exe"),
        ("GSM TextFeed", "msedge.exe"),
        ("GSM TextFeed", "discord.exe"),
        ("Unrelated Electron application", "electron.exe"),
        ("GameSentenceMiner", "GameSentenceMiner.exe"),
    ],
)
def test_other_applications_still_obscure_the_game(monkeypatch, title, executable):
    monitor = make_monitor(monkeypatch, title, executable)
    assert monitor._is_overlay_window(2) is False
    assert monitor._is_window_obscured(1) is True


def test_textfeed_exclusion_does_not_mask_another_covering_window(monkeypatch):
    monitor = make_monitor(monkeypatch, "GSM TextFeed", "GameSentenceMiner.exe", other_cover=True)
    assert monitor._is_window_obscured(1) is True
