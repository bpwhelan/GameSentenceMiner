"""Measure both desktop processes against the same OBS v5 fixture and Win32 window."""

import argparse
import asyncio
import hashlib
import json
import os
import platform
import statistics
import subprocess
import sys
import threading
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace

import psutil
from websockets.sync.server import serve

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts.benchmark_obs_outputs import ObsFixture, cpu_seconds

ROUTING_BATCH = 64
ROUTING_ROUNDS = 16


class Fixture(ObsFixture):
    def __init__(self, directory):
        super().__init__(directory)
        self.connections = 0
        self.requests = Counter()
        self.session = threading.local()
        self.record_directory = str(directory)
        self.params = {"Mode": "Simple", "RecRB": "true", "RecRBTime": "300"}
        self.duration, self.fps, self.stream = 300, 15, False

    def respond_request(self, method, data):
        if "routingIndex" in (data or {}):
            return 100, {"routingIndex": data["routingIndex"]}
        if method == "GetVersion" and (command := (data or {}).get("fixtureCommand")):
            ws = self.session.socket
            if command == "disconnect":
                threading.Timer(0.15, ws.close).start()
            elif command == "record":
                for name, event in [
                    ("RecordStateChanged", {"outputActive": True, "outputPath": "first.mkv"}),
                    ("RecordFileChanged", {"newOutputPath": "second.mkv"}),
                    ("RecordStateChanged", {"outputActive": False, "outputPath": "second.mkv"}),
                ]:
                    ws.send(json.dumps({"op": 5, "d": {"eventType": name, "eventIntent": 64, "eventData": event}}))
            elif command in ("start", "stop"):
                self.replay = command == "start"
                ws.send(
                    json.dumps(
                        {
                            "op": 5,
                            "d": {
                                "eventType": "ReplayBufferStateChanged",
                                "eventIntent": 64,
                                "eventData": {"outputActive": self.replay},
                            },
                        }
                    )
                )
            elif command == "all_outputs":
                self.replay = self.record = self.stream = True
            elif command == "unwritable_directory":
                blocked = self.directory / "existing-file"
                blocked.write_text("fixture")
                self.record_directory = str(blocked)
            return 100, {}
        source = (data or {}).get("sourceName")
        size = {
            "single-frame-fixture": 17 << 20,
            "large-fixture": 7 << 20,
            "second-large-fixture": 7 << 20,
            "small-fixture": 128 << 10,
        }.get(source)
        if method == "GetSourceScreenshot" and size:
            self.requests[method] += 1
            return 100, {"imageData": ("B" if source == "second-large-fixture" else "A") * size}
        if method == "GetProfileParameter":
            self.requests[method] += 1
            return 100, {"parameterValue": self.params.get(data.get("parameterName"))}
        if method == "SetProfileParameter":
            self.params[data["parameterName"]] = data["parameterValue"]
        if method == "SetVideoSettings":
            self.fps = data["fpsNumerator"]
        if method == "SetOutputSettings":
            self.duration = data["outputSettings"]["max_time_sec"]
        if method == "SetRecordDirectory":
            self.record_directory = data["recordDirectory"]
        return self.respond(method)

    def serve_session(self, ws):
        self.connections += 1
        self.session.socket = ws
        self.session.routing_replies = []
        return super().serve_session(ws)

    def send_response(self, ws, reply):
        index = reply.get("responseData", {}).get("routingIndex")
        if index is None:
            return super().send_response(ws, reply)
        if index % 7 == 0:
            del reply["responseData"]
            reply["requestStatus"] = {"result": False, "code": 600, "comment": f"missing {index}"}
        batch = self.session.routing_replies
        batch.append(reply)
        if len(batch) == ROUTING_BATCH:
            for position, response in enumerate(reversed(batch)):
                if position % 8 == 0:
                    ws.send(
                        json.dumps(
                            {
                                "op": 5,
                                "d": {
                                    "eventType": "StudioModeStateChanged",
                                    "eventIntent": 1024,
                                    "eventData": {"studioModeEnabled": False},
                                },
                            }
                        )
                    )
                super().send_response(ws, response)
                if position % 8 == 0:
                    super().send_response(ws, response)
            batch.clear()

    def respond(self, method):
        self.requests[method] += 1
        scene = {"sceneName": "Fixture", "sceneUuid": "fixture"}
        item = {"sourceName": "Capture", "inputKind": "window_capture", "sceneItemId": 1, "sceneItemEnabled": True}
        if method == "GetSceneList":
            return 100, {"scenes": [scene], "currentProgramSceneName": "Fixture", "currentProgramSceneUuid": "fixture"}
        if method == "GetCurrentProgramScene":
            return 100, {**scene, "currentProgramSceneName": "Fixture", "currentProgramSceneUuid": "fixture"}
        if method == "GetInputSettings":
            return 100, {"inputSettings": {"window": "GSM window benchmark:GsmObsBenchmark:python.exe"}}
        if method == "GetSceneItemList":
            return 100, {"sceneItems": [item]}
        if method == "GetRecordDirectory":
            return 100, {"recordDirectory": self.record_directory}
        if method == "GetOutputList":
            return 100, {"outputs": [{"outputKind": "replay_buffer", "outputName": "Replay Buffer"}]}
        if method == "GetOutputSettings":
            return 100, {"outputSettings": {"max_time_sec": self.duration}}
        if method == "GetVideoSettings":
            return 100, {"fpsNumerator": self.fps, "fpsDenominator": 1, "baseWidth": 1280, "baseHeight": 720}
        if method in {"StartStream", "StopStream"}:
            self.stream = method == "StartStream"
        if method == "GetStreamStatus":
            return 100, {"outputActive": self.stream}
        if method == "GetSourceScreenshot":
            return 100, {
                "imageData": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1TcAAAAASUVORK5CYII="
            }
        return super().respond(method)


