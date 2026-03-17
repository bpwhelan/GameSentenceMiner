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


class _FakeCheckbox:
    def __init__(self, checked: bool) -> None:
        self._checked = checked

    def isChecked(self) -> bool:
        return self._checked


class _FakeLineEdit:
    def __init__(self, text: str = "") -> None:
        self._text = text
        self.enabled: bool | None = None

    def text(self) -> str:
        return self._text

    def setText(self, text: str) -> None:
        self._text = text

    def setEnabled(self, enabled: bool) -> None:
        self.enabled = enabled


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


def test_sync_auto_accept_timer_controls_disables_editor_when_toggle_off() -> None:
    window = SimpleNamespace(
        auto_accept_timer_enabled_check=_FakeCheckbox(False),
        auto_accept_timer_edit=_FakeLineEdit("12"),
    )

    ConfigWindow._sync_auto_accept_timer_controls(window)

    assert window.auto_accept_timer_edit.text() == "12"
    assert window.auto_accept_timer_edit.enabled is False


def test_sync_auto_accept_timer_controls_restores_default_when_enabled_from_zero() -> None:
    window = SimpleNamespace(
        auto_accept_timer_enabled_check=_FakeCheckbox(True),
        auto_accept_timer_edit=_FakeLineEdit("0"),
    )

    ConfigWindow._sync_auto_accept_timer_controls(window)

    assert window.auto_accept_timer_edit.text() == "10"
    assert window.auto_accept_timer_edit.enabled is True


def test_get_auto_accept_timer_value_returns_zero_when_toggle_off() -> None:
    window = SimpleNamespace(
        auto_accept_timer_enabled_check=_FakeCheckbox(False),
        auto_accept_timer_edit=_FakeLineEdit("25"),
    )

    assert ConfigWindow._get_auto_accept_timer_value(window) == 0


def test_get_auto_accept_timer_value_uses_default_when_enabled_without_value() -> None:
    window = SimpleNamespace(
        auto_accept_timer_enabled_check=_FakeCheckbox(True),
        auto_accept_timer_edit=_FakeLineEdit("0"),
    )

    assert ConfigWindow._get_auto_accept_timer_value(window) == 10
