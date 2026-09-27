from GameSentenceMiner.util.platform import base_window_monitor
from GameSentenceMiner.web import texthooking_page


def test_set_scene_target_process_holds_the_basename_in_memory(monkeypatch):
    monkeypatch.setattr(base_window_monitor, "_scene_linux_target", "")
    client = texthooking_page.app.test_client()

    response = client.post("/linux/set_scene_target_process", json={"target": "S:\\Games\\Game\\game_.exe"})

    assert response.status_code == 200
    assert response.get_json() == {"success": True, "scene_target_process": "game_.exe"}
    assert base_window_monitor._scene_linux_target == "game_.exe"


def test_set_scene_target_process_clears_with_an_empty_target(monkeypatch):
    monkeypatch.setattr(base_window_monitor, "_scene_linux_target", "game_.exe")
    client = texthooking_page.app.test_client()

    response = client.post("/linux/set_scene_target_process", json={"target": ""})

    assert response.get_json() == {"success": True, "scene_target_process": ""}
    assert base_window_monitor._scene_linux_target == ""
