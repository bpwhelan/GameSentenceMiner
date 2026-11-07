"""Fast-forward evidence independent of hook flush boundaries.

Measures extreme production of new text, never a user's reading speed. Clocks
are local monotonic receipt times. The text coordinator owns this state.
"""

import unicodedata
from collections import deque
from dataclasses import dataclass, field
from itertools import pairwise
from statistics import median

from .models import SourceKind

AUTOMATIC_SOURCES = frozenset(
    {
        SourceKind.TEXTHOOK,
        SourceKind.CLIPBOARD,
        SourceKind.WEBSOCKET,
        SourceKind.OCR,
        SourceKind.OVERLAY,
        SourceKind.UNKNOWN,
    }
)
WINDOW_NS = 1_500_000_000


def compact_text(text: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFKC", text) if c.isalnum())


@dataclass
class SourceActivity:
    text: str = ""
    samples: deque = field(default_factory=lambda: deque(maxlen=256))


class SkipDetector:
    def __init__(self):
        self.sources: dict[tuple, SourceActivity] = {}
        self.suspended = False
        self.confirmed = False
        self.last_activity_ns = 0
        self.quiet_ns = WINDOW_NS
        self.started_ns = 0
        self.last_suspicion_ns = 0
        self.last_confirmation_ns = 0
        self.reason = ""

    def observe(self, source: tuple, text: str, now_ns: int, *, skip_control: bool = False) -> bool:
        """Return whether the payload adds evidence (duplicates add none)."""
        text = compact_text(text)
        activity = self.sources.setdefault(source, SourceActivity())
        previous = activity.text
        if not text or text == previous or previous.startswith(text):
            return False
        extends = bool(previous and text.startswith(previous))
        novel = text[len(previous) :] if extends else text
        if not extends and previous:
            for length in range(min(len(previous), len(text), 512), 7, -1):
                if previous.endswith(text[:length]):
                    novel = text[length:]
                    break
        activity.text = text
        activity.samples.append((now_ns, len(novel), not extends, skip_control))
        while activity.samples and now_ns - activity.samples[0][0] > WINDOW_NS:
            activity.samples.popleft()
        self.last_activity_ns = now_ns
        substantial = [s for s in activity.samples if s[1] >= 12]
        # A single instant full-page reveal is normal. Require substantial text
        # in addition to the largest contribution, even across many fragments.
        counts = [s[1] for s in activity.samples]
        total = sum(counts)
        other = total - max(counts, default=0)
        span = now_ns - activity.samples[0][0]
        replacements = [s for s in substantial if s[2] and now_ns - s[0] <= 750_000_000]
        volume = total >= 300 and other >= 180 and span >= 150_000_000
        rapid = len(replacements) >= 4 and sum(s[1] for s in replacements) >= 100 and span >= 150_000_000
        controlled = [s for s in substantial if s[2] and s[3]]
        control_burst = len(controlled) >= 2 and sum(s[1] for s in controlled) >= 48 and span >= 150_000_000
        if volume or rapid or control_burst:
            self.confirmed = True
            self.last_confirmation_ns = now_ns
            self.reason = (
                "text volume"
                if volume
                else "Ctrl with changing dialogue"
                if control_burst
                else "rapid dialogue replacements"
            )
        suspect = other >= 48 and total >= 100 and 100_000_000 <= span <= 750_000_000
        if suspect:
            self.last_suspicion_ns = now_ns
        if (suspect or self.confirmed) and not self.suspended:
            self.suspended = True
            self.started_ns = activity.samples[0][0]
        if self.suspended:
            times = [s[0] for s in substantial]
            gaps = [b - a for a, b in pairwise(times) if b > a]
            if gaps:
                self.quiet_ns = int(min(2_500_000_000, max(WINDOW_NS, median(gaps) * 3)))
        if len(self.sources) > 32:
            self.sources.pop(next(iter(self.sources)))
        return True

    def quiet(self, now_ns: int) -> bool:
        if not self.suspended:
            return False
        if now_ns - self.last_activity_ns >= self.quiet_ns:
            return True
        # A brief burst must not leave scans/stats suspended indefinitely when
        # subsequent text returns to an ordinary cadence without a full pause.
        evidence_ns = self.last_confirmation_ns if self.confirmed else self.last_suspicion_ns
        return now_ns - evidence_ns > (2_500_000_000 if self.confirmed else WINDOW_NS)

    def reset(self):
        self.__init__()
