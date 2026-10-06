import math

import pytest
from hypothesis import given
from hypothesis import strategies as st

from GameSentenceMiner.util.stats.stats_util import adaptive_cap_seconds, session_median_cps


def test_line_gets_two_and_a_half_times_its_expected_time_at_the_actual_median():
    assert adaptive_cap_seconds(20, 2.0) == 25.0


def test_subsecond_delivery_bursts_cannot_dominate_the_reading_pace():
    gaps = [(10.0, 20)] * 3 + [(0.01, 20)] * 20
    assert session_median_cps(gaps) == 2.0


def test_gaps_above_the_credit_ceiling_cannot_dominate_the_reading_pace():
    gaps = [(10.0, 20)] * 3 + [(600.0, 20)] * 20
    assert session_median_cps(gaps) == 2.0


def test_slower_reading_still_teaches_the_pace_even_above_the_adaptive_cap():
    gaps = [(10.0, 20)] * 3 + [(60.0, 20)] * 5
    assert session_median_cps(gaps) == pytest.approx(1 / 3)


def test_minority_fast_and_slow_outliers_do_not_change_a_stable_pace():
    gaps = [(10.0, 20)] * 9 + [(1.0, 20)] * 3 + [(240.0, 20)] * 3
    assert session_median_cps(gaps) == 2.0


@pytest.mark.parametrize("gap", [0.0, -10.0, 0.01, 600.0, math.nan, math.inf, -math.inf])
def test_unusable_gaps_do_not_establish_a_pace(gap):
    assert session_median_cps([(gap, 20)]) == 0.0


@pytest.mark.parametrize("median_cps", [0.0, -2.0, math.nan, math.inf, -math.inf])
def test_invalid_pace_uses_the_finite_fallback(median_cps):
    assert adaptive_cap_seconds(10, median_cps) == 30.0


@pytest.mark.parametrize("char_count", [0, -1])
@pytest.mark.parametrize("median_cps", [0.0, 2.0])
def test_no_text_cannot_add_reading_time(char_count, median_cps):
    assert adaptive_cap_seconds(char_count, median_cps) == 0.0


@given(
    char_count=st.integers(min_value=1, max_value=10000),
    median_cps=st.floats(min_value=0.001, max_value=1000, allow_nan=False, allow_infinity=False),
)
def test_more_text_never_receives_a_smaller_cap(char_count, median_cps):
    cap = adaptive_cap_seconds(char_count, median_cps)
    assert 2.0 <= cap <= adaptive_cap_seconds(char_count * 2, median_cps) <= 300.0


@given(
    char_count=st.integers(min_value=1, max_value=10000),
    median_cps=st.floats(min_value=0.001, max_value=1000, allow_nan=False, allow_infinity=False),
)
def test_faster_pace_never_increases_the_time_cap(char_count, median_cps):
    assert adaptive_cap_seconds(char_count, median_cps * 2) <= adaptive_cap_seconds(char_count, median_cps)
