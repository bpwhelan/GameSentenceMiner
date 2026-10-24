import asyncio
import json
from types import SimpleNamespace

from GameSentenceMiner.util.config.configuration import Overlay
from GameSentenceMiner.web import overlay_handler as overlay_handler_module


def test_magpie_notification_wakes_the_existing_monitor(monkeypatch):
    calls = []
    monitor = SimpleNamespace(request_refresh=lambda: calls.append("refresh"))
    monkeypatch.setattr(
        overlay_handler_module, "get_overlay_processor", lambda: SimpleNamespace(window_monitor=monitor)
    )
    asyncio.run(overlay_handler_module.OverlayRequestHandler().handle_message('{"type":"magpie-state-request"}'))
    assert calls == ["refresh"]


def test_focus_acknowledgement_reports_completion_and_rejects_a_previous_target(monkeypatch):
    sent, activated, refreshed = [], [], []

    async def activate():
        activated.append(True)
        return True

    async def send(_id, payload):
        sent.append(payload)

    monitor = SimpleNamespace(
        target_hwnd=42, activate_target_window=activate, request_refresh=lambda: refreshed.append(True)
    )
    monkeypatch.setattr(
        overlay_handler_module, "get_overlay_processor", lambda: SimpleNamespace(window_monitor=monitor)
    )
    monkeypatch.setattr(overlay_handler_module.websocket_manager, "send", send)
    handler = overlay_handler_module.OverlayRequestHandler()
    for expected in [42, 7]:
        asyncio.run(
            handler.handle_restore_focus_request({"request_id": str(expected), "expected_target_hwnd": expected})
        )
    assert len(activated) == 1
    assert len(refreshed) == 2
    assert sent == [
        {"type": "restore-focus-result", "request_id": "42", "success": True},
        {"type": "restore-focus-result", "request_id": "7", "success": False},
    ]


def test_missing_monitor_returns_a_failed_focus_acknowledgement(monkeypatch):
    sent = []

    async def send(_id, payload):
        sent.append(payload)

    monkeypatch.setattr(overlay_handler_module, "get_overlay_processor", lambda: SimpleNamespace(window_monitor=None))
    monkeypatch.setattr(overlay_handler_module.websocket_manager, "send", send)
    asyncio.run(overlay_handler_module.OverlayRequestHandler().handle_restore_focus_request({"request_id": "gone"}))
    assert sent == [{"type": "restore-focus-result", "request_id": "gone", "success": False}]


def test_new_overlay_interaction_cancels_backend_focus_retries(monkeypatch):
    async def scenario():
        started = asyncio.Event()
        focused = []

        async def activate():
            started.set()
            await asyncio.sleep(1)
            focused.append(True)
            return True

        async def send(*_):
            pass

        monitor = SimpleNamespace(target_hwnd=42, activate_target_window=activate, request_refresh=lambda: None)
        monkeypatch.setattr(
            overlay_handler_module, "get_overlay_processor", lambda: SimpleNamespace(window_monitor=monitor)
        )
        monkeypatch.setattr(overlay_handler_module.websocket_manager, "send", send)
        handler = overlay_handler_module.OverlayRequestHandler()
        task = asyncio.create_task(handler.handle_restore_focus_request({"request_id": "cancel-me"}))
        await started.wait()
        await handler.handle_message('{"type":"restore-focus-cancel","request_id":"cancel-me"}')
        result = await asyncio.gather(task, return_exceptions=True)
        assert isinstance(result[0], asyncio.CancelledError)
        assert focused == []
        assert handler._focus_restore_tasks == {}

    asyncio.run(scenario())


def test_quick_actions_toggle_intake_and_return_authoritative_state(monkeypatch):
    import GameSentenceMiner

    paused = [False]
    sent = []

    def toggle():
        paused[0] = not paused[0]

    async def send(server_id, payload):
        sent.append(payload)

    monkeypatch.setattr(
        GameSentenceMiner,
        "gametext",
        SimpleNamespace(is_text_intake_paused=lambda: paused[0], toggle_text_intake_paused=toggle),
        raising=False,
    )
    monkeypatch.setattr(overlay_handler_module, "get_all_lines", list)
    monkeypatch.setattr(overlay_handler_module.websocket_manager, "send", send)
    handler = overlay_handler_module.OverlayRequestHandler()
    for action in ["state", "toggle-intake", "state"]:
        asyncio.run(
            handler.handle_message(json.dumps({"type": "quick-action-request", "request_id": action, "action": action}))
        )
    assert [payload["paused"] for payload in sent] == [False, True, True]
    assert all(payload["type"] == "quick-action-result" and payload["success"] for payload in sent)
    assert all(payload["canReplay"] is False for payload in sent)


