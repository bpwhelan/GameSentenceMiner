"""Dialogue retention for standalone installs and reference-mode replay."""

from collections import OrderedDict

from GameSentenceMiner.native import ocr
from GameSentenceMiner.native.runtime import NativeMode, get_native_mode

from .models import TextRecordState


def make_journal():
    if get_native_mode("text") is NativeMode.NATIVE:
        journal = getattr(ocr._extension, "DialogueJournal", None)
        if journal is not None:
            return journal()
    return ReferenceJournal()


class ReferenceJournal:
    def __init__(self):
        self._rows = []
        self._by_id = {}
        self._sequence = 0
        self._offset = 0
        self._receipts = OrderedDict()
        self._prefixes = OrderedDict()
        self._pending = {}

    def observe(self, key, capacity):
        if capacity < 0:
            raise ValueError("negative observation capacity")
        if key in self._receipts:
            return False
        self._receipts[key] = None
        while len(self._receipts) > capacity:
            self._receipts.popitem(last=False)
        return True

    def get(self, key):
        return self._by_id.get(key)

    def latest(self):
        return self._rows[-1] if self._rows else None

    def context(self, open_id, key):
        return self._sequence, bool(self._pending), self.latest(), self.get(open_id), self._prefixes.get(key)

    def publish(self, line_id, record, append, lifecycle, source):
        _, stats, observed_ns = lifecycle
        if append:
            if line_id in self._by_id:
                raise ValueError("line ID is already present")
            self._rows.append(record)
            self._sequence += 1
        else:
            if line_id not in self._by_id:
                raise ValueError("line ID is absent")
            self._rows[record.stream_sequence - self._offset - 1] = record
        self._by_id[line_id] = record
        if source is not None:
            key, previous = source
            self._prefixes[key] = previous
            self._prefixes.move_to_end(key)
            if len(self._prefixes) > 512:
                self._prefixes.popitem(last=False)
        if stats not in ("pending", "pending_manual"):
            self._pending.pop(line_id, None)
        elif observed_ns is not None:
            self._pending[line_id] = observed_ns

    def pending(self):
        return [self._by_id[key] for key in self._pending]

    def ready(self, now_ns, window_ns):
        cutoff_ns = now_ns - window_ns
        rows = []
        for key, changed in self._pending.items():
            row = self._by_id[key]
            if row.state is not TextRecordState.FROZEN or (
                row.stats_status != "pending_manual" and changed >= cutoff_ns
            ):
                break
            rows.append(row)
        return rows

    def for_exclusion(self, confirmed):
        if not confirmed and len(self._pending) <= 512:
            return ()
        rows = (self._by_id[key] for key in self._pending)
        automatic = (row for row in rows if row.stats_status == "pending")
        if confirmed:
            return list(automatic)
        first = next(automatic, None)
        return [first] if first is not None else []

    def snapshot(self, max_records=None):
        if max_records is not None and max_records < len(self._rows):
            return self._sequence, tuple(self._rows[len(self._rows) - max_records :])
        return self._sequence, tuple(self._rows)

    def expire(self, cutoff):
        count = 0
        for record in self._rows:
            if (
                record.first_seen_at_utc >= cutoff
                or record.state is TextRecordState.PROVISIONAL
                or record.stats_status in ("pending", "pending_manual")
            ):
                break
            count += 1
        if not count:
            return ()
        removed = self._rows[:count]
        del self._rows[:count]
        self._offset += count
        for record in removed:
            del self._by_id[record.line_id]
        return removed
