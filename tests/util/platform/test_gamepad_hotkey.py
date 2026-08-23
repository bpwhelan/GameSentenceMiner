from GameSentenceMiner.util.platform.gamepad_hotkey import (
    GamepadHotkeyDispatcher,
    GamepadInputClient,
    parse_gamepad_binding,
)


def test_parse_gamepad_binding_accepts_named_buttons_and_combos():
    assert parse_gamepad_binding("A") == frozenset({0})
    assert parse_gamepad_binding("LB + DPad Up") == frozenset({4, 12})
    assert parse_gamepad_binding("Disabled") == frozenset()
    assert parse_gamepad_binding(7) == frozenset({7})


def test_dispatcher_triggers_once_per_complete_button_chord():
    triggered = []
    dispatcher = GamepadHotkeyDispatcher()
    dispatcher.register("LB+A", lambda: triggered.append("scan"))

    dispatcher.handle_message({"type": "button", "device": "pad", "button": 4, "pressed": True})
    assert triggered == []

    dispatcher.handle_message({"type": "button", "device": "pad", "button": 0, "pressed": True})
    dispatcher.handle_message({"type": "button", "device": "pad", "button": 0, "pressed": True})
    assert triggered == ["scan"]

    dispatcher.handle_message({"type": "button", "device": "pad", "button": 0, "pressed": False})
    dispatcher.handle_message({"type": "button", "device": "pad", "button": 0, "pressed": True})
    assert triggered == ["scan", "scan"]


def test_dispatcher_uses_snapshots_without_firing_hotkeys():
    triggered = []
    dispatcher = GamepadHotkeyDispatcher()
    dispatcher.register("A", lambda: triggered.append("confirm"))

    dispatcher.handle_message(
        {
            "type": "gamepad_connected",
            "device": "pad",
            "state": {"buttons": {"0": True}},
        }
    )
    assert triggered == []

    dispatcher.handle_message({"type": "button", "device": "pad", "button": 0, "pressed": False})
    dispatcher.handle_message({"type": "button", "device": "pad", "button": 0, "pressed": True})
    assert triggered == ["confirm"]


def test_dispatcher_keeps_devices_independent():
    triggered = []
    dispatcher = GamepadHotkeyDispatcher()
    dispatcher.register("A", lambda: triggered.append("confirm"))

    dispatcher.handle_message({"type": "button", "device": "pad-1", "button": 0, "pressed": True})
    dispatcher.handle_message({"type": "button", "device": "pad-2", "button": 0, "pressed": True})

    assert triggered == ["confirm", "confirm"]


def test_exclusive_client_ignores_input_until_capture_is_owned():
    triggered = []
    dispatcher = GamepadHotkeyDispatcher()
    dispatcher.register("A", lambda: triggered.append("confirm"))
    client = GamepadInputClient(dispatcher, exclusive=True)

    client._handle_message({"type": "button", "device": "pad", "button": 0, "pressed": True})
    assert triggered == []

    client._handle_message({"type": "gamepad_capture_changed", "active": True, "owned": True})
    client._handle_message({"type": "button", "device": "pad", "button": 0, "pressed": True})
    assert triggered == ["confirm"]


def test_exclusive_client_requests_capture_before_state_snapshot():
    dispatcher = GamepadHotkeyDispatcher()
    client = GamepadInputClient(dispatcher, exclusive=True)

    assert client._connection_messages()[0] == {
        "type": "configure_gamepad_capture",
        "enabled": True,
    }