def test_quick_action_replay_uses_latest_line_without_requiring_an_external_player(monkeypatch):
    from GameSentenceMiner.util.config.configuration import gsm_state
    from GameSentenceMiner.web import service

    latest = SimpleNamespace(id="latest", text="Latest line")
    calls = []
    sent = []

    async def send(server_id, payload):
        sent.append(payload)

    monkeypatch.setattr(overlay_handler_module, "get_all_lines", lambda: [SimpleNamespace(), latest])
    monkeypatch.setattr(
        overlay_handler_module,
        "get_config",
        lambda: SimpleNamespace(advanced=SimpleNamespace(audio_player_path="", video_player_path="")),
    )
    monkeypatch.setattr(overlay_handler_module, "save_replay_buffer", lambda: calls.append("replay"), raising=False)
    monkeypatch.setattr(gsm_state, "line_for_audio", None)
    monkeypatch.setattr(gsm_state, "previous_line_for_audio", None)
    monkeypatch.setattr(gsm_state, "previous_line_for_screenshot", None)
    monkeypatch.setattr(gsm_state, "texthooker_audio_request", {})
    monkeypatch.setattr(service, "has_cached_texthooker_audio", lambda *args: False)
    monkeypatch.setattr(overlay_handler_module.websocket_manager, "send", send)
    handler = overlay_handler_module.OverlayRequestHandler()
    asyncio.run(
        handler.handle_message(
            json.dumps({"type": "quick-action-request", "request_id": "audio", "action": "replay-audio"})
        )
    )
    assert gsm_state.line_for_audio is latest
    assert calls == ["replay"]
    assert sent[0]["success"] is True
    assert gsm_state.texthooker_audio_request == {
        "line_id": "latest",
        "trim_with_vad": False,
        "playback_mode": "native",
    }
    monkeypatch.setattr(service, "has_cached_texthooker_audio", lambda *args: True)
    monkeypatch.setattr(service, "handle_texthooker_button", lambda *args: calls.append("cached-playback"))
    asyncio.run(handler.handle_message(json.dumps({"type": "quick-action-request", "action": "replay-audio"})))
    assert calls == ["replay", "cached-playback"]


def test_quick_action_rejects_unknown_commands_and_empty_replays(monkeypatch):
    sent = []

    async def send(server_id, payload):
        sent.append(payload)

    monkeypatch.setattr(overlay_handler_module, "get_all_lines", list)
    monkeypatch.setattr(overlay_handler_module.websocket_manager, "send", send)
    handler = overlay_handler_module.OverlayRequestHandler()
    for action in ["exec", "replay-audio"]:
        asyncio.run(
            handler.handle_message(json.dumps({"type": "quick-action-request", "request_id": action, "action": action}))
        )
    assert len(sent) == 2
    assert all(payload["success"] is False and payload["error"] for payload in sent)


def test_today_stats_request_runs_off_websocket_loop_and_broadcasts_daily_payload(monkeypatch):
    import threading

    from GameSentenceMiner.util.stats import live_stats

    loop_thread = threading.get_ident()
    worker_threads = []
    sent = []
    payload = {"type": "live_stats_update", "scope": "today", "values": {"total_characters": 123}}

    def build(tracker, *, reason, game_name):
        worker_threads.append(threading.get_ident())
        assert tracker is live_stats.live_stats_tracker
        assert reason == "refresh"
        assert game_name == "Selected Game"
        return payload

    async def send(server_id, message):
        sent.append((server_id, message))

    monkeypatch.setattr(live_stats, "build_today_live_stats_payload", build, raising=False)
    monkeypatch.setattr(overlay_handler_module, "get_current_game", lambda **kwargs: "Selected Game")
    monkeypatch.setattr(overlay_handler_module.websocket_manager, "send", send)
    handler = overlay_handler_module.OverlayRequestHandler()
    asyncio.run(handler.handle_message(json.dumps({"type": "get-live-stats-today", "reason": "refresh"})))

    assert worker_threads and all(thread != loop_thread for thread in worker_threads)
    assert sent == [(overlay_handler_module.ID_OVERLAY, payload)]


