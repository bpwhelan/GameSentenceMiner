from __future__ import annotations

from types import SimpleNamespace

from GameSentenceMiner.ui.config_gui_qt import ConfigWindow


class _FakeConfigWindow:
    def __init__(self, minimized: bool) -> None:
        self._minimized = minimized
        self.calls: list[object] = []

    def isMinimized(self) -> bool:
        return self._minimized

    def reload_settings(self) -> None:
        self.calls.append("reload_settings")

    def navigate_to_settings_tab(self, root_tab_key: str, subtab_key: str) -> None:
        self.calls.append(("navigate_to_settings_tab", root_tab_key, subtab_key))

    def showNormal(self) -> None:
        self.calls.append("showNormal")

    def show(self) -> None:
        self.calls.append("show")

    def raise_(self) -> None:
        self.calls.append("raise_")

    def activateWindow(self) -> None:
        self.calls.append("activateWindow")


def test_show_window_impl_restores_minimized_window(monkeypatch) -> None:
    monkeypatch.setattr(
        "GameSentenceMiner.ui.config_gui_qt.logger",
        SimpleNamespace(info=lambda *_args, **_kwargs: None),
    )
    monkeypatch.setattr(
        "GameSentenceMiner.ui.config_gui_qt.obs",
        SimpleNamespace(update_current_game=lambda: None),
    )
    monkeypatch.setattr(
        "GameSentenceMiner.ui.config_gui_qt.QApplication",
        SimpleNamespace(processEvents=lambda: None),
    )
    monkeypatch.setattr(
        ConfigWindow,
        "_force_windows_foreground",
        lambda self: self.calls.append("force_windows_foreground"),
    )
    window = _FakeConfigWindow(minimized=True)

    ConfigWindow._show_window_impl(window, "advanced", "overlay")

    assert window.calls == [
        "reload_settings",
        ("navigate_to_settings_tab", "advanced", "overlay"),
        "showNormal",
        "raise_",
        "activateWindow",
        "force_windows_foreground",
    ]


def test_show_window_impl_shows_non_minimized_window(monkeypatch) -> None:
    monkeypatch.setattr(
        "GameSentenceMiner.ui.config_gui_qt.logger",
        SimpleNamespace(info=lambda *_args, **_kwargs: None),
    )
    monkeypatch.setattr(
        "GameSentenceMiner.ui.config_gui_qt.obs",
        SimpleNamespace(update_current_game=lambda: None),
    )
    monkeypatch.setattr(
        "GameSentenceMiner.ui.config_gui_qt.QApplication",
        SimpleNamespace(processEvents=lambda: None),
    )
    monkeypatch.setattr(
        ConfigWindow,
        "_force_windows_foreground",
        lambda self: self.calls.append("force_windows_foreground"),
    )
    window = _FakeConfigWindow(minimized=False)

    ConfigWindow._show_window_impl(window, "advanced", "overlay")

    assert window.calls == [
        "reload_settings",
        ("navigate_to_settings_tab", "advanced", "overlay"),
        "show",
        "raise_",
        "activateWindow",
        "force_windows_foreground",
    ]
