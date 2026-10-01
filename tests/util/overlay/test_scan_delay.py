import pytest

from GameSentenceMiner.util.overlay.scan_delay import AdaptiveOverlayScanDelay, OverlayScanTiming


def observe(*frames):
    timing = OverlayScanTiming(reference="expected sentence")
    for captured_at, text in frames:
        timing.observe(text, captured_at=captured_at)
    return timing


def test_confirmed_late_sentence_moves_first_capture_back_in_small_steps():
    delay = AdaptiveOverlayScanDelay()
    delay.use_context(("game", "hook"))

    for index in range(5):
        for _ in range(2):
            delay.record(observe((0.0, "前の台詞"), (0.8, "speaker expected sentence")))
            assert delay.delay == pytest.approx(index * 0.005)
        delay.record(observe((0.0, "前の台詞"), (0.8, "speaker expected sentence")))
        assert delay.delay == pytest.approx((index + 1) * 0.005)


@pytest.mark.parametrize(
    "intervening_frames",
    [
        [(0.0, "expected sentence")],
        [(0.0, ""), (0.2, "")],
        [(0.0, "expected sentenc"), (0.2, "expected sentence")],
    ],
)
def test_three_late_reveals_out_of_five_need_not_be_consecutive(intervening_frames):
    delay = AdaptiveOverlayScanDelay()
    for _ in range(2):
        delay.record(observe((0.0, ""), (0.2, "expected sentence")))
        delay.record(observe(*intervening_frames))
        assert delay.delay == 0

    delay.record(observe((0.0, ""), (0.2, "expected sentence")))
    assert delay.delay == pytest.approx(0.005)

    # A bump consumes the evidence, so the next two late lines are not enough.
    for _ in range(2):
        delay.record(observe((0.0, ""), (0.2, "expected sentence")))
        assert delay.delay == pytest.approx(0.005)
    delay.record(observe((0.0, ""), (0.2, "expected sentence")))
    assert delay.delay == pytest.approx(0.01)


@pytest.mark.parametrize(
    "intervening_frames",
    [
        [(0.0, "expected sentence")],
        [(0.0, ""), (0.2, "")],
        [(0.0, "expected sentenc"), (0.2, "expected sentence")],
    ],
)
def test_late_reveals_older_than_five_lines_do_not_count(intervening_frames):
    delay = AdaptiveOverlayScanDelay()
    for _ in range(2):
        delay.record(observe((0.0, ""), (0.2, "expected sentence")))
    for _ in range(3):
        delay.record(observe(*intervening_frames))
    for _ in range(2):
        delay.record(observe((0.0, ""), (0.2, "expected sentence")))
        assert delay.delay == 0
    delay.record(observe((0.0, ""), (0.2, "expected sentence")))
    assert delay.delay == pytest.approx(0.005)


@pytest.mark.parametrize(
    "frames",
    [
        [(0.0, ""), (0.2, "")],
        [(0.0, "unrelated HUD"), (1.5, "unrelated HUD")],
        [(0.0, "expected sentenc"), (0.2, "expected sentence")],
        [(0.0, ""), (0.2, "ex"), (0.4, "expected sentence")],
        [(0.0, "expected sentense"), (0.2, "expected sentence")],
        [(0.0, ""), (0.0, "expected sentence")],
    ],
)
def test_uncertain_reads_and_typewriter_progress_do_not_add_delay(frames):
    delay = AdaptiveOverlayScanDelay()
    for _ in range(5):
        delay.record(observe(*frames))

    assert delay.delay == 0


def test_delay_eases_down_only_after_repeated_first_capture_successes():
    delay = AdaptiveOverlayScanDelay()
    for _ in range(3):
        delay.record(observe((0, ""), (0.2, "expected sentence")))
    for _ in range(7):
        delay.record(observe((0.1, "expected sentence")))
        assert delay.delay == pytest.approx(0.005)
    delay.record(observe((0.1, "expected sentence")))

    assert delay.delay == 0
    for _ in range(40):
        delay.record(observe((0.1, "expected sentence")))
    assert delay.delay == 0


