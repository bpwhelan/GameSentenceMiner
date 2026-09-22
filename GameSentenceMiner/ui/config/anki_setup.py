"""Guided installation and configuration of recommended Anki note types."""

import threading
from html import escape
from pathlib import Path

from PyQt6.QtCore import Qt, pyqtSignal
from PyQt6.QtWidgets import (
    QApplication,
    QCheckBox,
    QComboBox,
    QDialog,
    QDialogButtonBox,
    QFormLayout,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QMessageBox,
    QPushButton,
    QTableWidget,
    QTableWidgetItem,
    QTabWidget,
    QVBoxLayout,
)

from GameSentenceMiner.anki_setup import (
    PRESETS,
    AnkiSetupClient,
    AnkiSetupError,
    SetupResult,
    get_preset,
    suggest_gsm_field_mappings,
)
from GameSentenceMiner.util.config.configuration import get_app_directory


def offer_recommended_field_mappings(window, model_name: str, fields: list[str]) -> bool:
    """Offer field-name updates from the normal note-type selector, then use autosave."""
    if window._autosave_suspended or window._suppress_anki_field_refresh:
        return False

    def current_context():
        return window.settings.name, window.anki_url_edit.text().strip(), window.anki_note_type_combo.currentText()

    context = current_context()
    if context[2] != model_name:
        return False
    labels = {
        "word": "Word",
        "sentence": "Sentence",
        "sentence_audio": "Sentence audio",
        "picture": "Screenshot",
        "sentence_furigana": "Sentence furigana",
        "game_name": "Game / source name",
        "ai": "AI output",
    }
    changes = []
    for key, field in suggest_gsm_field_mappings(fields).items():
        combo = window.ai_anki_field_edit if key == "ai" else getattr(window, f"{key}_field_edit")
        if combo.currentText() != field:
            changes.append((labels[key], combo, combo.currentText(), field))
    if not changes:
        return False

    message = QMessageBox(window)
    message.setWindowTitle("Update GSM field mappings")
    message.setIcon(QMessageBox.Icon.Question)
    message.setTextFormat(Qt.TextFormat.PlainText)
    message.setText(f'Do you want to update these GSM fields for "{model_name}"?')
    message.setInformativeText("\n".join(f"{label}: {old or '(empty)'} → {new}" for label, _, old, new in changes))
    message.setStandardButtons(QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No)
    message.button(QMessageBox.StandardButton.Yes).setText("Update fields")
    message.button(QMessageBox.StandardButton.No).setText("Keep current fields")
    message.setDefaultButton(QMessageBox.StandardButton.No)
    message.setEscapeButton(QMessageBox.StandardButton.No)
    previous_autosave = window._autosave_suspended
    window._auto_save_timer.stop()
    window._autosave_suspended = True
    try:
        if message.exec() != QMessageBox.StandardButton.Yes or current_context() != context:
            return False
        for _, combo, _, field in changes:
            combo.setCurrentText(field)
        return True
    finally:
        message.deleteLater()
        window._autosave_suspended = previous_autosave
        window.request_auto_save()


