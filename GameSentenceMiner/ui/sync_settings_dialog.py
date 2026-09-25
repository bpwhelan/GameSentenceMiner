"""Device sync configuration, available independently of GSM Cloud preview."""

import threading

from PyQt6.QtCore import pyqtSignal
from PyQt6.QtWidgets import QCheckBox, QDialog, QFormLayout, QHBoxLayout, QLabel, QLineEdit, QMessageBox, QPushButton

from GameSentenceMiner.util.cloud_sync import cloud_sync_service
from GameSentenceMiner.util.cloud_sync.crypto import SyncCipher, new_sync_key
from GameSentenceMiner.util.cloud_sync.relay_client import validate_relay_url


class SyncSettingsDialog(QDialog):
    finished_sync = pyqtSignal(dict)

    def __init__(self, window):
        super().__init__(window)
        self.window = window
        self.running = False
        self.setWindowTitle("Encrypted device sync")
        self.setMinimumWidth(600)
        layout = QFormLayout(self)
        note = QLabel(
            "Your devices keep the durable copy. The relay holds encrypted changes and device transfers for up to 30 days.\n"
            "After expiry, prepare a fresh transfer on an up-to-date device. Keep a separate local backup."
        )
        note.setWordWrap(True)
        layout.addRow(note)
        cfg = window.settings.advanced
        self.enabled = QCheckBox("Enable encrypted sync")
        self.enabled.setChecked(cfg.cloud_sync_enabled)
        self.auto = QCheckBox("Sync automatically")
        self.auto.setChecked(cfg.cloud_sync_auto_sync)
        self.url = QLineEdit(cfg.cloud_sync_api_url or window.settings.ai.gsm_cloud_api_url)
        self.token = QLineEdit(cfg.cloud_sync_api_token)
        self.token.setEchoMode(QLineEdit.EchoMode.Password)
        self.token.setPlaceholderText("Self-hosted relay token; leave empty to use GSM Cloud sign-in")
        self.key = QLineEdit(cfg.cloud_sync_key)
        self.key.setEchoMode(QLineEdit.EchoMode.Password)
        self.key.setPlaceholderText("Paste the same pairing key on each device")
        generate = QPushButton("Generate pairing key")
        generate.clicked.connect(self._generate_key)
        show = QCheckBox("Show pairing key")
        show.toggled.connect(
            lambda checked: self.key.setEchoMode(QLineEdit.EchoMode.Normal if checked else QLineEdit.EchoMode.Password)
        )
        layout.addRow(self.enabled)
        layout.addRow(self.auto)
        layout.addRow("Relay URL", self.url)
        layout.addRow("Access token", self.token)
        layout.addRow("Pairing key", self.key)
        key_actions = QHBoxLayout()
        key_actions.addWidget(generate)
        key_actions.addWidget(show)
        layout.addRow(key_actions)
        self.groups = {}
        layout.addRow(QLabel("Sync these preferences from the Default profile:"))
        for group, label in (
            ("language", "Native and target languages"),
            ("anki", "Anki field mappings"),
            ("text_processing", "Text processing and replacement rules"),
        ):
            checkbox = QCheckBox(label)
            checkbox.setChecked(group in cfg.cloud_sync_settings_groups)
            self.groups[group] = checkbox
            layout.addRow(checkbox)
        exclusions = QLabel(
            "Passwords, API keys, paths, ports, capture devices and named profiles stay on this device."
        )
        exclusions.setWordWrap(True)
        layout.addRow(exclusions)
        self.status = QLabel("")
        self.status.setWordWrap(True)
        layout.addRow(self.status)
        self.buttons = []
        actions = QHBoxLayout()
        for label, action in (
            ("Save", self._save),
            ("Sync now", self._sync),
            ("Prepare device transfer", lambda: self._sync(publish=True)),
        ):
            button = QPushButton(label)
            button.clicked.connect(lambda _checked=False, callback=action: callback())
            self.buttons.append(button)
            actions.addWidget(button)
        layout.addRow(actions)
        recovery = QPushButton("Rebuild an empty relay from this device…")
        recovery.clicked.connect(self._reseed)
        self.buttons.append(recovery)
        layout.addRow(recovery)
        remove = QPushButton("Remove relay data…")
        remove.clicked.connect(self._remove_relay)
        self.buttons.append(remove)
        layout.addRow(remove)
        self.finished_sync.connect(self._done)

    def _generate_key(self):
        if self.key.text().strip():
            QMessageBox.information(
                self,
                "Pairing key",
                "Clear the existing key first to create a separate sync group. Keep the old key if another device still uses it.",
            )
            return
        self.key.setText(new_sync_key())

    def _save(self, start_loop=True):
        if not cloud_sync_service._sync_lock.acquire(blocking=False):
            self.status.setText("Wait for the current sync to finish before changing its settings.")
            return False
        try:
            if self.enabled.isChecked():
                validate_relay_url(self.url.text())
                SyncCipher(self.key.text().strip())
                if not (self.token.text().strip() or self.window.settings.ai.gsm_cloud_access_token):
                    raise ValueError("Enter the relay access token or sign in to GSM Cloud first.")
            cfg = self.window.settings.advanced
            cfg.cloud_sync_protocol = "relay-v2"
            cfg.cloud_sync_enabled = self.enabled.isChecked()
            cfg.cloud_sync_auto_sync = self.auto.isChecked()
            cfg.cloud_sync_api_url = self.url.text().strip().rstrip("/")
            cfg.cloud_sync_api_token = self.token.text().strip()
            cfg.cloud_sync_key = self.key.text().strip()
            cfg.cloud_sync_settings_groups = [name for name, checkbox in self.groups.items() if checkbox.isChecked()]
            if not self.window.save_settings(show_indicator=False, immediate_reload=True):
                raise ValueError("Could not save sync settings.")
            self.status.setText("Sync settings saved.")
            return True
        except ValueError as exc:
            self.status.setText(str(exc))
            return False
        finally:
            cloud_sync_service._sync_lock.release()
            if start_loop:
                cloud_sync_service.refresh_background_loop()

    def _remove_relay(self):
        reply = QMessageBox.question(
            self,
            "Remove relay data",
            "Remove the encrypted changes and device transfer for this sync group, and disable sync on this device?\n"
            "Local data stays on your devices. Other devices will need a new transfer.",
        )
        if reply == QMessageBox.StandardButton.Yes:
            self._sync(remove=True)

    def _reseed(self):
        reply = QMessageBox.question(
            self,
            "Recover an empty relay",
            "Use this device as the source after the relay has expired or been cleared?\n"
            "Use an up-to-date device or restore a local backup first. This only works when the relay is empty.",
        )
        if reply == QMessageBox.StandardButton.Yes:
            self._sync(publish=True, reseed=True)

    def _sync(self, publish=False, reseed=False, remove=False):
        if self.running or not self._save(start_loop=False):
            return
        self.running = True
        for button in self.buttons:
            button.setEnabled(False)
        self.status.setText("Syncing encrypted data…")

        def run():
            result = (
                cloud_sync_service.purge_relay()
                if remove
                else cloud_sync_service.sync_once(manual=True, max_rounds=None, publish_snapshot=publish, reseed=reseed)
            )
            self.finished_sync.emit(result)

        threading.Thread(target=run, name="gsm-sync-dialog", daemon=True).start()

    def _done(self, result):
        self.running = False
        for button in self.buttons:
            button.setEnabled(True)
        if result.get("relay_deleted"):
            self.enabled.setChecked(False)
            self.auto.setChecked(False)
            self.status.setText("Relay data removed. Sync is disabled; your local data is unchanged.")
            self.window.reload_settings(force_refresh=True, suppress_profile_change_hooks=True)
        elif result.get("status") == "success":
            transfer = " Device transfer ready." if result.get("snapshot") else ""
            self.status.setText(
                f"Sync complete: sent {result.get('sent_changes', 0)}, received {result.get('received_changes', 0)}, updated {result.get('applied_settings', 0)} settings.{transfer}"
            )
            self.window.reload_settings(force_refresh=True, suppress_profile_change_hooks=True)
        else:
            self.status.setText(
                str(result.get("last_error") or result.get("reason") or "Sync is incomplete; run sync again.")
            )
        cloud_sync_service.refresh_background_loop()

    def reject(self):
        if not self.running:
            super().reject()

    def closeEvent(self, event):
        if self.running:
            event.ignore()
        else:
            super().closeEvent(event)
