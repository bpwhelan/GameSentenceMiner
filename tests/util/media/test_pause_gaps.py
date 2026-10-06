import numpy as np
import pytest

from GameSentenceMiner.util.media import pause_gaps
from GameSentenceMiner.util.media.pause_gaps import AudioTimeline, ExpectedGap

SR = 48000


def _ramp(seconds: float) -> np.ndarray:
    """Stereo signal that is never zero and strictly increasing, so each sample identifies its source position."""
    n = int(seconds * SR)
    mono = (np.arange(n, dtype=np.float64) + 1) / n * 0.5 + 0.1
    return np.column_stack((mono, mono)).astype(np.float32)


def _silence(x: np.ndarray, start: float, end: float) -> None:
    x[int(start * SR) : int(end * SR)] = 0


def _codec_fades(x: np.ndarray, start: float, end: float, fade: float = 0.004) -> None:
    """Near-silent smear either side of a zero run, as a lossy codec leaves it."""
    f = int(fade * SR)
    x[int(start * SR) - f : int(start * SR)] = 1e-4
    x[int(end * SR) : int(end * SR) + f] = 1e-4


def _paused_recording():
    """10s recording: game paused 4.0-6.0s, with codec fades and a resume stutter.

    The recorded pause starts 1s earlier than the gap, as replay save latency makes it.
    """
    x = _ramp(10)
    _silence(x, 4.0, 6.0)
    _codec_fades(x, 4.0, 6.0)
    # Resume stutter: one 18ms buffer, then a 40ms underrun.
    _silence(x, 6.004 + 0.018, 6.004 + 0.018 + 0.040)
    _codec_fades(x, 6.004 + 0.018, 6.004 + 0.018 + 0.040, fade=0.002)
    return x, [ExpectedGap(offset=3.0, duration=2.0)]


def test_expected_gaps_clips_pauses_to_the_recording():
    end = 1000.0
    pauses = [(900.0, 950.0), (985.0, 987.5), (999.0, 1003.0), (1010.0, 1012.0), (989.0, 989.05)]
    gaps = pause_gaps.expected_gaps(pauses, recording_end=end, recording_length=20.0)
    assert gaps == [ExpectedGap(5.0, 2.5), ExpectedGap(19.0, 1.0)]


def test_back_to_back_pauses_are_removed_together():
    end = 100.0
    gaps = pause_gaps.expected_gaps([(83.0, 86.0), (86.2, 89.2)], recording_end=end, recording_length=20.0)

    x = _ramp(20)
    _silence(x, 4.0, 10.2)  # 3s pause, 0.2s of game silence, 3s pause
    _, timeline = pause_gaps.remove_pause_gaps(x, SR, gaps)
    assert timeline.removed_seconds == pytest.approx(6.2, abs=0.01)


def test_back_to_back_pauses_split_by_game_sound_are_removed_separately():
    gaps = pause_gaps.expected_gaps([(85.0, 88.0), (88.2, 91.2)], recording_end=100.0, recording_length=20.0)
    x = _ramp(20)
    _silence(x, 5.0, 8.0)
    _silence(x, 8.2, 11.2)  # the game played 200ms between the two pauses
    _, timeline = pause_gaps.remove_pause_gaps(x, SR, gaps)
    assert timeline.removed_seconds == pytest.approx(6.0, abs=0.01)


def test_a_short_pause_leaves_neighbouring_silence_alone():
    x = _ramp(20)
    _silence(x, 3.0, 4.0)  # a 1s pause, which pins the latency at 0
    _silence(x, 6.0, 6.08)  # the game's own short silence, just before the next pause
    _silence(x, 6.2, 6.32)  # a 0.12s pause
    cuts = pause_gaps.find_pause_cuts(x, SR, [ExpectedGap(3.0, 1.0), ExpectedGap(6.2, 0.12)])

    assert [(round(a / SR, 2), round(b / SR, 2)) for a, b in cuts] == [(3.0, 4.0), (6.2, 6.32)]


def test_a_short_pause_is_found_past_its_resume_stutter():
    x = _ramp(20)
    _silence(x, 3.0, 4.0)
    _silence(x, 6.2, 6.29)  # a 0.12s pause that left 90ms of zeros...
    _silence(x, 6.31, 6.33)  # ...then two underruns as the game resumed
    _silence(x, 6.35, 6.37)
    cuts = pause_gaps.find_pause_cuts(x, SR, [ExpectedGap(3.0, 1.0), ExpectedGap(6.2, 0.12)])

    assert (round(cuts[1][0] / SR, 2), round(cuts[-1][1] / SR, 2)) == (6.2, 6.37)


