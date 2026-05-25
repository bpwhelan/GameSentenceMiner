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
        "cards_mined": 2,
    }
    assert [field["key"] for field in payload["fields"]] == [
        "chars_per_hour",
        "total_characters",
        "active_reading_time",
        "cards_mined",
    ]


def test_live_stats_field_options_are_copied():
    fields = get_live_stats_field_options()
    fields[0]["label"] = "Changed"

    assert get_live_stats_field_options()[0]["label"] == "Chars/hour"
