import math
from unittest.mock import Mock

import pytest

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


@pytest.mark.parametrize("paused", [False, True])
def test_live_stats_snapshot_includes_intake_state_before_any_text(monkeypatch, paused):
    from GameSentenceMiner.util.config.configuration import gsm_state

    monkeypatch.setattr(gsm_state, "text_input_paused", paused)
    payload = build_live_stats_payload(LiveSessionTracker(), reason="connect")

    assert payload["text_intake_paused"] is paused
    assert payload["session_active"] is False


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


def _mock_stats_config(monkeypatch, **overrides):
    from types import SimpleNamespace

    import GameSentenceMiner.util.stats.live_stats as live_mod

    settings = {
        "session_gap_seconds": 1800,
        "regex_out_repetitions": False,
        "extra_punctuation_regex": "",
        **overrides,
    }
    stats_config = SimpleNamespace(**settings)
    monkeypatch.setattr(live_mod, "get_stats_config", lambda: stats_config)
    return stats_config


def test_switching_games_starts_a_new_session_without_crediting_previous_game(monkeypatch):
    _mock_stats_config(monkeypatch)
    tracker = LiveSessionTracker()
    tracker.add_line("あ" * 20, 1000.0, line_id="one", game_name="First Game")
    tracker.add_line("あ" * 20, 1010.0, line_id="two", game_name="First Game")
    tracker.add_mined_line()
    tracker.add_line("new game", 1020.0, line_id="three", game_name="Second Game")

    payload = build_live_stats_payload(tracker, now=1020.0)
    assert payload["game_name"] == "Second Game"
    assert tracker.lines_count == 1
    assert tracker.session_start_time == 1020.0
    assert all(value == 0 for value in payload["values"].values())


def test_game_change_publishes_an_empty_session_before_the_next_line(monkeypatch):
    import GameSentenceMiner.util.stats.live_stats as live_mod

    _mock_stats_config(monkeypatch)
    publish = Mock()
    monkeypatch.setattr(live_mod, "publish_live_stats_update", publish)
    tracker = LiveSessionTracker()
    tracker.add_line("reading", 1000.0, line_id="one", game_name="First Game")
    publish.reset_mock()

    assert tracker.set_game("Second Game") is True
    assert tracker.set_game("Second Game") is False
    publish.assert_called_once_with(tracker, reason="game_changed")
    assert tracker.game_name == "Second Game"
    assert tracker.last_line_time is None
    assert tracker.get_live_lines() == []


def test_delayed_mining_from_previous_game_does_not_count_for_current_game(monkeypatch):
    _mock_stats_config(monkeypatch)
    tracker = LiveSessionTracker()
    tracker.add_line("reading", 1000.0, line_id="one", game_name="First Game")
    tracker.set_game("Second Game")
    tracker.add_mined_line(game_name="First Game")
    assert tracker.get_cards_mined() == 0
    tracker.add_mined_line(game_name="Second Game")
    assert tracker.get_cards_mined() == 1


@pytest.mark.parametrize("session_gap_seconds", [600, 1800, 7200])
@pytest.mark.parametrize("gap_offset", [-1, 0, 1])
def test_idle_session_resets_only_after_configured_gap(monkeypatch, session_gap_seconds, gap_offset):
    import GameSentenceMiner.util.stats.live_stats as live_mod

    _mock_stats_config(monkeypatch, session_gap_seconds=session_gap_seconds)
    publish = Mock()
    monkeypatch.setattr(live_mod, "publish_live_stats_update", publish)
    tracker = LiveSessionTracker()
    for index in range(5):
        tracker.add_line("あ" * 20, 1000.0 + index * 10, line_id=f"line-{index}")
    tracker.times_mined = 2
    before = build_live_stats_payload(tracker, now=1040.0)
    publish.reset_mock()

    expired = tracker.reset_if_inactive(now=1040.0 + session_gap_seconds + gap_offset)

    assert expired is (gap_offset > 0)
    if gap_offset <= 0:
        assert build_live_stats_payload(tracker, now=1040.0) == before
        publish.assert_not_called()
    else:
        payload = build_live_stats_payload(tracker, now=1040.0)
        assert payload["session_active"] is False
        assert payload["session_start_time"] is None
        assert payload["last_line_time"] is None
        assert all(value == 0 for value in payload["values"].values())
        assert tracker.last_line_text is None
        assert tracker.last_line_chars == 0
        assert tracker.lines_count == 0
        assert tracker.last_line_id is None
        assert tracker._line_ledger == {}
        assert tracker._reading_gaps == []
        assert tracker._reading_breaks == []
        publish.assert_called_once_with(tracker, reason="session_timeout")


