import sys
import win32gui
import win32con
import win32api
import keyboard
import time
import threading
import signal

from GameSentenceMiner.util.configuration import logger

# --- Configuration (equivalent to AHK top-level variables) ---
TRANSPARENT_LEVEL = 1  # Almost invisible (0-255 scale)
OPAQUE_LEVEL = 255     # Fully opaque
HOTKEY = 'ctrl+alt+y'

# --- Global State Variables (equivalent to AHK global variables) ---
is_toggled = False
target_hwnd = None
# A lock to prevent race conditions when accessing global state from different threads
state_lock = threading.Lock()

# --- Core Functions (equivalent to AHK functions) ---

def set_window_transparency(hwnd, transparency):
    """
    Sets the transparency of a window.
    This is the Python equivalent of WinSetTransparent.
    """
    if not hwnd or not win32gui.IsWindow(hwnd):
        return
    try:
        # Get the current window style
        style = win32gui.GetWindowLong(hwnd, win32con.GWL_EXSTYLE)
        # Add the WS_EX_LAYERED style, which is required for transparency
        win32gui.SetWindowLong(hwnd, win32con.GWL_EXSTYLE, style | win32con.WS_EX_LAYERED)
        # Set the transparency
        win32gui.SetLayeredWindowAttributes(hwnd, 0, transparency, win32con.LWA_ALPHA)
    except Exception as e:
        # Some windows (like system or elevated ones) might deny permission
        # logger.info(f"Error setting transparency for HWND {hwnd}: {e}")
        pass

def set_always_on_top(hwnd, is_on_top):
    """
    Sets or removes the "Always on Top" status for a window.
    This is the Python equivalent of WinSetAlwaysOnTop.
    """
    if not hwnd or not win32gui.IsWindow(hwnd):
        return
    try:
        rect = win32gui.GetWindowRect(hwnd)
        position = win32con.HWND_TOPMOST if is_on_top else win32con.HWND_NOTOPMOST
        # Set the window position without moving or resizing it
        win32gui.SetWindowPos(hwnd, position, rect[0], rect[1], 0, 0,
                              win32con.SWP_NOMOVE | win32con.SWP_NOSIZE)
    except Exception as e:
        # logger.info(f"Error setting always-on-top for HWND {hwnd}: {e}")
        pass

def reset_window_state(hwnd):
    """A helper to reset a window to its default state."""
    set_window_transparency(hwnd, OPAQUE_LEVEL)
    set_always_on_top(hwnd, False)

# --- Hotkey Callback (equivalent to AHK ^!y::) ---

def toggle_functionality(window_hwnd=None):
    """
    This function is called when the hotkey is pressed.
    It manages the toggling logic.
    """
    global is_toggled, target_hwnd
    
    if window_hwnd:
        current_hwnd = window_hwnd
    else:
        # Get the currently focused window (equivalent to WinGetID("A"))
        current_hwnd = win32gui.GetForegroundWindow()
        if not current_hwnd:
            logger.info("No window is currently active!")
            return

    with state_lock:
        # Case 1: The hotkey is pressed on the currently toggled window to disable it.
        if is_toggled and target_hwnd == current_hwnd:
            logger.info(f"Disabling functionality for window: {win32gui.GetWindowText(current_hwnd)}")
            reset_window_state(current_hwnd)
            is_toggled = False
            target_hwnd = None
        # Case 2: Enable functionality for a new window, or switch to a new one.
        else:
            # If another window was already toggled, reset it first.
            if is_toggled and target_hwnd is not None:
                logger.info(f"Resetting old window: {win32gui.GetWindowText(target_hwnd)}")
                reset_window_state(target_hwnd)

            # Enable functionality for the new window.
            logger.info(f"Enabling functionality for window: {win32gui.GetWindowText(current_hwnd)}")
            is_toggled = True
            target_hwnd = current_hwnd
            set_always_on_top(target_hwnd, True)
            # The mouse_monitor_loop will handle setting the initial transparency

# --- Mouse Monitoring (equivalent to AHK Loop) ---

def mouse_monitor_loop():
    """
    A loop that runs in a separate thread to monitor the mouse position.
    """
    global is_toggled, target_hwnd

    while True:
        # We check the state without a lock first for performance,
        # then use the lock when we need to read the shared variable.
        if is_toggled:
            with state_lock:
                # Make a local copy of the target handle to work with
                monitored_hwnd = target_hwnd

            if monitored_hwnd:
                # Get mouse position and the window handle under the cursor
                pos = win32gui.GetCursorPos()
                hwnd_under_mouse = win32gui.WindowFromPoint(pos)

                # WindowFromPoint can return a child window (like a button).
                # We need to walk up the parent chain to see if it belongs to our target window.
                is_mouse_over_target = False
                current_hwnd = hwnd_under_mouse
                while current_hwnd != 0:
                    if current_hwnd == monitored_hwnd:
                        is_mouse_over_target = True
                        break
                    current_hwnd = win32gui.GetParent(current_hwnd)

                # Apply transparency based on mouse position
                if is_mouse_over_target:
                    set_window_transparency(monitored_hwnd, OPAQUE_LEVEL)
                else:
                    set_window_transparency(monitored_hwnd, TRANSPARENT_LEVEL)

        # A small delay to reduce CPU usage
        time.sleep(0.1)

class HandleSTDINThread(threading.Thread):
    def run(self):
        while True:
            try:
                line = input()
                if "exit" in line.strip().lower():
                    handle_quit()
                    break
            except EOFError:
                break
            
def handle_quit():
    if is_toggled and target_hwnd:
        reset_window_state(target_hwnd)
    logger.info("Exiting Window Transparency Tool.")

# --- Main Execution Block ---

if __name__ == "__main__":
    import argparse
    # Start the mouse monitor in a separate, non-blocking thread.
    # daemon=True ensures the thread will exit when the main script does.
    monitor_thread = threading.Thread(target=mouse_monitor_loop, daemon=True)
    monitor_thread.start()

    # get hotkey from args
    parser = argparse.ArgumentParser(description="Window Transparency Toggle Script")
    parser.add_argument('--hotkey', type=str, default=HOTKEY, help='Hotkey to toggle transparency (default: ctrl+alt+y)')
    parser.add_argument('--window', type=str, help='Window title to target (optional)')

    args = parser.parse_args()
    hotkey = args.hotkey.lower()
    target_window_title = args.window
    
    if target_window_title:
        # Find the window by title if specified
        target_hwnd = win32gui.FindWindow(None, target_window_title)
        logger.info(f"Searching for window with title: {target_window_title}")
        logger.info(f"Target HWND: {target_hwnd}")
        if not target_hwnd:
            logger.error(f"Window with title '{target_window_title}' not found.")
            sys.exit(1)
        else:
            logger.info(f"Target window found: {target_window_title}")
            toggle_functionality(target_hwnd)  # Enable functionality for the specified window

    # Register the global hotkey
    keyboard.add_hotkey(hotkey, toggle_functionality)

    # Handle SigINT/SigTERM gracefully
    def signal_handler(sig, frame):
        handle_quit()
        sys.exit(0)

    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)

    logger.info(f"Script running. Press '{hotkey}' on a window to toggle transparency.")
    logger.info("Press Ctrl+C in this console to exit.")
    
    HandleSTDINThread().start()

    # Keep the script running to listen for the hotkey.
    # keyboard.wait() is a blocking call that waits indefinitely.
    try:
        keyboard.wait()
    except KeyboardInterrupt:
        if is_toggled and target_hwnd:
            reset_window_state(target_hwnd)
        logger.info("\nScript terminated by user.")