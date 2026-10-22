import pytest
from PIL import Image

from GameSentenceMiner.ocr.preview import PreviewGeometry, build_preview_geometry, capture_preview


def payload(lines=None, **processing):
    return {
        "pipeline": {
            "capture": {"scaled_size": {"width": 1000, "height": 500}},
            "processing": {"coordinate_mode": "source_content", "crop_offset": {"x": 100, "y": 250}, **processing},
        },
        "line_coords": lines
        if lines is not None
        else [
            {
                "text": "こんにちは",
                "bounding_rect": {"x1": 0, "y1": 0, "x2": 200, "y2": 0, "x3": 200, "y3": 50, "x4": 0, "y4": 50},
            }
        ],
    }


def test_preview_boxes_map_cropped_ocr_coordinates_back_to_the_full_source():
    geometry = build_preview_geometry(payload())
    assert geometry["sourceWidth"] == 1000
    assert geometry["boxes"][0] == {"text": "こんにちは", "points": [[0.1, 0.5], [0.3, 0.5], [0.3, 0.6], [0.1, 0.6]]}


def test_detector_boxes_follow_packed_region_offsets():
    data = payload([], crop_offset={"regions": [{"dest": [0, 0, 200, 50], "src": [700, 350]}]})
    data["boxes"] = [{"box": [10, 5, 110, 25]}]
    geometry = build_preview_geometry(data)
    assert geometry["boxes"][0]["points"] == [[0.71, 0.71], [0.81, 0.71], [0.81, 0.75], [0.71, 0.75]]


@pytest.mark.parametrize(
    "data",
    [None, {}, payload([], coordinate_mode="absolute_screen"), payload([{"bounding_rect": {"x1": float("nan")}}])],
)
def test_preview_rejects_unmapped_or_invalid_coordinates(data):
    geometry = build_preview_geometry(data)
    assert geometry is None or geometry["boxes"] == []


def test_preview_lease_avoids_work_without_a_viewer_and_clears_old_scene_boxes():
    now = [0.0]
    preview = PreviewGeometry(clock=lambda: now[0])
    assert not preview.enabled
    preview.update(payload(), scene_name="Game", source_name="Window")
    assert preview.snapshot({"enabled": True, "sceneName": "Game"}) is None
    preview.update(payload(), scene_name="Game", source_name="Window")
    assert preview.snapshot({"enabled": True, "sceneName": "Game"})["boxes"]
    assert preview.snapshot({"enabled": True, "sceneName": "Other game"}) is None
    now[0] = 10
    assert not preview.enabled
    assert preview.snapshot({"enabled": True, "sceneName": "Game"}) is None


def test_empty_detection_replaces_previous_boxes():
    preview = PreviewGeometry()
    preview.snapshot({"enabled": True, "sceneName": "Game"})
    preview.update(payload(), scene_name="Game", source_name="Window")
    preview.update(payload([]), scene_name="Game", source_name="Window")
    assert preview.snapshot({"enabled": True, "sceneName": "Game"})["boxes"] == []


def test_frame_capture_is_read_only_source_scoped_and_preserves_aspect_ratio(monkeypatch):
    from GameSentenceMiner import obs

    calls = []
    monkeypatch.setattr(obs, "get_current_scene", lambda: "Game")
    monkeypatch.setattr(obs, "get_source_from_scene", lambda _scene: {"sourceName": "Window"})
    monkeypatch.setattr(
        obs, "get_screenshot_PIL", lambda **kwargs: calls.append(kwargs) or Image.new("RGB", (960, 720))
    )
    result = capture_preview({"sceneId": "id", "sceneName": "Game"})
    assert result["imageData"].startswith("data:image/jpeg;base64,")
    assert (result["width"], result["height"], result["sourceName"]) == (960, 720, "Window")
    assert calls[0]["source_name"] == "Window"
    assert calls[0]["width"] == 960
    assert "height" not in calls[0]
    assert capture_preview({"sceneId": "other", "sceneName": "Other game"}) is None
    assert len(calls) == 1


def test_scene_changes_during_capture_cannot_return_the_old_game(monkeypatch):
    from GameSentenceMiner import obs

    scenes = iter(["Game", "Other game"])
    monkeypatch.setattr(obs, "get_current_scene", lambda: next(scenes))
    monkeypatch.setattr(obs, "get_source_from_scene", lambda _scene: {"sourceName": "Window"})
    monkeypatch.setattr(obs, "get_screenshot_PIL", lambda **kwargs: Image.new("RGB", (320, 180)))
    assert capture_preview({"sceneId": "id", "sceneName": "Game"}) is None


def test_pipeline_keeps_the_capture_identity_for_queued_ocr_results(monkeypatch):
    from GameSentenceMiner.ocr import gsm_ocr
    from GameSentenceMiner.owocr.owocr.ocr_runtime import _build_pipeline_metadata

    with Image.new("RGB", (200, 50)) as image:
        pipeline = _build_pipeline_metadata(
            {"scene_name": "Previous game", "source_name": "Previous window"}, image, "screenai", False
        )
    updates = []

    class Preview:
        enabled = True

        def update(self, data, **identity):
            updates.append(identity)

    monkeypatch.setattr(gsm_ocr, "preview_geometry", Preview())
    gsm_ocr._update_capture_preview({"pipeline": pipeline})
    assert updates == [{"scene_name": "Previous game", "source_name": "Previous window"}]
    gsm_ocr._update_capture_preview({"pipeline": {"capture": {}}})
    assert len(updates) == 1
