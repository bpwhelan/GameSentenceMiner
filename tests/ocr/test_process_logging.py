import os
from pathlib import Path

from GameSentenceMiner.ocr.process_logging import start_ocr_process_log


class FakeLogger:
    def __init__(self):
        self.add_calls = []
        self.info_calls = []

    def add(self, path, **kwargs):
        self.add_calls.append((path, kwargs))
        Path(path).touch()
        return 42

    def info(self, message, *args):
        self.info_calls.append(message.format(*args))


def test_start_ocr_process_log_creates_dedicated_log_and_keeps_latest_three(tmp_path):
    log_dir = tmp_path / "ocr_logs"
    log_dir.mkdir()
    old_logs = []
    for index in range(3):
        old_log = log_dir / f"ocr_process_20260101_00000{index}_000000_1.log"
        old_log.write_text(f"old {index}", encoding="utf-8")
        os.utime(old_log, (index + 1, index + 1))
        old_logs.append(old_log)

    fake_logger = FakeLogger()
    log_path, handler_id = start_ocr_process_log(fake_logger, tmp_path, max_files=3)

    remaining_logs = sorted(log_dir.glob("ocr_process_*.log"))
    assert handler_id == 42
    assert log_path in remaining_logs
    assert len(remaining_logs) == 3
    assert not old_logs[0].exists()
    assert fake_logger.add_calls[0][1]["level"] == "DEBUG"
    assert fake_logger.add_calls[0][1]["enqueue"] is True
    assert fake_logger.info_calls == [f"OCR process log: {log_path}"]
