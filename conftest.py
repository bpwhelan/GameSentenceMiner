from __future__ import annotations

import os
import shutil
import sys
import types
import uuid
from pathlib import Path

import pytest


_TEST_ROOT = Path(__file__).resolve().parent / ".tmp_test_env"
_APPDATA = _TEST_ROOT / "AppData" / "Roaming"
_LOCALAPPDATA = _TEST_ROOT / "AppData" / "Local"
_HOME = _TEST_ROOT / "home"
_XDG_CONFIG = _HOME / ".config"
_TMP = _TEST_ROOT / "tmp"
_TMP_CASES = _TEST_ROOT / "pytest_cases"

for _path in (_APPDATA, _LOCALAPPDATA, _HOME, _XDG_CONFIG, _TMP, _TMP_CASES):
    _path.mkdir(parents=True, exist_ok=True)

os.environ["APPDATA"] = str(_APPDATA)
os.environ["LOCALAPPDATA"] = str(_LOCALAPPDATA)
os.environ["HOME"] = str(_HOME)
os.environ["USERPROFILE"] = str(_HOME)
os.environ["XDG_CONFIG_HOME"] = str(_XDG_CONFIG)
os.environ["TMP"] = str(_TMP)
os.environ["TEMP"] = str(_TMP)
os.environ["TMPDIR"] = str(_TMP)
os.environ.setdefault("GAME_SENTENCE_MINER_TESTING", "1")


class _NoopLogger:
    def __getattr__(self, _name):
        def _noop(*_args, **_kwargs):
            return None

        return _noop

    def patch(self, *_args, **_kwargs):
        return self

    def log(self, *_args, **_kwargs):
        return None


_noop_logger = _NoopLogger()
_fake_logging_module = types.ModuleType("GameSentenceMiner.util.logging_config")
_fake_logging_module.logger = _noop_logger
_fake_logging_module.get_logger = lambda *args, **kwargs: _noop_logger
_fake_logging_module.initialize_logging = lambda *args, **kwargs: None
_fake_logging_module.cleanup_old_logs = lambda *args, **kwargs: None
_fake_logging_module.display = lambda *args, **kwargs: None
_fake_logging_module.background = lambda *args, **kwargs: None
_fake_logging_module.text_received = lambda *args, **kwargs: None
_fake_logging_module.LoggerManager = object

sys.modules["GameSentenceMiner.util.logging_config"] = _fake_logging_module


@pytest.fixture
def tmp_path():
    case_path = _TMP_CASES / f"case_{uuid.uuid4().hex}"
    case_path.mkdir(parents=True, exist_ok=False)
    try:
        yield case_path
    finally:
        shutil.rmtree(case_path, ignore_errors=True)
