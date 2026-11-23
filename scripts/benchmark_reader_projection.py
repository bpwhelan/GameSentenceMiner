"""Compare the old Rust intake/Python projector to the native reader using real sockets and SQLite."""

import argparse
import contextlib
import hashlib
import json
import os
import platform
import re
import socket
import sqlite3
import statistics
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from queue import Queue
from urllib.request import Request, urlopen

import psutil
from websockets.sync.client import connect
from websockets.sync.server import serve

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def spare_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def backend(profile, source, port):
    from scripts.benchmark_mining_history import setup_worker

    db = setup_worker(profile, real_logging=True)
    if not source:
        db.close()
        return
    from GameSentenceMiner import gametext as gt
    from GameSentenceMiner.util.communication import bus_client
    from GameSentenceMiner.util.config.configuration import WebsocketInputSource
    from GameSentenceMiner.web import gsm_websocket as ws

    endpoint = json.loads((profile / "electron/agent-control.json").read_text())
    bus = bus_client.start_bus(client_id="backend", port=endpoint["port"], token=endpoint["token"])
    assert bus.wait_connected(5)
    cfg = gt.get_config()
    cfg.general.use_clipboard = False
    cfg.general.use_websocket = True
    cfg.general.remove_matching_prefix_on_subsequent_lines = False
    cfg.general.websocket_sources = [WebsocketInputSource(name="Benchmark", uri=f"127.0.0.1:{source}")]
    cfg.features.generate_longplay = False
    cfg.advanced.direct_websocket_port = port
    gt.get_master_config().discord.enabled = False
    gt.gsm_state.replay_buffer_length = 300
    ws.start_default_websocket_server()
    runtime = gt.get_authoritative_text_runtime()
    runtime.wait_ready()
    ingress = ws.websocket_manager.get_ingress_port()
    if os.environ.get("GSM_NATIVE_READER") == "1":
        from GameSentenceMiner.native.mining import register_gateway_upstreams

        assert register_gateway_upstreams(0, ingress, 0)
    marker = profile / "backend-port"
    marker.write_text(str(ingress))
    marker.replace(profile / "backend-ready")
    if sys.stdin.readline().strip() == "report":
        marker.write_text(str(runtime.health_snapshot()["projected"]))
        marker.replace(profile / "projected")
        sys.stdin.readline()


def eventually(fn, timeout=20):
    deadline = time.monotonic() + timeout
    while True:
        value = fn()
        if value:
            return value
        if time.monotonic() >= deadline:
            raise TimeoutError(fn)
        time.sleep(0.01)


