"""Process elevation checks shared by startup and settings."""

import ctypes
import sys


def is_windows_admin() -> bool:
    """Check the current Windows token, not just the user's account membership.

    With UAC enabled, an administrator's unelevated process returns False.
    Other platforms are outside this Windows browser-launch restriction.
    """
    return sys.platform == "win32" and bool(ctypes.windll.shell32.IsUserAnAdmin())
