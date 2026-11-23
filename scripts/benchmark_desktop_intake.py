"""Measure actual loopback WebSocket and in-process GSM producer paths through projection.

Run via benchmark_mining_history.py --case dialogue-intake-sources. Each sample
starts an isolated desktop and backend client. Only the final consumers are replaced.
"""

import hashlib
import json
import os
import threading
import time
from concurrent.futures import CancelledError
from pathlib import Path
from queue import Queue
from statistics import median

import psutil
from websockets.sync.server import serve


def wait_for_native_log(log_file, text):
    # Include queued output work in CPU measurements without scanning the log during the timed reader path.
    last_receipt = ("]: " + text + "\n").encode()
    deadline = time.monotonic() + 5
    with log_file.open("rb") as handle:
        while True:
            end = handle.seek(0, os.SEEK_END)
            handle.seek(max(0, end - 4096))
            if last_receipt in handle.read().replace(b"\r\n", b"\n"):
                return
            if time.monotonic() >= deadline:
                raise AssertionError(f"Desktop receipt did not drain for {text}")
            time.sleep(0.002)


def verify_native_receipts(runtime, rows, log_file):
    # The output worker is independent of the reader. Check the real desktop log after timing.
    partial = {"source": "speech", "source_display_name": "Speech probe", "revision_window_ms": 5000, "text": "また"}
    first = runtime.submit(partial, wait=True)
    correction = {**partial, "text": "また明日", "observation_id": "probe-correction"}
    second = runtime.submit(correction, wait=True)
    repeated = runtime.submit(correction, wait=True)
    assert first["status"] == second["status"] == "accepted"
    assert first["line_id"] == second["line_id"]
    assert repeated["status"] == "duplicate" and repeated["observation_id"] == correction["observation_id"]
    assert second["revision"] > first["revision"]
    prefix = "[rust:text-intake]"
    deadline = time.monotonic() + 5
    while True:
        lines = [line for line in log_file.read_text(encoding="utf-8").splitlines() if line.startswith(prefix)]
        revised = [line for line in lines if " | Line revised from [" in line]
        if revised or time.monotonic() >= deadline:
            break
        time.sleep(0.02)
    appends = [
        line.split(" | Line received from [", 1)[1].split("]: ", 1)[1]
        for line in lines
        if " | Line received from [" in line
    ]
    assert appends == [*rows, partial["text"]]
    assert len(revised) == 1 and revised[0].endswith(f"rev={second['revision']}: {correction['text']}")
    assert all(
        " | TEXT_RECEIVED | " in line
        for line in lines
        if " | Line received from [" in line or " | Line revised from [" in line
    )
    assert runtime.health_snapshot()["accepted_lines"] == len(rows) + 1