def test_idle_session_publishes_reset_once_and_next_line_starts_fresh(monkeypatch):
    import GameSentenceMiner.util.stats.live_stats as live_mod

    _mock_stats_config(monkeypatch)
    publish = Mock()
    monkeypatch.setattr(live_mod, "publish_live_stats_update", publish)
    tracker = LiveSessionTracker()
    tracker.add_line("old session", 1000.0, line_id="one")
    tracker.add_line("last line", 1010.0, line_id="two")
    publish.reset_mock()

    assert tracker.reset_if_inactive(now=2811.0) is True
    assert tracker.reset_if_inactive(now=3000.0) is False
    publish.assert_called_once_with(tracker, reason="session_timeout")

    # Resetting also clears the revision ledger and the pending line's credit.
    tracker.add_line("fresh session", 3010.0, line_id="one")
    assert tracker.session_start_time == 3010.0
    assert tracker.lines_count == 1
    assert tracker.get_total_chars() == 0
    assert tracker.get_active_reading_time() == 0
    assert tracker.get_raw_reading_time() == 0
    assert tracker.reset_if_inactive(now=3011.0) is False


def test_idle_session_check_uses_current_gap_setting(monkeypatch):
    config = _mock_stats_config(monkeypatch, session_gap_seconds=600)
    tracker = LiveSessionTracker()
    tracker.add_line("reading", 1000.0)

    config.session_gap_seconds = 1800
    assert tracker.reset_if_inactive(now=1601.0) is False
    config.session_gap_seconds = 600
    assert tracker.reset_if_inactive(now=1601.0) is True


def test_revisions_and_mining_do_not_extend_idle_session(monkeypatch):
    _mock_stats_config(monkeypatch)
    tracker = LiveSessionTracker()
    tracker.add_line("first", 1000.0, line_id="one")
    tracker.add_line("last", 1010.0, line_id="two")
    tracker.add_line("revised", 1000.0, line_id="one", revision=2)
    tracker.add_mined_line()

    assert tracker.reset_if_inactive(now=2811.0) is True
    assert tracker.get_cards_mined() == 0


def test_empty_session_does_not_publish_idle_resets(monkeypatch):
    import GameSentenceMiner.util.stats.live_stats as live_mod

    publish = Mock()
    monkeypatch.setattr(live_mod, "publish_live_stats_update", publish)

    assert LiveSessionTracker().reset_if_inactive(now=10000.0) is False
    publish.assert_not_called()


@pytest.mark.parametrize("legacy_settings", [{}, {"reading_time_adaptive_v2": False}])
def test_short_line_after_afk_uses_session_pace(monkeypatch, legacy_settings):
    _mock_stats_config(monkeypatch, **legacy_settings)

    tracker = LiveSessionTracker()
    # Establish a ~2 cps reading pace across several 20-char lines.
    for i in range(5):
        tracker.add_line("あ" * 20, 1000.0 + i * 10)
    # A 1-char line, then a long (but sub-gap) AFK before the next line.
    tracker.add_line("x", 1050.0)
    before = tracker.total_reading_seconds
    tracker.add_line("next", 1350.0)  # 300s gap after the 1-char line

    # The 1-char line gets the two-second minimum cap at this pace.
    assert tracker.total_reading_seconds - before == 2.0


@pytest.mark.parametrize("legacy_settings", [{}, {"reading_time_adaptive_v2": False}])
def test_cph_guard_blocks_spike_until_enough_lines(monkeypatch, legacy_settings):
    _mock_stats_config(monkeypatch, **legacy_settings)

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


