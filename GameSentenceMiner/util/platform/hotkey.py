# We always import keyboard for Windows support
import keyboard
import platform
import threading
import time

from GameSentenceMiner.util.logging_config import logger

# Safe conditional import for pynput
try:
    from pynput import keyboard as pynput_kb
    PYNPUT_AVAILABLE = True
except ImportError:
    PYNPUT_AVAILABLE = False

class HotkeyManager:
    def __init__(self):
        self._registered_hotkeys = [] 
        self._pynput_mapping = {}     
        self._pynput_listener = None
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
        self._last_signal_time = {}    # When did we last hear from the OS?
        self._last_execution_time = {} # When did we last actually run the function?

        current_os = platform.system()
        if current_os == "Windows":
            self.mode = "keyboard"
        elif PYNPUT_AVAILABLE:
            self.mode = "pynput"
        else:
            self.mode = "disabled"
            logger.warning("HotkeyManager: Non-Windows OS detected but 'pynput' not installed.")

    def clear(self):
        self._last_signal_time.clear()
        self._last_execution_time.clear()
        
        if self.mode == "keyboard":
            for hk in self._registered_hotkeys:
                try:
                    keyboard.remove_hotkey(hk)
                except ValueError:
                    pass
            self._registered_hotkeys.clear()

        elif self.mode == "pynput":
            if self._pynput_listener:
                self._pynput_listener.stop()
                self._pynput_listener = None
            self._pynput_mapping.clear()

    def register(self, hotkey_getter, callback, _store=True):
        if self.mode == "disabled":
            return

        if _store:
            already_registered = any(
                binding[0] == hotkey_getter and binding[1] == callback
                for binding in self._bindings
            )
            if not already_registered:
                self._bindings.append((hotkey_getter, callback))

        try:
            hotkey_str = hotkey_getter() if callable(hotkey_getter) else hotkey_getter
        except Exception as e:
            logger.error(f"Failed to resolve hotkey: {e}")
            return

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
            try:
                hook = keyboard.add_hotkey(hotkey_str, debounced_wrapper)
                self._registered_hotkeys.append(hook)
            except ValueError as e:
                logger.error(f"Failed to register Windows hotkey '{hotkey_str}': {e}")

        elif self.mode == "pynput":
            translated_key = self._translate_to_pynput(hotkey_str)
            self._pynput_mapping[translated_key] = debounced_wrapper
            
            if self._pynput_listener:
                self._pynput_listener.stop()
            
            try:
                self._pynput_listener = pynput_kb.GlobalHotKeys(self._pynput_mapping)
                self._pynput_listener.start()
            except Exception as e:
                logger.error(f"Failed to register pynput hotkey '{translated_key}': {e}")

    def refresh(self):
        logger.info("Refreshing hotkey registrations...")
        if self.mode == "disabled":
            return

        self.clear()
        for hotkey_getter, callback in self._bindings:
            self.register(hotkey_getter, callback, _store=False)

    def _translate_to_pynput(self, hotkey_str):
        parts = hotkey_str.lower().split('+')
        translated_parts = []
        for part in parts:
            part = part.strip()
            if part == 'windows': part = 'cmd'
            if part == 'print screen': part = 'print_screen'
            if part == 'page up': part = 'page_up'
            if part == 'page down': part = 'page_down'
            if len(part) > 1:
                translated_parts.append(f'<{part}>')
            else:
                translated_parts.append(part)
        return '+'.join(translated_parts)

hotkey_manager = HotkeyManager()
