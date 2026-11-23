import asyncio
import os

import pytest

from GameSentenceMiner import obs
from GameSentenceMiner.obs import actions, service
from GameSentenceMiner.util.communication import bus_client


def test_managed_startup_never_opens_a_python_obs_socket(monkeypatch):
    monkeypatch.setenv("GSM_NATIVE_GAME_SESSION", "1")
    monkeypatch.setenv("GSM_CLIENT_ID", "backend")
    monkeypatch.setattr(obs, "obs_service", None)
    monkeypatch.setattr(service, "OBSService", lambda **kwargs: pytest.fail("Python opened an OBS connection"))
    asyncio.run(service.connect_to_obs(retry=1))
    service.connect_to_obs_sync(retry=1)
    assert obs.connection_pool is None


def test_managed_scene_list_uses_desktop_socket(monkeypatch):
    monkeypatch.setenv("GSM_NATIVE_GAME_SESSION", "1")
    monkeypatch.setenv("GSM_CLIENT_ID", "backend")
    calls = []

    class Bus:
        def request(self, dst, topic, data, **kwargs):
            calls.append((dst, topic, data["method"]))
            return {"response": {"scenes": [{"sceneName": "ゲーム"}]}}

    monkeypatch.setattr(bus_client, "get_bus", Bus)
    assert actions.get_obs_scenes() == [{"sceneName": "ゲーム"}]
    assert calls == [(bus_client.MAIN, "obs.request", "GetSceneList")]


def test_desktop_owned_ocr_worker_uses_a_separate_observer(monkeypatch):
    from GameSentenceMiner.obs import desktop_session

    monkeypatch.delenv("GSM_CLIENT_ID", raising=False)
    monkeypatch.setenv("GSM_OBS_READER_PORT", "1")
    monkeypatch.setenv("GSM_OBS_BACKEND_PID", str(os.getpid() + 1))
    attached = []
    monkeypatch.setattr(desktop_session, "reader_bus", lambda: attached.append(True))
    monkeypatch.setattr(service, "OBSService", lambda **kwargs: pytest.fail("OCR opened a direct OBS socket"))
    asyncio.run(service.connect_to_obs())
    service.connect_to_obs_sync()
    assert desktop_session.enabled() and attached == [True, True]


def test_large_screenshot_reads_one_capture_in_order(monkeypatch):
    from GameSentenceMiner.obs.desktop_client import client

    calls = []

    class Bus:
        def request(self, dst, topic, data, **kwargs):
            calls.append((topic, data))
            if topic == "obs.request":
                return {"transfer": "frame", "size": 7}
            assert data["id"] == "frame"
            return {0: "abcd", 4: "efg"}[data["offset"]]

    monkeypatch.setattr(bus_client, "get_bus", Bus)
    assert client.send("GetSourceScreenshot", raw=True) == {"imageData": "abcdefg"}
    assert len(calls) == 3
