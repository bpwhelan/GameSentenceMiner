import os

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PyQt6.QtCore import Qt
from PyQt6.QtGui import QColor
from PyQt6.QtWidgets import QApplication

from GameSentenceMiner.ocr.ss_picker_qt import create_high_visibility_crosshair_cursor


def test_high_visibility_crosshair_has_contrasting_layers_and_center_hotspot():
    app = QApplication.instance() or QApplication([])

    cursor = create_high_visibility_crosshair_cursor()
    pixmap = cursor.pixmap()
    image = pixmap.toImage()
    colors = {
        QColor(image.pixelColor(x, y)).name()
        for x in range(image.width())
        for y in range(image.height())
        if image.pixelColor(x, y).alpha() > 0
    }

    assert cursor.shape() == Qt.CursorShape.BitmapCursor
    assert cursor.hotSpot().x() == pixmap.width() // 2
    assert cursor.hotSpot().y() == pixmap.height() // 2
    assert "#000000" in colors
    assert "#00e5ff" in colors
    assert app is not None