def measure(desktop, legacy, count, *, attached=False):
    connections = Queue()
    stop = threading.Event()

    def source_connection(client):
        connections.put(client)
        stop.wait(100)

    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as folder, contextlib.ExitStack() as stack:
        profile = Path(folder)
        server = stack.enter_context(serve(source_connection, "127.0.0.1", 0, compression=None))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        source = server.socket.getsockname()[1]
        port = spare_port()
        direct = spare_port()
        config = {
            "discord": {"enabled": False},
            "current_profile": "Default",
            "configs": {
                "Default": {
                    "general": {
                        "single_port": port,
                        "use_websocket": True,
                        "use_clipboard": False,
                        "remove_matching_prefix_on_subsequent_lines": False,
                        "websocket_sources": [{"name": "Benchmark", "uri": f"127.0.0.1:{source}", "enabled": True}],
                    },
                    "advanced": {"localhost_bind_address": "127.0.0.1", "direct_websocket_port": direct},
                    "anki": {"enabled": False, "url": f"http://127.0.0.1:{spare_port()}"},
                    "obs": {"host": "127.0.0.2", "port": spare_port(), "open_obs": False, "close_obs": False},
                    "features": {"generate_longplay": False},
                }
            },
        }
        env = {
            **os.environ,
            "GSM_APP_ROOT": str(ROOT),
            "GSM_SMOKE_TEST": "1",
            "GSM_PROFILE_DIR": folder,
            "GSM_DATA_DIR": folder,
            "GSM_SHARED_DATA_DIR": folder,
            "GSM_NATIVE_MINING": "0" if legacy else "1",
            "GSM_NATIVE_READER": "1" if attached else "0",
            "GSM_CLIENT_ID": "backend",
            "GSM_NATIVE_TEXT_INTAKE": "1",
            "GSM_NATIVE_HISTORY": "1",
        }
        if attached:
            env["GSM_EXTERNAL_GATEWAY_PORT"] = str(port)
        env.pop("GSM_TEST_RESULT", None)
        worker = [sys.executable, str(Path(__file__).resolve()), "--worker", folder]
        subprocess.run(worker, env=env, cwd=ROOT, check=True, stdout=subprocess.DEVNULL)
        (profile / "config.json").write_text(json.dumps(config), encoding="utf-8")
        log = stack.enter_context((profile / "bench.log").open("w+", encoding="utf-8"))

        def start(exe):
            child = subprocess.Popen(exe, env=env, cwd=ROOT, stdout=log, stderr=log, stdin=subprocess.PIPE)

            def terminate():
                if child.poll() is None:
                    child.terminate()
                child.wait(timeout=10)

            stack.callback(terminate)
            return child

        processes = [start([str(desktop)])]

        def dump_error(exc_type, exc, tb):
            if exc_type is not None:
                for file in [profile / "bench.log", profile / "logs/desktop.log"]:
                    if file.is_file():
                        print(file.read_text(encoding="utf-8", errors="replace")[-4000:], file=sys.stderr)

        stack.push(dump_error)
        stack.callback(stop.set)
        eventually(lambda: (profile / "electron/agent-control.json").exists())
        if legacy or attached:
            processes.append(start([*worker, "--source", str(source), "--port", str(port)]))
            eventually(lambda: (profile / "backend-ready").exists(), 40)
            if legacy:
                port = int((profile / "backend-ready").read_text())
        source_socket = connections.get(timeout=10)
        base = f"ws://127.0.0.1:{port}"
        reader = stack.enter_context(connect(base + "/ws/texthooker", compression=None, open_timeout=5))

        def snapshot(client=reader):
            client.send(json.dumps({"event": "text_v2_snapshot_request"}))
            while True:
                msg = json.loads(client.recv(timeout=10))
                if msg["event"] == "text_v2_snapshot":
                    return msg

        assert snapshot()["lines"] == []

        def send(text):
            source_socket.send(json.dumps({"source": "manual", "sentence": text}, ensure_ascii=False))

        def recv(client=reader):
            while True:
                msg = json.loads(client.recv(timeout=8))
                if msg["event"] == "text_v2_append":
                    return msg["data"]

        def cpu():
            return sum(sum(p.cpu_times()[:2]) for p in measured)

        def memory():
            return sum(p.memory_full_info().uss for p in measured) / 2**20

        db = stack.enter_context(contextlib.closing(sqlite3.connect(profile / "gsm.db")))

        def persisted(n):
            eventually(lambda: db.execute("SELECT COUNT(*) FROM game_lines").fetchone()[0] == n)

        rows = ["準備完了"]
        send(rows[0])
        assert recv()["text"] == rows[0]
        persisted(1)
        roots = [psutil.Process(child.pid) for child in processes]
        measured = {p for root in roots for p in [root, *root.children(recursive=True)]}
        m0 = memory()
        idle_cpu, idle_start = cpu(), time.perf_counter()
        time.sleep(2)
        metrics = {"idle_cpu_ms_per_second": 1000 * (cpu() - idle_cpu) / (time.perf_counter() - idle_start)}
        for name in ("serial", "burst", "fanout", "overlay"):
            burst = name == "burst"
            overlay = None
            extra = []
            if name == "fanout":
                modern, legacy_a, legacy_b, plain = [
                    stack.enter_context(connect(base + path, compression=None))
                    for path in ["/ws/texthooker", "/ws/texthooker", "/hooker", "/jl"]
                ]
                extra = [modern, legacy_a, legacy_b, plain]
                assert [r["text"] for r in snapshot(modern)["lines"]] == rows
                assert [plain.recv(timeout=5) for _ in rows[-100:]] == rows[-100:]
            if name == "overlay":
                overlay = stack.enter_context(connect(base + "/ws/overlay", compression=None))

                def receive_stats(client=overlay):
                    while True:
                        event = json.loads(client.recv(timeout=10))
                        if isinstance(event, dict) and event.get("type") == "live_stats_update":
                            return event["values"]

                receive_stats()
            lines = [f"第{i}話。{name}の日本語の文章です。" for i in range(count)]
            durations = []
            start_cpu, start = cpu(), time.perf_counter()
            for text in lines:
                at = time.perf_counter_ns()
                send(text)
                if not burst:
                    assert recv()["text"] == text
                    if extra:
                        assert recv(modern)["text"] == text
                        for client in (legacy_a, legacy_b):
                            event = json.loads(client.recv(timeout=5))
                            assert event["event"] == "text_received" and event["sentence"] == text
                        assert plain.recv(timeout=5) == text
                    if overlay is not None:
                        metrics["verified_overlay_characters"] = receive_stats()["total_characters"]
                    durations.append((time.perf_counter_ns() - at) / 1000)
            if burst:
                assert [recv()["text"] for _ in lines] == lines
            delivered = time.perf_counter()
            rows.extend(lines)
            persisted(len(rows))
            metrics[name + "_delivery_us_per_line"] = (delivered - start) * 1e6 / count
            metrics[name + "_durable_us_per_line"] = (time.perf_counter() - start) * 1e6 / count
            metrics[name + "_cpu_us_per_line"] = (cpu() - start_cpu) * 1e6 / count
            for client in extra:
                client.close()
            if durations:
                metrics[name + "_p95_us"] = sorted(durations)[int(0.95 * len(durations))]
        metrics["private_mib_before"] = m0
        metrics["private_mib_after"] = memory()
        assert [r[0] for r in db.execute("SELECT line_text FROM game_lines ORDER BY rowid")] == rows
        final_rows = snapshot()["lines"]
        assert [r["text"] for r in final_rows] == rows
        assert len({r["scene"] for r in final_rows}) == 1, "The benchmark scene changed during capture"
        if not legacy:

            def http(path, data=None):
                req = Request(
                    f"http://127.0.0.1:{port}" + path,
                    data=json.dumps(data).encode() if data is not None else None,
                    headers={"Content-Type": "application/json"},
                )
                with urlopen(req, timeout=3) as response:
                    return json.load(response)

            ids = http("/get_ids")["ids"]
            assert len(ids) == len(rows) and http("/update_checkbox", {"id": ids[-1], "checked": True})[
                "selected_ids"
            ] == [ids[-1]]
            assert http("/data")[-1]["checked"]
            direct_port = http("/get_websocket_port")["direct_port"]
            with connect(f"ws://127.0.0.1:{direct_port}/ws/overlay") as overlay, connect(base + "/jl") as plain:
                stats = json.loads(overlay.recv(timeout=3))
                assert stats["type"] == "live_stats_update" and stats["values"]["total_characters"] > 0
                assert plain.recv(timeout=3) == rows[-min(100, count)]
                send("終了確認")
                assert recv()["text"] == "終了確認"
                while True:
                    incoming = json.loads(overlay.recv(timeout=4))
                    if isinstance(incoming, dict) and incoming.get("type") == "live_stats_update":
                        assert incoming["reason"] == "line"
                        break
            # Reader delivery must continue while another SQLite connection holds the writer.
            db.execute("BEGIN IMMEDIATE")
            try:
                send("データベースの待機中")
                assert recv()["text"] == "データベースの待機中"
            finally:
                db.rollback()
            eventually(
                lambda: (
                    db.execute(
                        "SELECT count(*) FROM game_lines WHERE line_text=?", ("データベースの待機中",)
                    ).fetchone()[0]
                    == 1
                )
            )
        if attached or legacy:
            backend_proc = processes[1]
            backend_proc.stdin.write(b"report\n")
            backend_proc.stdin.flush()
            eventually(lambda: (profile / "projected").exists())
            count_projected = int((profile / "projected").read_text())
            assert count_projected == 0 if attached else count_projected >= len(rows)
            metrics["python_projection_events"] = count_projected
        else:
            metrics["python_projection_events"] = 0
        return {**metrics, "rows": len(rows), "sha256": hashlib.sha256("\n".join(rows).encode()).hexdigest()}


