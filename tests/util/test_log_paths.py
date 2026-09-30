import os
import subprocess
import sys

from GameSentenceMiner.util import log_paths


def test_component_paths_have_stable_readable_names(tmp_path):
    assert log_paths.get_component_log_path(tmp_path, "gamesentenceminer") == tmp_path / "backend.log"
    assert log_paths.get_component_log_path(tmp_path, "misc_ocr_utils") == tmp_path / "ocr.log"


def test_rotations_are_bounded_and_kept_out_of_the_log_root(tmp_path):
    sink = log_paths.SharedRotatingLog(tmp_path / "ocr.log", max_bytes=32, backup_count=2)
    for index in range(10):
        sink.write(f"record {index}: recognized text\n")
    assert (tmp_path / "ocr.log").read_text() == "record 9: recognized text\n"
    assert sorted(p.name for p in (tmp_path / "history").iterdir()) == ["ocr.log.1", "ocr.log.2"]
    assert (tmp_path / "history" / "ocr.log.2").read_text() == "record 7: recognized text\n"
    assert not list(tmp_path.glob("ocr.*.log"))


def test_independent_processes_append_and_rotate_without_losing_records(tmp_path):
    script = (
        "from pathlib import Path\n"
        "import sys\n"
        "from GameSentenceMiner.util.log_paths import SharedRotatingLog\n"
        "sink = SharedRotatingLog(Path(sys.argv[1]), max_bytes=512, backup_count=30)\n"
        "for i in range(80): sink.write(f'{sys.argv[2]}:{i:03d} OCR 日本語\\n')\n"
    )
    workers = [
        subprocess.Popen(
            [sys.executable, "-c", script, str(tmp_path / "ocr.log"), str(index)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        for index in range(4)
    ]
    for worker in workers:
        stdout, stderr = worker.communicate(timeout=30)
        assert worker.returncode == 0, (stdout, stderr)
    records = []
    for log in [tmp_path / "ocr.log", *sorted((tmp_path / "history").iterdir())]:
        records.extend(log.read_text(encoding="utf-8").splitlines())
    assert sorted(records) == sorted(f"{worker}:{i:03d} OCR 日本語" for worker in range(4) for i in range(80))


def test_logger_survives_relaunch_without_empty_error_files_or_ansi(tmp_path):
    environment = {**os.environ, "GSM_DATA_DIR": str(tmp_path)}
    script = (
        "from GameSentenceMiner.util.logging_config import logger\n"
        "logger.info('persistent log test')\n"
        "try: raise ValueError('diagnostic error')\n"
        "except ValueError: logger.exception('failed')\n"
        "logger.complete()\n"
    )
    for _ in range(2):
        result = subprocess.run(
            [sys.executable, "-c", script],
            check=False,
            capture_output=True,
            text=True,
            env=environment,
            timeout=30,
        )
        assert result.returncode == 0, result.stderr
    logs = tmp_path / "logs"
    text = (logs / "backend.log").read_text(encoding="utf-8")
    assert text.count("persistent log test") == 2
    assert text.count("ValueError: diagnostic error") == 2
    assert "\x1b" not in text
    assert not list(logs.glob("error*"))
    assert len(list(logs.glob("*.log"))) == 1


def test_ocr_entrypoint_is_detected_before_importing_runtime(tmp_path):
    script = (
        "import sys\n"
        "sys.argv[0] = 'GameSentenceMiner/ocr/gsm_ocr.py'\n"
        "from GameSentenceMiner.util.logging_config import logger\n"
        "logger.error('early OCR startup failure')\n"
        "logger.complete()\n"
    )
    result = subprocess.run(
        [sys.executable, "-c", script],
        check=False,
        env={**os.environ, "GSM_DATA_DIR": str(tmp_path)},
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, result.stderr
    assert "early OCR startup failure" in (tmp_path / "logs" / "ocr.log").read_text()
    assert not (tmp_path / "logs" / "backend.log").exists()


def test_ocr_module_launch_routes_package_initialization_to_ocr_log(tmp_path):
    # Importing the OCR package initializes configuration before runpy replaces
    # argv[0] == '-m' with the module filename. This is the actual desktop launch path.
    result = subprocess.run(
        [sys.executable, "-m", "GameSentenceMiner.ocr.debug_logging"],
        env={**os.environ, "GSM_DATA_DIR": str(tmp_path)},
        capture_output=True,
        text=True,
        check=False,
        timeout=30,
    )
    assert result.returncode == 0, result.stderr
    assert (tmp_path / "logs" / "ocr.log").exists()
    assert not (tmp_path / "logs" / "backend.log").exists()


def test_backend_embedded_ocr_is_routed_to_ocr_log_and_helpers_keep_callsite(tmp_path):
    script = (
        "from GameSentenceMiner.util.logging_config import logger\n"
        "logger.background('backend callsite')\n"
        "logger.patch(lambda record: record.update(file={'path': 'GameSentenceMiner/owocr/owocr/ocr.py'})).info('embedded OCR result')\n"
        "logger.complete()\n"
    )
    result = subprocess.run(
        [sys.executable, "-c", script],
        env={**os.environ, "GSM_DATA_DIR": str(tmp_path)},
        capture_output=True,
        text=True,
        check=False,
        timeout=30,
    )
    assert result.returncode == 0, result.stderr
    backend = (tmp_path / "logs" / "backend.log").read_text()
    assert "__main__:<module>:2 | backend callsite" in backend
    assert "embedded OCR result" not in backend
    assert "embedded OCR result" in (tmp_path / "logs" / "ocr.log").read_text()
