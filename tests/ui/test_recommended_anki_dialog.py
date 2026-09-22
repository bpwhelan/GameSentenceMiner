"""Recommended card setup uses the existing settings save path."""

import os
from unittest.mock import Mock

import pytest
from PyQt6.QtCore import QSignalBlocker, Qt, QTimer
from PyQt6.QtTest import QTest
from PyQt6.QtWidgets import QApplication, QMessageBox

from GameSentenceMiner.anki_setup import SetupResult, get_preset
from GameSentenceMiner.ui.config.anki_setup import RecommendedAnkiDialog, apply_recommended_fields
from GameSentenceMiner.ui.config_gui_qt import ConfigWindow
from GameSentenceMiner.util.config.configuration import Config


@pytest.fixture
def setup_window(monkeypatch):
    os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    app = QApplication.instance() or QApplication([])
    monkeypatch.setattr("GameSentenceMiner.ui.config_gui_qt.get_latest_version", lambda: "test-version")
    monkeypatch.setattr(ConfigWindow, "_refresh_anki_model_list", lambda self, preserve_selection=True: None)
    monkeypatch.setattr(ConfigWindow, "_load_monitors", lambda self, preferred_index=None: None)
    monkeypatch.setattr(ConfigWindow, "get_online_models", lambda self: None)
    monkeypatch.setattr(ConfigWindow, "_schedule_runtime_reload", lambda self: None)
    monkeypatch.setattr("GameSentenceMiner.ui.config_gui_qt.write_overlay_scene_settings", lambda settings: None)
    window = ConfigWindow()
    yield window
    window._auto_save_timer.stop()
    window.close()
    app.processEvents()


@pytest.mark.parametrize("preset_id", ["lapis", "kiku", "senren"])
def test_preset_is_saved_in_existing_config_format(setup_window, preset_id):
    window = setup_window
    preset = get_preset(preset_id)
    window.video_field_edit.setCurrentText("Field from previous template")
    window.audio_enabled_check.setChecked(False)
    window.sentence_field_append_check.setChecked(True)
    result = SetupResult(preset_id, preset.name, tuple(preset.yomitan_fields), "Mining")
    apply_recommended_fields(window, result)
    assert window.save_settings(show_indicator=False)
    saved = Config.load().get_config()
    assert saved.anki.note_type == preset.name
    for key, name in preset.gsm_fields.items():
        assert getattr(saved.anki, key).name == name
    assert saved.anki.video.name == ""
    assert saved.anki.sentence.overwrite is True
    assert saved.anki.sentence.append is False
    assert saved.audio.enabled is False  # Keep the user's capture preference.


def test_pending_import_does_not_change_settings_and_offers_finish(setup_window):
    dialog = RecommendedAnkiDialog(setup_window)
    before = setup_window.anki_note_type_combo.currentText()
    dialog._context = dialog.current_context()
    dialog.on_finished("setup", SetupResult("lapis", deck="GSM", import_pending=True), "")
    assert setup_window.anki_note_type_combo.currentText() == before
    assert dialog.install_button.text() == "Finish setup"
    assert "Anki" in dialog.status.text()
    dialog.close()


def test_changed_profile_discards_setup_result(setup_window):
    dialog = RecommendedAnkiDialog(setup_window)
    before = setup_window.anki_note_type_combo.currentText()
    dialog._context = ("another profile", setup_window.anki_url_edit.text())
    preset = get_preset("senren")
    dialog.on_finished("setup", SetupResult("senren", "Senren", tuple(preset.yomitan_fields), "Mining"), "")
    assert setup_window.anki_note_type_combo.currentText() == before
    assert "changed" in dialog.status.text()
    dialog.close()


def test_yomitan_failure_explains_partial_success(setup_window):
    dialog = RecommendedAnkiDialog(setup_window)
    dialog._context = dialog.current_context()
    dialog.on_finished("yomitan", None, "Start the overlay.")
    assert "GSM settings saved" in dialog.status.text()
    assert "Start the overlay" in dialog.status.text()
    dialog.close()