def test_short_pauses_only_take_their_own_silence():
    """Hover pauses a few seconds apart: a pause whose silence is shorter than it must not take a neighbour's."""
    lag = 0.8
    x = _ramp(30)
    # (pause offset, pause length, recorded silence): the first pause left only 92ms of zeros.
    pauses = [(5.0, 0.134, 0.092), (7.0, 0.41, 0.364), (9.0, 1.122, 1.099), (11.5, 1.571, 1.52)]
    for offset, _, silence in pauses:
        _silence(x, offset + lag, offset + lag + silence)
    gaps = [ExpectedGap(offset, length) for offset, length, _ in pauses]

    cuts = pause_gaps.find_pause_cuts(x, SR, gaps)

    assert [(round(a / SR, 3), round(b / SR, 3)) for a, b in cuts] == [
        (round(offset + lag, 3), round(offset + lag + silence, 3)) for offset, _, silence in pauses
    ]


def test_removes_pause_silence_codec_fades_and_resume_stutter():
    x, gaps = _paused_recording()
    pieces, timeline = pause_gaps.remove_pause_gaps(x, SR, gaps)
    out = np.concatenate(pieces)

    assert len(out) == pytest.approx(len(x) - timeline.removed_seconds * SR, abs=1)
    # Pause + underrun + codec fades (4+4+2+2 ms) + one crossfade overlap per join (2x2 ms).
    assert timeline.removed_seconds == pytest.approx(2.0 + 0.040 + 0.012 + 0.004, abs=0.001)
    # No near-silent millisecond is left anywhere: the joins are continuous.
    window = SR // 1000
    rms = np.sqrt(np.mean(np.square(out[: len(out) // window * window, 0]).reshape(-1, window), axis=1))
    assert rms.min() > 0.05


def test_timeline_maps_cleaned_audio_back_to_the_source():
    x, gaps = _paused_recording()
    pieces, timeline = pause_gaps.remove_pause_gaps(x, SR, gaps)
    out = np.concatenate(pieces)
    for source_time in (1.0, 3.9, 6.012, 7.5, 9.9):  # 6.012 is inside the resume blip, which is kept
        audio_time = timeline.to_audio(source_time)
        assert timeline.to_source(audio_time) == pytest.approx(source_time, abs=1e-9)
        # The sample at the mapped position is the source sample (the ramp encodes its index).
        assert out[round(audio_time * SR), 0] == pytest.approx(x[round(source_time * SR), 0], abs=2e-5)


def test_positions_inside_a_removed_span_snap_to_the_splice():
    timeline = AudioTimeline(((4.0, 6.0),))
    assert timeline.to_audio(5.0) == 4.0
    assert timeline.to_audio(7.0) == 5.0
    assert timeline.to_source(4.0) == 6.0
    assert timeline.to_source(4.0, before_cut=True) == 4.0
    assert timeline.to_source(3.0) == 3.0


def test_no_recorded_pause_means_nothing_is_cut():
    x, _ = _paused_recording()
    pieces, timeline = pause_gaps.remove_pause_gaps(x, SR, [])
    assert not timeline
    assert len(pieces) == 1 and pieces[0] is x


def test_silence_that_does_not_match_the_pause_length_is_kept():
    x = _ramp(10)
    _silence(x, 4.0, 4.5)  # the game's own silence, much shorter than the 2s pause
    assert pause_gaps.find_pause_cuts(x, SR, [ExpectedGap(offset=4.0, duration=2.0)]) == []


def test_silence_far_from_the_pause_is_kept():
    x = _ramp(20)
    _silence(x, 15.0, 17.0)
    assert pause_gaps.find_pause_cuts(x, SR, [ExpectedGap(offset=2.0, duration=2.0)]) == []


def test_pause_inside_longer_game_silence_removes_only_the_pause_length():
    x = _ramp(20)
    _silence(x, 5.0, 10.0)  # game already silent; pause lasted 2s of it
    cuts = pause_gaps.find_pause_cuts(x, SR, [ExpectedGap(offset=6.0, duration=2.0)])
    assert len(cuts) == 1
    start, end = cuts[0]
    assert (end - start) / SR == pytest.approx(2.0, abs=1e-3)
    assert 5.0 * SR <= start and end <= 10.0 * SR
