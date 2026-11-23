"""Compare the Text Feed AI routes through Waitress and the native gateway against one loopback model."""

import argparse
import contextlib
import difflib
import hashlib
import json
import os
import platform
import shutil
import statistics
import subprocess
import sys
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from queue import Queue

import psutil
import requests
from benchmark_reader_projection import ROOT, eventually, spare_port
from websockets.sync.server import serve

CALLS_PER_BATCH = 32


def compatibility(profile, port, overlay_port):
    from benchmark_stats import _configure_bootstrap_environment, _install_keyboard_stub

    _configure_bootstrap_environment(profile / "bootstrap")
    os.environ["GSM_TEST_DATA_ROOT"] = str(profile)
    _install_keyboard_stub()
    from waitress import create_server

    from GameSentenceMiner.native import intake
    from GameSentenceMiner.util.communication import bus_client
    from GameSentenceMiner.web import texthooking_page

    endpoint = json.loads((profile / "electron/agent-control.json").read_bytes())
    bus = bus_client.start_bus(client_id="backend", port=endpoint["port"], token=endpoint["token"])
    assert bus.wait_connected(5) and intake.native_reader()
    intake.request(
        "start",
        session="reader-ai",
        native_reader=True,
        policy={"remove_prefix": False},
        projection={"collect": False, "discord": {"enabled": False}},
        retention=3600,
    )
    # The desktop and both routes use the same empty live OBS scene.
    texthooking_page.get_current_game = lambda: ""
    if overlay_port:
        from GameSentenceMiner.web import gsm_websocket, overlay_handler

        overlay_handler.get_current_game = lambda **kwargs: ""
        gsm_websocket.websocket_manager.start_multiplex_server(
            lambda: overlay_port,
            {
                gsm_websocket.ID_OVERLAY: gsm_websocket.EndpointSpec(
                    read_mode=True, enable_backup=False, message_callback=overlay_handler.overlay_handler.handle_message
                )
            },
        )
        # Register the real backend listener so the driver can also exercise a
        # public overlay socket while the compatibility upstream is attached.
        bus.request("main", "mining.gateway.register", {"httpPort": port, "wsPort": overlay_port, "directWsPort": 0}, 5)
    server = create_server(texthooking_page.app, host="127.0.0.1", port=port)
    (profile / "ready").touch()
    server.run()


class Provider(BaseHTTPRequestHandler):
    def do_POST(self):
        packet = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        prompt = packet["messages"][-1]["content"]
        self.server.prompts.append(prompt)
        if "SLOW_FIXTURE" in prompt:
            time.sleep(0.08)
        if "SIMULATE_RATE_LIMIT" in prompt:
            self.send_response(429)
            payload = {"error": {"message": "quota exceeded fixture-only-secret"}}
        else:
            self.send_response(200)
            digest = hashlib.sha256(prompt.encode()).hexdigest()
            content = digest
            if "Input blocks:\n" in prompt:
                blocks = json.loads(prompt.rsplit("Input blocks:\n", 1)[1])["blocks"]
                content = json.dumps(
                    {"blocks": [{"id": b["id"], "translation": f"<b>{digest}</b>"} for b in reversed(blocks)]}
                )
            payload = {"choices": [{"message": {"content": content}, "finish_reason": "stop"}]}
        body = json.dumps(payload).encode()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


