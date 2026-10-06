"""Cut the exact digital silence a GSM game pause leaves in recorded audio, only where a recorded pause lines up."""

from bisect import bisect_right
from collections.abc import Iterable, Sequence
from dataclasses import dataclass

import numpy as np

MIN_ZERO_RUN_SECONDS = 0.001
MIN_PAUSE_SECONDS = 0.05
# How far a silent run's length may differ from its pause (audio queued before or after it).
DURATION_TOLERANCE_SECONDS = 0.3
# Pause log -> replay offset shift (save latency, ~1s), estimated once from all pauses.
MAX_LAG_SECONDS = 5.0
ALIGN_TOLERANCE_SECONDS = 0.25
MIN_LAG_RUN_SECONDS = 0.05
# Suspending can leave a short underrun just before the pause; resuming, one buffer then an underrun after it.
SUSPEND_STUTTER_WINDOW_SECONDS = 0.08
STUTTER_WINDOW_SECONDS = 0.15
MAX_STUTTER_RUN_SECONDS = 0.1
# Lossy codecs smear the hard cut into a short fade on each side.
FADE_FLOOR_DBFS = -45.0
FADE_STEP_SECONDS = 0.0005
MAX_FADE_WIDEN_SECONDS = 0.02
CROSSFADE_SECONDS = 0.002


@dataclass(frozen=True)
class ExpectedGap:
    offset: float  # seconds from the start of the recording
    duration: float


@dataclass(frozen=True)
class AudioTimeline:
    """Sorted, disjoint spans (source seconds) removed from the source audio."""

    cuts: tuple[tuple[float, float], ...] = ()

    def __bool__(self) -> bool:
        return bool(self.cuts)

    @property
    def removed_seconds(self) -> float:
        return sum(end - start for start, end in self.cuts)

    def to_audio(self, source_time: float) -> float:
        """Source (video) position -> position in the cleaned audio."""
        removed = 0.0
        for start, end in self.cuts:
            if source_time <= start:
                break
            if source_time < end:
                return start - removed
            removed += end - start
        return source_time - removed

    def to_source(self, audio_time: float, before_cut: bool = False) -> float:
        """Cleaned-audio position -> source position; `before_cut` puts a splice point before its cut (range ends)."""
        removed = 0.0
        for start, end in self.cuts:
            splice_point = start - removed
            if audio_time < splice_point or (before_cut and audio_time <= splice_point):
                break
            removed += end - start
        return audio_time + removed


def expected_gaps(
    pauses: Iterable[tuple[float, float]], recording_end: float, recording_length: float
) -> list[ExpectedGap]:
    """Clip wall-clock pauses (epoch seconds) to a recording ending at `recording_end`."""
    recording_start = recording_end - recording_length
    gaps = []
    for start, end in sorted(pauses):
        start, end = max(start, recording_start) - recording_start, min(end, recording_end) - recording_start
        if end - start >= MIN_PAUSE_SECONDS:
            gaps.append(ExpectedGap(start, end - start))
    return gaps


def _zero_runs(samples: np.ndarray, min_len: int) -> np.ndarray:
    silent = ~samples.any(axis=1)
    edges = np.diff(silent.astype(np.int8), prepend=0, append=0)
    runs = np.column_stack((np.flatnonzero(edges == 1), np.flatnonzero(edges == -1)))
    return runs[(runs[:, 1] - runs[:, 0]) >= min_len]


def _widen(samples: np.ndarray, sr: int, start: int, end: int) -> tuple[int, int]:
    step = max(1, int(sr * FADE_STEP_SECONDS))
    limit = int(sr * MAX_FADE_WIDEN_SECONDS)
    floor = 10 ** (FADE_FLOOR_DBFS / 20)

    def quiet(lo: int, hi: int) -> bool:
        return float(np.sqrt(np.mean(np.square(samples[lo:hi], dtype=np.float64)))) < floor

    lo = start
    while lo - step >= 0 and start - (lo - step) <= limit and quiet(lo - step, lo):
        lo -= step
    hi = end
    while hi + step <= len(samples) and (hi + step) - end <= limit and quiet(hi, hi + step):
        hi += step
    return lo, hi


def _fitting_run(starts: list[float], ends: list[float], gap: ExpectedGap, lag: float) -> int | None:
    """Index of the zero run (seconds) that holds the pause shifted by `lag`, if any."""
    expected_start = gap.offset + lag
    expected_end = expected_start + gap.duration
    min_overlap = max(gap.duration - DURATION_TOLERANCE_SECONDS, gap.duration / 2)
    i = bisect_right(starts, expected_start + ALIGN_TOLERANCE_SECONDS) - 1
    while i >= 0 and ends[i] >= expected_start - ALIGN_TOLERANCE_SECONDS:
        if (
            starts[i] - ALIGN_TOLERANCE_SECONDS <= expected_start
            and expected_end <= ends[i] + ALIGN_TOLERANCE_SECONDS
            and min(ends[i], expected_end) - max(starts[i], expected_start) >= min_overlap
        ):
            return i
        i -= 1
    return None


