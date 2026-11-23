"""Compare the mining configuration produced by both loaders and time startup on disposable profiles."""

import argparse
import json
import os
import platform
import statistics
import sys
import tempfile
import time
from contextlib import ExitStack
from pathlib import Path

from benchmark_stats import _configure_bootstrap_environment, _install_noop_logging_module
from benchmark_stats_web import measure, start_worker


def python_worker(root):
    _configure_bootstrap_environment(root / "environment")
    _install_noop_logging_module()
    directory = root / "profile"
    directory.mkdir(exist_ok=True)
    os.environ["GSM_PROFILE_DIR"] = str(directory)
    os.chdir(directory)
    from GameSentenceMiner.util.config import configuration as config

    print(f"ready {os.getpid()}", flush=True)
    for line in sys.stdin:
        directory_arg, count, verify = json.loads(line)
        assert Path(directory_arg) == directory
        start = time.perf_counter()
        for _ in range(count):
            result = config.load_config()
        elapsed = (time.perf_counter() - start) * 1000 / count
        if verify:
            (root / "expected.json").write_text(json.dumps(result.to_dict()), encoding="utf-8")
        print(json.dumps({"ms": elapsed}), flush=True)


def verify(reference, actual):
    # Qt resolves the current display at construction. The desktop records an
    # explicit display choice when the capture selector runs.
    for d in [reference, actual]:
        d.pop("version")
        for overlay in [d["overlay"], *(p["overlay"] for p in d["configs"].values())]:
            overlay.pop("monitor_to_capture_id")
            overlay.pop("monitor_to_capture_bounds")
        for p in d["configs"].values():
            p["obs"]["obs_path"] = Path(p["obs"]["obs_path"]).as_posix()
            # Qt declares these as strings but gives fresh installs numeric defaults.
            # Both encodings select the same dimensions and encoder quality in GSM.
            for key in ("width", "height", "quality"):
                p["screenshot"][key] = int(p["screenshot"][key])
            # The workers have separate APPDATA roots.
            assert Path(p["audio"]["anki_media_collection"]).parts[-3:] == ("Anki2", "User 1", "collection.media")
            del p["audio"]["anki_media_collection"]
    errors = []

    def compare(left, right, path):
        if isinstance(left, dict) and isinstance(right, dict):
            for key in left:
                if key not in right:
                    errors.append((f"{path}.{key}", left[key], "<missing>"))
                else:
                    compare(left[key], right[key], f"{path}.{key}")
        elif left != right:
            errors.append((path, left, right))

    compare(reference, actual, "")
    if errors:
        raise AssertionError(errors[:10])


def run(root, args):
    directory = root / "profile"
    directory.mkdir()
    path = directory / "config.json"
    legacy = {"version": "2.17.9", "current_profile": "Default", "configs": {}, "stats": {"session_gap_seconds": 3600}}
    for i in range(8):
        name = "Default" if i == 0 else f"Game-{i}"
        legacy["configs"][name] = {
            "name": name,
            "general": {"websocket_uri": "localhost:6677, localhost:9001, custom:8333"},
            "anki": {"sentence_field": "Context", "sentence_field_append": True, "overwrite_sentence": False},
            "vad": {"selected_vad_model": "SILERO"},
            "retained_option": {"n": i},
        }
    results = {}
    with ExitStack() as stack:
        workers = {
            "python": start_worker(stack, [sys.executable, __file__, "--worker", root]),
            "rust": start_worker(
                stack, [args.rust_test.resolve(), "--exact", "benchmark_worker", "--ignored", "--nocapture"]
            ),
        }
        for kind in ("fresh", "upgrade", "reopen"):
            samples = {key: [] for key in workers}
            for round_index in range(args.rounds):
                for name in workers if round_index % 2 == 0 else reversed(workers):
                    if kind == "fresh":
                        path.unlink(missing_ok=True)
                    elif kind == "upgrade":
                        path.write_text(json.dumps(legacy), encoding="utf-8")
                    else:
                        path.write_bytes(upgraded)
                    row = measure(workers[name], str(directory), 10 if kind == "reopen" else 1, verify=round_index == 0)
                    samples[name].append(row)
                    if round_index == 0 and name == "rust":
                        actual = json.loads(path.read_text(encoding="utf-8"))
                        if kind == "upgrade":
                            upgraded = path.read_bytes()
                            assert actual["configs"]["Game-7"]["retained_option"] == {"n": 7}
                if round_index == 0:
                    verify(json.loads((root / "expected.json").read_text(encoding="utf-8")), actual)
            results[kind] = {
                name: {k: round(statistics.median(row[k] for row in rows), 3) for k in rows[0]}
                for name, rows in samples.items()
            }
    return {
        "platform": platform.platform(),
        "python": platform.python_version(),
        "rounds": args.rounds,
        "method": "Warm worker processes. Full config load, native atomic persistence when changed, eight profiles for upgrade/reopen. Median time and worker CPU in ms per call. Lifetime peak working set in MiB on Windows. Imports excluded.",
        "medians": results,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--worker", type=Path)
    parser.add_argument("--rust-test", type=Path)
    parser.add_argument("--rounds", type=int, default=5)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.worker:
        python_worker(args.worker)
    elif args.rust_test and args.rounds > 0:
        with tempfile.TemporaryDirectory(prefix="gsm-config-") as temporary:
            result = json.dumps(run(Path(temporary), args), indent=2)
        print(result)
        if args.output:
            args.output.write_text(result + "\n", encoding="utf-8")
    else:
        parser.error("Supply a release profile_upgrade test executable and positive round count")
