import asyncio
import json
from types import SimpleNamespace

import pytest

from GameSentenceMiner.web import overlay_handler as overlay_handler_module


def test_overlay_recycled_indicator_setting_saves_to_current_profile(monkeypatch):
    saved_configs = []
    sent_messages = []
    current_config = SimpleNamespace(
        overlay=SimpleNamespace(check_previous_lines_for_recycled_indicator=False),
    )
    master_config = SimpleNamespace(
        overlay=current_config.overlay,
        get_config=lambda: current_config,
    )
    handler = overlay_handler_module.OverlayRequestHandler()

    async def fake_send(server_id, message):
        sent_messages.append((server_id, message))

    monkeypatch.setattr(overlay_handler_module, "get_master_config", lambda: master_config)
    monkeypatch.setattr(overlay_handler_module, "save_full_config", lambda config: saved_configs.append(config))
    monkeypatch.setattr(handler, "_sync_recycled_line_cache", lambda enabled: None)
    monkeypatch.setattr(overlay_handler_module.websocket_manager, "send", fake_send)

    asyncio.run(
        handler.handle_message(
            json.dumps(
                {
                    "type": "set-gsm-overlay-config",
                    "key": "check_previous_lines_for_recycled_indicator",
                    "value": True,
                }
            )
        )
    )

    assert current_config.overlay.check_previous_lines_for_recycled_indicator is True
    assert master_config.overlay is current_config.overlay
    assert saved_configs == [master_config]
    assert sent_messages == [
        (
            overlay_handler_module.ID_OVERLAY,
            {
                "type": "gsm-overlay-config-updated",
                "settings": {"showRecycledIndicator": True},
            },
        )
    ]


def test_overlay_recycled_indicator_setting_rejects_unknown_key(monkeypatch):
    saved_configs = []
    current_config = SimpleNamespace(
        overlay=SimpleNamespace(check_previous_lines_for_recycled_indicator=False),
    )
    master_config = SimpleNamespace(
        overlay=current_config.overlay,
        get_config=lambda: current_config,
    )
    handler = overlay_handler_module.OverlayRequestHandler()

    monkeypatch.setattr(overlay_handler_module, "get_master_config", lambda: master_config)
    monkeypatch.setattr(overlay_handler_module, "save_full_config", lambda config: saved_configs.append(config))

    asyncio.run(
        handler.handle_message(
            json.dumps(
                {
                    "type": "set-gsm-overlay-config",
                    "key": "unsupported",
                    "value": True,
                }
            )
        )
    )

    assert current_config.overlay.check_previous_lines_for_recycled_indicator is False
    assert saved_configs == []


@pytest.mark.parametrize("key_name", ["mouseclick", "left-click"])
def test_overlay_forward_mouse_click_request_is_allowlisted(monkeypatch, key_name):
    calls = []

    async def fake_send_key_to_target_window(key, target_pid=None, activate_window=True):
        calls.append((key, target_pid, activate_window))
        return True

    fake_monitor = SimpleNamespace(
        target_hwnd=123,
        send_key_to_target_window=fake_send_key_to_target_window,
    )
    fake_overlay_processor = SimpleNamespace(window_monitor=fake_monitor)
    handler = overlay_handler_module.OverlayRequestHandler()

    monkeypatch.setattr(overlay_handler_module, "get_overlay_processor", lambda: fake_overlay_processor)

    asyncio.run(
        handler.handle_send_key_request(
            {
                "key": key_name,
                "source": "gamepad",
                "activateWindow": False,
                "targetPid": "42",
            }
        )
    )

    assert calls == [(key_name, 42, False)]


def test_overlay_forward_mouse_click_rejects_unknown_key(monkeypatch):
    calls = []

    async def fake_send_key_to_target_window(key, target_pid=None, activate_window=True):
        calls.append((key, target_pid, activate_window))
        return True

    fake_monitor = SimpleNamespace(
        target_hwnd=123,
        send_key_to_target_window=fake_send_key_to_target_window,
    )
    fake_overlay_processor = SimpleNamespace(window_monitor=fake_monitor)
    handler = overlay_handler_module.OverlayRequestHandler()

    monkeypatch.setattr(overlay_handler_module, "get_overlay_processor", lambda: fake_overlay_processor)

    asyncio.run(
        handler.handle_send_key_request(
            {
                "key": "f13",
                "source": "gamepad",
                "activateWindow": False,
                "targetPid": "42",
            }
        )
    )

    assert calls == []
