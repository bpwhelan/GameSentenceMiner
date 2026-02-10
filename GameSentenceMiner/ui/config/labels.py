from __future__ import annotations

from PyQt6.QtWidgets import QLabel
from enum import Enum
from typing import Any


class LabelColor(Enum):
    """Enum for different label color styles to indicate importance/category."""

    DEFAULT = "default"  # White/default color
    IMPORTANT = "important"  # Orange - important settings
    ADVANCED = "advanced"  # Red - advanced/dangerous settings
    RECOMMENDED = "recommended"  # Green - recommended settings

    def get_qt_color(self) -> str:
        """Return the Qt color string for this label type."""
        color_map = {
            LabelColor.DEFAULT: "white",
            LabelColor.IMPORTANT: "#FFA500",  # Orange
            LabelColor.ADVANCED: "#FF0000",  # Red
            LabelColor.RECOMMENDED: "#00FF00",  # Green
        }
        return color_map.get(self, "white")


def build_label(
    i18n: dict[str, Any],
    section: str,
    key: str,
    default_tooltip: str = "...",
    color: LabelColor = LabelColor.DEFAULT,
    bold: bool = False,
) -> QLabel:
    """Create a QLabel with text + tooltip from the i18n dict."""
    data = i18n.get(section, {}).get(key, {})
    label_text = data.get("label")
    if not label_text:
        label_text = " ".join(word.capitalize() for word in key.split("_"))
    label = QLabel(label_text)
    label.setToolTip(data.get("tooltip", default_tooltip))

    style_parts = []
    if color != LabelColor.DEFAULT:
        style_parts.append(f"color: {color.get_qt_color()};")
    if bold:
        style_parts.append("font-weight: bold;")
    if style_parts:
        label.setStyleSheet(" ".join(style_parts))
    return label