def test_short_line_without_session_pace_uses_adaptive_fallback(monkeypatch):
    _mock_stats_config(monkeypatch)

    tracker = LiveSessionTracker()
    tracker.add_line("ab", 1000.0)
    tracker.add_line("next", 1060.0)
    assert tracker.total_reading_seconds == 6.0


def test_revising_a_credited_line_adjusts_character_ledger(monkeypatch):
    _mock_stats_config(monkeypatch)
    tracker = LiveSessionTracker()
    tracker.add_line("old", 1000.0, line_id="one", revision=1)
    tracker.add_line("next", 1010.0, line_id="two", revision=1)
    original_total = tracker.total_characters

    tracker.add_line("correctedtext", 1000.0, line_id="one", revision=2)
    tracker.add_line("ignored stale revision", 1000.0, line_id="one", revision=1)

    assert tracker.total_characters == original_total - len("old") + len("correctedtext")
    assert tracker.lines_count == 2


def test_backward_wall_clock_step_never_creates_negative_reading_time(monkeypatch):
    _mock_stats_config(monkeypatch)
    tracker = LiveSessionTracker()
    tracker.add_line("first", 1000.0, line_id="one")
    tracker.add_line("second", 990.0, line_id="two")

    assert tracker.total_reading_seconds == 0
    assert tracker.get_raw_reading_time() == 0


def test_repeated_long_pauses_do_not_slow_the_learned_pace(monkeypatch):
    _mock_stats_config(monkeypatch)
    tracker = LiveSessionTracker()
    for i in range(5):
        tracker.add_line("あ" * 20, 1000.0 + i * 10)
    for i in range(1, 9):
        tracker.add_line("あ" * 20, 1040.0 + i * 600)

    assert tracker.total_reading_seconds == 40.0 + 8 * 25.0


@pytest.mark.parametrize("text, expected_seconds", [("あ" * 20 + "!" * 80, 25.0), ("...!?", 0.0)])
def test_caps_use_the_same_cleaned_characters_as_reading_speed(monkeypatch, text, expected_seconds):
    _mock_stats_config(monkeypatch)
    tracker = LiveSessionTracker()
    for i in range(5):
        tracker.add_line("あ" * 20, 1000.0 + i * 10)
    tracker.add_line(text, 1050.0)
    before = tracker.total_reading_seconds
    tracker.add_line("next", 1650.0)

    assert tracker.total_reading_seconds - before == expected_seconds


def test_slower_reading_can_retrain_the_live_pace(monkeypatch):
    _mock_stats_config(monkeypatch)
    tracker = LiveSessionTracker()
    for i in range(5):
        tracker.add_line("あ" * 20, 1000.0 + i * 10)
    for i in range(1, 7):
        tracker.add_line("あ" * 20, 1040.0 + i * 60)
    before = tracker.total_reading_seconds
    tracker.add_line("あ" * 20, 1460.0)

    assert tracker.total_reading_seconds - before == 60.0


def test_live_and_batch_use_the_same_pace_sample_filters(monkeypatch):
    from GameSentenceMiner.web.stats import calculate_actual_reading_time

    _mock_stats_config(monkeypatch)
    timestamps = [1000.0 + i * 10 for i in range(5)]
    timestamps += [1040.0 + i * 0.01 for i in range(1, 21)]
    timestamps += [1050.2, 1650.2]
    texts = ["あ" * 20] * len(timestamps)
    tracker = LiveSessionTracker()
    for timestamp, text in zip(timestamps, texts):
        tracker.add_line(text, timestamp)

    assert tracker.total_reading_seconds == pytest.approx(75.2)
    assert tracker.total_reading_seconds == pytest.approx(calculate_actual_reading_time(timestamps, texts))


@pytest.mark.parametrize("gaps", [[10.0] * 10 + [60.0] * 11, [60.0] * 11 + [10.0] * 10, [120.0, 10.0]])
def test_live_reading_time_matches_batch_after_every_pace_change(monkeypatch, gaps):
    from GameSentenceMiner.web import stats

    config = _mock_stats_config(monkeypatch)
    monkeypatch.setattr(stats, "get_stats_config", lambda: config)
    tracker = LiveSessionTracker()
    timestamps = [1000.0]
    texts = ["あ" * 20]
    tracker.add_line(texts[0], timestamps[0])
    for gap in gaps:
        timestamps.append(timestamps[-1] + gap)
        texts.append("あ" * 20)
        tracker.add_line(texts[-1], timestamps[-1])
        assert tracker.get_active_reading_time() == pytest.approx(
            stats.calculate_actual_reading_time(timestamps, texts)
        )