def test_delay_is_bounded_and_does_not_use_ocr_finish_time_as_render_latency():
    delay = AdaptiveOverlayScanDelay()
    for _ in range(100):
        delay.record(observe((0, ""), (30, "expected sentence")))
    assert delay.delay == 0.15


@pytest.mark.parametrize("visible", ["", "a", "ab", "st", "話者abメニュー"])
def test_at_most_ten_percent_of_the_expected_line_counts_toward_a_small_increase(visible):
    delay = AdaptiveOverlayScanDelay()
    timing = OverlayScanTiming(reference="abcdefghijklmnopqrst")
    timing.observe(visible, captured_at=0)
    timing.observe("abcdefghijklmnopqrst", captured_at=0.2)
    for _ in range(2):
        delay.record(timing)
        assert delay.delay == 0
    delay.record(timing)

    assert delay.delay == pytest.approx(0.005)
    assert timing.first_match_ratio <= 0.1
    assert timing.outcome == "late_reveal"


@pytest.mark.parametrize(
    "visible",
    [
        "cde",  # 15% is already too much to treat as an almost empty capture.
        "klmnopqrst",  # Half the line is visible, but the old prefix guard missed it.
        "Xbcdefghijklmnopqrst",  # A single OCR mistake at the beginning.
        "aXcdYfgZijQlmRopStuV",  # Several misreads among otherwise visible text.
        "話者cdefghijklmnopqrstメニュー",  # HUD text must not dilute line coverage.
    ],
)
def test_substantial_line_coverage_does_not_increase_delay_even_without_the_prefix(visible):
    delay = AdaptiveOverlayScanDelay()
    timing = OverlayScanTiming(reference="abcdefghijklmnopqrst")
    timing.observe(visible, captured_at=0)
    timing.observe("abcdefghijklmnopqrst", captured_at=0.2)
    for _ in range(5):
        delay.record(timing)

    assert delay.delay == 0
    assert timing.first_match_ratio > 0.1
    assert timing.outcome == "partial_text"


def test_scan_summary_reports_the_initial_expected_line_match_percentage():
    timing = OverlayScanTiming(reference="abcdefghijklmnopqrst")
    timing.observe("ab", captured_at=1.0)
    timing.observe(timing.reference, captured_at=1.2)

    summary = timing.summary(requested_at=1.0, initial_delay=0, next_delay=0.005)
    assert "initial match: 10%" in summary
    assert "initial delay: 0ms -> 5ms" in summary


def test_switching_game_or_hook_discards_learned_delay():
    delay = AdaptiveOverlayScanDelay()
    delay.use_context(("game", "hook"))
    for _ in range(3):
        delay.record(observe((0, ""), (0.2, "expected sentence")))
    delay.use_context(("game", "hook"))
    assert delay.delay > 0

    delay.use_context(("other game", "hook"))
    assert delay.delay == 0
    for _ in range(3):
        delay.record(observe((0, ""), (0.2, "expected sentence")))
    delay.use_context(("other game", "other hook"))
    assert delay.delay == 0


@pytest.mark.parametrize("context", [("other game", "hook"), ("game", "other hook")])
def test_switching_game_or_hook_discards_pending_late_reveals(context):
    delay = AdaptiveOverlayScanDelay()
    delay.use_context(("game", "hook"))
    for _ in range(2):
        delay.record(observe((0, ""), (0.2, "expected sentence")))

    delay.use_context(context)
    for _ in range(2):
        delay.record(observe((0, ""), (0.2, "expected sentence")))
        assert delay.delay == 0
    delay.use_context(context)
    delay.record(observe((0, ""), (0.2, "expected sentence")))
    assert delay.delay == pytest.approx(0.005)


@pytest.mark.parametrize("reference", ["", "a", "ab"])
def test_short_or_missing_reference_does_not_provide_timing_evidence(reference):
    delay = AdaptiveOverlayScanDelay()
    timing = OverlayScanTiming(reference=reference)
    timing.observe("", captured_at=0)
    timing.observe(reference, captured_at=0.2)
    delay.record(timing)
    assert delay.delay == 0