def run(exe, count, rounds, overlay=False):
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as folder, contextlib.ExitStack() as stack:
        root = Path(folder)
        profile = root / "profile"
        profile.mkdir()
        app = root / "app"
        shutil.copytree(ROOT / "dist/renderer", app / "dist/renderer")
        log = stack.enter_context((root / "process.log").open("w+", encoding="utf8"))

        def show_error(kind, error, tb):
            if kind:
                print((root / "process.log").read_text(encoding="utf8", errors="replace")[-3500:], file=sys.stderr)

        stack.push(show_error)
        model = stack.enter_context(ThreadingHTTPServer(("127.0.0.1", 0), Provider))
        model.prompts = []
        threading.Thread(target=model.serve_forever, daemon=True).start()
        stack.callback(model.shutdown)
        ws_connections = Queue()
        stop = threading.Event()

        def listen(client):
            ws_connections.put(client)
            stop.wait()

        ws = stack.enter_context(serve(listen, "127.0.0.1", 0))
        threading.Thread(target=ws.serve_forever, daemon=True).start()
        stack.callback(stop.set)
        gateway, flask = spare_port(), spare_port()
        overlay_port = spare_port() if overlay else 0
        config = {
            "general": {
                "single_port": gateway,
                "native_language": "zh",
                "use_websocket": True,
                "use_clipboard": False,
                "remove_matching_prefix_on_subsequent_lines": False,
                "websocket_sources": [
                    {"name": "fixture", "uri": f"127.0.0.1:{ws.socket.getsockname()[1]}", "enabled": True}
                ],
            },
            "ai": {
                "provider": "OpenAI",
                "open_ai_model": "fixture",
                "open_ai_url": f"http://127.0.0.1:{model.server_port}/v1",
                "open_ai_api_key": "fixture",
                "dialogue_context_length": 3,
            },
            "anki": {"enabled": False},
            "features": {"generate_longplay": False},
            "advanced": {
                "localhost_bind_address": "127.0.0.1",
                "direct_websocket_port": spare_port(),
                "dont_collect_stats": True,
            },
            "paths": {"output_folder": str(profile / "outputs")},
            "obs": {
                "host": "127.0.0.2",
                "port": spare_port(),
                "open_obs": False,
                "close_obs": False,
                "replay_buffer_duration_seconds": 3600,
            },
        }
        config_file = profile / "config.json"

        def configure():
            config_file.write_text(
                json.dumps(
                    {"current_profile": "Default", "configs": {"Default": config}, "discord": {"enabled": False}}
                ),
                encoding="utf8",
            )

        configure()
        saved = profile / "outputs/Clips/2001-01-01/clip"
        saved.mkdir(parents=True)
        (saved / "manifest.json").write_text(
            json.dumps(
                {
                    "clip": {"file": "clip.mkv", "end_time": "2001-01-01T12:00:08"},
                    "lines": [
                        {
                            "id": name,
                            "text": name,
                            "scene": "Saved game",
                            "time": f"2001-01-01T12:00:0{i}",
                            "role": role,
                        }
                        for i, (name, role) in enumerate(
                            [("clip-before", "previous"), ("old-line", "selected"), ("clip-after", "next")]
                        )
                    ],
                }
            ),
            encoding="utf8",
        )
        env = {
            **os.environ,
            "GSM_APP_ROOT": str(app),
            "GSM_PROFILE_DIR": str(profile),
            "GSM_DATA_DIR": str(profile),
            "GSM_SHARED_DATA_DIR": str(profile),
            "GSM_SMOKE_TEST": "1",
            "GSM_NATIVE_MINING": "1",
            "GSM_NATIVE_READER": "1",
            "GSM_NATIVE_TEXT_INTAKE": "1",
            "GSM_CLIENT_ID": "backend",
        }
        env.pop("GSM_TEST_RESULT", None)

        def launch(command, child_env, cwd):
            proc = subprocess.Popen(command, cwd=cwd, env=child_env, stdout=log, stderr=log)

            def close():
                if proc.poll() is None:
                    proc.terminate()
                proc.wait(timeout=10)

            stack.callback(close)
            return proc

        isolated = {**env, "PATH": str(Path(os.environ["SystemRoot"]) / "System32") if os.name == "nt" else str(app)}
        desktop = launch([str(exe)], isolated, app)
        client = stack.enter_context(requests.Session())
        client.trust_env = False
        gateway_url = f"http://127.0.0.1:{gateway}"
        ws_client = ws_connections.get(timeout=30)
        for i in range(count):
            ws_client.send(json.dumps({"source": "manual", "sentence": f"会話{i:04d}。"}))

        def ids_when_ready():
            ids = client.get(gateway_url + "/get_ids", timeout=10).json()["ids"]
            return ids if len(ids) == count else None

        ids = eventually(ids_when_ready)
        center = count // 2
        anchor = ids[center]
        cases = {
            "refresh": ("/translate-line", {"id": anchor, "force_refresh": True}),
            "cached": ("/translate-line", {"id": anchor}),
            "multiple": ("/translate-multiple", {"ids": [anchor, ids[center + 1]], "force_refresh": True}),
            "explanation": ("/analyze-line", {"id": anchor, "mode": "custom", "question": "How is this used?"}),
            "saved": ("/translate-line", {"id": "old-line", "force_refresh": True}),
        }
        hashes, samples, prompts = {}, {}, {}

        def measure_mode(mode):
            server = None
            base = gateway_url
            if overlay:
                # Seed before the compatibility worker takes over source configuration.
                # Fresh line IDs isolate the two measurements' translation cache entries.
                current_count = len(client.get(gateway_url + "/get_ids", timeout=10).json()["ids"])
                for line in ("前々", "前の行", "手前の行", "現在の行"):
                    ws_client.send(json.dumps({"source": "manual", "sentence": line}))
                eventually(
                    lambda: len(client.get(gateway_url + "/get_ids", timeout=10).json()["ids"]) == current_count + 4
                )
            if mode == "python_bridge":
                server = launch(
                    [
                        sys.executable,
                        __file__,
                        "--worker",
                        str(profile),
                        "--port",
                        str(flask),
                        "--overlay-port",
                        str(overlay_port),
                    ],
                    env,
                    ROOT,
                )

                def ready():
                    if server.poll() is not None:
                        raise RuntimeError("Waitress worker stopped")
                    return (profile / "ready").exists()

                eventually(ready, 60)
                base = f"http://127.0.0.1:{flask}"
            roots = [psutil.Process(desktop.pid)]
            if server:
                roots.append(psutil.Process(server.pid))
            # Windows venvs may keep a small launcher process above the interpreter.
            procs = {p for root_process in roots for p in [root_process, *root_process.children(recursive=True)]}

            def cpu():
                return sum(sum(proc.cpu_times()[:2]) for proc in procs)

            def memory():
                return sum(proc.memory_full_info().uss for proc in procs) / 2**20

            if overlay:
                from benchmark_overlay_ai import measure_overlay
                from websockets.sync.client import connect

                url = f"ws://127.0.0.1:{gateway if mode == 'rust' else overlay_port}/ws/overlay"

                def connect_ready():
                    try:
                        return connect(url, open_timeout=2)
                    except OSError:
                        return None

                with eventually(connect_ready, 10) as socket:
                    hashes[mode], prompts[mode], samples[mode] = measure_overlay(
                        socket, model, mode, rounds, CALLS_PER_BATCH, cpu, memory
                    )
                if mode == "python_bridge":
                    from benchmark_overlay_ai import verify_attached

                    verify_attached(gateway, model)
                return

            def call(path, body):
                res = client.post(base + path, json=body, timeout=20)
                assert res.status_code == 200, (mode, path, res.status_code, res.text[:500])
                if mode == "rust":
                    assert res.headers.get("x-gsm-handler") == "rust"
                return res.text.strip() if path.endswith("multiple") else res.json()

            expected = {}
            prompts[mode] = {}
            for name, (path, body) in cases.items():
                before = len(model.prompts)
                expected[name] = call(path, body)
                assert len(model.prompts) - before == int(name != "cached"), (mode, name)
                if name != "cached":
                    prompts[mode][name] = model.prompts[-1]
                if name == "saved":
                    assert all(s in model.prompts[-1] for s in ("clip-before", "clip-after", "Saved game"))
                if name == "refresh":
                    assert (
                        f"会話{center - 3:04d}" in model.prompts[-1]
                        and f"会話{center - 4:04d}" not in model.prompts[-1]
                    )
            assert expected["cached"] == expected["refresh"]
            hashes[mode] = expected
            results = {key: [] for key in cases}
            for i in range(rounds):
                for name in cases if i % 2 == 0 else reversed(cases):
                    start_cpu, start = cpu(), time.perf_counter()
                    for _ in range(CALLS_PER_BATCH):
                        assert call(*cases[name]) == expected[name]
                    elapsed = (time.perf_counter() - start) * 1000 / CALLS_PER_BATCH
                    results[name].append(
                        {"ms": elapsed, "cpu_ms": (cpu() - start_cpu) * 1000 / CALLS_PER_BATCH, "private_mib": memory()}
                    )
            samples[mode] = results
            if mode == "rust":
                before = len(model.prompts)
                with ThreadPoolExecutor(max_workers=4) as pool:
                    answers = list(
                        pool.map(
                            lambda _: requests.post(
                                base + "/translate-line", json={"id": anchor, "text": "SLOW_FIXTURE"}, timeout=10
                            ).json()["TL"],
                            range(4),
                        )
                    )
                assert len(set(answers)) == 1 and len(model.prompts) == before + 1
                res = client.post(base + "/translate-line", json={"id": anchor, "text": "SIMULATE_RATE_LIMIT"})
                assert (
                    res.status_code == 502
                    and res.json()["code"] == "ai_request_failed"
                    and "quota" in res.json()["error"]
                    and "fixture-only-secret" not in res.text
                )
                assert (
                    client.post(
                        base + "/analyze-line", json={"id": anchor, "mode": "custom", "question": "字" * 4001}
                    ).status_code
                    == 400
                )
                config["ai"]["custom_texthooker_prompt"] = "Fixture custom prompt."
                configure()
                call("/translate-line", {"id": anchor, "force_refresh": True})
                assert "Fixture custom prompt." in model.prompts[-1]
                config["ai"]["open_ai_api_key"] = ""
                configure()
                setup = client.post(base + "/translate-line", json={"id": anchor, "automatic": True}).json()
                assert setup["code"] == "ai_setup_required" and not setup["settings_opened"]
                config["ai"]["open_ai_api_key"] = "fixture"
                del config["ai"]["custom_texthooker_prompt"]
                configure()

        measure_mode("rust")
        measure_mode("python_bridge")
        for name, native_prompt in prompts["rust"].items():
            previous = prompts["python_bridge"][name]
            if previous != native_prompt:
                raise AssertionError(
                    (
                        name,
                        "\n".join(
                            difflib.unified_diff(
                                previous.splitlines(),
                                native_prompt.splitlines(),
                                fromfile="Flask",
                                tofile="Rust",
                                lineterm="",
                            )
                        ),
                    )
                )
        assert hashes["rust"] == hashes["python_bridge"], hashes
        median = {
            mode: {
                name: {key: round(statistics.median(row[key] for row in rows), 4) for key in rows[0]}
                for name, rows in results.items()
            }
            for mode, results in samples.items()
        }
        return {
            "lines": count,
            "rounds": rounds,
            "calls_per_batch": CALLS_PER_BATCH,
            "platform": platform.platform(),
            "desktop_sha256": hashlib.sha256(exe.read_bytes()).hexdigest(),
            "summary": median,
            "responses": hashes["rust"],
            "samples": samples,
        }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--worker", type=Path)
    parser.add_argument("--port", type=int)
    parser.add_argument("--overlay-port", type=int, default=0)
    parser.add_argument("--overlay", action="store_true")
    parser.add_argument("--desktop", type=Path)
    parser.add_argument("--lines", type=int, default=128)
    parser.add_argument("--rounds", type=int, default=5)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.worker:
        compatibility(args.worker, args.port, args.overlay_port)
    else:
        exe = args.desktop or Path(
            subprocess.check_output(
                [
                    "node",
                    "--input-type=module",
                    "-e",
                    "import {nativeExecutable} from './scripts/native-paths.mjs';console.log(nativeExecutable())",
                ],
                cwd=ROOT,
                text=True,
            ).strip()
        )
        result = run(exe.resolve(), args.lines, args.rounds, args.overlay)
        print(json.dumps(result["summary"], indent=2))
        if args.output:
            args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf8")