def test_revising_completed_text_recalculates_the_pace_and_time(monkeypatch):
    from GameSentenceMiner.web import stats

    config = _mock_stats_config(monkeypatch)
    monkeypatch.setattr(stats, "get_stats_config", lambda: config)
    tracker = LiveSessionTracker()
    timestamps = [1000.0, 1100.0, 1110.0, 1120.0, 1720.0]
    texts = ["あ" * 20] * len(timestamps)
    texts[0] = "あ" * 3
    for index, timestamp in enumerate(timestamps):
        tracker.add_line(texts[index], timestamp, line_id=str(index))

    texts[0] = "あ" * 200
    tracker.add_line(texts[0], timestamps[0], line_id="0", revision=2)

    assert tracker.get_active_reading_time() == pytest.approx(stats.calculate_actual_reading_time(timestamps, texts))
    assert tracker.get_total_chars() == 260


def test_pause_gap_is_neither_credited_nor_used_to_learn_pace(monkeypatch):
    from GameSentenceMiner.web import stats

    config = _mock_stats_config(monkeypatch)
    monkeypatch.setattr(stats, "get_stats_config", lambda: config)
    tracker = LiveSessionTracker()
    timestamps = [1000.0, 1010.0, 1130.0, 1250.0, 1370.0, 1970.0]
    breaks = [1020.0, 1140.0, 1260.0]
    texts = ["あ" * 20] * len(timestamps)
    for index, timestamp in enumerate(timestamps):
        if 2 <= index <= 4:
            tracker.mark_reading_break(breaks[index - 2])
        tracker.add_line(texts[index], timestamp, line_id=str(index))

    # Three interrupted gaps must not replace the established 2 cps pace.
    assert tracker.get_active_reading_time() == 10.0 + 25.0
    assert tracker.get_active_reading_time() == stats.calculate_actual_reading_time(
        timestamps, texts, reading_breaks=breaks
    )


def test_pause_before_first_line_does_not_discard_resumed_reading(monkeypatch):
    _mock_stats_config(monkeypatch)
    tracker = LiveSessionTracker()
    tracker.mark_reading_break(900.0)
    tracker.add_line("あ" * 20, 1000.0)
    tracker.add_line("あ" * 20, 1010.0)
    assert tracker.get_active_reading_time() == 10.0


def test_queued_text_before_pause_keeps_its_measured_reading_time(monkeypatch):
    _mock_stats_config(monkeypatch)
    tracker = LiveSessionTracker()
    tracker.add_line("あ" * 20, 1000.0)
    tracker.mark_reading_break(1020.0)
    # A delayed projection still belongs to the uninterrupted part of the session.
    tracker.add_line("あ" * 20, 1010.0)
    tracker.add_line("あ" * 20, 1130.0)
    tracker.add_line("あ" * 20, 1140.0)
    assert tracker.get_active_reading_time() == 20.0


def test_timestamp_zero_is_a_valid_session_start(monkeypatch):
    _mock_stats_config(monkeypatch)
    tracker = LiveSessionTracker()
    tracker.add_line("あ" * 20, 0.0)
    tracker.add_line("あ" * 20, 10.0)

    assert tracker.total_reading_seconds == 10.0
    assert tracker.total_characters == 20
    assert tracker.session_start_time == 0.0


@pytest.mark.parametrize("invalid_timestamp", [math.nan, math.inf, -math.inf])
def test_invalid_timestamps_do_not_poison_live_stats(monkeypatch, invalid_timestamp):
    _mock_stats_config(monkeypatch)
    tracker = LiveSessionTracker()
    tracker.add_line("あ" * 20, 1000.0)
    tracker.add_line("あ" * 20, invalid_timestamp)
    tracker.add_line("あ" * 20, 1010.0)

    assert tracker.total_reading_seconds == 10.0
    assert tracker.total_characters == 20
    assert tracker.lines_count == 2
