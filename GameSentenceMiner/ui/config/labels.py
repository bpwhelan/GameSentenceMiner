from __future__ import annotations

from PyQt6.QtWidgets import QLabel
from enum import Enum
from typing import Any

from GameSentenceMiner.ui.qt_theme import get_theme_palette


class LabelColor(Enum):
    """Enum for different label color styles to indicate importance/category."""

    DEFAULT = "default"
    IMPORTANT = "important"
    ADVANCED = "advanced"
    RECOMMENDED = "recommended"
    WARNING = "warning"
    DEPRECATED = "deprecated"

    def get_qt_color(self) -> str:
        """Return the Qt color string for this label type."""
        colors = get_theme_palette()
        return colors[LABEL_COLOR_TOKENS[self.value]]


LABEL_COLOR_TOKENS = {
    "default": "text-primary",
    "important": "text-primary",
    "advanced": "danger-text",
    "recommended": "success-text",
    "warning": "danger-text",
    "deprecated": "danger-text",
}


def style_label(label: QLabel, color: LabelColor, bold: bool) -> None:
    label.setProperty("gsmLabelColor", color.value)
    label.setProperty("gsmLabelBold", bold)
    style = f"color: {color.get_qt_color()};"
    if bold:
        style += " font-weight: bold;"
    label.setStyleSheet(style)


def build_label(
    i18n: dict[str, Any],
    section: str,
    key: str,
    default_tooltip: str = "...",
    color: LabelColor = LabelColor.DEFAULT,
    bold: bool = False,
    label_override: str | None = None,
) -> QLabel:
    """Create a QLabel with text + tooltip from the i18n dict."""
    data = i18n.get(section, {}).get(key, {})
    label_text = data.get("label")
    if label_override:
        label_text = label_override
    if not label_text:
        label_text = " ".join(word.capitalize() for word in key.split("_"))
    label = QLabel(label_text)
    label.setToolTip(data.get("tooltip", default_tooltip))

    style_label(label, color, bold)
    return label