def test_today_stats_coalesces_requests_while_history_is_loading(monkeypatch):
    from concurrent.futures import Future

    from GameSentenceMiner.util.concurrency import work_pool

    future = Future()
    calls = []
    sent = []
    payload = {"type": "live_stats_update", "scope": "today"}

    def submit(*args, **kwargs):
        calls.append((args, kwargs))
        return future

    async def send(server_id, message):
        sent.append(message)

    monkeypatch.setattr(work_pool, "submit_background_work", submit)
    monkeypatch.setattr(overlay_handler_module.websocket_manager, "send", send)

    async def scenario():
        handler = overlay_handler_module.OverlayRequestHandler()
        message = json.dumps({"type": "get-live-stats-today"})
        first = asyncio.create_task(handler.handle_message(message))
        await asyncio.sleep(0)
        await handler.handle_message(message)
        assert len(calls) == 1
        assert not sent
        future.set_result(payload)
        await first
        assert sent == [payload]

    asyncio.run(scenario())


def test_today_stats_rebuilds_if_active_game_changes_while_loading(monkeypatch):
    from GameSentenceMiner.util.stats import live_stats

    current_game = ["First Game"]
    built = []
    sent = []

    def build(tracker, *, reason, game_name):
        built.append(game_name)
        if game_name == "First Game":
            current_game[0] = "Second Game"
        return {"type": "live_stats_update", "scope": "today", "game_name": game_name}

    async def send(server_id, payload):
        sent.append(payload)

    monkeypatch.setattr(overlay_handler_module, "get_current_game", lambda **kwargs: current_game[0])
    monkeypatch.setattr(live_stats, "build_today_live_stats_payload", build)
    monkeypatch.setattr(overlay_handler_module.websocket_manager, "send", send)
    handler = overlay_handler_module.OverlayRequestHandler()
    asyncio.run(handler.handle_message(json.dumps({"type": "get-live-stats-today"})))

    assert built == ["First Game", "Second Game"]
    assert [payload["game_name"] for payload in sent] == ["Second Game"]


def _setup_block_translation(monkeypatch, translate):
    sent = []

    async def send(server_id, message):
        sent.append(message)

    monkeypatch.setattr(
        overlay_handler_module,
        "get_config",
        lambda: SimpleNamespace(ai=SimpleNamespace(is_configured=lambda: True, provider="Gemini")),
    )
    monkeypatch.setattr(overlay_handler_module, "get_current_game", lambda **kwargs: "Game")
    monkeypatch.setattr(overlay_handler_module, "get_all_lines", list)
    monkeypatch.setattr(overlay_handler_module, "translate_overlay_blocks", translate)
    monkeypatch.setattr(overlay_handler_module.websocket_manager, "send", send)
    return sent


def test_overlay_custom_question_uses_textfeed_analysis_and_preserves_request_identity(monkeypatch):
    sent = _setup_block_translation(monkeypatch, lambda *args: None)
    calls = []

    def analyze(*args):
        calls.append(args)
        return "Particle explanation"

    monkeypatch.setattr(overlay_handler_module, "get_sentence_analysis", analyze)
    handler = overlay_handler_module.OverlayRequestHandler()
    message = {
        "type": "translate-request",
        "request_id": "custom-1",
        "blocks": [{"id": "0", "text": "猫がいる"}],
        "mode": "custom",
        "question": "Why が here?",
    }
    asyncio.run(handler.handle_message(json.dumps(message)))
    assert calls[0][1] == "猫がいる"
    assert calls[0][-2:] == ("custom", "Why が here?")
    assert sent == [
        {
            "type": "translation-result",
            "data": {"request_id": "custom-1", "text": "Particle explanation", "mode": "custom"},
        }
    ]


