"""Split user-supplied argument strings using the host's quoting rules."""

import os
import shlex


def split_command_line(command: str) -> list[str]:
    if not command:
        return []
    if os.name != "nt":
        return shlex.split(command)

    # POSIX shlex consumes unquoted Windows backslashes (including \S and \N).
    # Ask Windows to parse quoting instead; this does not expand variables or
    # invoke a shell. Prefix a dummy executable so all tokens use argument rules.
    import ctypes
    from ctypes import wintypes

    parse = ctypes.WinDLL("shell32", use_last_error=True).CommandLineToArgvW
    parse.argtypes = [wintypes.LPCWSTR, ctypes.POINTER(ctypes.c_int)]
    parse.restype = ctypes.POINTER(wintypes.LPWSTR)
    free = ctypes.WinDLL("kernel32", use_last_error=True).LocalFree
    free.argtypes = [ctypes.c_void_p]
    free.restype = ctypes.c_void_p

    count = ctypes.c_int()
    arguments = parse("gsm " + command, ctypes.byref(count))
    if not arguments:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        return [arguments[index] for index in range(1, count.value)]
    finally:
        free(arguments)