def context_baseline(profile):
    from datetime import UTC, datetime
    from uuid import uuid4

    from scripts.benchmark_mining_history import setup_worker

    db = setup_worker(profile)
    from GameSentenceMiner.native.mining import _serialize_line
    from GameSentenceMiner.util.text_log import GameLine

    lines = []
    session_id = str(uuid4())
    for i in range(1024):
        stamp = datetime.fromtimestamp(i + 10, UTC).astimezone().replace(tzinfo=None)
        row = GameLine(
            str(uuid4()),
            f"日本語の文章番号{i}です。",
            stamp,
            lines[-1] if lines else None,
            None,
            index=i,
            source="manual",
            session_id=session_id,
            first_seen_time=stamp,
        )
        if lines:
            lines[-1].next = row
        lines.append(row)
    selected = [lines[64]]
    samples = []
    for _ in range(300):
        start = time.perf_counter_ns()
        extra_ids = {row.id for row in [selected[0], selected[0].prev, selected[0].next]}
        candidates = [r for r in lines[:-256] if r.id in extra_ids] + lines[-256:]
        payload = {
            "lines": [_serialize_line(r) for r in candidates],
            "selected_lines": [_serialize_line(r) for r in selected],
            "last_overlay_scan_line": None,
            "replay_buffer_length": 300,
            "current_game": "",
        }
        wire = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        samples.append((time.perf_counter_ns() - start) / 1000)
        assert len(json.loads(wire)["lines"]) == 259
    print(
        json.dumps(
            {"p50_us": statistics.median(samples), "p95_us": sorted(samples)[285], "wire_bytes": len(wire.encode())}
        )
    )
    # Time the existing deadline refresh with an established activity session and no IPC peer.
    # Excluding the Python dispatch queue makes this a conservative producer comparison.
    from GameSentenceMiner.util.clients.discord_rpc import DiscordRPCManager
    from GameSentenceMiner.util.config.configuration import get_config, get_master_config

    get_config()
    manager = DiscordRPCManager()
    manager.running = True
    manager.last_game_name = "Game"
    get_master_config().discord.enabled = True
    manager.update("Game")
    samples = []
    for _ in range(300):
        start = time.perf_counter_ns()
        for _ in range(128):
            manager.update("Game")
        samples.append((time.perf_counter_ns() - start) / 128000)
    print(json.dumps({"discord_touch_p50_us": statistics.median(samples), "p95_us": sorted(samples)[285]}))
    manager.stop()
    db.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--context-baseline", action="store_true")
    parser.add_argument("--native-tests", type=Path, help="Desktop Cargo test executable for component timings")
    parser.add_argument("--worker", type=Path)
    parser.add_argument("--source", type=int)
    parser.add_argument("--port", type=int)
    parser.add_argument("--old-desktop", type=Path)
    parser.add_argument("--desktop", type=Path)
    parser.add_argument("--count", type=int, default=160)
    parser.add_argument("--rounds", type=int, default=3)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.context_baseline:
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as temp:
            return context_baseline(Path(temp))
    if args.worker:
        return backend(args.worker, args.source, args.port)
    modes = ["python", "rust_with_backend", "rust_only"]
    report = {
        "count_per_workload": args.count,
        "samples": {mode: [] for mode in modes},
        "host": {"system": platform.platform(), "python": platform.python_version(), "logical_cpus": os.cpu_count()},
        "binary_sha256": {
            key: hashlib.sha256(exe.read_bytes()).hexdigest()
            for key, exe in [("previous", args.old_desktop), ("native", args.desktop)]
        },
    }
    for i in range(args.rounds):
        for key in modes[i % len(modes) :] + modes[: i % len(modes)]:
            legacy = key == "python"
            sample = measure(
                (args.old_desktop if legacy else args.desktop).resolve(),
                legacy,
                args.count,
                attached=key == "rust_with_backend",
            )
            report["samples"][key].append(sample)
            print(key, json.dumps(sample), flush=True)
    hashes = {s["sha256"] for group in report["samples"].values() for s in group}
    assert len(hashes) == 1
    assert len({s["verified_overlay_characters"] for group in report["samples"].values() for s in group}) == 1
    report["median"] = {
        mode: {k: statistics.median(s[k] for s in samples) for k in samples[0] if k != "sha256"}
        for mode, samples in report["samples"].items()
    }
    if args.native_tests:
        old = subprocess.check_output([sys.executable, __file__, "--context-baseline"], cwd=ROOT, encoding="utf-8")
        rows = [json.loads(line) for line in old.splitlines() if line.startswith("{")]
        context, presence = rows
        report["component_timings"] = {"python": {"mining_context": context, "discord_activity": presence}}
        native = {}
        for name, bench, label in [
            ("mining_context", "benchmark_reader_mining_context", "mining_context"),
            ("discord_activity", "benchmark_presence_activity", "discord_touch"),
        ]:
            out = subprocess.check_output(
                [str(args.native_tests.resolve()), bench, "--ignored", "--nocapture"], cwd=ROOT, encoding="utf-8"
            )
            match = re.search(rf"{label}_p50_us=([0-9.]+) p95_us=([0-9.]+)", out)
            assert match, out
            native[name] = {"p50_us": float(match[1]), "p95_us": float(match[2])}
        native["test_binary"] = args.native_tests.name
        native["cargo_profile"] = args.native_tests.parent.parent.name
        report["component_timings"]["rust"] = native
    if args.output:
        args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
