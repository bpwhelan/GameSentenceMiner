from __future__ import annotations

import os
import subprocess
import sys
import time
from pathlib import Path

import psutil
import pytest

from tests.util.test_bus_client import TOKEN, MiniBroker

_CHILD_SCRIPT = """
import json
import os
import threading
import faulthandler
import time

# Use the test data directory and logging/keyboard stubs, never the user's data.
import tests.conftest
import GameSentenceMiner.ocr.gsm_ocr as gsm_ocr
from GameSentenceMiner.util.communication import bus_client, ocr_ipc
from PyQt6.QtCore import QTimer

gsm_ocr.ocr_runtime.terminated = False
qt_main = gsm_ocr.initialize_qt_runtime_for_ocr()
ocr_ipc.register_command_handler(gsm_ocr.handle_ipc_command)
ocr_ipc.start_ipc_listener()
assert bus_client.get_bus().wait_connected(5)
faulthandler.dump_traceback_later(1.5)
for index in range(int(os.environ['OCR_TEST_PENDING_RESULTS'])):
    ocr_ipc.announce_ocr_result('shutdown test', {'observationId': f'shutdown-{index}'})
if os.environ['OCR_TEST_STOP_BEFORE_LOOP'] == '1':
    ocr_ipc.announce_started()
    deadline = time.monotonic() + 5
    while not gsm_ocr.shutdown_requested and time.monotonic() < deadline:
        time.sleep(0.01)
    assert gsm_ocr.shutdown_requested
else:
    QTimer.singleShot(0, ocr_ipc.announce_started)
gsm_ocr.run_qt_event_loop_for_ocr(qt_main)
faulthandler.cancel_dump_traceback_later()
print('OCR_SHUTDOWN_STATE=' + json.dumps({
    'scan_stopped': gsm_ocr.ocr_runtime.terminated,
    'remaining_threads': [
        thread.name for thread in threading.enumerate()
        if thread is not threading.main_thread() and not thread.daemon
    ],
}), flush=True)
"""


def _kill_test_process_tree(proc):
    if proc.poll() is not None:
        return
    try:
        descendants = psutil.Process(proc.pid).children(recursive=True)
    except psutil.NoSuchProcess:
        descendants = []
    for child in reversed(descendants):
        try:
            child.kill()
        except psutil.NoSuchProcess:
            pass
    proc.kill()


@pytest.mark.parametrize(
    ("pending_results", "stop_before_loop"),
    [(0, False), (4, False), (0, True)],
    ids=["idle", "pending-text-delivery", "stop-during-startup"],
)
def test_ocr_exits_after_bus_stop_without_force_killing(pending_results, stop_before_loop):
    broker = MiniBroker()
    broker.start()
    proc = subprocess.Popen(
        [sys.executable, "-u", "-c", _CHILD_SCRIPT],
        cwd=Path(__file__).resolve().parents[2],
        env={
            **os.environ,
            "GSM_BROKER_PORT": str(broker.port),
            "GSM_BROKER_TOKEN": TOKEN,
            "GSM_CLIENT_ID": "ocr",
            "QT_QPA_PLATFORM": "offscreen",
            "OCR_TEST_PENDING_RESULTS": str(pending_results),
            "OCR_TEST_STOP_BEFORE_LOOP": str(int(stop_before_loop)),
        },
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    try:
        broker.wait_for(
            lambda frame: frame.get("topic") == "ocr.event" and frame.get("data", {}).get("event") == "started",
            timeout=20,
        )
        started = time.monotonic()
        broker.send(
            {
                "v": 1,
                "id": "stop-test",
                "src": "main",
                "dst": "ocr",
                "kind": "command",
                "topic": "ocr.command",
                "data": {"command": "stop", "data": {"reason": "shutdown-regression"}},
            }
        )
        try:
            output, _ = proc.communicate(timeout=2)
        except subprocess.TimeoutExpired:
            _kill_test_process_tree(proc)
            output, _ = proc.communicate(timeout=5)
            pytest.fail(f"OCR stayed alive past the two-second graceful-stop deadline:\n{output}")
        assert proc.returncode == 0, output
        assert '"scan_stopped": true' in output, output
        assert '"remaining_threads": []' in output, output
        assert time.monotonic() - started < 2
    finally:
        _kill_test_process_tree(proc)
        proc.communicate(timeout=5)
        broker.stop()