def test_failed_gsm_save_does_not_configure_yomitan(setup_window, monkeypatch):
    dialog = RecommendedAnkiDialog(setup_window)
    dialog._context = dialog.current_context()
    monkeypatch.setattr(setup_window, "save_settings", lambda **kwargs: False)
    configure = Mock()
    monkeypatch.setattr(dialog, "_run", configure)
    preset = get_preset("lapis")
    dialog.on_finished("setup", SetupResult("lapis", "Lapis", tuple(preset.yomitan_fields), "Mining"), "")
    configure.assert_not_called()
    assert "Could not save" in dialog.status.text()
    dialog.close()


def test_saved_filter_tags_reach_yomitan(setup_window, monkeypatch):
    dialog = RecommendedAnkiDialog(setup_window)
    dialog._context = dialog.current_context()
    setup_window.tags_to_check_edit.setText("mining")
    configure = Mock(return_value="GSM - Kiku")
    monkeypatch.setattr("GameSentenceMiner.util.anki_yomitan.configure_yomitan", configure)
    monkeypatch.setattr(dialog, "_run", lambda action, operation: operation())
    preset = get_preset("kiku")
    dialog.on_finished("setup", SetupResult("kiku", "Kiku", tuple(preset.yomitan_fields), "Mining"), "")
    payload = configure.call_args.args[0]
    assert payload["tags"] == ["mining"]
    assert payload["deck"] == "Mining"
    assert payload["fields"]["ExpressionFurigana"] == "{furigana-plain}"
    dialog.close()


def test_existing_senren_fields_are_used_for_ai_output_and_the_copyable_table(setup_window):
    preset = get_preset("senren")
    fields = tuple(preset.gsm_fields.values()) + (
        "glossary",
        "sentenceEng",
        "reading",
        "pitch",
        "pitchPosition",
        "frequency",
    )
    result = SetupResult("senren", "Senren", fields, "Mining")
    dialog = RecommendedAnkiDialog(setup_window)
    dialog.preset_combo.setCurrentIndex(dialog.preset_combo.findData("senren"))
    dialog.yomitan_check.setChecked(False)
    dialog._context = dialog.current_context()
    setup_window.ai_enabled_check.setChecked(True)
    dialog.on_finished("setup", result, "")
    assert setup_window.ai_anki_field_edit.currentText() == "sentenceEng"
    assert setup_window.ai_enabled_check.isChecked()
    actual = {
        dialog.yomitan_table.item(row, 0).text(): dialog.yomitan_table.item(row, 1).text()
        for row in range(dialog.yomitan_table.rowCount())
    }
    assert actual == result.yomitan_payload("http://localhost:8765")["fields"]
    assert actual["reading"] == "{pitch-accents}"
    dialog.copy_fields()
    assert "pitch\t{pitch-accent-categories}" in QApplication.clipboard().text()
    assert "sentenceTranslation\t" not in QApplication.clipboard().text()
    dialog.close()


def select_note_type(window, combo_name, model):
    combo = getattr(window, combo_name)
    with QSignalBlocker(combo):
        current = combo.currentText()
        if combo.findText(model) < 0:
            combo.addItem(model)
        combo.setCurrentText(current)
    combo.setCurrentIndex(combo.findText(model))
    combo.activated.emit(combo.currentIndex())


