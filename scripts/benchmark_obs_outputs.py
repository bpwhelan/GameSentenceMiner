"""Compare mining commands through real Python and Tauri transports against an isolated OBS v5 fixture."""

import argparse
import gc
import json
import os
import shutil
import statistics
import subprocess
import sys
import threading
import time
from contextlib import ExitStack, suppress
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace

import psutil
from websockets.exceptions import ConnectionClosed
from websockets.sync.server import serve

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


class ObsFixture:
    def __init__(self, directory):
        self.directory = directory
        self.replay = False
        self.record = False
        self.saves = 0
        self.calls = 0

    def respond(self, method):
        if method == "GetReplayBufferStatus":
            return 100, {"outputActive": self.replay}
        if method == "GetRecordStatus":
            return 100, {
                "outputActive": self.record,
                "outputPaused": False,
                "outputTimecode": "00:00:01.000",
                "outputDuration": 1000 if self.record else 0,
                "outputBytes": 4000 if self.record else 0,
            }
        if method == "SaveReplayBuffer":
            self.saves += self.replay
            return (100 if self.replay else 501), {}
        if method == "ToggleReplayBuffer":
            self.replay = not self.replay
            return 100, {"outputActive": self.replay}
        for output, suffix in [("record", "Record"), ("replay", "ReplayBuffer")]:
            if method in ("Start" + suffix, "Stop" + suffix):
                active = method.startswith("Start")
                if active == getattr(self, output):
                    return (500 if active else 501), {}
                setattr(self, output, active)
                return 100, {"outputPath": "fixture.mkv"} if method == "StopRecord" else {}
        return 100, {"sceneItems": [], "scenes": [], "currentSceneCollectionName": "Fixture"}

    def handle(self, ws):
        with suppress(ConnectionClosed):
            self.serve_session(ws)

    def serve_session(self, ws):
        ws.send(json.dumps({"op": 0, "d": {"rpcVersion": 1}}))
        identify = json.loads(ws.recv())
        assert identify["op"] == 1
        listens_for_outputs = identify["d"].get("eventSubscriptions", 0) & 64
        ws.send(json.dumps({"op": 2, "d": {"negotiatedRpcVersion": 1}}))
        for frame in ws:
            request = json.loads(frame)["d"]
            method = request["requestType"]
            if "ReplayBuffer" in method or method in {"GetRecordStatus", "StartRecord", "StopRecord"}:
                self.calls += 1
            code, data = self.respond(method)
            reply = {
                "requestId": request["requestId"],
                "requestType": method,
                "requestStatus": {"result": code == 100, "code": code},
            }
            if data:
                reply["responseData"] = data
            ws.send(json.dumps({"op": 7, "d": reply}))
            if method == "SaveReplayBuffer" and code == 100 and listens_for_outputs:
                path = self.directory / f"replay-{self.saves}.mkv"
                path.write_bytes(b"fixture")
                ws.send(
                    json.dumps(
                        {
                            "op": 5,
                            "d": {
                                "eventType": "ReplayBufferSaved",
                                "eventIntent": 64,
                                "eventData": {"savedReplayPath": str(path)},
                            },
                        }
                    )
                )


def cpu_seconds(processes):
    clocks = [p.cpu_times() for p in processes]
    return sum(c.user + c.system for c in clocks)


def worker(args):
    from scripts.benchmark_stats import _configure_bootstrap_environment, _install_noop_logging_module

    profile = Path(os.environ["GSM_PROFILE_DIR"])
    _configure_bootstrap_environment(profile / "backend")
    _install_noop_logging_module()
    if args.worker == "python":
        import GameSentenceMiner

        GameSentenceMiner.__path__.insert(0, str(profile / "reference"))
    from GameSentenceMiner import obs
    from GameSentenceMiner.obs import actions
    from GameSentenceMiner.util.communication import bus_client

    assert Path(actions.__file__).is_relative_to(profile / "reference") == (args.worker == "python")

    endpoint = json.loads((profile / "electron/agent-control.json").read_text())
    desktop = psutil.Process(endpoint["pid"])
    bus = bus_client.start_bus(client_id="backend", port=endpoint["port"], token=endpoint["token"])
    assert bus.wait_connected(5)
    obs.connection_pool = obs.OBSConnectionPool(size=2, host="127.0.0.1", port=args.port, password="", timeout=3)
    obs.connection_pool.connect_all()
    # Other mining features still use this pool, and both desktop versions already run the bus.
    os.environ["GSM_NATIVE_OBS_OUTPUTS"] = "1" if args.worker == "rust" else "0"
    os.environ["GSM_NATIVE_REPLAY_ACQUISITION"] = os.environ["GSM_NATIVE_OBS_OUTPUTS"]
    os.environ["GSM_CLIENT_ID"] = "backend"
    actions.gsm_state.replay_buffer_stopped_timestamp = None
    cfg = SimpleNamespace(
        features=SimpleNamespace(generate_longplay=args.case == "longplay"),
        paths=SimpleNamespace(folder_to_watch=profile),
    )
    actions.get_config = lambda: cfg
    actions._is_obs_recording_disabled = lambda: False
    from GameSentenceMiner.obs.service import OBSService, gsm_status

    gsm_status.obs_connected = True
    service = OBSService.__new__(OBSService)
    service._state_lock = threading.Lock()
    service._replay_buffer_action_grace_seconds = 8
    service.state = SimpleNamespace(replay_buffer_active=None)
    obs.obs_service = service
    service.state.replay_buffer_active = actions.get_replay_buffer_status()
    assert service.state.replay_buffer_active is False
    recording_paths = []
    obs.longplay_handler = SimpleNamespace(
        on_record_stop_response=lambda output_path: recording_paths.append(output_path),
        on_record_start_requested=lambda: None,
    )
    processes = [psutil.Process(), desktop]

    saved_paths = set()

    def save():
        path = actions.save_replay_buffer()
        if args.worker == "rust":
            assert path not in saved_paths and Path(path).read_bytes() == b"fixture"
            saved_paths.add(path)

    def replay():
        actions.start_replay_buffer()
        assert actions.get_replay_buffer_status() is True
        save()
        actions.stop_replay_buffer()
        assert actions.get_replay_buffer_status() is False
        if cfg.features.generate_longplay:
            assert recording_paths.pop() == "fixture.mkv"

    def record():
        actions.start_recording()
        assert actions.stop_recording() == recording_paths.pop() == "fixture.mkv"

    def toggle():
        actions.toggle_replay_buffer()
        assert actions.get_replay_buffer_status() is True
        actions.toggle_replay_buffer()
        assert actions.get_replay_buffer_status() is False

    cycle = {
        "longplay": replay,
        "replay": replay,
        "record": record,
        "save": save,
        "toggle": toggle,
    }[args.case]

    try:
        if args.case == "save":
            actions.start_replay_buffer()
        for _ in range(10):
            cycle()
        gc.collect()
        start_cpu = cpu_seconds(processes)
        start = time.perf_counter()
        for _ in range(args.cycles):
            cycle()
        wall = time.perf_counter() - start
        cpu = cpu_seconds(processes) - start_cpu
        if args.case == "save":
            actions.stop_replay_buffer()
        # Count live private pages in both processes. Exclude the synthetic OBS server.
        gc.collect()
        print(
            json.dumps(
                {
                    "wall_ms": wall * 1000 / args.cycles,
                    "cpu_ms": cpu * 1000 / args.cycles,
                    "private_mib": sum(p.memory_full_info().uss for p in processes) / 2**20,
                }
            )
        )
    finally:
        obs.connection_pool.disconnect_all()
        bus.stop()


