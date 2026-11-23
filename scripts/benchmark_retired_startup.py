"""Measure the removed startup work on a disposable Windows profile."""

import ast
import json
import logging
import os
import re
import socketserver
import statistics
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace

import psutil

BASE = "4fea8c90c9448e603370e831c67b37b9154f178a"


def historical(filename, names, namespace):
    source = subprocess.check_output(["git", "show", f"{BASE}:{filename}"]).decode()
    tree = ast.parse(source)
    tree.body = [node for node in tree.body if getattr(node, "name", "") in names]
    if len(tree.body) != len(names):
        raise ValueError(f"Missing historical definitions in {filename}")
    exec(compile(tree, filename, "exec"), namespace)  # noqa: S102 - definitions from the pinned repository revision
    return namespace


def sample(root, baseline):
    from GameSentenceMiner import gsm

    config = SimpleNamespace(paths=SimpleNamespace(output_folder=str(root / "words")))
    scope = {"os": os, "re": re, "get_config": lambda: config}
    scan = historical("GameSentenceMiner/anki.py", {"migrate_old_word_folders"}, scope)["migrate_old_word_folders"]
    server = historical(
        "GameSentenceMiner/web/texthooking_page.py",
        {"_LegacyMovedPageServer", "_LegacyMovedPageHandler", "_start_legacy_moved_page_server"},
        {
            "ThreadingHTTPServer": ThreadingHTTPServer,
            "TCPServer": socketserver.TCPServer,
            "BaseHTTPRequestHandler": BaseHTTPRequestHandler,
            "threading": threading,
            "logger": logging.getLogger(__name__),
            "_get_single_port": lambda: 7275,
            "_get_legacy_texthooker_port": lambda: 55000,
            "_legacy_notice_server": None,
            "get_config": lambda: SimpleNamespace(advanced=SimpleNamespace(localhost_bind_address="127.0.0.1")),
        },
    )
    # The historical launcher still sees its normal settings. Ask Windows for
    # an ephemeral port at bind time so the benchmark cannot claim GSM's ports.
    legacy = server["_LegacyMovedPageServer"]
    server["_LegacyMovedPageServer"] = lambda address, handler: legacy((address[0], 0), handler)
    proc = psutil.Process()
    results = {}

    def measure(name, fn):
        start, cpu = time.perf_counter_ns(), time.process_time_ns()
        fn()
        results[name] = (
            round((time.perf_counter_ns() - start) / 1e6, 3),
            round((time.process_time_ns() - cpu) / 1e6, 3),
        )

    def initialize():
        app = gsm.GSMApplication()
        if baseline:
            from GameSentenceMiner import replay_handler
            from GameSentenceMiner.web import service

            app._replay_extractor = replay_handler.ReplayAudioExtractor()
            _ = service, app._replay_extractor.get_audio

    measure("constructor_and_media_setup", initialize)
    measure("scan", scan if baseline else lambda: None)
    measure("listener_start", server["_start_legacy_moved_page_server"] if baseline else lambda: None)
    results["peak_ws_mib"] = proc.memory_info().peak_wset / 2**20
    results["listener_threads"] = int(server["_legacy_notice_server"] is not None)
    if baseline:
        server["_legacy_notice_server"].shutdown()
        server["_legacy_notice_server"].server_close()
        server["_legacy_notice_thread"].join()
    print("SAMPLE", json.dumps(results), flush=True)


def main():
    if len(sys.argv) == 3:
        return sample(Path(sys.argv[1]), sys.argv[2] == "before")
    with tempfile.TemporaryDirectory(prefix="gsm-retired-") as folder:
        root = Path(folder)
        for i in range(384):
            word = root / "words" / f"word-{i}"
            word.mkdir(parents=True)
            (word / "notes.txt").touch()
        samples = {"before": [], "after": []}
        for i in range(5):
            for mode in samples if i % 2 == 0 else reversed(samples):
                data = root / f"profile-{mode}-{i}"
                data.mkdir()
                env = {
                    **os.environ,
                    "GSM_DATA_DIR": str(data),
                    "GSM_TEST_DATA_ROOT": str(data),
                    "GAME_SENTENCE_MINER_TESTING": "1",
                    "GSM_DISABLE_DB_BACKUP": "1",
                    "PYTHONUTF8": "1",
                    "QT_QPA_PLATFORM": "offscreen",
                }
                output = subprocess.check_output(
                    [sys.executable, "-m", "scripts.benchmark_retired_startup", str(root), mode],
                    env=env,
                    encoding="utf-8",
                    timeout=60,
                )
                samples[mode].append(
                    json.loads(next(line[7:] for line in output.splitlines() if line.startswith("SAMPLE ")))
                )
        for mode, rows in samples.items():
            medians = {}
            for key in rows[0]:
                values = [s[key] for s in rows]
                medians[key] = (
                    list(map(statistics.median, zip(*values)))
                    if isinstance(values[0], list)
                    else statistics.median(values)
                )
            print(mode, medians)


if __name__ == "__main__":
    main()
