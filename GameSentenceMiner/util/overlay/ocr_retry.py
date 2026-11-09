from dataclasses import dataclass
from typing import ClassVar

from rapidfuzz.distance import LCSseq


@dataclass
class AdaptiveOCRRetryState:
    """Track hook progress and optional fast retries within one scan."""

    FAST_DELAY: ClassVar[float] = 0.01
    INITIAL_DELAY: ClassVar[float] = 0.1
    MAX_DELAY: ClassVar[float] = 1.0
    QUIET_PERIOD: ClassVar[float] = 1.0

    reference: str = ""
    progress_window: float = 4.0
    retry_delay: float = INITIAL_DELAY
    _previous_text: str = ""
    _unchanged_since: float | None = None
    _uncertain_passes: int = 0
    _best_reference_match: int | None = None
    _last_reference_progress_at: float | None = None

    @property
    def progress_deadline(self) -> float | None:
        if self._last_reference_progress_at is None:
            return None
        return self._last_reference_progress_at + self.progress_window

    def has_recent_progress(self, now: float) -> bool:
        deadline = self.progress_deadline
        return deadline is not None and now < deadline

    def deadline(self, initial_deadline: float) -> float:
        """Allow another progress window after each new best hook match."""
        deadline = self.progress_deadline
        if deadline is None:
            return initial_deadline
        return max(initial_deadline, deadline)

    def observe(self, text: str, *, captured_at: float) -> bool:
        """Choose the next delay and report whether consecutive agreement is safe.

        Growth must preserve every previous character in order. Insertions can
        occur before a static footer or in several lines, so a prefix/substring
        check alone would miss valid expansion. Substitutions, shrinking text,
        and blank or failed reads all use the uncertain cadence instead.
        """
        if self.reference:
            # Count expected characters found in order. A partial_ratio can be
            # perfect for a tiny unfinished prefix, while a full-result ratio
            # is diluted by speaker/HUD text. Only a new best match is progress;
            # regaining an old match after a misread/blank must not renew it.
            matched = LCSseq.similarity(self.reference, text)
            if self._best_reference_match is not None and matched > self._best_reference_match:
                self._last_reference_progress_at = captured_at
            self._best_reference_match = max(self._best_reference_match or 0, matched)

        growing = False
        if self._previous_text and len(text) > len(self._previous_text):
            remaining = iter(text)
            growing = all(character in remaining for character in self._previous_text)

        if not text or text != self._previous_text or self._unchanged_since is None:
            self._unchanged_since = captured_at

        if growing:
            self._uncertain_passes = 0
            self.retry_delay = self.FAST_DELAY
        else:
            self.retry_delay = min(self.MAX_DELAY, self.INITIAL_DELAY * 2**self._uncertain_passes)
            self._uncertain_passes = min(self._uncertain_passes + 1, 4)

        self._previous_text = text
        # Measure from capture to capture: slow OCR processing must not make two
        # images taken close together look like a long period of agreement.
        # Once the hook match improves, allow short pauses in the reveal before
        # accepting an unchanged partial line. Exact completion is checked by
        # the caller and can still finish immediately.
        return (
            bool(text)
            and not self.has_recent_progress(captured_at)
            and captured_at - self._unchanged_since >= self.QUIET_PERIOD
        )
