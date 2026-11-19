import gc
import weakref
from dataclasses import replace
from datetime import UTC, datetime, timedelta

import pytest

from GameSentenceMiner.native import ocr
from GameSentenceMiner.text_pipeline.coordinator import TextCoordinatorState
from GameSentenceMiner.text_pipeline.models import IngressStatus, SourceKind, TextObservation


@pytest.fixture(params=["native", "python"])
def state(request, monkeypatch):
    monkeypatch.setenv("GSM_NATIVE_TEXT_MODE", request.param)
    state = TextCoordinatorState(max_observation_ids=2)
    if request.param == "native":
        extension = ocr._extension
        if not hasattr(extension, "DialogueJournal"):
            pytest.skip("native dialogue journal is unavailable")
        assert type(state._journal) is extension.DialogueJournal
    return state


STAMP = datetime(9998, 12, 31, tzinfo=UTC)


def obs(key, text, source=SourceKind.MANUAL, **fields):
    return TextObservation(key, source, "source", text, STAMP, STAMP, STAMP, 100, **fields)


def test_retry_fifo_includes_processed_rejections_and_preserves_exact_ids(state):
    key = "ab012345-6789-1234-9876-000000000000"

    def status(key, text="x", **kwargs):
        return state.ingest(obs(key, text, **kwargs), now=STAMP).ack

    assert status(key, processed_text="").status is IngressStatus.REJECTED
    assert status(key.upper(), "one").status is IngressStatus.ACCEPTED
    assert status(key).reason == "idempotent retry"
    assert status(key.replace("-", ""), "two").status is IngressStatus.ACCEPTED
    assert status(key, "three").status is IngressStatus.ACCEPTED
    assert status("odd\udc00", "").status is IngressStatus.REJECTED
    assert status("odd\udc00", "four").status is IngressStatus.ACCEPTED
    assert status("odd\udc00").reason == "idempotent retry"
    state.max_observation_ids = 0
    assert status("zero", "five").status is IngressStatus.ACCEPTED
    assert status("zero", "six").status is IngressStatus.ACCEPTED
    state.max_observation_ids = 2**200
    long_id = "\udfff" * 200
    assert status(long_id, "long").status is IngressStatus.ACCEPTED
    assert status(long_id).reason == "idempotent retry"


def test_expiring_a_prefix_preserves_identity_order_and_microseconds(state):
    marker = object()
    speech = obs("1", "next", SourceKind.SPEECH_RECOGNITION, merge_fragments=True, metadata={"handle": marker})
    a = state.ingest(speech, now=STAMP).events[-1].record
    b = state.ingest(obs("2", "manual"), now=STAMP).events[-1].record
    old = state.snapshot()
    later = STAMP + timedelta(microseconds=1)
    assert state.expire_before(later) == ()
    c = state.ingest(replace(speech, observation_id="3", raw_text="next line"), now=later).events[-1].record
    assert c.line_id == a.line_id and state.get(a.line_id) is c
    assert c.metadata["handle"] is marker
    assert old.records[0] is a and state.snapshot().records == (c, b)
    state.freeze(c.line_id, now=later)
    assert state.expire_before(STAMP) == ()
    assert [event.record.line_id for event in state.expire_before(later)] == [a.line_id, b.line_id]
    assert state.get(a.line_id) is None
    result = state.ingest(obs("4", "last"), now=later)
    assert result.ack.stream_sequence == 3


def test_prefix_recency_advances_on_write_and_survives_row_expiration(state):
    def put(index, text):
        item = replace(obs(f"{index}-{text}", text, remove_matching_prefix=True), source_instance=f"s\ud800{index}")
        return state.ingest(item, now=STAMP)

    for index in range(512):
        put(index, f"[{index}]")
    assert put(0, "[0] again").ack.status is IngressStatus.ACCEPTED
    assert put(511, "[1]").ack.status is IngressStatus.ACCEPTED
    # Source 1 is now oldest. Looking it up for a duplicate must leave it oldest.
    assert put(1, "[1]").ack.reason == "same text as immediately previous record"
    assert put(512, "extra").ack.status is IngressStatus.ACCEPTED
    state.expire_before(STAMP + timedelta(microseconds=1))
    assert put(0, "[0] again kept").events[-1].record.text == "kept"
    assert put(1, "[1] evicted").events[-1].record.text == "[1] evicted"


def test_projection_metadata_cycles_are_collectible(state):
    class Handle:
        pass

    handle = Handle()
    handle.state = state
    ref = weakref.ref(handle)
    state.ingest(obs("cycle", "text", metadata={"handle": handle}), now=STAMP)
    state.snapshot()
    del handle
    # Remove the external root but leave journal -> projection -> handle -> journal.
    ref().state = state._journal
    state._journal = None
    gc.collect()
    assert ref() is None


