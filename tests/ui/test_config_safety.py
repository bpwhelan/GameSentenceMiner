from __future__ import annotations

import os
from types import SimpleNamespace

from PyQt6.QtWidgets import QApplication

from GameSentenceMiner.ui.config.safety import safe_config_call, safe_config_callback, safe_config_methods
from GameSentenceMiner.ui.config.tabs.text_processing import StringReplacementDialog
from GameSentenceMiner.util.config.configuration import TextReplacementRule


def test_safe_config_call_logs_and_swallows_exceptions(monkeypatch) -> None:
    logged: list[tuple[str, bool]] = []
    monkeypatch.setattr(
        "GameSentenceMiner.ui.config.safety.logger",
        SimpleNamespace(error=lambda message, exc_info=False: logged.append((message, exc_info))),
    )

    @safe_config_call(name="demo.callback", default="fallback")
    def callback() -> str:
        raise RuntimeError("boom")

    assert callback() == "fallback"
    assert logged == [("Config GUI error in demo.callback: boom", True)]


def test_safe_config_call_ignores_extra_signal_args() -> None:
    calls: list[str] = []

    @safe_config_call(name="demo.clicked")
    def callback() -> None:
        calls.append("ran")

    callback(False, "extra")

    assert calls == ["ran"]


def test_safe_config_methods_uses_annotation_fallback(monkeypatch) -> None:
    logged: list[tuple[str, bool]] = []
    monkeypatch.setattr(
        "GameSentenceMiner.ui.config.safety.logger",
        SimpleNamespace(error=lambda message, exc_info=False: logged.append((message, exc_info))),
    )

    @safe_config_methods()
    class DemoConfigGui:
        def should_continue(self) -> bool:
            raise RuntimeError("stop")

    assert DemoConfigGui().should_continue() is False
    assert logged == [("Config GUI error in DemoConfigGui.should_continue: stop", True)]


def test_safe_config_methods_ignore_extra_signal_args() -> None:
    calls: list[str] = []

    @safe_config_methods()
    class DemoConfigGui:
        def trigger(self) -> None:
            calls.append("ran")

    DemoConfigGui().trigger(False, "extra")

    assert calls == ["ran"]


def test_safe_config_callback_ignores_extra_signal_args() -> None:
    calls: list[str] = []
    callback = safe_config_callback(lambda: calls.append("ran"), name="demo.signal")

    callback(False, "extra")

    assert calls == ["ran"]


def test_string_replacement_move_selected_reorders_rows_without_losing_modes() -> None:
    os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    app = QApplication.instance() or QApplication([])
    dialog = StringReplacementDialog(
        None,
        [
            TextReplacementRule(find="first", replace="1", mode="plain"),
            TextReplacementRule(find="second", replace="2", mode="regex"),
            TextReplacementRule(find="third", replace="3", mode="plain"),
        ],
        {"string_replacement": {"dialog": {}}},
    )
    try:
        dialog.table.selectRow(1)

        dialog._move_selected(1)

        rules = dialog.get_rules()
        assert [(rule.find, rule.mode) for rule in rules] == [
            ("first", "plain"),
            ("third", "plain"),
            ("second", "regex"),
        ]
        assert dialog.table.currentRow() == 2
    finally:
        dialog.close()
        app.processEvents()
