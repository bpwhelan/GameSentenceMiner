import importlib


hotkey_module = importlib.import_module("GameSentenceMiner.util.platform.hotkey")


class _FakeKeyboard:
    def __init__(self):
        self.add_hotkey_calls = []
        self.on_press_key_calls = []
        self.remove_hotkey_calls = []
        self.unhook_key_calls = []
        self.is_pressed_return_value = False

    def add_hotkey(self, hotkey, callback):
        handle = object()
        self.add_hotkey_calls.append((hotkey, callback, handle))
        return handle

    def on_press_key(self, key, callback):
        handle = object()
        self.on_press_key_calls.append((key, callback, handle))
        return handle

    def remove_hotkey(self, handle):
        self.remove_hotkey_calls.append(handle)

    def unhook_key(self, handle):
        self.unhook_key_calls.append(handle)

    def is_pressed(self, hotkey):
        return self.is_pressed_return_value


def _make_manager(monkeypatch, fake_keyboard):
    manager = hotkey_module.HotkeyManager()
    manager.mode = "keyboard"
    manager._keyboard_module = fake_keyboard
    return manager


def test_register_uses_raw_key_listener_for_single_non_modifier_hotkeys(monkeypatch):
    fake_keyboard = _FakeKeyboard()
    manager = _make_manager(monkeypatch, fake_keyboard)

    manager.register("o", lambda: None)

    assert [call[0] for call in fake_keyboard.on_press_key_calls] == ["o"]
    assert fake_keyboard.add_hotkey_calls == []


def test_register_uses_press_listeners_for_simple_modifier_combos(monkeypatch):
    fake_keyboard = _FakeKeyboard()
    manager = _make_manager(monkeypatch, fake_keyboard)
    manager._holding_gap = 0
    manager._execution_cooldown = 0

    triggered = []

    manager.register("ctrl+o", lambda: triggered.append("combo"))

    assert fake_keyboard.add_hotkey_calls == []
    assert [call[0] for call in fake_keyboard.on_press_key_calls] == ["ctrl", "o"]

    ctrl_listener = fake_keyboard.on_press_key_calls[0][1]
    trigger_listener = fake_keyboard.on_press_key_calls[1][1]

    fake_keyboard.is_pressed_return_value = False
    ctrl_listener(None)
    assert triggered == []

    fake_keyboard.is_pressed_return_value = True
    trigger_listener(None)
    assert triggered == ["combo"]


def test_register_keeps_modifier_only_and_multi_step_hotkeys_on_exact_match_path(monkeypatch):
    fake_keyboard = _FakeKeyboard()
    manager = _make_manager(monkeypatch, fake_keyboard)

    manager.register("shift", lambda: None)
    manager.register("ctrl+o, p", lambda: None)

    assert [call[0] for call in fake_keyboard.add_hotkey_calls] == ["shift", "ctrl+o, p"]
    assert fake_keyboard.on_press_key_calls == []


def test_clear_removes_single_key_hooks_separately_from_combo_hotkeys(monkeypatch):
    fake_keyboard = _FakeKeyboard()
    manager = _make_manager(monkeypatch, fake_keyboard)

    manager.register("o", lambda: None)
    manager.register("ctrl+o", lambda: None)
    manager.clear()

    assert len(fake_keyboard.unhook_key_calls) == 3
    assert len(fake_keyboard.remove_hotkey_calls) == 0


def test_register_preserves_spaces_inside_named_keys(monkeypatch):
    fake_keyboard = _FakeKeyboard()
    manager = _make_manager(monkeypatch, fake_keyboard)

    manager.register("Ctrl + Print Screen", lambda: None)

    assert [call[0] for call in fake_keyboard.on_press_key_calls] == ["Ctrl", "Print Screen"]