@pytest.mark.parametrize("combo_name", ["anki_note_type_combo", "req_note_type_combo"])
@pytest.mark.parametrize("preset_id", ["lapis", "kiku", "senren"])
def test_note_type_selection_offers_and_saves_fields_for_renamed_models(
    setup_window, monkeypatch, combo_name, preset_id
):
    window = setup_window
    preset = get_preset(preset_id)
    model = f"My customized {preset_id} cards"
    fields = list(preset.yomitan_fields) + ["CustomField"]
    invoke = Mock(return_value=fields)
    monkeypatch.setattr(window, "_anki_invoke", invoke)
    window.word_field_edit.setCurrentText("OldWord")
    window.anki_enabled_check.setChecked(False)
    window.update_anki_check.setChecked(False)
    window.audio_enabled_check.setChecked(False)
    window.sentence_field_overwrite_check.setChecked(False)
    window.sentence_field_append_check.setChecked(True)
    window.anki_field_grouping_enabled_check.setChecked(True)
    prompts = []

    def confirm(message):
        prompts.append((message.text(), message.informativeText()))
        assert window.word_field_edit.currentText() == "OldWord"
        assert window._autosave_suspended
        return QMessageBox.StandardButton.Yes

    monkeypatch.setattr(QMessageBox, "exec", confirm)
    select_note_type(window, combo_name, model)
    getattr(window, combo_name).lineEdit().editingFinished.emit()
    assert len(prompts) == 1
    assert model in prompts[0][0]
    assert "OldWord" in prompts[0][1]
    assert preset.gsm_fields["word"] in prompts[0][1]
    invoke.assert_called_once_with("modelFieldNames", modelName=model)
    assert window.anki_note_type_combo.currentText() == model
    assert window.req_note_type_combo.currentText() == model
    for key, name in preset.gsm_fields.items():
        assert getattr(window, f"{key}_field_edit").currentText() == name
    assert window.req_word_field_edit.currentText() == preset.gsm_fields["word"]
    assert not window.anki_enabled_check.isChecked()
    assert not window.update_anki_check.isChecked()
    assert not window.audio_enabled_check.isChecked()
    assert window.sentence_field_append_check.isChecked()
    assert not window.sentence_field_overwrite_check.isChecked()
    assert window.anki_field_grouping_enabled_check.isChecked()
    assert not window._autosave_suspended
    assert window._auto_save_timer.isActive()
    window._perform_auto_save()
    saved = Config.load().get_config()
    assert saved.anki.note_type == model
    for key, name in preset.gsm_fields.items():
        assert getattr(saved.anki, key).name == name


def test_declining_note_type_suggestion_keeps_fields_and_does_not_repeat_on_focus_loss(setup_window, monkeypatch):
    window = setup_window
    monkeypatch.setattr(window, "_anki_invoke", Mock(return_value=list(get_preset("senren").yomitan_fields)))
    window.word_field_edit.setCurrentText("My custom word")
    window.sentence_field_edit.setCurrentText("My custom sentence")
    prompt = Mock(return_value=QMessageBox.StandardButton.No)
    monkeypatch.setattr(QMessageBox, "exec", prompt)
    select_note_type(window, "anki_note_type_combo", "Renamed model")
    window.anki_note_type_combo.lineEdit().editingFinished.emit()
    assert prompt.call_count == 1
    assert window.word_field_edit.currentText() == "My custom word"
    assert window.sentence_field_edit.currentText() == "My custom sentence"
    assert window.anki_note_type_combo.currentText() == "Renamed model"


def test_matching_name_with_unrelated_fields_does_not_prompt(setup_window, monkeypatch):
    window = setup_window
    monkeypatch.setattr(window, "_anki_invoke", Mock(return_value=["Front", "Back"]))
    prompt = Mock(return_value=QMessageBox.StandardButton.Yes)
    monkeypatch.setattr(QMessageBox, "exec", prompt)
    window.word_field_edit.setCurrentText("Keep me")
    select_note_type(window, "anki_note_type_combo", "Lapis")
    prompt.assert_not_called()
    assert window.word_field_edit.currentText() == "Keep me"


def test_programmatic_note_type_changes_do_not_prompt_or_fetch_fields(setup_window, monkeypatch):
    window = setup_window
    invoke = Mock(return_value=list(get_preset("lapis").yomitan_fields))
    monkeypatch.setattr(window, "_anki_invoke", invoke)
    prompt = Mock(return_value=QMessageBox.StandardButton.Yes)
    monkeypatch.setattr(QMessageBox, "exec", prompt)
    window.anki_note_type_combo.addItem("Programmatic model")
    window.anki_note_type_combo.setCurrentText("Programmatic model")
    window._load_settings_to_ui_safely()
    prompt.assert_not_called()
    invoke.assert_not_called()


