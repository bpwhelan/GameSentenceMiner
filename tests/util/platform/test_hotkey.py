import importlib


hotkey_module = importlib.import_module("GameSentenceMiner.util.platform.hotkey")


class _FakeKeyboard:
    def __init__(self):
        self.add_hotkey_calls = []
        self.on_press_key_calls = []
        self.remove_hotkey_calls = []
        self.unhook_key_calls = []

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


def _make_manager(monkeypatch, fake_keyboard):
    monkeypatch.setattr(hotkey_module, "keyboard", fake_keyboard)
    manager = hotkey_module.HotkeyManager()
    manager.mode = "keyboard"
    return manager


def test_register_uses_raw_key_listener_for_single_non_modifier_hotkeys(monkeypatch):
    fake_keyboard = _FakeKeyboard()
    manager = _make_manager(monkeypatch, fake_keyboard)

    manager.register("o", lambda: None)

    assert [call[0] for call in fake_keyboard.on_press_key_calls] == ["o"]
    assert fake_keyboard.add_hotkey_calls == []


def test_register_keeps_combo_and_modifier_only_hotkeys_on_exact_match_path(monkeypatch):
    fake_keyboard = _FakeKeyboard()
    manager = _make_manager(monkeypatch, fake_keyboard)

    manager.register("ctrl+o", lambda: None)
    manager.register("shift", lambda: None)

    assert [call[0] for call in fake_keyboard.add_hotkey_calls] == ["ctrl+o", "shift"]
    assert fake_keyboard.on_press_key_calls == []


def test_clear_removes_single_key_hooks_separately_from_combo_hotkeys(monkeypatch):
    fake_keyboard = _FakeKeyboard()
    manager = _make_manager(monkeypatch, fake_keyboard)

    manager.register("o", lambda: None)
    manager.register("ctrl+o", lambda: None)
    manager.clear()

    assert len(fake_keyboard.unhook_key_calls) == 1
    assert len(fake_keyboard.remove_hotkey_calls) == 1
