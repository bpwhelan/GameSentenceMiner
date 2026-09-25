from dataclasses import dataclass
from typing import ClassVar


@dataclass
class AdaptiveOCRRetryState:
    """Track progress within one scan, using normalized text and capture times."""

    FAST_DELAY: ClassVar[float] = 0.01
    INITIAL_DELAY: ClassVar[float] = 0.1
    MAX_DELAY: ClassVar[float] = 1.0
    QUIET_PERIOD: ClassVar[float] = 1.0

    retry_delay: float = INITIAL_DELAY
    _previous_text: str = ""
    _unchanged_since: float | None = None
    _uncertain_passes: int = 0

    def observe(self, text: str, *, captured_at: float) -> bool:
        """Choose the next delay and report whether consecutive agreement is safe.

        Growth must preserve every previous character in order. Insertions can
        occur before a static footer or in several lines, so a prefix/substring
        check alone would miss valid expansion. Substitutions, shrinking text,
        and blank or failed reads all use the uncertain cadence instead.
        """
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
        return bool(text) and captured_at - self._unchanged_since >= self.QUIET_PERIOD
