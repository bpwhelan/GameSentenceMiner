from __future__ import annotations

import os
import shutil
import sys
import tempfile
import types
import uuid
from pathlib import Path

import pytest


_TEST_ROOT = Path(__file__).resolve().parent.parent / ".tmp_test_env"
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
os.environ["GSM_TEST_DATA_ROOT"] = str(_TEST_ROOT)
os.environ["GSM_DISABLE_DB_BACKUP"] = "1"
tempfile.tempdir = str(_TMP)

# ---------------------------------------------------------------------------
# Stub out the ``keyboard`` package which fatally aborts on macOS when imported
# (it tries to access the Darwin keyboard API without Accessibility permissions).
# The stub must land in sys.modules *before* any test module triggers an import
# of ``GameSentenceMiner.util.platform`` → ``hotkey`` → ``keyboard``.
# ---------------------------------------------------------------------------
if "keyboard" not in sys.modules:
    _fake_keyboard = types.ModuleType("keyboard")
    _fake_keyboard.add_hotkey = lambda *a, **kw: None
    _fake_keyboard.remove_hotkey = lambda *a, **kw: None
    _fake_keyboard.on_press_key = lambda *a, **kw: None
    _fake_keyboard.unhook_key = lambda *a, **kw: None
    _fake_keyboard.hook = lambda *a, **kw: None
    _fake_keyboard.unhook_all = lambda *a, **kw: None
    sys.modules["keyboard"] = _fake_keyboard


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


@pytest.fixture(scope="session", autouse=True)
def _initialize_database_runtime_for_tests():
    from GameSentenceMiner.util.database.db import gsm_db, start_database_runtime

    start_database_runtime()
    yield
    from GameSentenceMiner.util.communication.electron_ipc import stop_ipc_listener
    from GameSentenceMiner.util.concurrency.scheduler import shutdown_runtime_scheduler
    from GameSentenceMiner.util.concurrency.work_pool import shutdown_background_work
    from GameSentenceMiner.util.cron.tokenize_lines import stop_realtime_tokenization

    stop_ipc_listener(close_bus=False)
    stop_realtime_tokenization()
    shutdown_runtime_scheduler()
    shutdown_background_work(wait=True)
    gsm_db.close()


@pytest.fixture
def tmp_path():
    case_path = _TMP_CASES / f"case_{uuid.uuid4().hex}"
    case_path.mkdir(parents=True, exist_ok=False)
    try:
        yield case_path
    finally:
        shutil.rmtree(case_path, ignore_errors=True)


@pytest.fixture(autouse=True)
def _stop_authoritative_text_runtime_between_tests():
    """Never leak GSM's managed non-daemon actors across test boundaries."""
    yield
    gametext_module = sys.modules.get("GameSentenceMiner.gametext")
    stop = getattr(gametext_module, "stop_authoritative_text_runtime", None)
    if callable(stop):
        stop()
    ocr_ipc_module = sys.modules.get("GameSentenceMiner.util.communication.ocr_ipc")
    stop_ocr_outbox = getattr(ocr_ipc_module, "stop_text_ingress_outbox", None)
    if callable(stop_ocr_outbox):
        stop_ocr_outbox()
