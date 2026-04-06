import sys
import json
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


def test_get_overlay_area_config_reads_overlay_rects(tmp_path, monkeypatch):
    overlay_config_path = tmp_path / "Scene_overlay.json"
    overlay_config_path.write_text(
        json.dumps(
            {
                "monitor_index": 2,
                "coordinate_system": "percentage",
                "rects": [{"x": 0.1, "y": 0.2, "w": 0.3, "h": 0.4}],
            }
        ),
        encoding="utf-8",
    )

    monkeypatch.setattr(
        gsm_ocr_config, "get_overlay_area_config_path", lambda *args, **kwargs: str(overlay_config_path)
    )
    monkeypatch.setattr(gsm_ocr_config.obs, "update_current_game", lambda: None)

    config = gsm_ocr_config.get_overlay_area_config()

    assert config is not None
    assert config.scene == "Scene"
    assert config.coordinate_system == "percentage"
    assert len(config.rectangles) == 1
    assert config.rectangles[0].monitor.index == 2
    assert config.rectangles[0].coordinates == [0.1, 0.2, 0.3, 0.4]
    assert config.rectangles[0].is_excluded is False
    assert config.rectangles[0].is_secondary is False
    assert getattr(config, "overlay_coordinate_space", None) == "monitor"


def test_get_overlay_area_config_reads_standard_rectangle_schema(tmp_path, monkeypatch):
    overlay_config_path = tmp_path / "Scene_overlay.json"
    overlay_config_path.write_text(
        json.dumps(
            {
                "scene": "Scene",
                "coordinate_system": "percentage",
                "window_geometry": {"left": 300, "top": 200, "width": 1280, "height": 720},
                "rectangles": [
                    {
                        "monitor": {"index": 0, "left": 0, "top": 0, "width": 1920, "height": 1080},
                        "coordinates": [0.1, 0.2, 0.3, 0.4],
                        "is_excluded": False,
                        "is_secondary": False,
                    }
                ],
            }
        ),
        encoding="utf-8",
    )

    monkeypatch.setattr(
        gsm_ocr_config, "get_overlay_area_config_path", lambda *args, **kwargs: str(overlay_config_path)
    )
    monkeypatch.setattr(gsm_ocr_config.obs, "update_current_game", lambda: None)

    config = gsm_ocr_config.get_overlay_area_config()

    assert config is not None
    assert config.scene == "Scene"
    assert config.window_geometry.left == 300
    assert config.window_geometry.top == 200
    assert config.window_geometry.width == 1280
    assert config.window_geometry.height == 720
    assert config.rectangles[0].coordinates == [0.1, 0.2, 0.3, 0.4]
    assert getattr(config, "overlay_coordinate_space", None) == "window"


def test_get_overlay_minimum_character_size_reads_overlay_scene_setting(tmp_path, monkeypatch):
    overlay_config_path = tmp_path / "Scene_overlay.json"
    overlay_config_path.write_text(
        json.dumps(
            {
                "monitor_index": 2,
                "coordinate_system": "percentage",
                "rects": [{"x": 0.1, "y": 0.2, "w": 0.3, "h": 0.4}],
                "minimum_character_size": 17,
            }
        ),
        encoding="utf-8",
    )

    monkeypatch.setattr(
        gsm_ocr_config, "get_overlay_area_config_path", lambda *args, **kwargs: str(overlay_config_path)
    )

    assert gsm_ocr_config.get_overlay_minimum_character_size(default=3) == 17


def test_write_overlay_scene_settings_preserves_existing_overlay_areas(tmp_path, monkeypatch):
    overlay_config_path = tmp_path / "Scene_overlay.json"
    overlay_config_path.write_text(
        json.dumps(
            {
                "monitor_index": 1,
                "coordinate_system": "percentage",
                "rects": [{"x": 0.2, "y": 0.3, "w": 0.4, "h": 0.5}],
            }
        ),
        encoding="utf-8",
    )

    monkeypatch.setattr(
        gsm_ocr_config, "get_overlay_area_config_path", lambda *args, **kwargs: str(overlay_config_path)
    )

    gsm_ocr_config.write_overlay_scene_settings({"minimum_character_size": 11})

    saved_data = json.loads(overlay_config_path.read_text(encoding="utf-8"))
    assert saved_data["minimum_character_size"] == 11
    assert saved_data["monitor_index"] == 1
    assert saved_data["coordinate_system"] == "percentage"
    assert saved_data["rects"] == [{"x": 0.2, "y": 0.3, "w": 0.4, "h": 0.5}]
