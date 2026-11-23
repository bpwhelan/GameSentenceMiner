"""Run the desktop's supervised Qt host against an offscreen text input dialog."""

import argparse
import json
import os
import platform
import statistics
import subprocess
import sys
from pathlib import Path
from tempfile import TemporaryDirectory

ROOT = Path(__file__).resolve().parents[1]


def write_fixture(profile):
    # Only this temporary worker overlays the dialog entry point. It imports
    # the actual widgets and supplies a user response through Qt's event loop.
    fixture = profile / "dialog-fixture"
    for relative in ("GameSentenceMiner", "GameSentenceMiner/ui"):
        package = fixture / relative
        package.mkdir(parents=True)
        original = ROOT / relative
        (package / "__init__.py").write_text(
            f"__path__.append({str(original)!r})\n"
            f"exec(compile(open({str(original / '__init__.py')!r}, 'rb').read(), "
            f"{str(original / '__init__.py')!r}, 'exec'))\n"
        )
    (fixture / "GameSentenceMiner/ui/desktop_dialog.py").write_text(
        f"""import json, os, runpy, sys
from pathlib import Path
import psutil
from PyQt6.QtCore import QTimer
from PyQt6.QtWidgets import QApplication, QInputDialog
from GameSentenceMiner.ui import qt_main

if os.environ['GSM_QT_FIXTURE_MODE'] == 'session':
    qt_main.get_qt_app()
host = runpy.run_path({str(ROOT / "GameSentenceMiner/ui/desktop_dialog.py")!r})
original = host['open_dialog']
def choose():
    widget = QApplication.activeModalWidget()
    grouping = os.environ.get('GSM_SMOKE_ANKI_GROUPING')
    if not grouping and not isinstance(widget, QInputDialog):
        raise RuntimeError('Expected a real Qt text input dialog')
    proc = psutil.Process()
    metrics = {{'cpu_ms': 1000 * (proc.cpu_times().user + proc.cpu_times().system),
               'uss_mib': proc.memory_full_info().uss / 2**20}}
    (Path(os.environ['GSM_PROFILE_DIR'])/'metrics.json').write_text(json.dumps(metrics))
    if grouping:
        assert widget.order_combo.currentData() == 'back' and not widget.delete_duplicate_check.isChecked()
        widget.target_combo.setCurrentIndex(1)
        widget._accept_overwrite()
    else:
        widget.setTextValue('日本語')
        widget.accept()
def opened(request, *args, **kwargs):
    if request.get('dialog') == 'settings':
        from GameSentenceMiner.ui import config_gui_qt
        # Offscreen Qt must not activate a window or contact the user's OBS or Anki.
        config_gui_qt.ConfigWindow._force_windows_foreground = lambda self: None
        config_gui_qt.ConfigWindow._start_settings_lookup = lambda *a, **kw: None
        config_gui_qt.ConfigWindow.get_online_models = lambda self: None
        config_gui_qt.obs.update_current_game = lambda: None
        config_gui_qt.obs.apply_obs_performance_settings = lambda *a, **kw: None
        result = original(request, *args, **kwargs)
        window = qt_main.get_config_window()
        expected = window._settings_tab_indices[request['root_tab_key']]
        assert window.isVisible() and window.tab_widget.currentIndex() == expected
        if request['root_tab_key'] == 'hotkeys':
            assert window.open_config_on_startup_check.isChecked(), 'Saved checkbox did not survive reopening'
        if kwargs.get('standalone'):
            timer = QTimer(window)
            timer.setInterval(50)
            def close():
                if (Path(os.environ['GSM_PROFILE_DIR'])/'close-settings').is_file():
                    timer.stop()
                    window.open_config_on_startup_check.setChecked(True)
                    window.request_auto_save(immediate=True)
                    window.hide()
            timer.timeout.connect(close)
            timer.start()
        return result
    QTimer.singleShot(0, choose)
    return original(request, *args, **kwargs)
host['run_worker'].__globals__['open_dialog'] = opened
if os.environ['GSM_QT_FIXTURE_MODE'] == 'live':
    from GameSentenceMiner.util.communication.bus_client import get_bus
    app = qt_main.get_qt_app()
    bus = get_bus()
    bus.handle('gui.dialog', host['handle_dialog'], concurrent=True)
    bus.start()
    app.exec()
else:
    host['run_worker'](*sys.argv[1:])
""",
        encoding="utf-8",
    )


def sample(desktop, mode):
    with TemporaryDirectory() as temp:
        profile = Path(temp)
        write_fixture(profile)
        result = profile / "result.json"
        env = {
            **os.environ,
            "GSM_APP_ROOT": str(ROOT),
            "GSM_PROFILE_DIR": temp,
            "GSM_DATA_DIR": temp,
            "GSM_SHARED_DATA_DIR": temp,
            "GSM_TEST_QT_PYTHON": sys.executable,
            "GSM_SMOKE_TEST": "1",
            "GSM_SMOKE_SUITE": "qt-dialog",
            "GSM_TEST_RESULT": str(result),
            "GSM_QT_FIXTURE_MODE": mode,
            "QT_QPA_PLATFORM": "offscreen",
        }
        try:
            run = subprocess.run([desktop], cwd=ROOT, env=env, timeout=60, capture_output=True, check=False)
        except subprocess.TimeoutExpired as exc:
            backend_log = profile / "logs" / "backend.log"
            logs = backend_log.read_text(encoding="utf-8", errors="replace")[-3500:] if backend_log.is_file() else ""
            raise RuntimeError(logs + (exc.stderr or b"").decode(errors="replace")[-3000:]) from exc
        if run.returncode or not result.is_file():
            raise RuntimeError(
                (result.read_text() if result.is_file() else "") + run.stderr.decode(errors="replace")[-4000:]
            )
        if mode == "settings":
            detail = json.loads(result.read_text())["detail"]
            if not {"open_ms", "focus_ms", "reopen_ms"} <= detail.keys():
                raise RuntimeError("The executable does not contain the settings smoke test.")
            return detail
        return {**json.loads(result.read_text())["detail"], **json.loads((profile / "metrics.json").read_text())}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rounds", type=int, default=3)
    parser.add_argument("--desktop", type=Path, help="Select a specific desktop build")
    parser.add_argument(
        "--settings", action="store_true", help="Exercise the settings window and a concurrent modal dialog"
    )
    parser.add_argument("--output", type=Path, help="Write each measured sample and its median to JSON")
    args = parser.parse_args()
    if args.rounds < 1:
        parser.error("--rounds must be positive")
    exe = (
        args.desktop.resolve()
        if args.desktop
        else subprocess.check_output(
            [
                "node",
                "--input-type=module",
                "-e",
                "import {nativeExecutable} from './scripts/native-paths.mjs'; console.log(nativeExecutable())",
            ],
            cwd=ROOT,
            text=True,
        ).strip()
    )
    if args.settings:
        samples = {"settings": [sample(exe, "settings") for _ in range(args.rounds)]}
    else:
        samples = {"session": [], "standalone": []}
        for i in range(args.rounds):
            for mode in ["session", "standalone"] if i % 2 == 0 else ["standalone", "session"]:
                samples[mode].append(sample(exe, mode))
        samples["live"] = [{"elapsed_ms": sample(exe, "live")["elapsed_ms"]} for _ in range(args.rounds)]
    report = {"platform": platform.platform(), "python": platform.python_version(), "cases": {}}
    for mode, runs in samples.items():
        median = {k: round(statistics.median(r[k] for r in runs), 2) for k in runs[0]}
        report["cases"][mode] = {"samples": runs, "median": median}
        print(mode, median)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, indent=2, allow_nan=False) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
