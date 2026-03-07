import sys
from types import SimpleNamespace

from GameSentenceMiner.ocr.gsm_ocr_config import Monitor, OCRConfig, Rectangle
import GameSentenceMiner.ocr.gsm_ocr_config as gsm_ocr_config


def _build_percentage_config(*, window: str | None = None) -> OCRConfig:
    return OCRConfig(
        scene="scene",
        rectangles=[
            Rectangle(
                monitor=Monitor(index=0),
                coordinates=[0.101, 0.255, 0.504, 0.333],
                is_excluded=False,
            )
        ],
        coordinate_system="percentage",
        window=window,
    )


def test_scale_to_custom_size_rounds_up_to_even_coordinates():
    config = _build_percentage_config()

    config.scale_to_custom_size(101, 99)

    assert config.rectangles[0].coordinates == [12, 26, 52, 34]
    assert all(coord % 2 == 0 for coord in config.rectangles[0].coordinates)


def test_scale_coords_rounds_up_to_even_coordinates(monkeypatch):
    config = _build_percentage_config(window="My Window")

    dummy_window = SimpleNamespace(left=0, top=0, width=101, height=99)
    monkeypatch.setitem(sys.modules, "pygetwindow", SimpleNamespace())
    monkeypatch.setattr(gsm_ocr_config, "set_dpi_awareness", lambda: None)
    monkeypatch.setattr(gsm_ocr_config, "get_window", lambda _title: dummy_window)

    config.scale_coords()

    assert config.rectangles[0].coordinates == [12, 26, 52, 34]
    assert all(coord % 2 == 0 for coord in config.rectangles[0].coordinates)
