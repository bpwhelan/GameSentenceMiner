"""Exercise the boot error handler without importing GSM's dependencies."""

import ast
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest


@pytest.mark.parametrize("logger_state", ["working", "missing", "broken"])
def test_initialization_failure_exits_with_stdin_still_open(logger_state):
    source = Path(__file__).resolve().parents[1] / "GameSentenceMiner" / "gsm.py"
    handler = next(
        node
        for node in ast.parse(source.read_text(encoding="utf-8")).body
        if isinstance(node, ast.FunctionDef) and node.name == "handle_error_in_initialization"
    )
    script = textwrap.dedent(
        f"""
        import builtins
        import sys

        class BootLogger:
            def exception(self, message):
                if {logger_state!r} == "broken":
                    raise RuntimeError("logging is broken too")
                print(message, flush=True)

            def info(self, message):
                print(message, flush=True)

        logger = None if {logger_state!r} == "missing" else BootLogger()

        def broken_import(*args, **kwargs):
            raise ImportError("dependencies are unavailable during early boot")

        builtins.__import__ = broken_import
        """
    )
    script += "\n" + ast.unparse(handler)
    script += '\nhandle_error_in_initialization(AttributeError("module idna has no attribute IDNAError"))\n'
    proc = subprocess.Popen(
        [sys.executable, "-c", script],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        # communicate() would close stdin and conceal the original deadlock.
        proc.wait(timeout=5)
        stdout, stderr = proc.communicate()
        assert proc.returncode == 1, stderr
        assert "module idna has no attribute IDNAError" in stdout
    finally:
        if proc.poll() is None:
            proc.kill()
        proc.communicate()