def sample(args, exe, mode):
    with ExitStack() as resources:
        directory = resources.enter_context(TemporaryDirectory())
        fixture = ObsFixture(Path(directory))
        server = resources.enter_context(serve(fixture.handle, "127.0.0.1", 0, compression=None))
        port = server.socket.getsockname()[1]
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        profile = Path(directory)
        if mode == "python":
            # Load the original code under its normal package name. Prepare the
            # reference outside the measured worker so it has the same imports.
            prior_obs = profile / "reference/obs"
            shutil.copytree(ROOT / "GameSentenceMiner/obs", prior_obs, ignore=shutil.ignore_patterns("__pycache__"))
            for name in ("actions.py", "service.py"):
                (prior_obs / name).write_bytes(
                    subprocess.check_output(
                        ["git", "show", f"{args.reference_ref}:GameSentenceMiner/obs/{name}"], cwd=ROOT
                    )
                )
        config = {"host": "127.0.0.1", "port": port, "open_obs": False, "close_obs": False}
        (profile / "config.json").write_text(
            json.dumps({"current_profile": "Bench", "configs": {"Bench": {"obs": config}}})
        )
        env = {
            **os.environ,
            "GSM_APP_ROOT": str(ROOT),
            "GSM_PROFILE_DIR": directory,
            "GSM_SHARED_DATA_DIR": directory,
            "GSM_DATA_DIR": directory,
            "GSM_SMOKE_TEST": "1",
        }
        env.pop("GSM_TEST_RESULT", None)
        child = subprocess.Popen(
            [str(exe)],
            cwd=ROOT,
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        try:
            endpoint = profile / "electron/agent-control.json"
            deadline = time.monotonic() + 15
            while not endpoint.is_file() and child.poll() is None and time.monotonic() < deadline:
                time.sleep(0.05)
            assert json.loads(endpoint.read_text())["pid"] == child.pid
            output = subprocess.check_output(
                [
                    sys.executable,
                    __file__,
                    "--worker",
                    mode,
                    "--port",
                    str(port),
                    "--cycles",
                    str(args.cycles),
                    "--case",
                    args.case,
                ],
                env=env,
                text=True,
                timeout=120,
            )
            sample = json.loads(output.splitlines()[-1])
            assert fixture.saves == (0 if args.case in {"record", "toggle"} else args.cycles + 10)
            assert not fixture.replay and not fixture.record
            setup_calls = 1 + (4 if args.case == "save" else 0)
            return {**sample, "obs_calls": (fixture.calls - setup_calls) / (args.cycles + 10)}
        finally:
            server.shutdown()
            child.terminate()
            child.wait(timeout=10)
            thread.join(timeout=5)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--desktop", type=Path)
    parser.add_argument("--cycles", type=int, default=400)
    parser.add_argument("--rounds", type=int, default=5)
    parser.add_argument("--reference-ref", default="7a87ee32")
    parser.add_argument("--case", choices=["longplay", "replay", "record", "save", "toggle"], default="longplay")
    parser.add_argument("--worker", choices=["python", "rust"])
    parser.add_argument("--port", type=int)
    args = parser.parse_args()
    if args.worker:
        worker(args)
        return
    exe = args.desktop
    if exe is None:
        exe = Path(
            subprocess.check_output(
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
    samples = {"python": [], "rust": []}
    for i in range(args.rounds):
        for mode in ["python", "rust"] if i % 2 == 0 else ["rust", "python"]:
            samples[mode].append(sample(args, exe.resolve(), mode))
    for mode, results in samples.items():
        print(mode, {key: round(statistics.median(r[key] for r in results), 3) for key in results[0]})


if __name__ == "__main__":
    main()
