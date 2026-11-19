"""Time recurring vocabulary work with identical native SQLite and dictionary kernels."""

import json
import os
import threading
import time
from unittest.mock import patch


def scheduled(profile, db, bus, config, lines, measure, mode):
    from GameSentenceMiner.util.cron.run_crons import CronScheduler
    from GameSentenceMiner.util.database.cron_table import CronTable
    from scripts.benchmark_cron_scheduler import until

    os.environ.update(GSM_NATIVE_CRON="1", GSM_NATIVE_WORD_BACKFILL=str(int(mode == "rust")))
    CronTable.set_db(db)
    path = profile / "config.json"
    scheduler = CronScheduler()
    name = "tokenize_backfill"
    cron = CronTable.create_cron_entry(name, "Benchmark backfill", time.time() - 1, "once")

    def options(enabled=True, slow=False):
        config.enable_experimental_features = config.enable_tokenization = enabled
        config.tokenize_low_performance = slow
        document = json.loads(path.read_text(encoding="utf-8-sig")) if path.exists() else {}
        document["experimental"] = {
            "enable_experimental_features": enabled,
            "enable_tokenization": enabled,
            "tokenize_low_performance": slow,
            "tokenization_sudachi_dictionary": "small",
        }
        path.write_text(json.dumps(document), encoding="utf-8")

    def seed(start, count):
        db.executemany(
            "INSERT INTO game_lines(id,line_text,timestamp) VALUES(?,?,?)",
            [(row.id, row.text, row.time.timestamp()) for row in lines(start, count)],
            commit=True,
        )

    def done():
        return db.fetchone("SELECT enabled=0 AND last_run IS NOT NULL FROM cron_table WHERE id=?", (cron.id,))[0]

    def arm():
        db.execute("UPDATE cron_table SET enabled=1,next_run=0,last_run=NULL WHERE id=?", (cron.id,), commit=True)

    def refresh():
        scheduler._desktop.wake(refresh=True)
        until(done)

    leases = []

    def observe(job):
        leases.append((job["name"], threading.current_thread().name))
        return original_execute(job)

    pages = []
    original_execute = scheduler._execute_desktop_job
    original_request = bus.request

    def request(dst, topic, data=None, timeout=15):
        if topic == "mining.wordIndex":
            pages.append(data["action"])
        return original_request(dst, topic, data, timeout)

    metrics = {}
    options(enabled=False)
    with patch.object(scheduler, "_execute_desktop_job", observe), patch.object(bus, "request", request):
        try:
            metrics["disabled_startup"] = measure(lambda: (scheduler.start(), until(done)))
            assert scheduler._desktop is not None
            options()
            for label, start, count, slow in (
                ("idle", 0, 0, False),
                ("cold_512", 0, 512, False),
                ("warm_2048", 512, 2048, False),
                ("throttled_128", 2560, 128, True),
            ):
                options(slow=slow)
                if count:
                    seed(start, count)
                if label == "cold_512":
                    db.execute("INSERT INTO words(id,word) VALUES(1000,'孤児')", commit=True)
                    db.execute("INSERT INTO word_occurrences(word_id,line_id) VALUES(1000,'removed')", commit=True)
                arm()
                metrics[label] = measure(refresh)
                assert not db.fetchone("SELECT count(*) FROM game_lines WHERE tokenized=0")[0]
                assert not db.fetchone("SELECT count(*) FROM word_occurrences WHERE line_id='removed'")[0]
            assert len(leases) == (5 if mode == "python" else 0), leases
            assert pages == (["backfill"] * (3 + 9 + 3) if mode == "python" else []), pages
            # The caller-facing job also uses a single desktop request. Manual
            # triggers must leave the persisted schedule intact.
            previous = db.fetchone("SELECT enabled,last_run,next_run FROM cron_table WHERE id=?", (cron.id,))
            seed(2688, 1)
            scheduler.force_tokenize_backfill()
            until(lambda: db.fetchone("SELECT tokenized FROM game_lines WHERE id='2688'")[0])
            assert db.fetchone("SELECT enabled,last_run,next_run FROM cron_table WHERE id=?", (cron.id,)) == previous
            if mode == "rust":
                from GameSentenceMiner.util.cron.tokenize_lines import run_tokenize_backfill

                assert run_tokenize_backfill()["total_lines"] == 0
                assert pages == ["runBackfill"]
        finally:
            scheduler.stop(timeout=10)
    return metrics
