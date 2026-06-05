import ctypes
import ctypes.wintypes
import win32con
import win32gui
import win32process

# Target window executable name
TARGET_EXE = "forzahorizon6.exe"

# Windows API setup
user32 = ctypes.windll.user32
ole32 = ctypes.windll.ole32

# Event hook constant for foreground window change
EVENT_SYSTEM_FOREGROUND = 0x0003
WINEVENT_OUTOFCONTEXT = 0x0000


def get_window_exe_name(hwnd):
    """Retrieves the executable name for a given window handle."""
    _, pid = win32process.GetWindowThreadProcessId(hwnd)
    try:
        import win32api

        handle = win32api.OpenProcess(win32con.PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        exe_path = win32process.GetModuleFileNameEx(handle, 0)
        return exe_path.split("\\")[-1]
    except Exception:
        return ""


def win_event_proc(hWinEventHook, event, hwnd, idObject, idChild, dwEventThread, dwmsEventTime):
    """Callback function triggered whenever the foreground window changes."""
    # Find the game window handle if it's running
    game_hwnd = win32gui.FindWindow(None, None)

    def enum_windows_callback(hwnd_current, extra):
        if get_window_exe_name(hwnd_current).lower() == TARGET_EXE.lower():
            extra.append(hwnd_current)
        return True

    game_hwnds = []
    win32gui.EnumWindows(enum_windows_callback, game_hwnds)

    if not game_hwnds:
        return

    target_hwnd = game_hwnds[0]
    current_foreground = user32.GetForegroundWindow()

    # If the user switched away from the game, spoof the activation message
    if current_foreground != target_hwnd:
        # WM_ACTIVATE = 0x0006, WA_ACTIVE = 1
        win32gui.PostMessage(target_hwnd, win32con.WM_ACTIVATE, 1, 0)


# Define the callback type for the Windows Hook
WinEventProcType = ctypes.WINFUNCTYPE(
    None,
    ctypes.wintypes.HANDLE,
    ctypes.wintypes.DWORD,
    ctypes.wintypes.HWND,
    ctypes.wintypes.LONG,
    ctypes.wintypes.LONG,
    ctypes.wintypes.DWORD,
    ctypes.wintypes.DWORD,
)
callback = WinEventProcType(win_event_proc)

ole32.CoInitialize(None)

# Set the hook to listen for system-wide foreground changes
hook = user32.SetWinEventHook(
    EVENT_SYSTEM_FOREGROUND,
    EVENT_SYSTEM_FOREGROUND,
    0,
    callback,
    0,
    0,
    WINEVENT_OUTOFCONTEXT,
)

# Standard Windows message loop required to keep the hook alive
msg = ctypes.wintypes.MSG()
try:
    while user32.GetMessageW(ctypes.byref(msg), 0, 0, 0) != 0:
        user32.TranslateMessage(ctypes.byref(msg))
        user32.DispatchMessageW(ctypes.byref(msg))
finally:
    user32.UnhookWinEvent(hook)
    ole32.CoUninitialize()
