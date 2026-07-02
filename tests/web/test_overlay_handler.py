import asyncio
import json
from types import SimpleNamespace

from GameSentenceMiner.util.config.configuration import Overlay
from GameSentenceMiner.web import overlay_handler as overlay_handler_module


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
                "engine_v2": "lens",
            },
        },
    )

    assert current_config.overlay.minimum_character_size == 12
    assert current_config.overlay.periodic is True
    assert current_config.overlay.engine_v2 == "lens"
    assert saved_configs  # saved once
    assert len(sent_messages) == 1


def test_send_click_request_forwards_to_target_window(monkeypatch):
    calls = []

    async def fake_send_click(*, target_pid=None, activate_window=True):
        calls.append({"target_pid": target_pid, "activate_window": activate_window})
        return True

    monitor = SimpleNamespace(target_hwnd=1234, send_click_to_target_window=fake_send_click)
    processor = SimpleNamespace(window_monitor=monitor)
    monkeypatch.setattr(overlay_handler_module, "get_overlay_processor", lambda: processor)

    handler = overlay_handler_module.OverlayRequestHandler()
    asyncio.run(
        handler.handle_message(json.dumps({"type": "send-click-request", "source": "gamepad", "activateWindow": True}))
    )

    assert calls == [{"target_pid": None, "activate_window": True}]


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


def test_overlay_config_ignores_invalid_value(monkeypatch):
    current_config, saved_configs, sent_messages = _run_overlay_config_message(
        monkeypatch,
        {"type": "set-gsm-overlay-config", "key": "minimum_character_size", "value": "not-a-number"},
    )

    # Invalid value coerces to nothing applied -> no save, no broadcast.
    assert saved_configs == []
    assert sent_messages == []
