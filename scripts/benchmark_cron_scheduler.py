"""Real desktop scheduling on the benchmark harness's isolated GSM profiles."""

import json
import os
import queue
import threading
import time
from pathlib import Path
from unittest.mock import patch

import psutil


def until(check):
    deadline = time.monotonic() + 20
    while not check():
        if time.monotonic() > deadline:
            raise TimeoutError("Scheduled result did not reach the fixture")
        time.sleep(0.001)


def measure_scheduled(db, bus, desktop_pid, args):
    from GameSentenceMiner.util.config.configuration import get_master_config
    from GameSentenceMiner.util.cron.run_crons import CronScheduler
    from GameSentenceMiner.util.database.cron_table import CronTable
    from scripts.benchmark_anki_sync import digest, prepare_collection
    from scripts.benchmark_daily_rollup import prepare_rollup

    if args.case == "cron-rollup":
        name, operation = "daily_stats_rollup", "rebuildRollups"
        _, verify = prepare_rollup(db, "rollup-mixed")
    else:
        name, operation = "anki_card_sync", "anki.sync"
        prepare_collection(db, f"http://127.0.0.1:{args.port}/sync/collection")

        def verify():
            assert db.fetchone("SELECT count(*) FROM anki_notes")[0] == 1200
            assert db.fetchone("SELECT count(*) FROM anki_cards")[0] == 2400
            assert db.fetchone("SELECT count(*) FROM anki_reviews")[0] == 14400
            return digest(db)

    CronTable.set_db(db)
    db.execute("DELETE FROM cron_table", commit=True)

    (Path(os.environ["GSM_PROFILE_DIR"]) / "config.json").write_text(
        json.dumps(get_master_config().to_dict()), encoding="utf-8"
    )
    row = CronTable.create_cron_entry(name, name, time.time() - 1, "once")
    scheduler = CronScheduler()
    processes = [psutil.Process(), psutil.Process(desktop_pid)]
    calls = []
    original = bus.request

    def observe(dst, topic, data=None, timeout=15):
        if topic == "mining.history" and data["operation"] == "rebuildRollups":
            calls.append(data["operation"])
        elif topic == "anki.sync":
            calls.append(topic)
        return original(dst, topic, data, timeout)

    def cpu():
        return sum(sum(p.cpu_times()[:2]) for p in processes)

    with patch.object(bus, "request", observe):
        start_cpu, start = cpu(), time.perf_counter()
        scheduler.start()
        try:
            until(lambda: not CronTable.get(row.id).enabled)
            wall_ms = (time.perf_counter() - start) * 1000
            cpu_ms = (cpu() - start_cpu) * 1000
            assert (scheduler._desktop is not None) == (args.worker == "rust")
            assert calls == ([] if args.worker == "rust" else [operation])
            if args.case == "cron-rollup":
                assert db.fetchone("SELECT count(*) FROM daily_stats_rollup")[0] == 10
            uss = sum(p.memory_full_info().uss for p in processes) / 2**20
            return {"result": verify(), "wall_ms": wall_ms, "cpu_ms": cpu_ms, "settled_uss_mib": uss}
        finally:
            scheduler.stop(timeout=5)