def test_existing_correct_mappings_do_not_prompt(setup_window, monkeypatch):
    window = setup_window
    preset = get_preset("lapis")
    monkeypatch.setattr(window, "_anki_invoke", Mock(return_value=list(preset.yomitan_fields)))
    for key, name in preset.gsm_fields.items():
        getattr(window, f"{key}_field_edit").setCurrentText(name)
    prompt = Mock(return_value=QMessageBox.StandardButton.Yes)
    monkeypatch.setattr(QMessageBox, "exec", prompt)
    select_note_type(window, "anki_note_type_combo", "Already mapped")
    prompt.assert_not_called()


def test_note_type_selection_can_retry_after_anki_connection_failure(setup_window, monkeypatch):
    window = setup_window
    invoke = Mock(side_effect=[RuntimeError("Anki is closed"), list(get_preset("senren").yomitan_fields)])
    monkeypatch.setattr(window, "_anki_invoke", invoke)
    window.word_field_edit.setCurrentText("Before retry")
    prompt = Mock(return_value=QMessageBox.StandardButton.Yes)
    monkeypatch.setattr(QMessageBox, "exec", prompt)
    select_note_type(window, "anki_note_type_combo", "Retry this model")
    prompt.assert_not_called()
    select_note_type(window, "anki_note_type_combo", "Retry this model")
    assert invoke.call_count == 2
    assert prompt.call_count == 1
    assert window.word_field_edit.currentText() == "word"


def test_changed_connection_while_confirming_does_not_apply_stale_fields(setup_window, monkeypatch):
    window = setup_window
    monkeypatch.setattr(window, "_anki_invoke", Mock(return_value=list(get_preset("senren").yomitan_fields)))
    window.word_field_edit.setCurrentText("Keep current")

    def confirm(_message):
        window.anki_url_edit.setText(window.anki_url_edit.text().rstrip("/") + "/changed")
        return QMessageBox.StandardButton.Yes

    prompt = Mock(side_effect=confirm)
    monkeypatch.setattr(QMessageBox, "exec", lambda message: prompt(message))
    select_note_type(window, "anki_note_type_combo", "Stale result")
    assert prompt.call_count == 1
    assert window.word_field_edit.currentText() == "Keep current"


def test_keyboard_selection_uses_one_real_confirmation(setup_window, monkeypatch):
    window = setup_window
    monkeypatch.setattr(window, "_anki_invoke", Mock(return_value=list(get_preset("senren").yomitan_fields)))
    combo = window.req_note_type_combo
    with QSignalBlocker(combo):
        combo.clear()
        combo.addItems(["Original layout", "My Japanese cards"])
    window.editor.set_value(("profile", "anki", "note_type"), "Original layout")
    window.word_field_edit.setCurrentText("OriginalWord")
    window.show()
    combo.setFocus()
    QApplication.processEvents()
    prompts = []

    def accept_prompt():
        message = QApplication.activeModalWidget()
        if isinstance(message, QMessageBox):
            prompts.append((message.text(), message.informativeText()))
            message.button(QMessageBox.StandardButton.Yes).click()

    timer = QTimer(window)
    timer.timeout.connect(accept_prompt)
    timer.start(25)
    try:
        QTest.keyClick(combo, Qt.Key.Key_Down)
        QApplication.processEvents()
    finally:
        timer.stop()
        window.hide()
    assert len(prompts) == 1
    assert "My Japanese cards" in prompts[0][0]
    assert "OriginalWord → word" in prompts[0][1]
    assert window.word_field_edit.currentText() == "word"
    assert window.req_word_field_edit.currentText() == "word"
