"""Missing-field recovery is optional, deduplicated and confined to the GUI thread."""

import os
import threading
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from PyQt6.QtWidgets import QApplication, QMessageBox

from GameSentenceMiner import anki_setup
from GameSentenceMiner.ui import qt_main
from GameSentenceMiner.ui.config import anki_setup as setup_ui
from GameSentenceMiner.util.config.configuration import ProfileConfig


@pytest.fixture
def mismatch_ui(monkeypatch):
    os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    app = QApplication.instance() or QApplication([])
    config = ProfileConfig()
    monkeypatch.setattr(qt_main, "get_config", lambda: config)
    window = SimpleNamespace(
        settings=config,
        anki_url_edit=SimpleNamespace(text=lambda: config.anki.url),
        show_window=Mock(),
    )
    get_window = Mock(return_value=window)
    monkeypatch.setattr(qt_main, "get_config_window", get_window)
    open_setup = Mock()
    monkeypatch.setattr(setup_ui, "open_recommended_anki_setup", open_setup)
    manager = qt_main.DialogManager()
    issue = anki_setup.find_anki_field_mismatch(config, "Custom <cards>", ["Sentence"])
    yield app, config, manager, issue, get_window, open_setup
    if manager._anki_setup_prompt is not None:
        manager._anki_setup_prompt.reject()
    app.processEvents()


def test_warning_names_missing_fields_and_acceptance_opens_normal_setup(mismatch_ui):
    app, _, manager, issue, get_window, open_setup = mismatch_ui
    manager.offer_anki_setup(issue)
    app.processEvents()
    prompt = manager._anki_setup_prompt
    text = prompt.text() + prompt.informativeText()
    for expected in ("Custom <cards>", "Expression", "SentenceAudio", "Picture", "Lapis (simplest)", "Kiku", "Senren"):
        assert expected in text
    assert "Anki settings" in text
    get_window.assert_not_called()
    open_setup.assert_not_called()

    prompt.button(QMessageBox.StandardButton.Yes).click()
    open_setup.assert_called_once_with(get_window.return_value)
    get_window.return_value.show_window.assert_called_once_with("anki")
    assert manager._anki_setup_prompt is None


def test_decline_and_repeated_cards_do_not_reopen_warning(mismatch_ui):
    _, _, manager, issue, get_window, open_setup = mismatch_ui
    manager.offer_anki_setup(issue)
    prompt = manager._anki_setup_prompt
    manager.offer_anki_setup(issue)
    assert manager._anki_setup_prompt is prompt
    prompt.button(QMessageBox.StandardButton.No).click()
    manager.offer_anki_setup(issue)
    assert manager._anki_setup_prompt is None
    get_window.assert_not_called()
    open_setup.assert_not_called()


@pytest.mark.parametrize("change_before_show", [True, False])
def test_stale_profile_does_not_show_or_open_setup(mismatch_ui, change_before_show):
    _, config, manager, issue, get_window, open_setup = mismatch_ui
    if not change_before_show:
        manager.offer_anki_setup(issue)
    config.name = "Changed profile"
    if change_before_show:
        manager.offer_anki_setup(issue)
    else:
        manager._anki_setup_prompt.button(QMessageBox.StandardButton.Yes).click()
    assert manager._anki_setup_prompt is None
    get_window.assert_not_called()
    open_setup.assert_not_called()


def test_worker_can_request_prompt_without_waiting_for_user(mismatch_ui):
    app, _, manager, issue, _, _ = mismatch_ui
    worker = threading.Thread(target=lambda: manager.offer_anki_setup(issue), daemon=True)
    worker.start()
    worker.join(timeout=1)
    assert not worker.is_alive()
    assert manager._anki_setup_prompt is None
    app.processEvents()
    assert manager._anki_setup_prompt is not None


def test_refreshed_settings_do_not_open_setup_for_an_old_mapping(mismatch_ui):
    _, config, manager, issue, get_window, open_setup = mismatch_ui
    get_window.return_value.show_window.side_effect = lambda _tab: setattr(config.anki, "word_field", "Term")
    manager.offer_anki_setup(issue)
    manager._anki_setup_prompt.button(QMessageBox.StandardButton.Yes).click()
    open_setup.assert_not_called()
    assert manager._anki_setup_prompt is None


def test_changed_mapping_can_offer_setup_again(mismatch_ui):
    _, config, manager, issue, _, _ = mismatch_ui
    manager.offer_anki_setup(issue)
    manager._anki_setup_prompt.reject()
    config.anki.word_field = "DifferentWord"
    changed_issue = anki_setup.find_anki_field_mismatch(config, issue.model_name, issue.available_fields)
    manager.offer_anki_setup(changed_issue)
    assert manager._anki_setup_prompt is not None


def test_setup_failure_does_not_leave_prompt_stuck(mismatch_ui):
    _, _, manager, issue, _, open_setup = mismatch_ui
    open_setup.side_effect = RuntimeError("Could not open setup")
    manager.offer_anki_setup(issue)
    manager._anki_setup_prompt.button(QMessageBox.StandardButton.Yes).click()
    assert manager._anki_setup_prompt is None
    manager.offer_anki_setup(issue)
    assert manager._anki_setup_prompt is not None
