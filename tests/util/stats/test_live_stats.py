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
    tracker.lines_count = 5

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


def test_characters_credited_one_line_late():
    # A line's characters are not counted until the next line arrives, so a
    # huge line can't spike read speed the instant it appears.
    tracker = LiveSessionTracker()
    tracker.add_line("あ" * 10, 1000.0)
    assert tracker.total_characters == 0  # nothing credited yet

    tracker.add_line("あ" * 500, 1005.0)  # huge line, but first is now credited
    assert tracker.total_characters == 10

    tracker.add_line("あ" * 3, 1010.0)  # now the huge line gets credited
    assert tracker.total_characters == 10 + 500


def test_live_stats_field_options_are_copied():
    fields = get_live_stats_field_options()
    fields[0]["label"] = "Changed"

    assert get_live_stats_field_options()[0]["label"] == "Chars/hour"


def _enable_v2(monkeypatch):
    from types import SimpleNamespace
    import GameSentenceMiner.util.stats.live_stats as live_mod

    monkeypatch.setattr(
        live_mod,
        "get_stats_config",
        lambda: SimpleNamespace(
            reading_time_adaptive_v2=True,
            session_gap_seconds=1800,
            regex_out_repetitions=False,
            extra_punctuation_regex="",
        ),
    )


def test_v2_short_line_after_afk_costs_floor_not_15s(monkeypatch):
    _enable_v2(monkeypatch)

    tracker = LiveSessionTracker()
    # Establish a ~2 cps reading pace across several 20-char lines.
    for i in range(5):
        tracker.add_line("あ" * 20, 1000.0 + i * 10)
    # A 1-char line, then a long (but sub-gap) AFK before the next line.
    tracker.add_line("x", 1050.0)
    before = tracker.total_reading_seconds
    tracker.add_line("next", 1350.0)  # 300s gap after the 1-char line

    # The AFK gap is credited against the 1-char line → adaptive floor (2s),
    # not v1's 15s floor.
    assert tracker.total_reading_seconds - before == 2.0


def test_v2_cph_guard_blocks_spike_until_enough_lines(monkeypatch):
    _enable_v2(monkeypatch)

    tracker = LiveSessionTracker()
    # A couple of lines with a tiny denominator would otherwise read as a huge cph.
    tracker.add_line("あ" * 20, 1000.0)
    tracker.add_line("あ" * 20, 1006.0)
    assert tracker.lines_count < 5
    assert tracker.total_reading_seconds > 5  # would normally produce a cph
    assert tracker.get_chars_per_hour() == 0  # ...but the guard suppresses the spike

    # Once enough lines accrue, cph reports normally.
    for i in range(2, 6):
        tracker.add_line("あ" * 20, 1000.0 + i * 6)
    assert tracker.get_chars_per_hour() > 0


def test_v1_disabled_unchanged_floor(monkeypatch):
    from types import SimpleNamespace
    import GameSentenceMiner.util.stats.live_stats as live_mod

    monkeypatch.setattr(
        live_mod,
        "get_stats_config",
        lambda: SimpleNamespace(
            reading_time_adaptive_v2=False,
            session_gap_seconds=1800,
            regex_out_repetitions=False,
            extra_punctuation_regex="",
        ),
    )

    # With v2 off, a short line still uses the v1 15s floor.
    tracker = LiveSessionTracker()
    tracker.add_line("ab", 1000.0)
    tracker.add_line("next", 1060.0)
    assert tracker.total_reading_seconds == 15.0
