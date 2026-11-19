from GameSentenceMiner.obs import actions, active_game
from GameSentenceMiner.ocr import native_context


def test_desktop_consumers_share_scene_target_and_minimized_activity(monkeypatch):
    from GameSentenceMiner.obs import desktop_session

    monkeypatch.setenv("GSM_NATIVE_GAME_SESSION", "1")
    monkeypatch.setenv("GSM_CLIENT_ID", "backend")
    state = {
        "scene": "Game A",
        "target_id": 812,
        "target_pid": 42,
        "active": True,
        "available": False,
        "capture_kind": "window",
        "source_name": "Game Capture",
        "window_info": {"exe": "game.exe"},
    }
    monkeypatch.setattr(desktop_session, "_state", state)
    assert actions.get_current_scene() == actions.get_current_game() == "Game A"
    assert active_game.get_active_game_snapshot(None) == {"sceneName": "Game A", "active": True}
    assert native_context.context_snapshot()["target_id"] == 812
    assert native_context.context_snapshot()["available"] is False
    assert native_context.handle_result({"data": {"ocr_scene": "Game B"}})["status"] == "rejected"


def test_managed_editor_preserves_desktop_profile_and_persists_edits(tmp_path):
    import json

    from GameSentenceMiner.util.config.desktop_profile import write_settings

    path = tmp_path / "config.json"
    path.write_text(json.dumps({"current_profile": "Game", "configs": {"Default": {}, "Game": {}}}))
    write_settings(path, {"current_profile": "Default", "configs": {"Default": {"scenes": ["Other"]}, "Game": {}}})
    saved = json.loads(path.read_text())
    assert saved["current_profile"] == "Game"
    assert saved["configs"]["Default"]["scenes"] == ["Other"]
    write_settings(path, {"current_profile": "Default", "configs": {"Default": {}}})
    assert json.loads(path.read_text())["current_profile"] == "Default"


def test_session_subscription_clears_capture_on_disconnect(monkeypatch):
    import asyncio
    from types import SimpleNamespace

    from GameSentenceMiner.obs import desktop_session
    from GameSentenceMiner.util.communication import bus_client
    from GameSentenceMiner.util.config import configuration

    async def exercise():
        after = []
        applied = asyncio.Event()
        offline = asyncio.Event()
        seen = []
        loop = asyncio.get_running_loop()
        state = dict(desktop_session._EMPTY, scene="New", available=True, revision=5, profile="Gaming")
        master = SimpleNamespace(configs={"Gaming": {}}, current_profile="Default")

        async def request(dst, topic, data, timeout):
            assert dst == bus_client.MAIN and topic == "game.session"
            after.append(data["after"])
            if len(after) == 1:
                return state
            await applied.wait()
            raise ConnectionError()

        def observe(previous, latest):
            seen.append((previous["scene"], latest["scene"], latest["available"]))
            loop.call_soon_threadsafe((applied if latest["scene"] else offline).set)

        monkeypatch.setattr(bus_client, "get_bus", lambda: SimpleNamespace(request_async=request))
        monkeypatch.setattr(configuration, "get_master_config", lambda: master)
        monkeypatch.setattr(desktop_session, "_state", desktop_session._EMPTY)
        monkeypatch.setattr(configuration.gsm_state, "current_game", "")
        task = asyncio.create_task(desktop_session.watch(observe))
        try:
            await asyncio.wait_for(offline.wait(), 2)
            assert after == [None, 5]
            assert seen == [("", "New", True), ("New", "", False)]
            assert master.current_profile == "Gaming"
            assert desktop_session.snapshot()["target_id"] is None
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    asyncio.run(exercise())


def test_overlay_can_use_obs_while_an_unresolved_window_waits_for_ocr(monkeypatch):
    from GameSentenceMiner.obs import desktop_session
    from GameSentenceMiner.util.overlay.capture_state import get_overlay_capture_state

    monkeypatch.setenv("GSM_NATIVE_GAME_SESSION", "1")
    monkeypatch.setenv("GSM_CLIENT_ID", "backend")
    state = dict(desktop_session._EMPTY, scene="Browser", active=True, obs_fallback_available=True)
    monkeypatch.setattr(desktop_session, "_state", state)
    assert get_overlay_capture_state(None)["available"] is True
    assert native_context.context_snapshot()["available"] is False
