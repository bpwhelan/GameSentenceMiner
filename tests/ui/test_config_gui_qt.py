from __future__ import annotations

import os
from types import SimpleNamespace

from PyQt6.QtCore import QEvent, Qt
from PyQt6.QtGui import QKeyEvent, QKeySequence
from PyQt6.QtWidgets import QApplication, QCheckBox, QMessageBox

from GameSentenceMiner.ui.config_gui_qt import ClearableKeySequenceEdit, ConfigWindow
from GameSentenceMiner.util.config.configuration import Locale


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


class _FakeProfileCombo:
    def __init__(self, text: str) -> None:
        self._text = text

    def currentText(self) -> str:
        return self._text


class _FakeDeleteButton:
    def __init__(self) -> None:
        self.hidden: bool | None = None

    def setHidden(self, hidden: bool) -> None:
        self.hidden = hidden


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


def test_process_pausing_saved_enabled_state_loads_without_warning() -> None:
    os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    app = QApplication.instance() or QApplication([])
    warning_calls = []
    checkbox = QCheckBox()
    window = SimpleNamespace(
        process_pausing_enabled_check=checkbox,
        _show_game_pausing_warning=lambda: warning_calls.append(True) or False,
    )
    checkbox.stateChanged.connect(lambda state: ConfigWindow._handle_game_pausing_toggle(window, state))

    try:
        ConfigWindow._set_process_pausing_enabled_from_config(window, True)

        assert checkbox.isChecked() is True
        assert warning_calls == []
    finally:
        checkbox.close()
        app.processEvents()


def test_process_pausing_user_enable_still_requires_warning() -> None:
    os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    app = QApplication.instance() or QApplication([])
    warning_calls = []
    checkbox = QCheckBox()
    window = SimpleNamespace(
        process_pausing_enabled_check=checkbox,
        _show_game_pausing_warning=lambda: warning_calls.append(True) or False,
    )
    checkbox.stateChanged.connect(lambda state: ConfigWindow._handle_game_pausing_toggle(window, state))

    try:
        checkbox.setChecked(True)

        assert checkbox.isChecked() is False
        assert warning_calls == [True]
    finally:
        checkbox.close()
        app.processEvents()


def test_clearable_key_sequence_edit_clears_with_escape_or_backspace() -> None:
    os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    app = QApplication.instance() or QApplication([])

    for key in (Qt.Key.Key_Escape, Qt.Key.Key_Backspace):
        edit = ClearableKeySequenceEdit()
        changes: list[str] = []
        edit.keySequenceChanged.connect(lambda sequence: changes.append(sequence.toString()))

        try:
            edit.setKeySequence(QKeySequence("Ctrl+M"))
            changes.clear()

            event = QKeyEvent(QEvent.Type.KeyPress, key, Qt.KeyboardModifier.NoModifier)
            edit.keyPressEvent(event)

            assert edit.keySequence().isEmpty()
            assert changes == [""]
        finally:
            edit.close()
            app.processEvents()


def test_on_profile_changed_notifies_profile_change_hooks() -> None:
    calls: list[tuple[str, str]] = []
    saved_profiles: list[str] = []
    reloaded = []

    class _FakeMasterConfig:
        current_profile = "Default"

        def save(self) -> None:
            saved_profiles.append(self.current_profile)

    class _FakeEditor:
        def __init__(self, master_config) -> None:
            self.master_config = master_config
            self.profile = SimpleNamespace(name=master_config.current_profile)

        def replace_master_config(self, master_config) -> None:
            self.master_config = master_config
            self.profile = SimpleNamespace(name=master_config.current_profile)

    master_config = _FakeMasterConfig()
    window = SimpleNamespace(
        _profile_change_hooks=[],
        profile_combo=_FakeProfileCombo("Persona 3"),
        settings=SimpleNamespace(name="Default"),
        master_config=master_config,
        editor=_FakeEditor(master_config),
        delete_profile_button=_FakeDeleteButton(),
        _flush_pending_auto_save=lambda **_kwargs: None,
        _schedule_runtime_reload=lambda: reloaded.append(True),
        _load_settings_to_ui_safely=lambda: None,
        refresh_obs_scenes=lambda **_kwargs: None,
        _update_window_title=lambda: None,
    )

    ConfigWindow.add_profile_change_hook(window, lambda previous, new: calls.append((previous, new)))
    ConfigWindow._on_profile_changed(window)

    assert calls == [("Default", "Persona 3")]
    assert saved_profiles == ["Persona 3"]
    assert reloaded == [True]
    assert window.delete_profile_button.hidden is False


