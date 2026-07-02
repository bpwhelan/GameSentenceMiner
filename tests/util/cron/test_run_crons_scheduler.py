import threading
from datetime import datetime, timedelta
from types import SimpleNamespace

from GameSentenceMiner.util.cron import run_crons
from GameSentenceMiner.util.database.cron_table import CronTable


def test_scheduler_runs_initial_check_on_dedicated_thread(monkeypatch):
    calls = []
    run_entered = threading.Event()
    release_run = threading.Event()
    test_thread_id = threading.get_ident()

    def fake_run_due_crons(force_task=None, progress=None, **kwargs):
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

    def fake_run_due_crons(force_task=None, progress=None, **kwargs):
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

    def fake_run_due_crons(force_task=None, progress=None, **kwargs):
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
    monkeypatch.setattr(run_crons, "run_due_crons", lambda force_task=None, progress=None, **kwargs: {"executed": 0})

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
    monkeypatch.setattr(run_crons.CronTable, "get_all_enabled", lambda: [])

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


def test_scheduler_defaults_poll_every_minute_with_900_second_cron_cache():
    scheduler = run_crons.CronScheduler()

    assert scheduler.check_interval == 60
    assert scheduler.cache_refresh_interval == 900


def test_cron_table_cache_reuses_enabled_crons_until_refresh(monkeypatch):
    clock = {"monotonic": 10.0, "wall": 1_000.0}
    pulls = []

    def fake_get_all_enabled():
        pulls.append(clock["monotonic"])
        return [
            SimpleNamespace(
                id=1,
                name=run_crons.Crons.USER_PLUGINS.value,
                description="Custom user plugins",
                enabled=True,
                next_run=clock["wall"] - 1,
            )
        ]

    monkeypatch.setattr(run_crons.time, "monotonic", lambda: clock["monotonic"])
    monkeypatch.setattr(run_crons.time, "time", lambda: clock["wall"])
    monkeypatch.setattr(run_crons.CronTable, "get_all_enabled", fake_get_all_enabled)

    cache = run_crons._CronTableCache(refresh_interval=900)

    assert [cron.id for cron in cache.get_due_crons()] == [1]
    assert pulls == [10.0]

    clock["monotonic"] = 800.0
    assert [cron.id for cron in cache.get_due_crons()] == [1]
    assert pulls == [10.0]

    clock["monotonic"] = 911.0
    assert [cron.id for cron in cache.get_due_crons()] == [1]
    assert pulls == [10.0, 911.0]


def test_run_due_crons_uses_supplied_cached_rows_and_reports_updates(monkeypatch):
    ran = []
    cron = SimpleNamespace(
        id=42,
        name=run_crons.Crons.POPULATE_GAMES.value,
        description="Populate games",
        enabled=True,
        last_run=None,
        next_run=0,
        schedule="quarter_hourly",
    )

    def fake_runner():
        ran.append("populate_games")
        return {}

    def fake_just_ran(cron_id):
        assert cron_id == 42
        cron.last_run = 1_000.0
        cron.next_run = 1_900.0
        return cron

    updated = []

    monkeypatch.setitem(
        run_crons._TASK_REGISTRY,
        run_crons.Crons.POPULATE_GAMES.value,
        run_crons._TaskDef(runner=fake_runner),
    )
    monkeypatch.setattr(run_crons.CronTable, "just_ran", fake_just_ran)

    result = run_crons.run_due_crons(
        due_crons=[cron],
        on_cron_ran=updated.append,
    )

    assert ran == ["populate_games"]
    assert result["executed"] == 1
    assert updated == [cron]
    assert cron.next_run == 1_900.0


def test_quarter_hourly_cron_schedule_advances_15_minutes(monkeypatch):
    now = datetime(2026, 7, 2, 12, 0, 0)

    class DummyCron:
        id = 1
        name = "user_plugins"
        schedule = "quarter_hourly"
        enabled = True
        last_run = None
        next_run = None
        saved = False

        def save(self):
            self.saved = True

    cron = DummyCron()

    monkeypatch.setattr("GameSentenceMiner.util.database.cron_table.time.time", lambda: now.timestamp())
    monkeypatch.setattr(CronTable, "get", lambda cron_id: cron if cron_id == 1 else None)

    updated = CronTable.just_ran(1)

    assert updated is cron
    assert cron.saved is True
    assert cron.enabled is True
    assert cron.last_run == now.timestamp()
    assert cron.next_run == (now + timedelta(minutes=15)).timestamp()
