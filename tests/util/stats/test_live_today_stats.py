from datetime import datetime, timedelta
from types import SimpleNamespace

import pytest

from GameSentenceMiner.util.database.db import GameLinesTable, SQLiteDB
from GameSentenceMiner.util.stats import live_stats
from GameSentenceMiner.web import stats, stats_repository


@pytest.fixture(autouse=True)
def daily_stats_database(monkeypatch):
    original_db = GameLinesTable._db
    db = SQLiteDB(":memory:")
    GameLinesTable.set_db(db)
    config = SimpleNamespace(
        session_gap_seconds=1800,
        day_rollover_hour=4,
        regex_out_repetitions=False,
        extra_punctuation_regex="",
    )
    for module in (live_stats, stats, stats_repository):
        monkeypatch.setattr(module, "get_stats_config", lambda: config)
    monkeypatch.setattr(live_stats, "publish_live_stats_update", lambda *args, **kwargs: False)
    monkeypatch.setattr("GameSentenceMiner.util.database.game_archive.archived_stats_lines", lambda *args: [])
    yield config
    db.close()
    GameLinesTable._db = original_db


def save_line(line_id, text, timestamp, **kwargs):
    GameLinesTable(id=line_id, game_name="Game", line_text=text, timestamp=timestamp, **kwargs).add()


def local_time(hour):
    # Stats days intentionally follow the machine's local calendar.
    return datetime(2026, 10, 5, hour).astimezone()


def test_today_restores_persisted_totals_across_sessions_and_backend_restarts():
    start = local_time(9).timestamp()
    for session in range(2):
        for index in range(5):
            save_line(
                f"{session}-{index}",
                "あ" * 20,
                start + session * 3600 + index * 10,
                note_ids=["one", "two"] if session == 0 and index == 0 else [],
            )
    now = start + 7200
    # A new tracker represents a backend restart: the session starts empty.
    tracker = live_stats.LiveSessionTracker()
    payload = live_stats.build_today_live_stats_payload(tracker, now=now)

    assert payload["type"] == "live_stats_update"
    assert payload["scope"] == "today"
    assert payload["session_active"] is False
    assert payload["values"] == {
        "chars_per_hour": 9000,
        "total_characters": 200,
        "active_reading_time": 80.0,
        "raw_reading_time": 80.0,
        "cards_mined": 2,
    }
    assert live_stats.build_live_stats_payload(tracker, now=now)["values"]["total_characters"] == 0


@pytest.mark.parametrize("rollover_hour", [0, 4, 6, 23])
@pytest.mark.parametrize("offset_seconds", [-1, 0, 1])
def test_today_uses_configured_local_cutover(daily_stats_database, rollover_hour, offset_seconds):
    daily_stats_database.day_rollover_hour = rollover_hour
    cutover = local_time(rollover_hour)
    yesterday = cutover - timedelta(days=1)
    tomorrow = cutover + timedelta(days=1)
    save_line("before-window", "excluded", yesterday.timestamp() - 1)
    save_line("previous-day", "あ" * 10, cutover.timestamp() - 1)
    save_line("at-cutover", "あ" * 20, cutover.timestamp())
    save_line("future", "excluded", tomorrow.timestamp())
    now = cutover.timestamp() + offset_seconds

    payload = live_stats.build_today_live_stats_payload(live_stats.LiveSessionTracker(), now=now)

    assert payload["values"]["total_characters"] == (10 if offset_seconds < 0 else 20)
    assert payload["period_start"] == (yesterday if offset_seconds < 0 else cutover).timestamp()
    assert payload["period_end"] == (cutover if offset_seconds < 0 else tomorrow).timestamp()


def test_today_combines_saved_history_with_live_revisions_without_duplicates():
    start = local_time(9).timestamp()
    save_line("one", "old", start, note_ids=["card"])
    tracker = live_stats.LiveSessionTracker()
    tracker.add_line("old", start, line_id="one")
    tracker.add_line("pending", start + 10, line_id="two")
    tracker.add_line("revised!!!", start, line_id="one", revision=2)

    payload = live_stats.build_today_live_stats_payload(tracker, now=start + 15)

    assert payload["values"]["total_characters"] == len("revisedpending")
    assert payload["values"]["cards_mined"] == 1
    assert payload["values"]["active_reading_time"] == 10.0
    assert payload["values"]["raw_reading_time"] == 15.0
    assert payload["session_active"] is True
    assert payload["updated_at"] == start + 15


def test_today_retains_totals_after_idle_reset_and_excludes_breaks():
    start = local_time(9).timestamp()
    tracker = live_stats.LiveSessionTracker()
    for index in range(5):
        timestamp = start + index * 10
        text = "あ" * 20
        save_line(str(index), text, timestamp)
        tracker.add_line(text, timestamp, line_id=str(index))
    assert tracker.reset_if_inactive(now=start + 1841)

    payload = live_stats.build_today_live_stats_payload(tracker, now=start + 7200)

    assert payload["values"]["total_characters"] == 100
    assert payload["values"]["raw_reading_time"] == 40.0
    assert payload["values"]["active_reading_time"] == 40.0
    assert payload["session_active"] is False


def test_today_resets_at_cutover_during_an_active_session():
    cutover = local_time(4).timestamp()
    tracker = live_stats.LiveSessionTracker()
    tracker.add_line("old day", cutover - 20, line_id="one")
    tracker.add_line("still old", cutover - 10, line_id="two")

    payload = live_stats.build_today_live_stats_payload(tracker, now=cutover)

    assert payload["session_active"] is False
    assert all(value == 0 for value in payload["values"].values())
    tracker.add_line("new day", cutover + 10, line_id="three")
    payload = live_stats.build_today_live_stats_payload(tracker, now=cutover + 15)
    assert payload["values"]["total_characters"] == len("newday")
    assert payload["values"]["active_reading_time"] == 0.0
    assert payload["values"]["raw_reading_time"] == 5.0


def test_today_reloads_mined_cards_from_database():
    start = local_time(9).timestamp()
    save_line("one", "reading", start)
    tracker = live_stats.LiveSessionTracker()
    assert live_stats.build_today_live_stats_payload(tracker, now=start + 60)["values"]["cards_mined"] == 0

    GameLinesTable.update(line_id="one", note_id="card")

    assert live_stats.build_today_live_stats_payload(tracker, now=start + 60)["values"]["cards_mined"] == 1
