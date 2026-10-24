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
    normalized = normalize_magpie_info({key: ctypes.c_int32(value).value for key, value in info.items()})
    if normalized is None:
        return None
    source = get_prop(hwnd, "Magpie.SrcHWND")
    if not source or not user32.IsWindowVisible(hwnd):
        return None
    if expected_source_hwnd is not None and source != int(expected_source_hwnd):
        return None
    return {
        **normalized,
        "source_hwnd": source,
        "scaling_hwnd": hwnd,
        "windowed": bool(get_prop(hwnd, "Magpie.Windowed")),
    }


if __name__ == "__main__":
    print(json.dumps(get_magpie_info()))