def fixture_window(ready, stop):
    import win32con as wc
    import win32gui as gui

    cls = gui.WNDCLASS()
    cls.lpszClassName = "GsmObsBenchmark"
    cls.lpfnWndProc = gui.DefWindowProc
    atom = gui.RegisterClass(cls)
    hwnd = gui.CreateWindowEx(
        0x08000000, atom, "GSM window benchmark", wc.WS_OVERLAPPEDWINDOW, 40, 60, 320, 200, 0, 0, 0, None
    )
    try:
        gui.ShowWindow(hwnd, wc.SW_SHOWNOACTIVATE)
        ready.append(hwnd)
        while not stop.wait(0.005):
            gui.PumpWaitingMessages()
    finally:
        gui.DestroyWindow(hwnd)
        gui.UnregisterClass(atom, 0)


def wait(predicate, seconds=12):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.005)
    raise TimeoutError(f"Timed out waiting for {predicate}")


def verify_request_routing(backend, reader):
    from GameSentenceMiner.util.communication.bus_client import MAIN

    async def issue(client, index):
        methods = ("GetInputSettings", "GetVideoSettings", "GetRecordStatus")
        reply = await client.request_async(
            MAIN, "obs.request", {"method": methods[index % len(methods)], "data": {"routingIndex": index}}
        )
        if index % 7 == 0:
            assert reply["error"] == {"code": 600, "message": f"missing {index}"}, (index, reply)
        else:
            assert reply["response"] == {"routingIndex": index}, (index, reply)

    async def issue_group(client, indices):
        await asyncio.gather(*(issue(client, index) for index in indices))

    samples = []
    for start in range(0, ROUTING_BATCH * ROUTING_ROUNDS, ROUTING_BATCH):
        begin = time.perf_counter_ns()
        futures = [
            client.submit(issue_group(client, range(start + offset, start + ROUTING_BATCH, 2)))
            for offset, client in enumerate((backend, reader))
        ]
        for future in futures:
            future.result(timeout=15)
        samples.append((time.perf_counter_ns() - begin) / 1e6)
    return {"routing_requests": ROUTING_BATCH * ROUTING_ROUNDS, "routing_batch_p50_ms": statistics.median(samples)}


