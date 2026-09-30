from __future__ import annotations

import json
from datetime import datetime, timezone

import pytest
from PIL import Image

from GameSentenceMiner.ocr.debug_logging import (
    close_ocr_debug_log,
    emit_ocr_debug,
    reset_ocr_debug_log_for_tests,
    start_ocr_debug_log,
)
from GameSentenceMiner.ocr.gsm_ocr import TwoPassConfig, TwoPassOCRControllerV2


@pytest.fixture(autouse=True)
def _reset_debug_log():
    reset_ocr_debug_log_for_tests()
    yield
    reset_ocr_debug_log_for_tests()


def _debug_payloads(path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


def test_debug_event_is_parseable_and_disabled_logging_is_silent(tmp_path):
    log_path, created = start_ocr_debug_log(tmp_path)

    emit_ocr_debug(False, "disabled", text="secret")
    emit_ocr_debug(True, "enabled", frame_id=7, text="recognized")
    close_ocr_debug_log()

    assert created is True
    payloads = _debug_payloads(log_path)
    assert datetime.fromisoformat(payloads[0].pop("timestamp"))
    assert isinstance(payloads[0].pop("pid"), int)
    assert payloads == [
        {
            "schema": "gsm_ocr_debug_v1",
            "event": "enabled",
            "frame_id": 7,
            "text": "recognized",
        }
    ]


def test_debug_log_rotates_by_size_and_remains_parseable(tmp_path):
    path, _ = start_ocr_debug_log(tmp_path, max_bytes=512, backup_count=2)
    for index in range(20):
        emit_ocr_debug(True, "ocr.result", text="recognized", frame_id=index)
    emit_ocr_debug(True, "large.result", text="x" * 2000)
    close_ocr_debug_log()
    assert path == tmp_path / "ocr-debug.jsonl"
    files = [path, *sorted((tmp_path / "history").glob("ocr-debug.jsonl.*"))]
    assert len(files) == 3
    for file in files:
        assert file.stat().st_size <= 512
        assert _debug_payloads(file)
    assert _debug_payloads(path)[-1]["event"] == "diagnostic.oversized"


def test_v2_logs_no_flush_then_flush_reason(tmp_path):
    log_path, _created = start_ocr_debug_log(tmp_path)
    queued: list[str] = []

    def queue_second_pass(ocr1_text, *_args, **_kwargs):
        queued.append(ocr1_text)
        return True

    controller = TwoPassOCRControllerV2(
        config=TwoPassConfig(
            two_pass_enabled=True,
            ocr1_engine="oneocr",
            ocr2_engine="glens",
            advanced_debug_logging=True,
        ),
        queue_second_pass=queue_second_pass,
        get_ocr2_image=lambda _coords, image, _padding=0: image,
    )
    image = Image.new("RGB", (80, 30), "white")
    now = datetime(2026, 8, 5, 12, 0, 0, tzinfo=timezone.utc)

    controller.handle_ocr_result("hello", ["hello"], now, image)
    controller.handle_ocr_result("hello", ["hello"], now, image)
    close_ocr_debug_log()

    payloads = _debug_payloads(log_path)
    no_flush = [payload for payload in payloads if payload["event"] == "ocr2.no_flush"]
    flushes = [payload for payload in payloads if payload["event"] == "ocr2.flush"]

    assert no_flush[-1]["reason"] == "waiting_for_stable_text"
    assert flushes[-1]["reason"] == "text_stable"
    assert queued == ["hello"]


def test_debug_log_is_reused_for_the_same_process_run(tmp_path):
    first_path, first_created = start_ocr_debug_log(tmp_path)
    emit_ocr_debug(True, "before_disable")
    close_ocr_debug_log()
    emit_ocr_debug(True, "while_closed")
    second_path, second_created = start_ocr_debug_log(tmp_path)
    emit_ocr_debug(True, "after_reenable")
    close_ocr_debug_log()

    assert second_path == first_path
    assert first_created is True
    assert second_created is False
    assert [payload["event"] for payload in _debug_payloads(first_path)] == [
        "before_disable",
        "after_reenable",
    ]
