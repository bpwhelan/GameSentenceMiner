import json
from pathlib import Path

import flask
import pytest

from GameSentenceMiner.web import ocr_area_selector_api


@pytest.fixture()
def config_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(ocr_area_selector_api, "get_ocr_config_path", lambda: str(tmp_path))
    return tmp_path


@pytest.fixture()
def client(config_dir):
    test_app = flask.Flask(
        __name__,
        template_folder="../../GameSentenceMiner/web/templates",
        static_folder="../../GameSentenceMiner/web/static",
    )
    test_app.config["TESTING"] = True
    ocr_area_selector_api.register_ocr_area_selector_routes(test_app)
    return test_app.test_client()


def _write_config(path: Path):
    path.write_text(
        json.dumps(
            {
                "scene": "Test Game",
                "coordinate_system": "percentage",
                "language": "ja",
                "window": "Test Window",
                "window_geometry": {"left": 10, "top": 20, "width": 1920, "height": 1080},
                "rectangles": [
                    {
                        "monitor": {"index": 0, "left": 0, "top": 0, "width": 1920, "height": 1080},
                        "coordinates": [0.1, 0.2, 0.3, 0.25],
                        "is_excluded": False,
                        "is_secondary": True,
                        "is_exclusive": False,
                        "is_black_hole": False,
                    }
                ],
            }
        ),
        encoding="utf-8",
    )


def test_select_areas_page_loads_canvas_editor(client):
    response = client.get("/select_areas")

    assert response.status_code == 200
    assert b'id="areaCanvas"' in response.data
    assert b"/static/js/ocr-area-selector.js" in response.data


def test_config_list_only_includes_area_configs(client, config_dir):
    _write_config(config_dir / "Test Game.json")
    (config_dir / "Test Game_config.json").write_text('{"furigana_filter_sensitivity": 4}', encoding="utf-8")
    (config_dir / "selector_ui_state.json").write_text("{}", encoding="utf-8")

    response = client.get("/api/ocr-area-selector/configs")

    assert response.status_code == 200
    assert [item["name"] for item in response.get_json()["configs"]] == ["Test Game.json"]


def test_load_config_returns_normalized_rectangles(client, config_dir):
    _write_config(config_dir / "Test Game.json")

    response = client.get("/api/ocr-area-selector/config", query_string={"name": "Test Game.json"})
    payload = response.get_json()

    assert response.status_code == 200
    assert payload["image_size"] == {"width": 1920, "height": 1080}
    assert payload["rectangles"][0]["coordinates"] == [0.1, 0.2, 0.3, 0.25]
    assert payload["rectangles"][0]["is_secondary"] is True


def test_current_config_creates_config_for_active_obs_scene(client, config_dir, monkeypatch):
    monkeypatch.setattr(ocr_area_selector_api.obs, "get_current_scene", lambda: "Test/Game: Scene")

    response = client.get("/api/ocr-area-selector/current-config")
    payload = response.get_json()

    assert response.status_code == 200
    assert payload["name"] == "TestGameScene.json"
    assert payload["scene"] == "TestGameScene"
    assert payload["rectangles"] == []
    assert (config_dir / "TestGameScene.json").exists()


def test_save_config_preserves_metadata_and_writes_percentage_rectangles(client, config_dir):
    config_path = config_dir / "Test Game.json"
    _write_config(config_path)

    response = client.post(
        "/api/ocr-area-selector/config",
        json={
            "name": "Test Game.json",
            "image_size": {"width": 1280, "height": 720},
            "rectangles": [
                {
                    "monitor": {"index": 0},
                    "coordinates": [0.2, 0.25, 0.4, 0.3],
                    "is_excluded": True,
                    "is_secondary": False,
                    "is_exclusive": False,
                    "is_black_hole": False,
                }
            ],
        },
    )

    assert response.status_code == 200
    saved = json.loads(config_path.read_text(encoding="utf-8"))
    assert saved["language"] == "ja"
    assert saved["window"] == "Test Window"
    assert saved["coordinate_system"] == "percentage"
    assert saved["rectangles"][0]["coordinates"] == [0.2, 0.25, 0.4, 0.3]
    assert saved["rectangles"][0]["is_excluded"] is True


def test_config_api_rejects_path_traversal(client):
    response = client.get("/api/ocr-area-selector/config", query_string={"name": "../outside.json"})

    assert response.status_code == 400