def test_pending_statistics_keep_the_first_position_after_revision(state):
    from GameSentenceMiner.text_pipeline.skip_detection import WINDOW_NS

    journal = state._journal
    a = state.ingest(obs("a", "first"), now=STAMP).events[-1].record
    b = state.ingest(obs("b", "second"), now=STAMP).events[-1].record

    def set_pending(row, status, tick, frozen=True):
        from GameSentenceMiner.text_pipeline.models import TextRecordState

        row = replace(row, stats_status=status, state=TextRecordState.FROZEN if frozen else TextRecordState.PROVISIONAL)
        journal.publish(row.line_id, row, False, (frozen, status, tick), None)
        return row

    a = set_pending(a, "pending", 10)
    b = set_pending(b, "pending_manual", 15)
    a = set_pending(a, "pending", 30, frozen=False)
    assert list(journal.ready(31 + WINDOW_NS, WINDOW_NS)) == []
    a = set_pending(a, "pending", None)
    assert list(journal.ready(30 + WINDOW_NS, WINDOW_NS)) == []
    assert list(journal.ready(31 + WINDOW_NS, WINDOW_NS)) == [a, b]
    assert list(journal.for_exclusion(False)) == []
    assert list(journal.for_exclusion(True)) == [a]
    assert list(journal.pending()) == [a, b]
    state._classify_stats(a, True)
    assert list(journal.ready(-(2**127), WINDOW_NS)) == [b]


def test_only_oldest_automatic_row_is_selected_when_pending_capacity_is_exceeded(state):
    seed = state.ingest(obs("one", "line"), now=STAMP).events[-1].record
    journal = state._journal
    automatic = []
    for i in range(513):
        status = "pending" if i in (1, 500) else "pending_manual"
        row = replace(seed, line_id=f"pending-{i}", stream_sequence=i + 2, stats_status=status)
        journal.publish(row.line_id, row, True, (True, status, i), None)
        if status == "pending":
            automatic.append(row)
        if i == 511:
            assert not journal.for_exclusion(False)
    assert list(journal.for_exclusion(False)) == automatic[:1]
    assert list(journal.for_exclusion(True)) == automatic


def test_older_extension_and_reference_modes_use_compatible_journal(monkeypatch):
    from types import SimpleNamespace

    from GameSentenceMiner.text_pipeline.journal import ReferenceJournal, make_journal

    monkeypatch.setenv("GSM_NATIVE_TEXT_MODE", "native")
    monkeypatch.setattr(ocr, "_extension", SimpleNamespace())
    assert isinstance(make_journal(), ReferenceJournal)
    monkeypatch.setattr(ocr, "_extension", SimpleNamespace(DialogueJournal=object))
    for mode in ("shadow", "python"):
        monkeypatch.setenv("GSM_NATIVE_TEXT_MODE", mode)
        assert isinstance(make_journal(), ReferenceJournal)


@pytest.mark.skipif(not hasattr(ocr._extension, "DialogueJournal"), reason="native dialogue journal is unavailable")
def test_native_snapshot_is_reused_until_a_record_changes(monkeypatch):
    monkeypatch.setenv("GSM_NATIVE_TEXT_MODE", "native")
    state = TextCoordinatorState()
    a = state.ingest(obs("a", "speech", SourceKind.SPEECH_RECOGNITION), now=STAMP).events[-1].record
    before = state.snapshot().records
    assert state.snapshot().records is before
    assert state.expire_before(STAMP) == ()
    assert state.snapshot().records is before
    state.freeze(a.line_id, now=STAMP)
    frozen = state.snapshot().records
    assert frozen is not before and frozen[0].revision == 2 and before[0] is a
    state.expire_before(STAMP + timedelta(microseconds=1))
    assert state.snapshot().records == () and len(frozen) == 1


def test_recent_snapshot_reads_only_requested_tail_through_actor(state):
    from GameSentenceMiner.text_pipeline.coordinator import SnapshotCommand, TextCoordinatorActor

    actor = TextCoordinatorActor(state=state)
    rows = [state.ingest(obs(str(i), str(i)), now=STAMP).events[-1].record for i in range(5)]
    snap = actor.handle(SnapshotCommand(max_records=2))
    assert snap.records == tuple(rows[-2:]) and snap.snapshot_sequence == 5
    assert actor.handle(SnapshotCommand(max_records=0)).records == ()
    assert actor.handle(SnapshotCommand(max_records=-1)).records == ()
    assert actor.handle(SnapshotCommand(max_records=2**130)).records == tuple(rows)
    assert actor.handle(SnapshotCommand()).records == tuple(rows)
    assert actor.handle(SnapshotCommand(max_records=2)).records == tuple(rows[-2:])
