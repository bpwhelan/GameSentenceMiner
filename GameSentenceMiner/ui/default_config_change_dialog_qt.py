from __future__ import annotations

import sys

from PyQt6.QtCore import Qt
from PyQt6.QtWidgets import (
    QApplication,
    QDialog,
    QDialogButtonBox,
    QFrame,
    QLabel,
    QVBoxLayout,
    QWidget,
)

from GameSentenceMiner.util.config.configuration import (
    DefaultConfigChangeNotice,
    get_config,
    get_master_config,
    get_pending_default_config_changes,
    logger,
    resolve_default_config_change,
)


class DefaultConfigChangeDialog(QDialog):
    def __init__(self, notice: DefaultConfigChangeNotice, parent: QWidget | None = None):
        super().__init__(parent)
        self.notice = notice
        self.setWindowTitle("New Defaults Detected")
        self.setModal(True)
        self.setMinimumWidth(460)
        self._init_ui()

    def _init_ui(self) -> None:
        layout = QVBoxLayout(self)
        layout.setContentsMargins(18, 18, 18, 18)
        layout.setSpacing(12)

        title = QLabel("New Defaults Detected")
        title.setStyleSheet("font-size: 18px; font-weight: bold;")
        layout.addWidget(title)

        version = QLabel(f"Version: {self.notice.version}")
        version.setStyleSheet("color: #999;")
        layout.addWidget(version)

        intro = QLabel("GSM has changed defaults for this config:")
        intro.setWordWrap(True)
        layout.addWidget(intro)

        for change in self.notice.changes:
            change_label = QLabel(f"{change.label}: {change.old_value} -> {change.new_value}")
            change_label.setWordWrap(True)
            change_label.setStyleSheet("font-weight: bold;")
            layout.addWidget(change_label)

        separator = QFrame()
        separator.setFrameShape(QFrame.Shape.HLine)
        separator.setFrameShadow(QFrame.Shadow.Sunken)
        layout.addWidget(separator)

        reason_title = QLabel("Reason:")
        reason_title.setStyleSheet("font-weight: bold;")
        layout.addWidget(reason_title)

        reason = QLabel(self.notice.reason)
        reason.setWordWrap(True)
        reason.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        layout.addWidget(reason)

        prompt = QLabel("Accept this change?")
        prompt.setStyleSheet("font-weight: bold;")
        layout.addWidget(prompt)

        buttons = QDialogButtonBox()
        yes_button = buttons.addButton("Yes", QDialogButtonBox.ButtonRole.AcceptRole)
        no_button = buttons.addButton("No", QDialogButtonBox.ButtonRole.RejectRole)
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)
        yes_button.setDefault(True)
        no_button.setAutoDefault(False)
        layout.addWidget(buttons)


def show_default_config_change_dialogs(parent: QWidget | None = None) -> bool:
    if QApplication.instance() is None:
        QApplication(sys.argv)

    master_config = get_master_config()
    if master_config is None:
        get_config()
        master_config = get_master_config()
    if master_config is None:
        logger.warning("Default config change dialog skipped because no master config is loaded.")
        return False

    changed_config = False
    for notice in get_pending_default_config_changes(master_config):
        dialog = DefaultConfigChangeDialog(notice, parent=parent)
        accepted = dialog.exec() == QDialog.DialogCode.Accepted
        applied_count = resolve_default_config_change(master_config, notice.change_id, accepted)
        master_config.save()
        changed_config = changed_config or bool(applied_count)
        logger.info(
            f"Default config change '{notice.change_id}' "
            f"{'accepted' if accepted else 'declined'}; applied to {applied_count} profile(s)."
        )

    return changed_config
