"""Learn an initial overlay delay from OCR passes the workflow already performs."""

from dataclasses import dataclass, field

from rapidfuzz.distance import LCSseq


@dataclass
class OverlayScanTiming:
    """Evidence for one hooked line, using normalized text and capture times."""

    MAX_EARLY_MATCH_RATIO = 0.1

    reference: str
    first_capture_at: float | None = None
    first_match_ratio: float | None = None
    ready_at: float | None = None
    saw_partial: bool = False

    def observe(self, text: str, *, captured_at: float) -> None:
        # Very short hooks can match a name or HUD by accident. Neither those
        # nor agreement on unrelated text can establish when dialogue appeared.
        if len(self.reference) < 3 or self.ready_at is not None:
            return
        fully_present = self.reference in text
        # Count expected characters found in order, relative to the expected
        # line's length. Extra speaker/HUD text must not dilute the percentage,
        # and a misread at the beginning must not make a mostly visible line
        # look absent. This only compares text from the existing OCR passes.
        match_ratio = 1.0 if fully_present else LCSseq.similarity(self.reference, text) / len(self.reference)
        if self.first_capture_at is None:
            self.first_capture_at = captured_at
            self.first_match_ratio = match_ratio
        if fully_present:
            self.ready_at = captured_at
        elif match_ratio > self.MAX_EARLY_MATCH_RATIO:
            # Only almost-empty reads qualify. Meaningful partial text on any
            # existing pass makes this uncertain/typewriter evidence instead.
            self.saw_partial = True

    @property
    def outcome(self) -> str:
        if len(self.reference) < 3:
            return "short_reference"
        if self.ready_at is None:
            return "unconfirmed"
        if self.ready_at == self.first_capture_at:
            return "first_capture_ready"
        return "partial_text" if self.saw_partial else "late_reveal"

    def summary(self, *, requested_at: float, initial_delay: float, next_delay: float) -> str:
        first_capture = (
            f"{(self.first_capture_at - requested_at) * 1000:.0f}ms" if self.first_capture_at is not None else "unknown"
        )
        ready_capture = f"{(self.ready_at - requested_at) * 1000:.0f}ms" if self.ready_at is not None else "unknown"
        initial_match = f"{self.first_match_ratio:.0%}" if self.first_match_ratio is not None else "unknown"
        return (
            f"initial delay: {initial_delay * 1000:.0f}ms -> {next_delay * 1000:.0f}ms, "
            f"initial match: {initial_match}, timing: {self.outcome}, "
            f"first capture: {first_capture}, ready capture: {ready_capture}"
        )


@dataclass
class AdaptiveOverlayScanDelay:
    """Small, bounded adjustments across lines; no extra captures or OCR calls."""

    INCREASE_STEP = 0.005
    INCREASE_WINDOW_SIZE = 5
    LATE_REVEALS_BEFORE_INCREASE = 3
    DECREASE_STEP = 0.005
    SUCCESSES_BEFORE_DECREASE = 8
    MAX_DELAY = 0.15

    delay: float = 0.0
    _context: tuple | None = None
    _first_pass_successes: int = 0
    _recent_late_reveals: list[bool] = field(default_factory=list)

    def use_context(self, context: tuple) -> None:
        if context != self._context:
            self._context = context
            self.delay = 0.0
            self._first_pass_successes = 0
            self._recent_late_reveals.clear()

    def record(self, timing: OverlayScanTiming) -> None:
        # Require repeated evidence across recent completed lines, without
        # requiring consecutive late reveals. Other outcomes age evidence out.
        self._recent_late_reveals.append(timing.outcome == "late_reveal")
        del self._recent_late_reveals[: -self.INCREASE_WINDOW_SIZE]

        # Learn only after the existing workflow completed. A blank/misread
        # without a later exact match, or a cancelled line, proves no delay.
        if timing.ready_at is None:
            self._first_pass_successes = 0
            return
        if timing.ready_at == timing.first_capture_at:
            self._first_pass_successes += 1
            if self._first_pass_successes >= self.SUCCESSES_BEFORE_DECREASE:
                self.delay = round(max(0.0, self.delay - self.DECREASE_STEP), 3)
                self._first_pass_successes = 0
            return
        self._first_pass_successes = 0
        if not timing.saw_partial and sum(self._recent_late_reveals) >= self.LATE_REVEALS_BEFORE_INCREASE:
            # Retry spacing and slow OCR only give an upper bound on reveal
            # time. Nudge later instead of adopting that entire measured wait.
            self.delay = round(min(self.MAX_DELAY, self.delay + self.INCREASE_STEP), 3)
            self._recent_late_reveals.clear()
