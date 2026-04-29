import importlib.util
import platform
import re
import threading
import time

from GameSentenceMiner.util.logging_config import logger


class HotkeyManager:
    def __init__(self):
        self._registered_hotkeys = []
        self._registered_key_hooks = []
        self._pynput_mapping = {}
        self._pynput_listener = None
        self._keyboard_module = None
        self._pynput_keyboard_module = None
        self._lock = threading.Lock()
        self._bindings = []

        # --- TIMING CONFIGURATION ---

        # 1. HOLDING GAP:
        # The max time between OS 'repeat' signals to consider the key "held down".
        # Windows/Linux usually repeat every 0.03s - 0.05s.
        self._holding_gap = 0.15

        # 2. EXECUTION COOLDOWN:
        # The minimum time between actual triggers.
        # MUST be > 0.5s to bridge the OS "Initial Repeat Delay".
        self._execution_cooldown = 0.6

        # TIMESTAMPS
        self._last_signal_time = {}  # When did we last hear from the OS?
        self._last_execution_time = {}  # When did we last actually run the function?

        current_os = platform.system()
        if current_os == "Windows":
            self.mode = "keyboard"
        elif importlib.util.find_spec("pynput") is not None:
            self.mode = "pynput"
        else:
            self.mode = "disabled"
            logger.warning("HotkeyManager: Non-Windows OS detected but 'pynput' not installed.")

    def _load_keyboard_module(self):
        if self._keyboard_module is not None:
            return self._keyboard_module

        try:
            import keyboard
        except ImportError:
            logger.warning("HotkeyManager: Windows hotkeys requested but 'keyboard' is not installed.")
            self.mode = "disabled"
            return None

        self._keyboard_module = keyboard
        return self._keyboard_module

    def _load_pynput_keyboard_module(self):
        if self._pynput_keyboard_module is not None:
            return self._pynput_keyboard_module

        try:
            from pynput import keyboard as pynput_keyboard
        except ImportError:
            logger.warning("HotkeyManager: Non-Windows hotkeys requested but 'pynput' is not installed.")
            self.mode = "disabled"
            return None

        self._pynput_keyboard_module = pynput_keyboard
        return self._pynput_keyboard_module

    def clear(self, clear_bindings=True):
        self._last_signal_time.clear()
        self._last_execution_time.clear()

        if self.mode == "keyboard":
            keyboard = self._load_keyboard_module()
            for hk in self._registered_hotkeys:
                try:
                    if keyboard:
                        keyboard.remove_hotkey(hk)
                except (KeyError, ValueError):
                    pass
            self._registered_hotkeys.clear()

            for hk in self._registered_key_hooks:
                try:
                    if keyboard:
                        keyboard.unhook_key(hk)
                except (KeyError, ValueError):
                    pass
            self._registered_key_hooks.clear()

        elif self.mode == "pynput":
            if self._pynput_listener:
                self._pynput_listener.stop()
                self._pynput_listener = None
            self._pynput_mapping.clear()

        if clear_bindings:
            self._bindings.clear()

    def register(self, hotkey_getter, callback, _store=True):
        if self.mode == "disabled":
            return

        if _store:
            already_registered = any(
                binding[0] == hotkey_getter and binding[1] == callback for binding in self._bindings
            )
            if not already_registered:
                self._bindings.append((hotkey_getter, callback))

        try:
            hotkey_str = hotkey_getter() if callable(hotkey_getter) else hotkey_getter
        except Exception as e:
            logger.error(f"Failed to resolve hotkey: {e}")
            return

        hotkey_str = self._normalize_hotkey_string(hotkey_str)
        if not hotkey_str:
            return

        def debounced_wrapper():
            now = time.time()

            # Retrieve last known times
            last_sig = self._last_signal_time.get(hotkey_str, 0)
            last_exec = self._last_execution_time.get(hotkey_str, 0)

            # ALWAYS update signal time. This resets the "Holding" timer.
            self._last_signal_time[hotkey_str] = now

            # CHECK 1: Are we currently holding the key?
            # If the gap between now and the last signal is tiny, it's a rapid repeat.
            if (now - last_sig) < self._holding_gap:
                return

            # CHECK 2: Did we JUST run this?
            # This prevents the "Double Fire" caused by the OS 500ms initial delay.
            if (now - last_exec) < self._execution_cooldown:
                return

            # If we passed both checks, execute safely
            if self._lock.acquire(blocking=False):
                try:
                    # Mark execution time immediately so we don't re-enter
                    self._last_execution_time[hotkey_str] = time.time()
                    callback()
                except Exception as e:
                    logger.error(f"Error in hotkey callback for {hotkey_str}: {e}")
                finally:
                    self._lock.release()

        # --- Registration Logic (Same as before) ---
        if self.mode == "keyboard":
            keyboard = self._load_keyboard_module()
            if keyboard is None:
                return
            try:
                if self._should_use_single_key_listener(hotkey_str):
                    hook = keyboard.on_press_key(hotkey_str, lambda _: debounced_wrapper())
                    self._registered_key_hooks.append(hook)
                elif self._should_use_press_state_listeners(hotkey_str):
                    for key_name in self._iter_press_state_listener_keys(hotkey_str):
                        hook = keyboard.on_press_key(
                            key_name,
                            lambda _, keyboard_module=keyboard, hotkey=hotkey_str: self._trigger_if_pressed(
                                keyboard_module,
                                hotkey,
                                debounced_wrapper,
                            ),
                        )
                        self._registered_key_hooks.append(hook)
                else:
                    hook = keyboard.add_hotkey(hotkey_str, debounced_wrapper)
                    self._registered_hotkeys.append(hook)
            except ValueError as e:
                logger.error(f"Failed to register Windows hotkey '{hotkey_str}': {e}")

        elif self.mode == "pynput":
            pynput_keyboard = self._load_pynput_keyboard_module()
            if pynput_keyboard is None:
                return
            translated_key = self._translate_to_pynput(hotkey_str)
            self._pynput_mapping[translated_key] = debounced_wrapper

            if self._pynput_listener:
                self._pynput_listener.stop()

            try:
                self._pynput_listener = pynput_keyboard.GlobalHotKeys(self._pynput_mapping)
                self._pynput_listener.start()
            except Exception as e:
                logger.error(f"Failed to register pynput hotkey '{translated_key}': {e}")

    def refresh(self):
        logger.info("Refreshing hotkey registrations...")
        if self.mode == "disabled":
            return

        self.clear(clear_bindings=False)
        for hotkey_getter, callback in self._bindings:
            self.register(hotkey_getter, callback, _store=False)

    def _normalize_hotkey_string(self, hotkey_str):
        if hotkey_str is None:
            return ""
        normalized = str(hotkey_str).strip()
        if not normalized:
            return ""
        return re.sub(r"\s*\+\s*", "+", normalized)

    def _split_single_step_hotkey(self, hotkey_str):
        if "," in hotkey_str:
            return []

        parts = [part.strip() for part in hotkey_str.split("+")]
        if not parts or any(not part for part in parts):
            return []
        return parts

    def _is_modifier_key(self, key_name):
        return key_name.lower() in {
            "alt",
            "altgr",
            "cmd",
            "command",
            "control",
            "ctrl",
            "leftalt",
            "leftcmd",
            "leftctrl",
            "leftshift",
            "leftwindows",
            "option",
            "rightalt",
            "rightcmd",
            "rightctrl",
            "rightshift",
            "rightwindows",
            "shift",
            "win",
            "windows",
        }

    def _should_use_single_key_listener(self, hotkey_str):
        parts = self._split_single_step_hotkey(hotkey_str)
        if len(parts) != 1:
            return False
        return not self._is_modifier_key(parts[0])

    def _should_use_press_state_listeners(self, hotkey_str):
        parts = self._split_single_step_hotkey(hotkey_str)
        if len(parts) <= 1:
            return False
        return any(not self._is_modifier_key(part) for part in parts)

    def _iter_press_state_listener_keys(self, hotkey_str):
        seen = set()
        for part in self._split_single_step_hotkey(hotkey_str):
            normalized = part.lower()
            if normalized in seen:
                continue
            seen.add(normalized)
            yield part

    def _trigger_if_pressed(self, keyboard_module, hotkey_str, callback):
        try:
            if keyboard_module.is_pressed(hotkey_str):
                callback()
        except ValueError as e:
            logger.error(f"Failed to evaluate Windows hotkey '{hotkey_str}': {e}")

    def _translate_to_pynput(self, hotkey_str):
        parts = hotkey_str.lower().split("+")
        translated_parts = []
        for part in parts:
            part = part.strip()
            if part == "windows":
                part = "cmd"
            if part == "print screen":
                part = "print_screen"
            if part == "page up":
                part = "page_up"
            if part == "page down":
                part = "page_down"
            if len(part) > 1:
                translated_parts.append(f"<{part}>")
            else:
                translated_parts.append(part)
        return "+".join(translated_parts)


hotkey_manager = HotkeyManager()
