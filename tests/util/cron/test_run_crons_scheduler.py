import threading

from GameSentenceMiner.util.cron import run_crons


def test_scheduler_runs_initial_check_on_dedicated_thread(monkeypatch):
    calls = []
    run_entered = threading.Event()
    release_run = threading.Event()
    test_thread_id = threading.get_ident()

    def fake_run_due_crons(force_task=None, progress=None):
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

    def fake_run_due_crons(force_task=None, progress=None):
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

    def fake_run_due_crons(force_task=None, progress=None):
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


def test_shutdown_is_nonblocking_and_stops_thread(monkeypatch):
    monkeypatch.setattr(run_crons, "run_due_crons", lambda force_task=None, progress=None: {"executed": 0})

    scheduler = run_crons.CronScheduler(check_interval=60)
    scheduler.start()
    thread = scheduler._thread

    scheduler.shutdown()  # must not block
    assert scheduler.is_running() is False
    assert thread is not None
    thread.join(timeout=2)
    assert not thread.is_alive()


def test_run_due_crons_dispatches_via_registry(monkeypatch):
    ran = []

    def fake_runner():
        ran.append("populate_games")
        return {"created": 2, "linked_lines": 5}

    monkeypatch.setitem(
        run_crons._TASK_REGISTRY,
        run_crons.Crons.POPULATE_GAMES.value,
        run_crons._TaskDef(runner=fake_runner),
    )

    seen = []
    result = run_crons.run_due_crons(
        force_task=run_crons.Crons.POPULATE_GAMES,
        progress=seen.append,
    )

    assert ran == ["populate_games"]
    assert result["executed"] == 1
    assert result["failed"] == 0
    assert result["details"][0]["success"] is True
    # progress is pinged with the task name on start and None on completion.
    assert seen == ["populate_games", None]


def test_run_due_crons_counts_failures(monkeypatch):
    def boom():
        raise RuntimeError("kaboom")

    monkeypatch.setitem(
        run_crons._TASK_REGISTRY,
        run_crons.Crons.POPULATE_GAMES.value,
        run_crons._TaskDef(runner=boom),
    )

    result = run_crons.run_due_crons(force_task=run_crons.Crons.POPULATE_GAMES)

    assert result["executed"] == 0
    assert result["failed"] == 1
    assert "kaboom" in result["details"][0]["error"]


def test_active_task_cleared_after_forced_run(monkeypatch):
    started = threading.Event()
    release = threading.Event()

    def slow_runner():
        started.set()
        release.wait(timeout=1)
        return {}

    monkeypatch.setitem(
        run_crons._TASK_REGISTRY,
        run_crons.Crons.POPULATE_GAMES.value,
        run_crons._TaskDef(runner=slow_runner),
    )

    scheduler = run_crons.CronScheduler(check_interval=60)
    scheduler.start()
    try:
        scheduler.force_populate_games()
        assert started.wait(timeout=1)
        assert scheduler._active_task_info() is not None
        release.set()
    finally:
        scheduler.stop()

    assert scheduler._active_task_info() is None
