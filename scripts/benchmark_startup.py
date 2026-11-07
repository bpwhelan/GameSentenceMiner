"""Measure backend readiness in an isolated profile, without starting external apps.

Run with the repository's .venv Python. Each sample exercises real database
initialization, route registration, Qt, overlay processing, HTTP and text intake.
OBS, Anki, cloud sync, global hotkeys, dependency downloads and cron jobs are
excluded. Settings are opened after readiness to verify the lazy GUI lifecycle.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import platform
import socket
import statistics
import subprocess
import sys
import tempfile
import threading
import time
from http.client import HTTPConnection
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parent.parent
RESULT_PREFIX = "GSM_STARTUP_BENCHMARK:"


def sample(data: Path) -> dict:
    sys.path.insert(0, str(ROOT))
    os.environ.update(
        GSM_DATA_DIR=str(data),
        GSM_ELECTRON="1",
        GAME_SENTENCE_MINER_TESTING="1",
        GSM_TEST_DATA_ROOT=str(data),
        GSM_DISABLE_DB_BACKUP="1",
        QT_QPA_PLATFORM="offscreen",
    )
    for key in (
        "GSM_BROKER_PORT",
        "GSM_BROKER_TOKEN",
        "GSM_CLIENT_ID",
        "GSM_INPUT_SERVER_MANAGED",
        "GSM_INPUT_SERVER_URL",
        "GSM_INPUT_SERVER_PORT",
    ):
        os.environ.pop(key, None)

    started = time.perf_counter()
    import GameSentenceMiner.gsm as gsm

    config = gsm.get_config()
    config.general.open_config_on_startup = False
    config.general.open_multimine_on_startup = False
    config.general.use_clipboard = False
    config.general.use_websocket = False
    config.obs.open_obs = False
    config.obs.close_obs = False
    config.advanced.localhost_bind_address = "127.0.0.1"
    config.paths.output_folder = str(data / "output")
    Path(config.paths.output_folder).mkdir()
    with socket.socket() as listener, socket.socket() as legacy_listener:
        listener.bind(("127.0.0.1", 0))
        legacy_listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
        config.general.texthooker_port = legacy_listener.getsockname()[1]
    config.general.single_port = port
    gsm.hotkey_manager = SimpleNamespace(
        clear=lambda: None, register=lambda *args: None, register_gamepad=lambda *args: None
    )
    app = gsm.GSMApplication()
    app.initial_checks = lambda: None
    app._start_foreground_window_hook = lambda: None

    async def idle(*args, **kwargs):
        await gsm.asyncio.Event().wait()

    gsm.obs.wait_for_obs_ready = idle
    app.background_tasks_async = idle
    app._announce_startup_ready = lambda: None
    app.start_background_threads = lambda: app._start_thread(gsm._get_run_text_hooker_page(), "benchmark-http")
    qt = gsm._get_qt_main_module()
    start_qt = qt.start_qt_app
    results = {}
    failures = []

    def inspect():
        try:
            deadline = time.perf_counter() + 20
            while time.perf_counter() < deadline:
                connection = HTTPConnection("127.0.0.1", port, timeout=0.3)
                try:
                    connection.request("GET", "/get_status")
                    response = connection.getresponse()
                    response.read()
                    if response.status == 200 and gsm._get_gametext_module().is_text_monitor_initialized():
                        break
                except OSError:
                    pass
                finally:
                    connection.close()
                time.sleep(0.02)
            else:
                raise RuntimeError("HTTP/text intake did not become ready")
            results["ready_seconds"] = round(time.perf_counter() - started, 4)
            results["hidden_settings_created"] = app.state.settings_window is not None
            settings_started = time.perf_counter()
            settings = app._ensure_settings_window()
            if settings is not app._ensure_settings_window():
                raise RuntimeError("Settings were constructed more than once")
            results["settings_first_open_seconds"] = round(time.perf_counter() - settings_started, 4)
        except Exception as error:
            failures.append(str(error))
        finally:
            app._request_shutdown()

    def run_qt(**kwargs):
        threading.Thread(target=inspect, name="benchmark-inspect", daemon=True).start()
        return start_qt(**kwargs)

    qt.start_qt_app = run_qt
    # An existing installation has already prepared its dependencies. Avoid
    # downloading them or starting OBS while exercising the remaining startup.
    app.run(reloading=True)
    if app._shutdown_thread:
        app._shutdown_thread.join(timeout=10)
    if failures or not results:
        raise RuntimeError(f"Startup benchmark failed: {failures}")
    if app._shutdown_thread is None or app._shutdown_thread.is_alive():
        raise RuntimeError("Backend shutdown did not finish")
    results["clean_shutdown"] = True
    return results


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--sample-directory", type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.sample_directory:
        print(RESULT_PREFIX + json.dumps(sample(args.sample_directory.resolve())), flush=True)
        return
    if not 1 <= args.runs <= 20:
        parser.error("--runs must be between 1 and 20")

    samples = []
    temporary_root = Path(tempfile.gettempdir()).resolve()
    for index in range(args.runs):
        with tempfile.TemporaryDirectory(prefix="gsm-startup-", dir=temporary_root) as directory:
            # Verify the cleanup target before allowing TemporaryDirectory to
            # remove it; never point this tool at the user's GSM data directory.
            if Path(directory).resolve().parent != temporary_root:
                raise RuntimeError("Unexpected benchmark temporary directory")
            result = subprocess.run(
                [sys.executable, str(Path(__file__).resolve()), "--sample-directory", directory],
                cwd=ROOT,
                capture_output=True,
                stdin=subprocess.DEVNULL,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=45,
            )
            if result.returncode:
                raise RuntimeError(f"Benchmark process failed:\n{result.stdout}\n{result.stderr}")
            line = next((line for line in result.stdout.splitlines() if line.startswith(RESULT_PREFIX)), None)
            if line is None:
                raise RuntimeError(f"Benchmark returned no measurement:\n{result.stdout}\n{result.stderr}")
            measurement = json.loads(line.removeprefix(RESULT_PREFIX))
            samples.append(measurement)
            print(f"Sample {index + 1}: {measurement['ready_seconds']:.3f}s; clean shutdown verified", flush=True)

    report = {
        "scope": "Isolated Python backend readiness; excludes external services and first-run setup",
        "platform": platform.platform(),
        "python": platform.python_version(),
        "samples": samples,
        "median_seconds": statistics.median(entry["ready_seconds"] for entry in samples),
    }
    content = json.dumps(report, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(content, encoding="utf-8")
    print(content)


if __name__ == "__main__":
    main()
