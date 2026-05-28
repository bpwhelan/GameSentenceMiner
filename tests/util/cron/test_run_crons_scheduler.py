import threading

from GameSentenceMiner.util.cron import run_crons


def test_scheduler_runs_initial_check_on_dedicated_thread(monkeypatch):
    calls = []
    run_entered = threading.Event()
    release_run = threading.Event()
    test_thread_id = threading.get_ident()

    def fake_run_due_crons(force_task=None):
        calls.append((force_task, threading.get_ident()))
        run_entered.set()
        release_run.wait(timeout=1)
        return {"executed": 0}

    monkeypatch.setattr(run_crons, "run_due_crons", fake_run_due_crons)

    scheduler = run_crons.CronScheduler(check_interval=60)
    scheduler.start()

    try:
        assert run_entered.wait(timeout=1)
        assert len(calls) == 1
        assert calls[0][0] is None
        assert calls[0][1] != test_thread_id
        assert scheduler.is_running()
    finally:
        release_run.set()
        scheduler.stop()


def test_scheduler_runs_forced_task_queued_before_start(monkeypatch):
    calls = []
    forced_seen = threading.Event()

    def fake_run_due_crons(force_task=None):
        calls.append(force_task)
        if force_task == run_crons.Crons.DAILY_STATS_ROLLUP:
            forced_seen.set()
        return {"executed": 0}

    monkeypatch.setattr(run_crons, "run_due_crons", fake_run_due_crons)

    scheduler = run_crons.CronScheduler(check_interval=60)
    scheduler.add_external_task(run_crons.Crons.DAILY_STATS_ROLLUP)
    scheduler.start()

    try:
        assert forced_seen.wait(timeout=1)
        assert calls[:2] == [None, run_crons.Crons.DAILY_STATS_ROLLUP]
    finally:
        scheduler.stop()


def test_forced_task_wakes_scheduler_between_interval_checks(monkeypatch):
    calls = []
    initial_seen = threading.Event()
    forced_seen = threading.Event()

    def fake_run_due_crons(force_task=None):
        calls.append(force_task)
        if force_task is None:
            initial_seen.set()
        elif force_task == run_crons.Crons.POPULATE_GAMES:
            forced_seen.set()
        return {"executed": 0}

    monkeypatch.setattr(run_crons, "run_due_crons", fake_run_due_crons)

    scheduler = run_crons.CronScheduler(check_interval=60)
    scheduler.start()

    try:
        assert initial_seen.wait(timeout=1)
        scheduler.force_populate_games()
        assert forced_seen.wait(timeout=1)
        assert calls[:2] == [None, run_crons.Crons.POPULATE_GAMES]
    finally:
        scheduler.stop()
