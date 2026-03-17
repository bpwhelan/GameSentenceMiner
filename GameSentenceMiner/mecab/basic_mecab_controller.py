# Copyright: Ren Tatsumoto <tatsu at autistici.org> and contributors
# License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

import functools
import os
import subprocess
from typing import Optional

try:
    from .mecab_exe_finder import IS_WIN, SUPPORT_DIR, find_executable
except ImportError:
    from mecab_exe_finder import IS_WIN, SUPPORT_DIR, find_executable

INPUT_BUFFER_SIZE = str(819200)
MECAB_RC_PATH = os.path.join(SUPPORT_DIR, "mecabrc")


@functools.cache
def startup_info():
    if IS_WIN:
        # Prevents a console window from popping up on Windows
        si = subprocess.STARTUPINFO()
        si.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    else:
        si = None
    return si


@functools.cache
def find_best_dic_dir():
    """
    If the user has mecab-ipadic-neologd (or mecab-ipadic) installed, pick its system dictionary.
    """
    possible_locations = (
        "/usr/lib/mecab/dic/mecab-ipadic-neologd",
        "/usr/local/lib/mecab/dic/mecab-ipadic-neologd",
        "/opt/homebrew/lib/mecab/dic/mecab-ipadic-neologd",
        "/usr/lib/mecab/dic/ipadic",
        "/usr/local/lib/mecab/dic/ipadic",  # for `brew install mecab-ipadic`
        "/opt/homebrew/lib/mecab/dic/ipadic",
    )
    for directory in possible_locations:
        if os.path.isdir(directory):
            return directory
    return SUPPORT_DIR


def normalize_for_platform(popen: list[str]) -> list[str]:
    if IS_WIN:
        popen = [os.path.normpath(x) for x in popen]
    return popen


def check_mecab_rc():
    if not os.path.isfile(MECAB_RC_PATH):
        with open(MECAB_RC_PATH, "w") as f:
            # create mecabrc if it doesn't exist
            f.write("")


def expr_to_bytes(expr: str) -> bytes:
    return expr.encode("utf-8", "ignore") + b"\n"


def mecab_output_to_str(outs: bytes) -> str:
    return outs.rstrip(b"\r\n").decode("utf-8", "replace")


def prepend_library_path() -> None:
    for library_path in ("DYLD_LIBRARY_PATH", "LD_LIBRARY_PATH"):
        try:
            os.environ[library_path] = f"{SUPPORT_DIR}:{os.environ[library_path]}"
        except KeyError:
            os.environ[library_path] = SUPPORT_DIR


class BasicMecabController:
    _mecab_cmd: list[str] = [
        find_executable("mecab"),
        "--dicdir=" + find_best_dic_dir(),
        "--rcfile=" + MECAB_RC_PATH,
        "--userdic=" + os.path.join(SUPPORT_DIR, "user_dic.dic"),
        "--input-buffer-size=" + INPUT_BUFFER_SIZE,
    ]
    _mecab_args: list[str] = []
    _verbose: bool

    def __init__(
        self,
        mecab_cmd: Optional[list[str]] = None,
        mecab_args: Optional[list[str]] = None,
        verbose: bool = False,
    ) -> None:
        super().__init__()
        check_mecab_rc()
        self._verbose = verbose
        self._mecab_cmd = normalize_for_platform((mecab_cmd or self._mecab_cmd) + (mecab_args or self._mecab_args))
        prepend_library_path()
        if self._verbose:
            print("mecab cmd:", self._mecab_cmd)

    def run(self, expr: str) -> str:
        try:
            proc = subprocess.Popen(
                self._mecab_cmd,
                bufsize=-1,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                startupinfo=startup_info(),
            )
        except OSError:
            raise Exception("Please ensure your Linux system has 64 bit binary support.")

        try:
            outs, errs = proc.communicate(expr_to_bytes(expr), timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            outs, errs = proc.communicate()

        str_out = mecab_output_to_str(outs)
        if "tagger.cpp" in str_out and "no such file or directory" in str_out:
            raise RuntimeError("Please ensure your Windows user name contains only English characters.")
        return str_out


def main():
    mecab = BasicMecabController()

    try_expressions = (
        "カリン、自分でまいた種は自分で刈り取れ",
        "昨日、林檎を2個買った。",
        "真莉、大好きだよん＾＾",
        "彼２０００万も使った。",
        "彼二千三百六十円も使った。",
        "千葉",
        "昨日すき焼きを食べました",
        "二人の美人",
        "詳細はお気軽にお問い合わせ下さい。",
        "Lorem ipsum dolor sit amet. Съешь ещё этих мягких французских булок, да выпей же чаю.",
    )

    for expr in try_expressions:
        print(mecab.run(expr))


if __name__ == "__main__":
    main()
