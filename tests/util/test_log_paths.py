import os
from pathlib import Path
import subprocess
import sys

from GameSentenceMiner.util.log_paths import get_process_log_path


def test_process_log_paths_do_not_share_a_file_between_processes(tmp_path):
    first_process_log = get_process_log_path(tmp_path, "gamesentenceminer", process_id=101)
    second_process_log = get_process_log_path(tmp_path, "gamesentenceminer", process_id=202)

    assert first_process_log == Path(tmp_path) / "gamesentenceminer.101.log"
    assert second_process_log == Path(tmp_path) / "gamesentenceminer.202.log"
    assert first_process_log != second_process_log


def test_logging_config_creates_process_scoped_file_sinks(tmp_path):
    environment = os.environ.copy()
    environment["APPDATA"] = str(tmp_path)
    environment["HOME"] = str(tmp_path)

    result = subprocess.run(
        [
            sys.executable,
            "-c",
            (
                "import os\n"
                "from GameSentenceMiner.util.logging_config import logger\n"
                "logger.info('process-scoped log test')\n"
                "logger.complete()\n"
                "print(f'TEST_PID={os.getpid()}')\n"
            ),
        ],
        check=True,
        capture_output=True,
        text=True,
        env=environment,
    )

    process_id = int(
        next(line.removeprefix("TEST_PID=") for line in result.stdout.splitlines() if line.startswith("TEST_PID="))
    )
    platform_log_root = tmp_path if sys.platform == "win32" else tmp_path / ".config"
    log_dir = platform_log_root / "GameSentenceMiner" / "logs"

    assert get_process_log_path(log_dir, "gamesentenceminer", process_id).is_file()
    assert get_process_log_path(log_dir, "error", process_id).is_file()