def _estimate_lag(starts: list[float], ends: list[float], gaps: Sequence[ExpectedGap]) -> float | None:
    """The shift that lines up the most pause time with silence."""
    candidates = {0.0}
    for gap in gaps:
        lo = bisect_right(starts, gap.offset - MAX_LAG_SECONDS - ALIGN_TOLERANCE_SECONDS)
        hi = bisect_right(starts, gap.offset + MAX_LAG_SECONDS)
        for run_start, run_end in zip(starts[lo:hi], ends[lo:hi], strict=True):
            if run_end - run_start < MIN_LAG_RUN_SECONDS:
                continue
            for lag in (run_start - gap.offset, run_end - (gap.offset + gap.duration)):
                if abs(lag) <= MAX_LAG_SECONDS:
                    candidates.add(round(lag, 3))
    best, best_weight = None, 0.0
    for lag in sorted(candidates, key=abs):
        weight = sum(gap.duration for gap in gaps if _fitting_run(starts, ends, gap, lag) is not None)
        if weight > best_weight:
            best, best_weight = lag, weight
    return best


def find_pause_cuts(samples: np.ndarray, sr: int, gaps: Sequence[ExpectedGap]) -> list[tuple[int, int]]:
    """Sample ranges to remove, for the expected gaps that lined up with a zero run."""
    runs = _zero_runs(samples, max(1, int(sr * MIN_ZERO_RUN_SECONDS)))
    if not gaps or not len(runs):
        return []
    starts, ends = (runs[:, 0] / sr).tolist(), (runs[:, 1] / sr).tolist()
    lag = _estimate_lag(starts, ends, gaps)
    if lag is None:
        return []
    # Pauses in quick succession, with no sound in between, share one run.
    claims: dict[int, list[ExpectedGap]] = {}
    for gap in gaps:
        i = _fitting_run(starts, ends, gap, lag)
        if i is not None:
            claims.setdefault(i, []).append(gap)
    max_stutter = int(sr * MAX_STUTTER_RUN_SECONDS)
    suspend_window = int(sr * SUSPEND_STUTTER_WINDOW_SECONDS)
    stutter_window = int(sr * STUTTER_WINDOW_SECONDS)
    used = set(claims)
    cuts: list[tuple[int, int]] = []
    for i, claimed in claims.items():
        start, end = (int(v) for v in runs[i])
        paused = max(gap.offset + gap.duration for gap in claimed) - claimed[0].offset
        if (end - start) / sr > paused + DURATION_TOLERANCE_SECONDS:
            # The game was already silent around the pause: remove only the pause's worth of zeros, where it was.
            for gap in claimed:
                length = int(gap.duration * sr)
                cut_start = min(max(int((gap.offset + lag) * sr), start), end - length)
                cuts.append((cut_start, cut_start + length))
            continue
        cuts.append(_widen(samples, sr, start, end))
        first = int(np.searchsorted(runs[:, 1], start - suspend_window))
        last = int(np.searchsorted(runs[:, 0], end + stutter_window, "right"))
        for j in range(first, last):
            s_start, s_end = (int(v) for v in runs[j])
            if j not in used and s_end - s_start <= max_stutter:
                used.add(j)
                cuts.append(_widen(samples, sr, s_start, s_end))

    merged: list[tuple[int, int]] = []
    for start, end in sorted(cuts):
        if merged and start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    return merged


def splice(samples: np.ndarray, sr: int, cuts: Sequence[tuple[int, int]]) -> tuple[list[np.ndarray], AudioTimeline]:
    """Pieces of `samples` left after removing `cuts`, joined by a short equal-power crossfade."""
    if not cuts:
        return [samples], AudioTimeline()
    fade = max(1, int(sr * CROSSFADE_SECONDS))
    ramp = np.linspace(0, np.pi / 2, fade, dtype=np.float32)[:, None]
    bounds = [0, *(v for cut in cuts for v in cut), len(samples)]
    pieces = [samples[bounds[k] : bounds[k + 1]] for k in range(0, len(bounds), 2)]

    out = [pieces[0]]
    timeline_cuts = []
    for (start, end), piece in zip(cuts, pieces[1:], strict=True):
        if len(out[-1]) >= fade and len(piece) >= fade:
            blended = out[-1][-fade:] * np.cos(ramp) + piece[:fade] * np.sin(ramp)
            out[-1] = out[-1][:-fade]
            out.extend([blended, piece[fade:]])
            # The overlap costs one fade length, centred on the splice.
            timeline_cuts.append(((start - fade / 2) / sr, (end + fade / 2) / sr))
        else:
            out.append(piece)
            timeline_cuts.append((start / sr, end / sr))
    return [piece for piece in out if len(piece)], AudioTimeline(tuple(timeline_cuts))


def remove_pause_gaps(
    samples: np.ndarray, sr: int, gaps: Sequence[ExpectedGap]
) -> tuple[list[np.ndarray], AudioTimeline]:
    return splice(samples, sr, find_pause_cuts(samples, sr, gaps))