def measure(mode, desktop_pid, count):
    from GameSentenceMiner import gametext as gt
    from GameSentenceMiner.util.communication import bus_client
    from GameSentenceMiner.util.config.configuration import WebsocketInputSource

    os.environ["GSM_NATIVE_TEXT_INTAKE"] = "1" if mode == "rust" else "0"
    # Compare to the previous default (including its installed native kernels).
    os.environ["GSM_NATIVE_TEXT_MODE"] = "native"
    processes = [psutil.Process(), psutil.Process(desktop_pid)]

    def cpu():
        return sum(sum(p.cpu_times()[:2]) for p in processes)

    def uss():
        return sum(p.memory_full_info().uss for p in processes) / 2**20

    log_file = Path(os.environ["GSM_PROFILE_DIR"]) / "logs" / "desktop.log"
    received = Queue()
    connection = Queue()
    end = threading.Event()

    def connected(socket):
        connection.put(socket)
        end.wait(60)

    legacy_preview = True

    def project(event, *, desktop_outputs=False):
        if event.kind.value == "append":
            assert desktop_outputs == (mode == "rust")
            record = event.record
            if mode == "python" and legacy_preview:
                gt._log_info(
                    f"<cyan>Line Received from [{record.source_display_name}]: {record.text}</cyan>", colors=True
                )
                bus_client.get_bus().publish(
                    bus_client.MAIN,
                    "backend.event",
                    {
                        "function": "text_received",
                        "data": {
                            "text": record.raw_text,
                            "processed_text": record.text,
                            "time": record.captured_at_utc.isoformat(),
                            "source": record.source_kind.value,
                            "source_display_name": record.source_display_name,
                        },
                    },
                )
            received.put((record.source_kind.value, record.text))

    gt._project_text_domain_event = project
    gt._expire_live_stats_session = lambda: None
    settings = gt.get_config()
    settings.general.use_clipboard = False
    settings.general.use_websocket = True
    settings.general.remove_matching_prefix_on_subsequent_lines = False
    with serve(connected, "127.0.0.1", 0, compression=None) as server:
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        uri = f"127.0.0.1:{server.socket.getsockname()[1]}"
        settings.general.websocket_sources = [WebsocketInputSource(name="Benchmark", uri=uri)]
        runtime = gt.get_authoritative_text_runtime()
        task = bus_client.get_bus().submit(gt.start_text_monitor() if mode == "rust" else gt.listen_on_websocket(uri))
        try:
            sock = connection.get(timeout=15)
            rows = []

            def consume(expected):
                actual = received.get(timeout=10)
                assert actual == ("manual", expected), (actual, expected)
                rows.append(expected)

            def send(text):
                sock.send(json.dumps({"sentence": text, "source": "manual"}, ensure_ascii=False))

            send("準備完了")
            consume("準備完了")
            start_memory = uss()
            before = cpu()
            time.sleep(2)
            idle_cpu = cpu() - before
            metrics = {"idle_cpu_ms_per_s": idle_cpu * 500, "private_mib_start": start_memory}
            for name in ("websocket", "producer", "async_producer", "burst", "producer_control"):
                # This control isolates the old actor wait with a minimal downstream consumer.
                # Native preview always remains enabled in the desktop.
                legacy_preview = name != "producer_control"
                samples = []
                values = [f"第{i}話。{name}の日本語の文章です。" for i in range(count)]
                before = cpu()
                started = time.perf_counter()
                for text in values:
                    stamp = time.perf_counter_ns()
                    if name in ("producer", "producer_control"):
                        gt._ingest_line_sync(text, source="manual")
                    elif name == "async_producer":
                        bus_client.get_bus().submit(gt.add_line_to_text_log(text, source="manual")).result(timeout=5)
                    else:
                        send(text)
                    if name != "burst":
                        consume(text)
                        samples.append((time.perf_counter_ns() - stamp) / 1000)
                if name == "burst":
                    for text in values:
                        consume(text)
                elapsed = time.perf_counter() - started
                metrics[f"{name}_us_per_line"] = 1e6 * elapsed / count
                if mode == "rust":
                    wait_for_native_log(log_file, values[-1])
                elif legacy_preview:
                    gt.logger.complete()
                metrics[f"{name}_drained_us_per_line"] = 1e6 * (time.perf_counter() - started) / count
                metrics[f"{name}_cpu_us_per_line"] = 1e6 * (cpu() - before) / count
                if samples:
                    metrics[f"{name}_p50_us"] = median(samples)
                    metrics[f"{name}_p95_us"] = sorted(samples)[int(0.95 * len(samples))]
            metrics["private_mib_end"] = uss()
            snapshot = runtime.snapshot()
            assert [r.text for r in snapshot.records] == rows
            if mode == "rust":
                verify_native_receipts(runtime, rows, log_file)
            return {
                **metrics,
                "result": {"lines": len(rows), "sha256": hashlib.sha256("\n".join(rows).encode()).hexdigest()},
            }
        finally:
            end.set()
            task.cancel()
            try:
                task.result(timeout=2)
            except CancelledError:
                pass
            gt.stop_authoritative_text_runtime()
            server.shutdown()
            thread.join(2)
