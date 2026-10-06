from types import SimpleNamespace

import pytest

from GameSentenceMiner.util.clients import discord_rpc
from GameSentenceMiner.util.concurrency.scheduler import SchedulerActor
from GameSentenceMiner.util.config.configuration import StatsConfig
from GameSentenceMiner.util.stats import live_stats


def test_discord_rpc_actor_does_not_block_process_shutdown(monkeypatch):
    created_threads = []

    class FakeThread:
        def __init__(self, *, target, name, daemon):
            self.target = target
            self.name = name
            self.daemon = daemon
            self.started = False
            created_threads.append(self)

        def start(self):
            self.started = True

    monkeypatch.setattr(
        discord_rpc,
        "get_master_config",
        lambda: SimpleNamespace(discord=SimpleNamespace(enabled=True)),
    )
    monkeypatch.setattr(discord_rpc.threading, "Thread", FakeThread)

    manager = discord_rpc.DiscordRPCManager()
    manager.start()

    assert len(created_threads) == 1
    assert created_threads[0].name == "gsm-discord-actor"
    assert created_threads[0].daemon is True
    assert created_threads[0].started is True


def _live_session(monkeypatch, session_gap_seconds):
    stats_config = StatsConfig(session_gap_seconds=session_gap_seconds)
    monkeypatch.setattr(live_stats, "get_stats_config", lambda: stats_config)
    tracker = live_stats.LiveSessionTracker()
    for index in range(5):
        tracker.add_line("あ" * 20, 1000.0 + index * 10, line_id=f"line-{index}")
    tracker.times_mined = 2
    monkeypatch.setattr(discord_rpc, "live_stats_tracker", tracker)
    return tracker


@pytest.mark.parametrize("session_gap_seconds", [600, 1800, 7200])
@pytest.mark.parametrize("gap_offset", [-1, 0, 1])
def test_discord_inactivity_preserves_stats_until_configured_session_gap(monkeypatch, session_gap_seconds, gap_offset):
    tracker = _live_session(monkeypatch, session_gap_seconds)
    before = live_stats.build_live_stats_payload(tracker, now=1040.0)
    scheduler = SchedulerActor(monotonic_ns=lambda: 0)
    released_schedulers = []
    monkeypatch.setattr(
        discord_rpc,
        "get_master_config",
        lambda: SimpleNamespace(discord=SimpleNamespace(enabled=True, inactivity_timer=300)),
    )
    monkeypatch.setattr(discord_rpc, "acquire_runtime_scheduler", lambda: scheduler)
    monkeypatch.setattr(discord_rpc, "release_runtime_scheduler", released_schedulers.append)
    manager = discord_rpc.DiscordRPCManager()
    manager.running = True
    manager.start_time = 1000
    manager.update("Test game")

    assert scheduler.run_due(now_ns=299 * 1_000_000_000) == 0
    assert manager.running is True
    assert scheduler.run_due(now_ns=300 * 1_000_000_000) == 1
    assert manager.running is False
    assert manager.last_game_name is None
    assert manager.start_time is None
    assert released_schedulers == [scheduler]
    assert live_stats.build_live_stats_payload(tracker, now=1040.0) == before

    # Returning within the stats gap continues the session, including its
    # pending line. Returning after that gap starts a fresh session.
    resumed_at = 1040.0 + session_gap_seconds + gap_offset
    tracker.add_line("Resumed reading", resumed_at, line_id="resumed")
    if gap_offset <= 0:
        assert tracker.session_start_time == 1000.0
        assert tracker.lines_count == 6
        assert tracker.get_total_chars() == 100
        assert tracker.get_cards_mined() == 2
        assert tracker.get_active_reading_time() > before["values"]["active_reading_time"]
        assert tracker.get_raw_reading_time() == resumed_at - 1000.0
    else:
        assert tracker.session_start_time == resumed_at
        assert tracker.lines_count == 1
        assert tracker.get_total_chars() == 0
        assert tracker.get_cards_mined() == 0
        assert tracker.get_active_reading_time() == 0
        assert tracker.get_raw_reading_time() == 0


@pytest.mark.parametrize("disable_discord", [False, True])
def test_stopping_discord_preserves_live_stats(monkeypatch, disable_discord):
    tracker = _live_session(monkeypatch, 1800)
    before = live_stats.build_live_stats_payload(tracker, now=1040.0)
    manager = discord_rpc.DiscordRPCManager()
    manager.running = True

    if disable_discord:
        monkeypatch.setattr(
            discord_rpc,
            "get_master_config",
            lambda: SimpleNamespace(discord=SimpleNamespace(enabled=False)),
        )
        manager.update("Test game")
    else:
        manager.stop()

    assert manager.running is False
    assert live_stats.build_live_stats_payload(tracker, now=1040.0) == before