def verify_desktop(bus, port, token, hwnd):
    from GameSentenceMiner.obs import desktop_session
    from GameSentenceMiner.obs.desktop_client import client
    from GameSentenceMiner.util.communication.bus_client import MAIN, BusClient

    def command(action):
        bus.request(MAIN, "obs.request", {"method": "GetVersion", "data": {"fixtureCommand": action}})

    records = []
    bus.subscribe(
        "backend.command",
        lambda msg: records.append(msg["data"]["data"]) if msg["data"]["function"] == "obs_record_event" else None,
    )
    command("record")
    wait(lambda: len(records) == 3)
    assert [r["event"] for r in records] == ["RecordStateChanged", "RecordFileChanged", "RecordStateChanged"]
    assert records[1]["data"]["newOutputPath"] == "second.mkv"
    for action in ["start", "stop"]:
        command(action)
        wait(lambda action=action: desktop_session.snapshot().get("replay_active") is (action == "start"))
    assert desktop_session.snapshot()["replay_seconds"] == 300
    with ThreadPoolExecutor(max_workers=2) as pool:
        images = [
            pool.submit(client.get_source_screenshot, name, "png", None, None, -1)
            for name in ("large-fixture", "second-large-fixture")
        ]
        for image, expected in zip(images, ("A", "B"), strict=True):
            assert image.result(timeout=15).image_data == expected * (7 << 20)
    assert (
        len(client.send("GetSourceScreenshot", {"sourceName": "single-frame-fixture"}, raw=True)["imageData"])
        == 17 << 20
    )
    assert not bus.request(
        MAIN, "game.windowInput", {"hwnd": hwnd, "pid": os.getpid() + 1, "action": "key", "key": "enter", "post": True}
    )
    assert desktop_session.window_action("key", hwnd, key="enter", post=True)
    reader = BusClient(client_id=f"obs-reader-{os.getpid()}", port=port, token=token).start()
    try:
        assert reader.wait_connected(5)
        routing = verify_request_routing(bus, reader)
        assert reader.request(MAIN, "game.session")["target_id"] == hwnd
        assert reader.request(MAIN, "obs.request", {"method": "GetSceneList"})["response"]["scenes"]
        try:
            reader.request(MAIN, "obs.request", {"method": "StopReplayBuffer"})
        except RuntimeError:
            pass
        else:
            raise AssertionError("OCR reader could change an OBS output")
    finally:
        reader.stop()
    subprocess.run(
        [sys.executable, __file__, "--worker", "reader"],
        env={**os.environ, "GSM_CLIENT_ID": "", "GSM_OBS_READER_PORT": str(port), "GSM_OBS_READER_TOKEN": token},
        check=True,
        timeout=20,
    )
    previous = desktop_session.snapshot()["connection"]
    command("disconnect")
    wait(lambda: desktop_session.snapshot().get("connection") not in (None, previous), 18)
    wait(lambda: desktop_session.snapshot().get("replay_active") is False)
    command("all_outputs")
    path = Path(os.environ["GSM_PROFILE_DIR"]) / "config.json"
    config = json.loads(path.read_text())
    config["configs"]["Default"]["obs"].update(recording_fps=30, replay_buffer_duration_seconds=90)
    tmp = path.with_suffix(".new")
    tmp.write_text(json.dumps(config))
    tmp.replace(path)
    bus.request(MAIN, "obs.configure", {})
    wait(lambda: desktop_session.snapshot().get("replay_seconds") == 90)
    assert client.send("GetVideoSettings", raw=True)["fpsNumerator"] == 30
    for status in ["GetReplayBufferStatus", "GetRecordStatus", "GetStreamStatus"]:
        assert client.send(status, raw=True)["outputActive"]
    command("unwritable_directory")
    command("disconnect")
    fallback = path.parent / "recordings"
    try:
        wait(
            lambda: Path(desktop_session.snapshot().get("record_directory") or ".").resolve() == fallback.resolve(), 22
        )
    except TimeoutError as error:
        actual = client.send("GetRecordDirectory", raw=True)["recordDirectory"]
        reported = desktop_session.snapshot().get("record_directory")
        raise AssertionError(f"Expected {fallback}, OBS returned {actual}, desktop reported {reported}") from error
    assert Path(client.send("GetRecordDirectory", raw=True)["recordDirectory"]).resolve() == fallback.resolve()
    assert client.send("GetReplayBufferStatus", raw=True)["outputActive"]
    return routing


