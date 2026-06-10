from GameSentenceMiner.util.stats.live_stats import (
    LiveSessionTracker,
    build_live_stats_payload,
    get_live_stats_field_options,
)


def test_live_stats_snapshot_contains_current_session_values():
    tracker = LiveSessionTracker()
    tracker.total_characters = 120
    tracker.total_reading_seconds = 60.0
    tracker.times_mined = 2
    tracker.session_start_time = 1000.0
    tracker.last_line_time = 1060.0

    payload = build_live_stats_payload(tracker, reason="test", now=1070.0)

    assert payload["type"] == "live_stats_update"
    assert payload["reason"] == "test"
    assert payload["session_active"] is True
    assert payload["updated_at"] == 1070.0
    assert payload["values"] == {
        "chars_per_hour": 7200,
        "total_characters": 120,
        "active_reading_time": 60.0,
        "raw_reading_time": 60.0,
        "cards_mined": 2,
    }
    assert [field["key"] for field in payload["fields"]] == [
        "chars_per_hour",
        "total_characters",
        "active_reading_time",
        "raw_reading_time",
        "cards_mined",
    ]


def test_raw_reading_time_is_wall_clock_not_afk_capped():
    tracker = LiveSessionTracker()
    tracker.session_start_time = 1000.0
    tracker.last_line_time = 5000.0  # 4000s wall clock
    tracker.total_reading_seconds = 90.0  # AFK-capped active time

    payload = build_live_stats_payload(tracker, reason="test", now=5000.0)

    assert payload["values"]["active_reading_time"] == 90.0
    assert payload["values"]["raw_reading_time"] == 4000.0


def test_raw_reading_time_zero_without_session():
    tracker = LiveSessionTracker()
    payload = build_live_stats_payload(tracker, reason="test", now=1070.0)

    assert payload["session_active"] is False
    assert payload["values"]["raw_reading_time"] == 0.0


def test_raw_reading_time_resets_on_session_gap():
    from GameSentenceMiner.util.config.configuration import get_stats_config

    gap = get_stats_config().session_gap_seconds

    tracker = LiveSessionTracker()
    tracker.add_line("first session", 1000.0)
    tracker.add_line("still first", 1010.0)

    # A gap larger than the session gap starts a fresh session.
    new_start = 1010.0 + gap + 1
    tracker.add_line("new session", new_start)

    assert tracker.session_start_time == new_start
    assert tracker.get_raw_reading_time() == 0.0

    tracker.add_line("new session continues", new_start + 30)
    assert tracker.get_raw_reading_time() == 30.0


def test_live_stats_field_options_are_copied():
    fields = get_live_stats_field_options()
    fields[0]["label"] = "Changed"

    assert get_live_stats_field_options()[0]["label"] == "Chars/hour"