def apply_recommended_fields(window, result: SetupResult) -> None:
    """Update the normal settings controls, so the existing save/binding path is used."""
    preset = get_preset(result.preset_id)
    if result.import_pending or not set(preset.gsm_fields.values()).issubset(result.fields):
        raise AnkiSetupError("Verify the imported note type before applying its settings.")
    previous_autosave = window._autosave_suspended
    previous_refresh = window._suppress_anki_field_refresh
    window._autosave_suspended = True
    window._suppress_anki_field_refresh = True
    try:
        window._set_available_anki_fields(result.fields, preserve_selection=True)
        if window.anki_note_type_combo.findText(result.model_name) < 0:
            window.anki_note_type_combo.addItem(result.model_name)
        window.anki_note_type_combo.setCurrentText(result.model_name)
        window.anki_enabled_check.setChecked(True)
        window.update_anki_check.setChecked(True)
        for key, field_name in preset.gsm_fields.items():
            getattr(window, f"{key}_field_edit").setCurrentText(field_name)
            if key == "word":
                continue
            # Keep the user's audio/screenshot capture preferences.
            if key not in ("sentence_audio", "picture"):
                getattr(window, f"{key}_field_enabled_check").setChecked(True)
            getattr(window, f"{key}_field_append_check").setChecked(False)
            getattr(window, f"{key}_field_overwrite_check").setChecked(True)
        for key in ("previous_sentence", "previous_image", "video"):
            combo = getattr(window, f"{key}_field_edit")
            if combo.currentText() not in result.fields:
                combo.setCurrentText("")
                getattr(window, f"{key}_field_enabled_check").setChecked(False)
        translation_field = "sentenceTranslation" if preset.id == "senren" else "SentenceTranslation"
        if preset.id == "senren" and translation_field not in result.fields:
            translation_field = "sentenceEng"
        if translation_field in result.fields:
            window.ai_anki_field_edit.setCurrentText(translation_field)
        elif window.ai_anki_field_edit.currentText() not in result.fields:
            window.ai_anki_field_edit.setCurrentText("")
            window.ai_enabled_check.setChecked(False)
        # Kiku's data-group-id markup is not Senren's scene-switching format.
        if preset.id != "kiku":
            window.anki_field_grouping_enabled_check.setChecked(False)
        window.anki_field_grouping_additional_fields_edit.setText(
            ", ".join(name for name in (translation_field, preset.gsm_fields["game_name"]) if name in result.fields)
        )
        window._apply_anki_field_policy_states()
    finally:
        window._suppress_anki_field_refresh = previous_refresh
        window._autosave_suspended = previous_autosave