def test_on_profile_changed_can_suppress_profile_change_hooks() -> None:
    calls: list[tuple[str, str]] = []
    saved_profiles: list[str] = []
    reloaded = []

    class _FakeMasterConfig:
        current_profile = "Default"

        def save(self) -> None:
            saved_profiles.append(self.current_profile)

    class _FakeEditor:
        def __init__(self, master_config) -> None:
            self.master_config = master_config
            self.profile = SimpleNamespace(name=master_config.current_profile)

        def replace_master_config(self, master_config) -> None:
            self.master_config = master_config
            self.profile = SimpleNamespace(name=master_config.current_profile)

    master_config = _FakeMasterConfig()
    window = SimpleNamespace(
        _profile_change_hooks=[],
        _suppress_profile_change_hooks=True,
        profile_combo=_FakeProfileCombo("Persona 3"),
        settings=SimpleNamespace(name="Default"),
        master_config=master_config,
        editor=_FakeEditor(master_config),
        delete_profile_button=_FakeDeleteButton(),
        _flush_pending_auto_save=lambda **_kwargs: None,
        _schedule_runtime_reload=lambda: reloaded.append(True),
        _load_settings_to_ui_safely=lambda: None,
        refresh_obs_scenes=lambda **_kwargs: None,
        _update_window_title=lambda: None,
    )

    ConfigWindow.add_profile_change_hook(window, lambda previous, new: calls.append((previous, new)))
    ConfigWindow._on_profile_changed(window)

    assert calls == []
    assert saved_profiles == ["Persona 3"]
    assert reloaded == [True]
    assert window.delete_profile_button.hidden is False


def test_reload_settings_rebuilds_localized_ui_when_locale_changes(monkeypatch) -> None:
    calls: list[object] = []

    class _FakeProfile:
        name = "Default"

        def config_changed(self, _other) -> bool:
            return False

    class _FakeMasterConfig:
        def __init__(self, locale: Locale) -> None:
            self._locale = locale

        def get_config(self) -> _FakeProfile:
            return _FakeProfile()

        def get_locale(self) -> Locale:
            return self._locale

    class _FakeEditor:
        def __init__(self, master_config) -> None:
            self.master_config = master_config
            self.profile = _FakeProfile()

        def replace_master_config(self, master_config) -> None:
            calls.append("replace_master_config")
            self.master_config = master_config
            self.profile = _FakeProfile()

        def clear_listeners(self) -> None:
            calls.append("clear_listeners")

    current_master = _FakeMasterConfig(Locale.English)
    next_master = _FakeMasterConfig(Locale.Українська)
    editor = _FakeEditor(current_master)
    window = SimpleNamespace(
        editor=editor,
        master_config=current_master,
        settings=_FakeProfile(),
        i18n={},
        binder=None,
        tab_widget=SimpleNamespace(clear=lambda: calls.append("clear_tabs")),
        _flush_pending_auto_save=lambda: calls.append("flush_pending_auto_save"),
        _register_shared_bindings=lambda: calls.append("register_shared_bindings"),
        _create_tabs=lambda: calls.append("create_tabs"),
        _create_button_bar=lambda: calls.append("create_button_bar"),
        _load_settings_to_ui_safely=lambda: calls.append("load_settings_to_ui"),
        _connect_signals=lambda: calls.append("connect_signals"),
        _update_window_title=lambda: calls.append("update_window_title"),
        refresh_obs_scenes=lambda **_kwargs: calls.append("refresh_obs_scenes"),
    )

    monkeypatch.setattr(
        "GameSentenceMiner.ui.config_gui_qt.configuration",
        SimpleNamespace(load_config=lambda: next_master),
    )
    monkeypatch.setattr(
        "GameSentenceMiner.ui.config_gui_qt.load_localization",
        lambda locale: {"locale": locale.value},
    )
    monkeypatch.setattr(
        "GameSentenceMiner.ui.config_gui_qt.BindingManager",
        lambda _editor: calls.append("new_binder") or object(),
    )

    ConfigWindow._reload_settings_impl(window)

    assert window.master_config is next_master
    assert window.i18n == {"locale": "ukr_ua"}
    assert "clear_tabs" in calls
    assert "create_tabs" in calls
    assert "create_button_bar" in calls
    assert "connect_signals" in calls


