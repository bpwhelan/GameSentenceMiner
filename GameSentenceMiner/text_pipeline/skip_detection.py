"""Fast-forward evidence independent of hook flush boundaries.

Measures extreme production of new text, never a user's reading speed. Clocks
are local monotonic receipt times. The text coordinator owns this state.
"""

from collections import deque
from dataclasses import dataclass, field
from itertools import pairwise

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
COMMIT_WINDOW_NS = 2_000_000_000
SUSTAINED_WINDOW_NS = 3_500_000_000
FAST_WINDOW_NS = 750_000_000
CONFIRMED_QUIET_MIN_NS = 2_000_000_000
MAX_QUIET_NS = 2_500_000_000


def _compact_reference(text: str) -> str:
    import unicodedata

    return "".join(c for c in unicodedata.normalize("NFKC", text) if c.isalnum())


def compact_text(text: str) -> str:
    from GameSentenceMiner.native import ocr
    from GameSentenceMiner.native.runtime import NativeMode, get_native_mode

    compact = getattr(ocr._extension, "compact_dialogue", None)
    if compact is not None and get_native_mode("text") is NativeMode.NATIVE:
        result = compact(text)
        if result is not None:
            return result
    return _compact_reference(text)


class _NativeDetector:
    def __init__(self, engine):
        self._engine = engine
        self.suspended = self.confirmed = False

    def observe(self, source, text, now_ns, *, skip_control=False):
        kind, instance = source
        key = instance.encode("utf-8", "surrogatepass")
        result = self._engine.observe(kind.value, key, text, now_ns, skip_control, False)
        if result is None:
            # Use the installed Python Unicode tables for compatibility forms
            # and combining sequences outside the native fast path.
            result = self._engine.observe(kind.value, key, _compact_reference(text), now_ns, skip_control, True)
        added, self.suspended, self.confirmed = result
        return added

    def quiet(self, now_ns):
        return self._engine.quiet(now_ns)

    @property
    def reason(self):
        return self._engine.reason

    @property
    def quiet_ns(self):
        return self._engine.quiet_ns

    def reset(self):
        self._engine.reset()
        self.suspended = self.confirmed = False


def make_detector():
    from GameSentenceMiner.native import ocr
    from GameSentenceMiner.native.runtime import NativeMode, get_native_mode

    engine = getattr(ocr._extension, "DialogueSkipDetector", None)
    if engine is not None and get_native_mode("text") is NativeMode.NATIVE:
        return _NativeDetector(engine())
    return SkipDetector()


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
        text = _compact_reference(text)
        if not text:
            return False
        activity = self.sources.setdefault(source, SourceActivity())
        previous = activity.text
        if text == previous or previous.startswith(text):
            return False
        extends = bool(previous and text.startswith(previous))
        novel = text[len(previous) :] if extends else text
        if not extends and previous:
            for length in range(min(len(previous), len(text), 512), 7, -1):
                if previous.endswith(text[:length]):
                    novel = text[length:]
                    break
        activity.text = text
        novel_len = len(novel)
        activity.samples.append((now_ns, novel_len, not extends, skip_control))
        while activity.samples and now_ns - activity.samples[0][0] > SUSTAINED_WINDOW_NS:
            activity.samples.popleft()
        self.last_activity_ns = now_ns

        short = [s for s in activity.samples if now_ns - s[0] <= WINDOW_NS]
        substantial = [s for s in short if s[1] >= 12]
        # A single instant full-page reveal is normal. Require substantial text
        # in addition to the largest contribution, even across many fragments.
        counts = [s[1] for s in short]
        total = sum(counts)
        other = total - max(counts, default=0)
        span = now_ns - short[0][0]

        fast = [s for s in short if now_ns - s[0] <= FAST_WINDOW_NS]
        fast_counts = [s[1] for s in fast]
        fast_total = sum(fast_counts)
        fast_other = fast_total - max(fast_counts, default=0)
        fast_span = now_ns - fast[0][0]

        replacements = [s for s in substantial if s[2] and now_ns - s[0] <= FAST_WINDOW_NS]
        repl_sum = sum(s[1] for s in replacements)
        repl_other = repl_sum - max((s[1] for s in replacements), default=0)

        sustained_counts = [s[1] for s in activity.samples]
        sustained_total = sum(sustained_counts)
        sustained_other = sustained_total - max(sustained_counts, default=0)
        sustained_span = now_ns - activity.samples[0][0]
        sustained_repl = sum(1 for s in activity.samples if s[1] >= 12 and s[2])

        volume = (total >= 200 and other >= 80 and span >= 150_000_000) or (
            fast_total >= 300 and fast_other >= 55 and fast_span >= 150_000_000
        )
        rapid = fast_span >= 150_000_000 and (
            (len(replacements) >= 4 and repl_sum >= 100)
            or (len(replacements) >= 3 and repl_sum >= 120 and repl_other >= 45)
        )
        sustained = (
            sustained_span >= 150_000_000 and sustained_total >= 240 and sustained_other >= 130 and sustained_repl >= 3
        )
        controlled = [s for s in substantial if s[2] and s[3]]
        control_burst = len(controlled) >= 2 and sum(s[1] for s in controlled) >= 48 and span >= 150_000_000
        if volume or rapid or sustained or control_burst:
            self.confirmed = True
            self.last_confirmation_ns = now_ns
            self.reason = (
                "text volume"
                if volume
                else "Ctrl with changing dialogue"
                if control_burst
                else "rapid dialogue replacements"
                if rapid
                else "sustained text volume"
            )
        elif self.confirmed and (
            (total >= 120 and other >= 50 and span >= 150_000_000)
            or (len(replacements) >= 2 and repl_sum >= 75 and fast_span >= 150_000_000)
        ):
            self.last_confirmation_ns = now_ns
        suspect = (other >= 48 and total >= 100 and 100_000_000 <= span <= FAST_WINDOW_NS) or (
            novel_len >= 30 and other >= 80 and total >= 150 and 100_000_000 <= span <= WINDOW_NS
        )
        if suspect:
            self.last_suspicion_ns = now_ns
        if (suspect or self.confirmed) and not self.suspended:
            self.suspended = True
            self.started_ns = short[0][0]
        if self.suspended:
            floor = CONFIRMED_QUIET_MIN_NS if self.confirmed else WINDOW_NS
            times = [s[0] for s in substantial]
            gaps = [b - a for a, b in pairwise(times) if b > a]
            if gaps:
                from statistics import median

                self.quiet_ns = int(min(MAX_QUIET_NS, max(floor, median(gaps) * 3)))
            else:
                self.quiet_ns = max(self.quiet_ns, floor)
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
        return now_ns - evidence_ns > (MAX_QUIET_NS if self.confirmed else WINDOW_NS)

    def reset(self):
        self.__init__()