def test_overlay_custom_question_rejects_missing_or_oversized_questions(monkeypatch):
    sent = _setup_block_translation(monkeypatch, lambda *args: None)
    handler = overlay_handler_module.OverlayRequestHandler()
    for question in ["", " " * 5, "a" * 4001, None]:
        asyncio.run(
            handler.handle_message(
                json.dumps(
                    {
                        "type": "translate-request",
                        "request_id": "invalid-question",
                        "blocks": [{"id": "0", "text": "猫"}],
                        "mode": "custom",
                        "question": question,
                    }
                )
            )
        )
    assert len(sent) == 4
    assert all(payload["type"] == "translation-error" for payload in sent)


def test_block_translation_uses_renderer_text_and_echoes_request_id(monkeypatch):
    calls = []

    def translate(lines, blocks, game):
        calls.append((lines, blocks, game))
        return [{"id": "dialogue", "translation": "Hello"}]

    sent = _setup_block_translation(monkeypatch, translate)
    message = {
        "type": "translate-request",
        "request_id": "frame-1",
        "blocks": [{"id": "dialogue", "text": "こんにちは"}],
    }
    handler = overlay_handler_module.OverlayRequestHandler()
    asyncio.run(handler.handle_message(json.dumps(message)))
    assert calls == [([], message["blocks"], "Game")]
    assert sent == [
        {
            "type": "translation-result",
            "data": {"request_id": "frame-1", "blocks": [{"id": "dialogue", "translation": "Hello"}]},
        }
    ]
    assert handler.processing is False


def test_block_translation_error_is_correlated_and_does_not_retry(monkeypatch):
    calls = []

    def translate(*args):
        calls.append(args)
        raise ValueError("Missing block")

    sent = _setup_block_translation(monkeypatch, translate)
    handler = overlay_handler_module.OverlayRequestHandler()
    asyncio.run(handler.handle_translation_request({"request_id": "bad", "blocks": [{"id": "0", "text": "test"}]}))
    assert len(calls) == 1
    assert sent == [{"type": "translation-error", "request_id": "bad", "error": "Translation failed: Missing block"}]
    assert handler.processing is False


def test_busy_block_translation_keeps_only_newest_waiting_frame(monkeypatch):
    async def scenario():
        handler = overlay_handler_module.OverlayRequestHandler()
        started = asyncio.Event()
        finish = asyncio.Event()
        calls = []

        async def perform(message):
            calls.append(message["request_id"])
            if message["request_id"] == "first":
                started.set()
                await finish.wait()

        monkeypatch.setattr(handler, "_perform_translation_request", perform)
        first = asyncio.create_task(handler.handle_translation_request({"request_id": "first", "blocks": []}))
        await started.wait()
        second = asyncio.create_task(handler.handle_translation_request({"request_id": "second", "blocks": []}))
        third = asyncio.create_task(handler.handle_translation_request({"request_id": "third", "blocks": []}))
        await asyncio.sleep(0)
        finish.set()
        await asyncio.gather(first, second, third)
        assert calls == ["first", "third"]

    asyncio.run(scenario())


def _build_master_config():
    current_config = SimpleNamespace(overlay=Overlay())
    master_config = SimpleNamespace(
        overlay=current_config.overlay,
        get_config=lambda: current_config,
    )
    return master_config, current_config


def _run_overlay_config_message(monkeypatch, message, *, sync_recycled=True):
    saved_configs = []
    sent_messages = []
    master_config, current_config = _build_master_config()
    handler = overlay_handler_module.OverlayRequestHandler()

    async def fake_send(server_id, message):
        sent_messages.append((server_id, message))

    monkeypatch.setattr(overlay_handler_module, "get_master_config", lambda: master_config)
    monkeypatch.setattr(overlay_handler_module, "save_full_config", lambda config: saved_configs.append(config))
    if sync_recycled:
        monkeypatch.setattr(handler, "_sync_recycled_line_cache", lambda enabled: None)
    monkeypatch.setattr(overlay_handler_module.websocket_manager, "send", fake_send)

    asyncio.run(handler.handle_message(json.dumps(message)))
    return current_config, saved_configs, sent_messages