def test_reset_to_default_handles_numeric_screenshot_defaults(monkeypatch) -> None:
    os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    app = QApplication.instance() or QApplication([])

    monkeypatch.setattr(
        "GameSentenceMiner.ui.config_gui_qt.get_latest_version",
        lambda: "test-version",
    )
    monkeypatch.setattr(ConfigWindow, "_refresh_anki_model_list", lambda self, preserve_selection=True: None)
    monkeypatch.setattr(ConfigWindow, "_load_monitors", lambda self, preferred_index=None: None)
    monkeypatch.setattr(ConfigWindow, "get_online_models", lambda self: None)
    monkeypatch.setattr(
        ConfigWindow,
        "save_settings",
        lambda self, **kwargs: True,
    )
    monkeypatch.setattr(
        QMessageBox,
        "question",
        lambda *args, **kwargs: QMessageBox.StandardButton.Yes,
    )

    window = ConfigWindow()
    try:
        window._reset_to_default("screenshot", window._create_screenshot_tab)

        assert window.screenshot_width_edit.text() == "0"
        assert window.screenshot_height_edit.text() == "0"
        assert window.screenshot_quality_edit.text() == "85"
    finally:
        window.close()
        app.processEvents()


def test_refresh_obs_scenes_keeps_saved_profile_scenes_when_obs_temporarily_returns_nothing(monkeypatch) -> None:
    os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    app = QApplication.instance() or QApplication([])

    monkeypatch.setattr(
        "GameSentenceMiner.ui.config_gui_qt.get_latest_version",
        lambda: "test-version",
    )
    monkeypatch.setattr(ConfigWindow, "_refresh_anki_model_list", lambda self, preserve_selection=True: None)
    monkeypatch.setattr(ConfigWindow, "_load_monitors", lambda self, preferred_index=None: None)
    monkeypatch.setattr(ConfigWindow, "get_online_models", lambda self: None)

    scene_responses = iter(
        [
            [{"sceneName": "Scene A"}, {"sceneName": "Scene B"}],
            None,
        ]
    )
    monkeypatch.setattr(
        "GameSentenceMiner.ui.config_gui_qt.obs.get_obs_scenes",
        lambda: next(scene_responses),
    )

    window = ConfigWindow()
    try:
        window.obs_error_timer.stop()
        window.obs_scene_refresh_timer.stop()
        window.settings.scenes = ["Scene A", "Missing Scene"]

        window.refresh_obs_scenes(force_reload=True)

        assert [window.obs_scene_list.item(i).text() for i in range(window.obs_scene_list.count())] == [
            "Scene A",
            "Scene B",
        ]
        assert [item.text() for item in window.obs_scene_list.selectedItems()] == ["Scene A"]

        window.refresh_obs_scenes()

        assert [window.obs_scene_list.item(i).text() for i in range(window.obs_scene_list.count())] == [
            "Scene A",
            "Scene B",
        ]
        assert window.settings.scenes == ["Scene A", "Missing Scene"]
    finally:
        window.close()
        app.processEvents()