def measure(db, bus, desktop_pid, iterations, mode):
    from GameSentenceMiner.util.cron import run_crons as cron
    from GameSentenceMiner.util.database.cron_table import CronTable

    CronTable.set_db(db)
    db.execute("DELETE FROM cron_table", commit=True)
    # The dispatch workload intentionally exercises one high-priority leased
    # job. The separate rollup case measures a native scheduled calculation.
    (Path(os.environ["GSM_PROFILE_DIR"]) / "config.json").write_text(
        json.dumps({"stats": {"extra_punctuation_regex": "(?<=a)b"}}), encoding="utf-8"
    )
    scheduler = cron.CronScheduler()
    jobs = []
    for name in ("populate_games", "daily_goals_completion", "daily_stats_rollup"):
        CronTable.create_cron_entry(name, name, time.time() - 30, "once")
    db.execute(
        "INSERT INTO game_lines(id,game_name,line_text,timestamp) VALUES ('first','Benchmark','early',1)", commit=True
    )
    processes = [psutil.Process(), psutil.Process(desktop_pid)]

    def cpu():
        clocks = [p.cpu_times() for p in processes]
        return sum(c.user + c.system for c in clocks)

    def runner(name):
        def record():
            jobs.append(name)
            return {"success": True}

        return cron._TaskDef(record, priority=cron._TASK_REGISTRY[name].priority)

    waits = 0
    original = scheduler._queue.get

    def counted(*args, **kwargs):
        nonlocal waits
        try:
            return original(*args, **kwargs)
        except queue.Empty:
            if kwargs.get("timeout") is not None:
                waits += 1
            raise

    def linked(line):
        return db.fetchone("SELECT game_id FROM game_lines WHERE id=?", (line,))[0]

    callbacks = ("daily_goals_completion", "daily_stats_rollup")
    with (
        patch.dict(cron._TASK_REGISTRY, {name: runner(name) for name in callbacks}),
        patch.object(scheduler._queue, "get", counted),
    ):
        scheduler.force_daily_goals_completion()
        start_cpu, start = cpu(), time.perf_counter()
        scheduler.start()
        try:
            until(lambda: len(jobs) == 3 and linked("first") and not CronTable.get_all_enabled())
            startup_ms = (time.perf_counter() - start) * 1000
            startup_cpu_ms = (cpu() - start_cpu) * 1000
            assert jobs == ["daily_stats_rollup", "daily_goals_completion", "daily_goals_completion"]
            assert (scheduler._desktop is not None) == (mode == "rust")
            persisted = db.fetchall("SELECT id,last_run,next_run FROM cron_table ORDER BY id")
            idle_waits = waits
            idle_cpu = cpu()
            time.sleep(4)
            idle_cpu_ms = 1000 * (cpu() - idle_cpu)
            idle_waits = waits - idle_waits
            threads = sum(t.name == "gsm-cron-scheduler" for t in threading.enumerate())
            assert idle_waits == 0 if mode == "rust" else idle_waits >= 5
            assert threads == (0 if mode == "rust" else 1)
            # Check one observable database effect per forced job. Both paths
            # include the same insert and one-millisecond observer.
            start_cpu, start = cpu(), time.perf_counter()
            for i in range(iterations):
                row_id = f"manual-{i}"
                db.execute(
                    "INSERT INTO game_lines(id,game_name,line_text,timestamp) VALUES (?,'Benchmark','later',1)",
                    (row_id,),
                    commit=True,
                )
                scheduler.force_populate_games()
                until(lambda row_id=row_id: linked(row_id))
            wall = (time.perf_counter() - start) * 1000 / iterations
            cpu_ms = (cpu() - start_cpu) * 1000 / iterations
            assert db.fetchall("SELECT id,last_run,next_run FROM cron_table ORDER BY id") == persisted
            assert (
                db.fetchone("SELECT count(*) FROM game_lines JOIN games ON game_lines.game_id=games.id")[0]
                == iterations + 1
            )
            result = {
                "result": {
                    "linked": iterations + 1,
                    "startup_jobs": jobs[:3],
                    "unchanged_manual_schedules": len(persisted),
                },
                "startup_ms": startup_ms,
                "startup_cpu_ms": startup_cpu_ms,
                "forced_wall_ms": wall,
                "forced_cpu_ms": cpu_ms,
                "idle_cpu_ms_4s": idle_cpu_ms,
                "idle_python_timeouts_4s": idle_waits,
                "python_cron_threads": threads,
                "settled_uss_mib": sum(p.memory_full_info().uss for p in processes) / 2**20,
            }
            original_isolate = cron._run_registered_task_isolated
            child_results = []

            def isolate(name):
                response = original_isolate(name)
                child_results.append((name, response["skipped"]))
                return response

            with patch.object(cron, "_run_registered_task_isolated", isolate):
                start = time.perf_counter()
                scheduler.force_anki_word_sync()
                scheduler.force_daily_goals_completion()
                until(lambda: len(jobs) == 4)
                result["retired_job_and_barrier_ms"] = (time.perf_counter() - start) * 1000
                assert child_results == ([("anki_word_sync", True)] if mode == "python" else [])
                result["retired_job_python_processes"] = len(child_results)
            if mode == "rust":
                for shutdown in (False, True):
                    verify_interrupted_job(bus, scheduler, CronTable, cron, shutdown)
            return result
        finally:
            scheduler.stop(timeout=5)
            if scheduler._desktop is not None:
                assert scheduler._desktop.future.done()


def verify_interrupted_job(bus, scheduler, table, cron, shutdown):
    entered, release = threading.Event(), threading.Event()
    executions = []

    def active():
        executions.append(1)
        entered.set()
        assert release.wait(15)
        return {"success": True}

    with patch.dict(cron._TASK_REGISTRY, {"daily_goals_completion": cron._TaskDef(active)}):
        row = table.get_by_name("daily_goals_completion")
        row.enabled, row.next_run = True, time.time() - 1
        row.save()
        scheduler.update_scheduled_cron(row)
        try:
            assert entered.wait(5)
            if shutdown:
                scheduler.shutdown()
            else:
                # Drop only this temporary backend's connection during a
                # leased job. The result must survive the next handshake.
                bus.submit(bus._ws.close()).result(5)
        finally:
            release.set()
        until(lambda: not table.get_by_name("daily_goals_completion").enabled)
        assert executions == [1]
