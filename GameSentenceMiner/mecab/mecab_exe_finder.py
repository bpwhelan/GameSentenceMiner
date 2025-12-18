# Copyright: Ajatt-Tools and contributors; https://github.com/Ajatt-Tools
# License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

import functools
import os
import shutil
import sys

IS_MAC = sys.platform.startswith("darwin")
IS_WIN = sys.platform.startswith("win32")
SUPPORT_DIR = os.path.join(os.path.dirname(__file__), "support")


@functools.cache
def support_exe_suffix() -> str:
    """
    The mecab executable file in the "support" dir has a different suffix depending on the platform.
    """
    if IS_WIN:
        return ".exe"
    elif IS_MAC:
        return ".mac"
    else:
        return ".lin"


def get_bundled_executable(name: str) -> str:
    """
    Get path to executable in the bundled "support" folder.
    Used to provide 'mecab' on computers where it is not installed system-wide or can't be found.
    """
    path_to_exe = os.path.join(SUPPORT_DIR, name) + support_exe_suffix()
    assert os.path.isfile(path_to_exe), f"{path_to_exe} doesn't exist. Can't recover."
    if not IS_WIN:
        os.chmod(path_to_exe, 0o755)
    return path_to_exe


@functools.cache
def find_executable(name: str) -> str:
    """
    If possible, use the executable installed in the system.
    Otherwise, use the executable provided in the support directory.
    """
    return shutil.which(name) or get_bundled_executable(name)