class RecommendedAnkiDialog(QDialog):
    finished_work = pyqtSignal(str, object, str)

    def __init__(self, window):
        super().__init__(window)
        self.window = window
        self._busy = False
        self._pending_preset = None
        self._context = None
        self.setWindowTitle("Set up recommended Anki cards")
        self.setModal(True)
        self.resize(740, 700)
        layout = QVBoxLayout(self)
        instructions = QLabel(
            "Open Anki with AnkiConnect enabled. Choose a card type and a deck for new cards. "
            "GSM downloads missing note types from their official releases and opens Anki's import screen. "
            "Packages may include example cards. Existing note types are reused."
        )
        instructions.setWordWrap(True)
        layout.addWidget(instructions)
        form = QFormLayout()
        self.preset_combo = QComboBox()
        for preset in PRESETS:
            self.preset_combo.addItem(preset.name, preset.id)
        form.addRow("Card type", self.preset_combo)
        self.deck_combo = QComboBox()
        self.deck_combo.setEditable(True)
        self.deck_combo.setCurrentText("GSM")
        self.deck_combo.setToolTip("Choose an existing deck or enter a new name. GSM creates the deck if needed.")
        deck_row = QHBoxLayout()
        deck_row.addWidget(self.deck_combo, 1)
        self.check_button = QPushButton("Check Anki / refresh decks")
        self.check_button.clicked.connect(self.check_connection)
        deck_row.addWidget(self.check_button)
        form.addRow("Deck", deck_row)
        layout.addLayout(form)
        self.description = QLabel()
        self.description.setWordWrap(True)
        self.description.setOpenExternalLinks(True)
        layout.addWidget(self.description)
        self.yomitan_check = QCheckBox("Configure Yomitan in the running GSM overlay")
        self.yomitan_check.setChecked(True)
        layout.addWidget(self.yomitan_check)
        details = QLabel(
            "GSM will enable Anki updates and apply the fields below to the current GSM profile. "
            "Sentence, audio, picture and furigana fields use overwrite mode; your capture preferences are kept. "
            "Unsupported optional mappings are cleared. AI output uses the translation field when available. "
            "Field grouping is kept only for Kiku.\n\n"
            "Yomitan receives a separate GSM profile with your current dictionaries, the selected deck and these "
            "fields. Your previous profiles are kept. Browser Yomitan can be configured manually using the field table. "
            "The glossary uses your enabled dictionaries; a primary dictionary can be selected later."
        )
        details.setWordWrap(True)
        layout.addWidget(details)
        tabs = QTabWidget()
        self.gsm_table = self._make_table("GSM setting", "Anki field")
        self.yomitan_table = self._make_table("Anki field", "Yomitan value")
        tabs.addTab(self.gsm_table, "GSM fields")
        tabs.addTab(self.yomitan_table, "Yomitan fields")
        layout.addWidget(tabs, 1)
        copy_button = QPushButton("Copy Yomitan field table")
        copy_button.clicked.connect(self.copy_fields)
        layout.addWidget(copy_button)
        self.status = QLabel("Use Check Anki to confirm the connection, or start setup below.")
        self.status.setTextFormat(Qt.TextFormat.PlainText)
        self.status.setWordWrap(True)
        self.status.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        layout.addWidget(self.status)
        buttons = QDialogButtonBox(QDialogButtonBox.StandardButton.Close)
        buttons.rejected.connect(self.reject)
        self.close_button = buttons.button(QDialogButtonBox.StandardButton.Close)
        self.install_button = buttons.addButton("Install and set up", QDialogButtonBox.ButtonRole.ActionRole)
        self.install_button.clicked.connect(self.install)
        layout.addWidget(buttons)
        self.preset_combo.currentIndexChanged.connect(self.refresh_preset)
        self.finished_work.connect(self.on_finished)
        self.refresh_preset()

    @staticmethod
    def _make_table(left, right):
        table = QTableWidget(0, 2)
        table.setHorizontalHeaderLabels([left, right])
        table.horizontalHeader().setSectionResizeMode(0, QHeaderView.ResizeMode.ResizeToContents)
        table.horizontalHeader().setSectionResizeMode(1, QHeaderView.ResizeMode.Stretch)
        table.verticalHeader().hide()
        table.setEditTriggers(QTableWidget.EditTrigger.NoEditTriggers)
        return table

    @staticmethod
    def _fill_table(table, values):
        table.setRowCount(len(values))
        for row, (left, right) in enumerate(values.items()):
            table.setItem(row, 0, QTableWidgetItem(left))
            table.setItem(row, 1, QTableWidgetItem(right))

    def refresh_preset(self):
        preset = get_preset(self.preset_combo.currentData())
        self._pending_preset = None
        self.install_button.setText("Install and set up")
        self.description.setText(
            f'{escape(preset.description)} <a href="{preset.documentation}">Official setup guide</a>'
        )
        labels = {
            "word": "Word",
            "sentence": "Sentence",
            "sentence_audio": "Sentence audio",
            "picture": "Screenshot",
            "sentence_furigana": "Sentence furigana",
            "game_name": "Game / source name",
        }
        self._fill_table(self.gsm_table, {labels[key]: value for key, value in preset.gsm_fields.items()})
        self._yomitan_fields = preset.yomitan_fields
        self._fill_table(self.yomitan_table, self._yomitan_fields)

    def copy_fields(self):
        QApplication.clipboard().setText(
            "\n".join(f"{field}\t{value}" for field, value in self._yomitan_fields.items())
        )
        self.status.setText(
            "Copied. In browser Yomitan, choose the deck and model under Anki → Configure Anki flashcards, then copy each value into its field."
        )

    def current_context(self):
        return self.window.settings.name, self.window.anki_url_edit.text().strip()

    def _set_busy(self, busy):
        self._busy = busy
        for control in (
            self.preset_combo,
            self.deck_combo,
            self.check_button,
            self.install_button,
            self.yomitan_check,
            self.close_button,
        ):
            control.setEnabled(not busy)

    def _run(self, action, operation):
        if self._busy:
            return
        self._context = self.current_context()
        self._set_busy(True)

        def run():
            try:
                result, error = operation(), ""
            except Exception as exc:  # noqa: BLE001 - Deliver worker failures to the Qt thread.
                result, error = None, str(exc)
            try:
                self.finished_work.emit(action, result, error)
            except RuntimeError:
                pass  # The application may have closed while a request was running.

        threading.Thread(target=run, name=f"anki-setup-{action}", daemon=True).start()

    def _with_client(self, operation):
        url = self.current_context()[1]
        directory = Path(get_app_directory()) / "downloads" / "anki-note-types"

        def run():
            client = AnkiSetupClient(url, directory)
            try:
                return operation(client)
            finally:
                client.close()

        return run

    def check_connection(self):
        self.status.setText("Checking AnkiConnect…")
        self._run("check", self._with_client(lambda client: client.check()))

    def install(self):
        preset_id = self.preset_combo.currentData()
        deck = self.deck_combo.currentText()
        allow_download = self._pending_preset != preset_id
        self.status.setText(
            "Checking the note type and preparing its official package…"
            if allow_download
            else "Checking the imported note type…"
        )
        self._run(
            "setup", self._with_client(lambda client: client.setup(preset_id, deck, allow_download=allow_download))
        )

    def on_finished(self, action, result, error):
        self._set_busy(False)
        if self._context != self.current_context():
            self.status.setText("The GSM profile or AnkiConnect URL changed. Run setup again for the current profile.")
            return
        if error:
            prefix = "GSM settings saved. Yomitan still needs setup: " if action == "yomitan" else ""
            self.status.setText(prefix + error)
            return
        if action == "check":
            current = self.deck_combo.currentText()
            self.deck_combo.clear()
            self.deck_combo.addItems(result)
            self.deck_combo.setCurrentText(current)
            self.status.setText("Connected to Anki. Choose a card type and deck, then start setup.")
        elif action == "setup":
            if result.import_pending:
                self._pending_preset = result.preset_id
                self.install_button.setText("Finish setup")
                self.status.setText(
                    "The package is downloaded and Anki's import screen is open. Complete the import in Anki, then click Finish setup here. GSM settings have not changed yet."
                )
                return
            try:
                apply_recommended_fields(self.window, result)
                self.window._auto_save_timer.stop()
                if not self.window.save_settings(show_indicator=False, force_backup=True, immediate_reload=True):
                    raise AnkiSetupError("Could not save GSM settings. Check the settings form and retry.")
            except Exception as exc:  # noqa: BLE001 - Keep save failures visible in the dialog.
                self.status.setText(str(exc))
                return
            self._pending_preset = None
            self.install_button.setText("Apply settings again")
            self._yomitan_fields = result.yomitan_fields
            self._fill_table(self.yomitan_table, self._yomitan_fields)
            if self.yomitan_check.isChecked():
                from GameSentenceMiner.util.anki_yomitan import configure_yomitan

                payload = result.yomitan_payload(self.current_context()[1])
                payload["tags"] = list(self.window.settings.anki.tags_to_check or [])
                self.status.setText("GSM settings saved. Configuring the overlay's Yomitan profile…")
                self._run("yomitan", lambda: configure_yomitan(payload))
            else:
                self.status.setText(
                    f"{result.model_name} is ready and GSM settings are saved. Use the Yomitan field table if you mine with browser Yomitan."
                )
        elif action == "yomitan":
            self.status.setText(
                f"Setup complete. GSM settings saved; Yomitan profile '{result}' is selected. New cards will use your chosen deck and fields."
            )

    def reject(self):
        if not self._busy:
            super().reject()

    def closeEvent(self, event):
        if self._busy:
            event.ignore()
        else:
            super().closeEvent(event)


def open_recommended_anki_setup(window):
    RecommendedAnkiDialog(window).exec()