def _capture_overlay_scan_call(monkeypatch, source):
    scan_calls = []

    def fake_scan(*args, **kwargs):
        scan_calls.append((args, kwargs))

        async def completed_scan():
            return None

        return completed_scan()

    class FakeFuture:
        def add_done_callback(self, callback):
            return None

    def fake_run_coroutine_threadsafe(coroutine, loop):
        coroutine.close()
        return FakeFuture()

    processor = SimpleNamespace(
        processing_loop=SimpleNamespace(is_running=lambda: True),
        find_box_and_send_to_overlay=fake_scan,
    )
    monkeypatch.setattr(overlay_handler_module, "get_overlay_processor", lambda: processor)
    monkeypatch.setattr(overlay_handler_module.asyncio, "run_coroutine_threadsafe", fake_run_coroutine_threadsafe)

    handler = overlay_handler_module.OverlayRequestHandler()
    asyncio.run(
        handler.handle_message(
            json.dumps(
                {
                    "type": "manual-overlay-scan-request",
                    "source": source,
                }
            )
        )
    )
    return scan_calls


def test_overlay_recycled_indicator_setting_saves_and_broadcasts_full_subset(monkeypatch):
    current_config, saved_configs, sent_messages = _run_overlay_config_message(
        monkeypatch,
        {
            "type": "set-gsm-overlay-config",
            "key": "check_previous_lines_for_recycled_indicator",
            "value": True,
        },
    )

    assert current_config.overlay.check_previous_lines_for_recycled_indicator is True
    assert saved_configs and saved_configs[0].overlay is current_config.overlay
    assert len(sent_messages) == 1
    server_id, payload = sent_messages[0]
    assert server_id == overlay_handler_module.ID_OVERLAY
    assert payload["type"] == "gsm-overlay-config-updated"
    # The echo carries the full GSM-owned subset (keyed by overlay userSettings keys).
    assert payload["settings"]["showRecycledIndicator"] is True
    assert "monitors" in payload


def test_overlay_config_rejects_unknown_key(monkeypatch):
    current_config, saved_configs, sent_messages = _run_overlay_config_message(
        monkeypatch,
        {"type": "set-gsm-overlay-config", "key": "unsupported", "value": True},
    )

    assert saved_configs == []
    assert sent_messages == []


def test_overlay_config_accepts_batch_with_coercion(monkeypatch):
    current_config, saved_configs, sent_messages = _run_overlay_config_message(
        monkeypatch,
        {
            "type": "set-gsm-overlay-config",
            "settings": {
                "minimum_character_size": "12",
                "periodic": True,
                "scan_on_overlay_activation": "true",
                "text_appears_instantly": "true",
                "adaptive_ocr_retries": "true",
                "engine_v2": "lens",
            },
        },
    )

    assert current_config.overlay.minimum_character_size == 12
    assert current_config.overlay.periodic is True
    assert current_config.overlay.scan_on_overlay_activation is True
    assert current_config.overlay.text_appears_instantly is True
    assert current_config.overlay.adaptive_ocr_retries is True
    assert current_config.overlay.engine_v2 == "lens"
    assert saved_configs  # saved once
    assert len(sent_messages) == 1
    assert sent_messages[0][1]["settings"]["scan_on_overlay_activation"] is True
    assert sent_messages[0][1]["settings"]["text_appears_instantly"] is True
    assert sent_messages[0][1]["settings"]["adaptive_ocr_retries"] is True


def test_overlay_config_applies_runtime_monitor_identity_before_saving(monkeypatch):
    master_config, current_config = _build_master_config()
    handler = overlay_handler_module.OverlayRequestHandler()
    saved_monitor_ids = []

    async def fake_send(server_id, message):
        return None

    def fake_runtime_side_effects(overlay, applied):
        assert applied == {"monitor_to_capture": 1}
        overlay.monitor_to_capture_id = "display-2"

    monkeypatch.setattr(overlay_handler_module, "get_master_config", lambda: master_config)
    monkeypatch.setattr(
        overlay_handler_module,
        "save_full_config",
        lambda config: saved_monitor_ids.append(config.get_config().overlay.monitor_to_capture_id),
    )
    monkeypatch.setattr(handler, "_apply_overlay_runtime_side_effects", fake_runtime_side_effects)
    monkeypatch.setattr(overlay_handler_module.websocket_manager, "send", fake_send)

    asyncio.run(
        handler.handle_message(
            json.dumps(
                {
                    "type": "set-gsm-overlay-config",
                    "key": "monitor_to_capture",
                    "value": 1,
                }
            )
        )
    )

    assert current_config.overlay.monitor_to_capture_id == "display-2"
    assert saved_monitor_ids == ["display-2"]


