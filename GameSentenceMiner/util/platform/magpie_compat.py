import ctypes
import json
import sys
from ctypes import wintypes

IS_WINDOWS = sys.platform == "win32"
user32 = ctypes.windll.user32 if IS_WINDOWS else None

if user32 is not None:
    # HWND and window property values are pointer-sized, even though RECT
    # coordinates stored in the properties are signed 32-bit LONGs.
    user32.FindWindowA.argtypes = [wintypes.LPCSTR, wintypes.LPCSTR]
    user32.FindWindowA.restype = wintypes.HWND
    user32.GetPropA.argtypes = [wintypes.HWND, wintypes.LPCSTR]
    user32.GetPropA.restype = wintypes.HANDLE
    user32.IsWindowVisible.argtypes = [wintypes.HWND]
    user32.IsWindowVisible.restype = wintypes.BOOL
    user32.SetPropA.argtypes = [wintypes.HWND, wintypes.LPCSTR, wintypes.HANDLE]
    user32.SetPropA.restype = wintypes.BOOL
    user32.RemovePropA.argtypes = [wintypes.HWND, wintypes.LPCSTR]
    user32.RemovePropA.restype = wintypes.HANDLE
    user32.RegisterWindowMessageA.argtypes = [wintypes.LPCSTR]
    user32.RegisterWindowMessageA.restype = wintypes.UINT

MAGPIE_WINDOW_CLASS = "Window_Magpie_967EB565-6F73-4E94-AE53-00CC42592A22"
# Scaling surfaces from Magpie's src/Shared/CommonSharedConstants.h. Its main
# settings window and toast windows are ordinary occluders, not game overlays.
MAGPIE_OVERLAY_WINDOW_CLASSES = frozenset(
    {
        MAGPIE_WINDOW_CLASS,
        "Window_Magpie_C322D752-C866-4630-91F5-32CB242A8930",
        "Magpie_Renderer",
        "Magpie_ScalingBorderHelper",
        "Magpie_TouchHelper",
        "Magpie_TouchHelperHole",
    }
)
MAGPIE_PROPERTY_NAMES = (
    "magpieWindowTopEdgePosition",
    "magpieWindowBottomEdgePosition",
    "magpieWindowLeftEdgePosition",
    "magpieWindowRightEdgePosition",
    "sourceWindowLeftEdgePosition",
    "sourceWindowTopEdgePosition",
    "sourceWindowRightEdgePosition",
    "sourceWindowBottomEdgePosition",
)


def get_magpie_window_handle():
    """Finds the Magpie window handle."""
    if not IS_WINDOWS or user32 is None:
        return 0
    # We need to pass byte strings to these WinAPI functions
    return int(user32.FindWindowA(MAGPIE_WINDOW_CLASS.encode("utf-8"), None) or 0)


def get_prop(hwnd, prop_name):
    """Gets a numeric property from a window handle."""
    if not IS_WINDOWS or user32 is None:
        return 0
    return int(user32.GetPropA(hwnd, prop_name.encode("utf-8")) or 0)


def normalize_magpie_info(info):
    """Coerces Magpie window metadata into a validated geometry payload."""
    if not info:
        return None

    normalized = {}
    for key in MAGPIE_PROPERTY_NAMES:
        try:
            normalized[key] = int(info[key])
        except (KeyError, TypeError, ValueError):
            return None

    if normalized["sourceWindowRightEdgePosition"] <= normalized["sourceWindowLeftEdgePosition"]:
        return None
    if normalized["sourceWindowBottomEdgePosition"] <= normalized["sourceWindowTopEdgePosition"]:
        return None
    if normalized["magpieWindowRightEdgePosition"] <= normalized["magpieWindowLeftEdgePosition"]:
        return None
    if normalized["magpieWindowBottomEdgePosition"] <= normalized["magpieWindowTopEdgePosition"]:
        return None

    return normalized


def get_magpie_info(expected_source_hwnd=None):
    """Read visible scaling geometry, optionally restricted to one source window."""
    if expected_source_hwnd is not None and not expected_source_hwnd:
        return None
    hwnd = get_magpie_window_handle()
    # Magpie only guarantees initialized properties on a visible scaling window.
    # See its docs/Interact with Magpie programally.md.
    if not hwnd or not user32.IsWindowVisible(hwnd):
        return None
    if expected_source_hwnd is not None and get_prop(hwnd, "Magpie.SrcHWND") != int(expected_source_hwnd):
        return None

    info = {
        "magpieWindowTopEdgePosition": get_prop(hwnd, "Magpie.DestTop"),
        "magpieWindowBottomEdgePosition": get_prop(hwnd, "Magpie.DestBottom"),
        "magpieWindowLeftEdgePosition": get_prop(hwnd, "Magpie.DestLeft"),
        "magpieWindowRightEdgePosition": get_prop(hwnd, "Magpie.DestRight"),
        "sourceWindowLeftEdgePosition": get_prop(hwnd, "Magpie.SrcLeft"),
        "sourceWindowTopEdgePosition": get_prop(hwnd, "Magpie.SrcTop"),
        "sourceWindowRightEdgePosition": get_prop(hwnd, "Magpie.SrcRight"),
        "sourceWindowBottomEdgePosition": get_prop(hwnd, "Magpie.SrcBottom"),
    }
    # Match Magpie's documented (LONG)(INT_PTR)GetProp conversion, including
    # monitors to the left of or above the primary display.
    return normalize_magpie_info({key: ctypes.c_int32(value).value for key, value in info.items()})


def mark_window(hwnd_int):
    """Marks a window as a Magpie tool window."""
    if not IS_WINDOWS or user32 is None:
        return 0
    # The value 1 is passed as a HANDLE/pointer-sized integer.
    return user32.SetPropA(hwnd_int, b"Magpie.ToolWindow", 1)


def unmark_window(hwnd_int):
    """Unmarks a window as a Magpie tool window."""
    if not IS_WINDOWS or user32 is None:
        return 0
    return user32.RemovePropA(hwnd_int, b"Magpie.ToolWindow")


def register_message(message_name):
    """Registers a window message and returns its ID."""
    if not IS_WINDOWS or user32 is None:
        return 0
    return user32.RegisterWindowMessageA(message_name.encode("utf-8"))


def main():
    """Main function to handle command-line arguments."""
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No command provided."}))
        return

    command = sys.argv[1]
    output = None

    if command == "is_scaling":
        output = {"is_scaling": bool(get_magpie_info())}
    elif command == "get_info":
        output = get_magpie_info()
    elif command == "mark_window":
        hwnd = int(sys.argv[2])
        success = mark_window(hwnd)
        output = {"success": bool(success)}
    elif command == "unmark_window":
        hwnd = int(sys.argv[2])
        unmark_window(hwnd)  # RemoveProp returns the old value, not a success bool
        output = {"success": True}
    elif command == "register_message":
        message_id = register_message("MagpieScalingChanged")
        output = {"message_id": message_id}
    else:
        output = {"error": "Unknown command"}

    # Print the result as a JSON string to stdout
    print(json.dumps(output))


if __name__ == "__main__":
    main()
