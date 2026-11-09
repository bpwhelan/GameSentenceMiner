from PyQt6.QtWidgets import QFormLayout, QLabel, QPushButton, QSpinBox, QWidget

from ..labels import LabelColor, style_label


def build_session_review_settings(window, binder, i18n):
    labels = i18n.get("tabs", {}).get("session_review", {})
    widget = QWidget()
    layout = QFormLayout(widget)
    layout.setFieldGrowthPolicy(QFormLayout.FieldGrowthPolicy.AllNonFixedFieldsGrow)
    description = QLabel(
        labels.get(
            "description",
            "Mine without interruption. GSM updates cards during play and keeps their replay, audio, screenshots, and dialogue for editing after the game closes. Pending reviews survive restarts.",
        )
    )
    description.setWordWrap(True)
    layout.addRow(description)
    future_lines = QSpinBox()
    future_lines.setRange(0, 100)
    future_lines.setToolTip(
        labels.get(
            "max_future_context_lines_tooltip",
            "Save one extra replay after this many following dialogue lines. It is used only if you add future context during review, and deleted when confirmed. 0 disables this capture.",
        )
    )
    window.session_review_future_lines_spin = future_lines
    binder.bind(("profile", "features", "review_after_session", "max_future_context_lines"), future_lines)
    future_label = QLabel(labels.get("max_future_context_lines", "Maximum future context lines"))
    future_label.setToolTip(future_lines.toolTip())
    style_label(future_label, LabelColor.WARNING, bold=True)
    layout.addRow(future_label, future_lines)
    review = QPushButton(labels.get("review_now", "Review pending cards now"))

    def open_review():
        from GameSentenceMiner.ui.session_review_qt import open_session_review

        if window.save_settings(show_indicator=False):
            open_session_review()

    review.clicked.connect(open_review)
    layout.addRow(review)
    note = QLabel(
        labels.get(
            "storage_note",
            "Saved replays use disk space until reviewed. Closing the review window leaves unfinished cards in the queue. Anki must be open to save edits.",
        )
    )
    note.setWordWrap(True)
    layout.addRow(note)
    return widget