def test_overlay_config_confirmation_echoes_request_id(monkeypatch):
    _, saved_configs, sent_messages = _run_overlay_config_message(
        monkeypatch,
        {
            "type": "set-gsm-overlay-config",
            "request_id": "ocr-setting-17",
            "key": "periodic",
            "value": True,
        },
    )

    assert saved_configs
    assert sent_messages[0][1]["request_id"] == "ocr-setting-17"


def test_get_gsm_profile_state_broadcasts_authoritative_snapshot(monkeypatch):
    sent_messages = []
    expected_payload = {
        "type": "gsm-profile-state-updated",
        "currentProfileName": "Visual Novel",
        "profiles": [{"name": "Visual Novel", "scenes": ["Game"]}],
    }

    async def fake_send(server_id, message):
        sent_messages.append((server_id, message))

    monkeypatch.setattr(overlay_handler_module, "build_gsm_profile_state_payload", lambda: expected_payload)
    monkeypatch.setattr(overlay_handler_module.websocket_manager, "send", fake_send)

    handler = overlay_handler_module.OverlayRequestHandler()
    asyncio.run(handler.handle_message(json.dumps({"type": "get-gsm-profile-state"})))

    assert sent_messages == [(overlay_handler_module.ID_OVERLAY, expected_payload)]


def test_send_click_request_forwards_to_target_window(monkeypatch):
    calls = []

    async def fake_send_click(*, target_pid=None, activate_window=True, client_x=None, client_y=None):
        calls.append(
            {
                "target_pid": target_pid,
                "activate_window": activate_window,
                "client_x": client_x,
                "client_y": client_y,
            }
        )
        return True

    monitor = SimpleNamespace(target_hwnd=1234, send_click_to_target_window=fake_send_click)
    processor = SimpleNamespace(window_monitor=monitor)
    monkeypatch.setattr(overlay_handler_module, "get_overlay_processor", lambda: processor)

    handler = overlay_handler_module.OverlayRequestHandler()
    asyncio.run(
        handler.handle_message(json.dumps({"type": "send-click-request", "source": "gamepad", "activateWindow": True}))
    )

    assert calls == [{"target_pid": None, "activate_window": True, "client_x": 8, "client_y": 8}]


def test_send_click_request_ignored_without_target_window(monkeypatch):
    calls = []

    async def fake_send_click(*, target_pid=None, activate_window=True):
        calls.append(True)
        return True

    monitor = SimpleNamespace(target_hwnd=None, send_click_to_target_window=fake_send_click)
    processor = SimpleNamespace(window_monitor=monitor)
    monkeypatch.setattr(overlay_handler_module, "get_overlay_processor", lambda: processor)

    handler = overlay_handler_module.OverlayRequestHandler()
    asyncio.run(handler.handle_message(json.dumps({"type": "send-click-request"})))

    assert calls == []


def test_overlay_activation_scan_requests_95_percent_dedupe(monkeypatch):
    scan_calls = _capture_overlay_scan_call(monkeypatch, "overlay-activation:push-to-show")

    assert scan_calls == [
        (
            (),
            {
                "source": overlay_handler_module.TextSource.HOTKEY,
                "check_against_last": True,
                "custom_threshold": 0.95,
            },
        )
    ]


def test_explicit_overlay_scan_does_not_enable_activation_dedupe(monkeypatch):
    scan_calls = _capture_overlay_scan_call(monkeypatch, "gamepad")

    assert scan_calls == [
        (
            (),
            {
                "source": overlay_handler_module.TextSource.HOTKEY,
                "check_against_last": False,
                "custom_threshold": None,
            },
        )
    ]


def test_overlay_config_ignores_invalid_value(monkeypatch):
    current_config, saved_configs, sent_messages = _run_overlay_config_message(
        monkeypatch,
        {"type": "set-gsm-overlay-config", "key": "minimum_character_size", "value": "not-a-number"},
    )

    # Invalid value coerces to nothing applied -> no save, no broadcast.
    assert saved_configs == []
    assert sent_messages == []
