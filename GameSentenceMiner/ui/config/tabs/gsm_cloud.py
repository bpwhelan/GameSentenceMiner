from __future__ import annotations

from typing import TYPE_CHECKING

from PyQt6.QtWidgets import QFormLayout, QHBoxLayout, QWidget

if TYPE_CHECKING:
    from GameSentenceMiner.ui.config_gui_qt import ConfigWindow


def build_gsm_cloud_tab(window: ConfigWindow, i18n: dict) -> QWidget:
    widget = QWidget()
    layout = QFormLayout(widget)
    layout.setFieldGrowthPolicy(QFormLayout.FieldGrowthPolicy.AllNonFixedFieldsGrow)

    layout.addRow("Status", window.gsm_cloud_status_label)
    layout.addRow("Authenticated User", window.gsm_cloud_user_id_edit)
    layout.addRow("Token Expires", window.gsm_cloud_token_expiry_edit)

    actions_widget = QWidget()
    actions_layout = QHBoxLayout(actions_widget)
    actions_layout.setContentsMargins(0, 0, 0, 0)
    actions_layout.addWidget(window.gsm_cloud_authenticate_button)
    actions_layout.addWidget(window.gsm_cloud_sign_out_button)
    actions_layout.addWidget(window.gsm_cloud_sync_now_button)
    actions_layout.addStretch(1)

    layout.addRow("Actions", actions_widget)
    return widget
