"""Bounded search for an approximate animated AVIF size, using encoded samples."""

from collections.abc import Callable
from dataclasses import dataclass, replace


@dataclass(frozen=True)
class AvifParameters:
    fps: int
    width: int
    crf: int


def size_candidates(caps: AvifParameters, priority: str) -> list[AvifParameters]:
    """Order reductions by preference; all three modes can reach the same floor."""
    candidates = [caps]
    current = caps
    min_width = min(caps.width, 240)
    max_crf = max(caps.crf, 56)
    if priority == "balanced":
        while current.fps > 1 or current.width > min_width or current.crf < max_crf:
            current = AvifParameters(
                max(1, int(current.fps * 0.85)),
                max(min_width, int(current.width * 0.90) // 2 * 2),
                min(max_crf, current.crf + 2),
            )
            candidates.append(current)
        return candidates

    stages = ("detail", "fps") if priority == "prefer_fps" else ("fps", "detail")
    for stage in stages:
        if stage == "fps":
            while current.fps > 1:
                current = replace(current, fps=max(1, int(current.fps * 0.75)))
                candidates.append(current)
        else:
            while current.crf < max_crf:
                current = replace(current, crf=min(max_crf, current.crf + 2))
                candidates.append(current)
            while current.width > min_width:
                current = replace(current, width=max(min_width, int(current.width * 0.75) // 2 * 2))
                candidates.append(current)
    return candidates


def choose_size_parameters(
    candidates: list[AvifParameters], target_bytes: int, estimate: Callable[[AvifParameters], int]
) -> tuple[AvifParameters, int]:
    """Keep caps when they fit, otherwise binary search measured size estimates."""
    first_size = estimate(candidates[0])
    if first_size <= target_bytes or len(candidates) == 1:
        return candidates[0], first_size
    lower, upper = 0, len(candidates) - 1
    upper_size = estimate(candidates[upper])
    if upper_size > target_bytes:
        return candidates[upper], upper_size
    while upper - lower > 1:
        middle = (lower + upper) // 2
        size = estimate(candidates[middle])
        if size <= target_bytes:
            upper, upper_size = middle, size
        else:
            lower = middle
    return candidates[upper], upper_size


def sample_ranges(start: float, duration: float) -> list[tuple[float, float]]:
    if duration <= 3.0:
        return [(start, duration)]
    return [(start, 1.0), (start + (duration - 1.0) / 2, 1.0), (start + duration - 1.0, 1.0)]