def worker(args):
    import win32con as wc
    import win32gui as gui

    from scripts.benchmark_stats import _configure_bootstrap_environment, _install_noop_logging_module

    profile = Path(os.environ["GSM_PROFILE_DIR"])
    _configure_bootstrap_environment(profile / "bootstrap")
    _install_noop_logging_module()
    if args.worker == "before":
        import GameSentenceMiner
        import GameSentenceMiner.util.platform

        GameSentenceMiner.__path__.insert(0, str(profile / "reference"))
        GameSentenceMiner.util.platform.__path__.insert(0, str(profile / "reference/platform"))
    from GameSentenceMiner import obs
    from GameSentenceMiner.obs import desktop_session
    from GameSentenceMiner.util.communication import bus_client
    from GameSentenceMiner.util.config.configuration import get_config
    from GameSentenceMiner.util.overlay.get_overlay_coords import _window_monitor_loop
    from GameSentenceMiner.util.platform.foreground_window_hook import ForegroundWindowHook
    from GameSentenceMiner.util.platform.window_state_monitor import WindowStateMonitor, set_window_state_monitor

    if args.worker == "reader":
        obs.connect_to_obs_sync()
        try:
            assert obs.connection_pool is None
            assert obs.get_current_scene() == "Fixture"
            assert obs.get_obs_scenes()[0]["sceneName"] == "Fixture"
        finally:
            obs.disconnect_from_obs()
        return
    assert Path(obs.__file__).is_relative_to(profile / "reference") == (args.worker == "before")
    cfg = get_config()
    cfg.obs.port, cfg.obs.host, cfg.obs.password = args.port, "127.0.0.1", ""
    cfg.obs.automatically_manage_replay_buffer = False
    cfg.paths.folder_to_watch = str(profile)
    endpoint = json.loads((profile / "electron/agent-control.json").read_text())
    bus = bus_client.start_bus(client_id="backend", port=endpoint["port"], token=endpoint["token"])
    assert bus.wait_connected(10)
    stop = threading.Event()
    ready = []
    window = threading.Thread(target=fixture_window, args=(ready, stop), daemon=True)
    window.start()
    wait(lambda: ready)
    hwnd = ready[0]
    watcher = bus.submit(desktop_session.watch(lambda *_: None))
    processor = SimpleNamespace(obs_width=None, obs_height=None)
    monitor = WindowStateMonitor(processor)
    set_window_state_monitor(monitor)
    hook = None
    task = None
    try:
        if args.worker == "before":
            obs.connect_to_obs_sync(retry=1, check_output=True, start_manager=True)
            assert obs.obs_connection_manager and obs.obs_connection_manager.is_alive()
            hook = ForegroundWindowHook(
                lambda s: bus.publish("main", "backend.event", {"function": "foreground_window_changed", "data": s}),
                on_emulator_snapshot=lambda s: bus.publish(
                    "main", "backend.event", {"function": "emulator_window_changed", "data": s}
                ),
            )
            assert hook.start()
        else:
            wait(lambda: desktop_session.snapshot().get("connected"))
            assert obs.connection_pool is None and obs.obs_connection_manager is None
        task = bus.submit(_window_monitor_loop(monitor))
        wait(lambda: monitor.target_hwnd == hwnd and monitor.last_window_rect, 20)
        processes = [psutil.Process(), psutil.Process(endpoint["pid"])]
        time.sleep(2)
        cpu = [cpu_seconds([process]) for process in processes]
        start = time.perf_counter()
        time.sleep(args.idle)
        elapsed_idle = time.perf_counter() - start
        idle_cpu = [
            (cpu_seconds([p]) - initial) * 1000 / elapsed_idle for p, initial in zip(processes, cpu, strict=True)
        ]
        reads, moves, replay_reads = [], [], []
        for _ in range(20):
            start = time.perf_counter_ns()
            for _ in range(100):
                assert obs.get_replay_buffer_status() is False
            replay_reads.append((time.perf_counter_ns() - start) / 100_000)
        for _ in range(200):
            start = time.perf_counter_ns()
            assert obs.get_obs_scenes()[0]["sceneName"] == "Fixture"
            reads.append((time.perf_counter_ns() - start) / 1e6)
        for i in range(args.moves):
            start = time.perf_counter_ns()
            x = 61 + i % 2 * 20
            gui.SetWindowPos(hwnd, 0, x, 60, 320, 200, wc.SWP_NOACTIVATE | wc.SWP_NOZORDER)
            wait(lambda x=x: monitor.last_window_rect and monitor.last_window_rect[0] == x, 4)
            moves.append((time.perf_counter_ns() - start) / 1e6)
        seen_positions = set()
        drag_cpu = [cpu_seconds([process]) for process in processes]
        drag_start = time.perf_counter()
        steps = 120
        for step in range(steps):
            gui.SetWindowPos(hwnd, 0, 120 + step, 60, 320, 200, wc.SWP_NOACTIVATE | wc.SWP_NOZORDER)
            time.sleep(max(0, drag_start + (step + 1) / 60 - time.perf_counter()))
            if monitor.last_window_rect and monitor.last_window_rect[0] >= 120:
                seen_positions.add(monitor.last_window_rect[0])
        elapsed_drag = time.perf_counter() - drag_start
        drag_cpu = [
            (cpu_seconds([p]) - initial) * 1000 / elapsed_drag for p, initial in zip(processes, drag_cpu, strict=True)
        ]
        wait(lambda: monitor.last_window_rect and monitor.last_window_rect[0] == 120 + steps - 1, 4)
        private_mib = sum(p.memory_full_info().uss for p in processes) / 2**20
        threads = sum(p.num_threads() for p in processes)
        from GameSentenceMiner.obs.service import _call_with_obs_client

        screenshots = {}
        for name, size, iterations in [("small-fixture", 128 << 10, 20), ("large-fixture", 7 << 20, 4)]:
            samples = []
            for _ in range(iterations):
                start = time.perf_counter_ns()
                data = _call_with_obs_client(
                    lambda client, name=name: client.send(
                        "GetSourceScreenshot", {"sourceName": name, "imageFormat": "png"}, raw=True
                    ),
                    raise_exc=True,
                )
                assert len(data["imageData"]) == size
                samples.append((time.perf_counter_ns() - start) / 1e6)
            screenshots[name] = statistics.median(samples)
        routing = (
            verify_desktop(bus, endpoint["port"], endpoint["token"], hwnd)
            if args.verify and args.worker == "after"
            else {}
        )
        print(
            json.dumps(
                {
                    "idle_cpu_ms_per_s": sum(idle_cpu),
                    "idle_cpu_by_process": dict(zip(("python", "desktop"), idle_cpu, strict=True)),
                    "private_mib": private_mib,
                    "threads": threads,
                    **routing,
                    "screenshot_128k_ms": screenshots["small-fixture"],
                    "screenshot_7m_ms": screenshots["large-fixture"],
                    "scene_list_p50_ms": statistics.median(reads),
                    "replay_status_us": statistics.median(replay_reads),
                    "move_p50_ms": statistics.median(moves),
                    "move_max_ms": max(moves),
                    "drag_cpu_ms_per_s": sum(drag_cpu),
                    "drag_cpu_by_process": dict(zip(("python", "desktop"), drag_cpu, strict=True)),
                    "drag_positions_seen": len(seen_positions),
                }
            ),
            flush=True,
        )
    finally:
        if task:
            task.cancel()
        watcher.cancel()
        if hook:
            hook.stop()
        if obs.obs_connection_manager:
            obs.obs_connection_manager.stop()
            obs.obs_connection_manager.join(5)
        obs.disconnect_from_obs()
        monitor._stop_event_hooks()
        bus.stop()
        stop.set()
        window.join(1)


