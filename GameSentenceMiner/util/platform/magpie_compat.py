import ctypes
import json
import sys

IS_WINDOWS = sys.platform == "win32"
user32 = ctypes.windll.user32 if IS_WINDOWS else None

MAGPIE_WINDOW_CLASS = "Window_Magpie_967EB565-6F73-4E94-AE53-00CC42592A22"

def get_magpie_window_handle():
    """Finds the Magpie window handle."""
    if not IS_WINDOWS or user32 is None:
        return 0
    # We need to pass byte strings to these WinAPI functions
    return user32.FindWindowA(MAGPIE_WINDOW_CLASS.encode('utf-8'), None)

def get_prop(hwnd, prop_name):
    """Gets a numeric property from a window handle."""
    if not IS_WINDOWS or user32 is None:
        return 0
    return user32.GetPropA(hwnd, prop_name.encode('utf-8'))

def get_magpie_info():
    """Gathers all scaling information from the Magpie window."""
    hwnd = get_magpie_window_handle()
    if not hwnd:
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
    return info

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
    return user32.RegisterWindowMessageA(message_name.encode('utf-8'))

def main():
    """Main function to handle command-line arguments."""
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No command provided."}))
        return

    command = sys.argv[1]
    output = None

    if command == "is_scaling":
        output = {"is_scaling": bool(get_magpie_window_handle())}
    elif command == "get_info":
        output = get_magpie_info()
    elif command == "mark_window":
        hwnd = int(sys.argv[2])
        success = mark_window(hwnd)
        output = {"success": bool(success)}
    elif command == "unmark_window":
        hwnd = int(sys.argv[2])
        unmark_window(hwnd) # RemoveProp returns the old value, not a success bool
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