def sample(args, mode):
    with TemporaryDirectory() as directory:
        profile = Path(directory)
        if mode == "before":
            for relative in ["obs", "util/platform"]:
                dest = profile / "reference" / relative.split("/")[-1]
                dest.mkdir(parents=True)
                for p in (ROOT / "GameSentenceMiner" / relative).glob("*.py"):
                    spec = f"{args.reference}:GameSentenceMiner/{relative}/{p.name}"
                    old = subprocess.run(["git", "show", spec], capture_output=True, cwd=ROOT, check=False)
                    if old.returncode == 0:
                        (dest / p.name).write_bytes(old.stdout)
        fixture = Fixture(profile)
        with serve(fixture.handle, "127.0.0.1", 0, compression=None) as server:
            threading.Thread(target=server.serve_forever, daemon=True).start()
            port = server.socket.getsockname()[1]
            (profile / "config.json").write_text(
                json.dumps(
                    {
                        "current_profile": "Default",
                        "configs": {
                            "Default": {
                                "obs": {
                                    "port": port,
                                    "open_obs": False,
                                    "close_obs": False,
                                    "automatically_manage_replay_buffer": False,
                                }
                            }
                        },
                    }
                )
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
            with subprocess.Popen(
                [str(getattr(args, mode).resolve())],
                cwd=ROOT,
                env=env,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            ) as desktop:
                try:
                    wait(lambda: (profile / "electron/agent-control.json").is_file())
                    start = time.monotonic()
                    env.update(GSM_NATIVE_GAME_SESSION="1", GSM_NATIVE_OBS_OUTPUTS="1", GSM_CLIENT_ID="backend")
                    result = subprocess.check_output(
                        [
                            sys.executable,
                            __file__,
                            "--worker",
                            mode,
                            "--port",
                            str(port),
                            "--idle",
                            str(args.idle),
                            "--moves",
                            str(args.moves),
                            *(["--verify"] if args.verify else []),
                        ],
                        env=env,
                        cwd=ROOT,
                        text=True,
                        timeout=180,
                    )
                    row = json.loads(result.strip().splitlines()[-1])
                    return dict(
                        row,
                        obs_connections=fixture.connections,
                        obs_requests=dict(fixture.requests),
                        worker_seconds=time.monotonic() - start,
                    )
                finally:
                    desktop.terminate()
                    desktop.wait(timeout=10)
                    server.shutdown()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--before", type=Path)
    parser.add_argument("--after", type=Path)
    parser.add_argument("--reference", default="4fea8c90")
    parser.add_argument("--idle", type=float, default=10)
    parser.add_argument("--rounds", type=int, default=3)
    parser.add_argument("--moves", type=int, default=8)
    parser.add_argument("--worker", choices=["before", "after", "reader"])
    parser.add_argument("--mode", choices=["before", "after", "both"], default="both")
    parser.add_argument(
        "--verify",
        action="store_true",
        help="Also exercise recording events, reconnect, large images, reader permissions and window identity",
    )
    parser.add_argument("--port", type=int)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.worker:
        worker(args)
    else:
        rows = {"before": [], "after": []}
        binaries = {}
        for mode in ("before", "after"):
            binary = getattr(args, mode)
            if binary and args.mode in ("both", mode):
                with binary.open("rb") as executable:
                    binaries[mode] = hashlib.file_digest(executable, "sha256").hexdigest()
        rows["environment"] = {
            "platform": platform.platform(),
            "python": platform.python_version(),
            "logical_cpus": psutil.cpu_count(),
            "reference": args.reference,
            "rounds": args.rounds,
            "idle_seconds": args.idle,
            "moves": args.moves,
            "scene_requests_per_worker": 200,
            "drag_positions": 120,
            "drag_hz": 60,
            "binary_sha256": binaries,
        }
        for i in range(args.rounds):
            for mode in ["before", "after"] if i % 2 == 0 else ["after", "before"]:
                if args.mode not in ("both", mode):
                    continue
                row = sample(args, mode)
                rows[mode].append(row)
                print(mode, json.dumps(row), flush=True)
                if args.output:
                    args.output.write_text(json.dumps(rows, indent=2) + "\n")
