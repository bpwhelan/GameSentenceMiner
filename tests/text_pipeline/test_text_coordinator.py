from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

from GameSentenceMiner.text_pipeline.coordinator import (
    IngestCommand,
    SnapshotCommand,
    TextCoordinatorActor,
    TextCoordinatorState,
)
from GameSentenceMiner.text_pipeline.models import (
    IngressStatus,
    SourceKind,
    TextEventKind,
    TextObservation,
    TextRecordState,
)

NOW = datetime(2026, 8, 9, 12, 0, tzinfo=timezone.utc)


def observation(
    text: str,
    source: SourceKind,
    observation_id: str,
    *,
    emitted_at: datetime = NOW,
    source_instance: str = "default",
) -> TextObservation:
    return TextObservation(
        observation_id=observation_id,
        source_kind=source,
        source_instance=source_instance,
        raw_text=text,
        captured_at_utc=emitted_at,
        emitted_at_utc=emitted_at,
        received_at_utc=emitted_at,
        received_monotonic_ns=1,
    )


def test_first_observation_is_immediately_provisional():
    state = TextCoordinatorState(session_id="session")
    result = state.ingest(observation("hello", SourceKind.OCR, "ocr-1"), now=NOW)

    assert result.ack.status is IngressStatus.ACCEPTED
    assert [event.kind for event in result.events] == [TextEventKind.APPENDED]
    record = result.events[0].record
    assert record.text == "hello"
    assert record.stream_sequence == 1
    assert record.revision == 1
    assert record.state is TextRecordState.PROVISIONAL


def test_higher_quality_hook_revises_ocr_record_in_place():
    state = TextCoordinatorState(session_id="session")
    first = state.ingest(observation("I0ve you", SourceKind.OCR, "ocr-1"), now=NOW)
    second = state.ingest(
        observation("I love you", SourceKind.TEXTHOOK, "hook-1", emitted_at=NOW + timedelta(milliseconds=50)),
        now=NOW + timedelta(milliseconds=50),
    )

    assert first.events[0].record.line_id == second.events[0].record.line_id
    assert second.events[0].kind is TextEventKind.UPDATED
    assert second.events[0].record.text == "I love you"
    assert second.events[0].record.revision == 2
    assert second.events[0].record.source_kind is SourceKind.TEXTHOOK


def test_hook_can_upgrade_ocr_after_one_second_without_delaying_first_visibility():
    state = TextCoordinatorState(session_id="session")
    first = observation("I0ve you", SourceKind.OCR, "ocr-1")
    first = TextObservation(**{**first.__dict__, "received_monotonic_ns": 1_000_000_000, "metadata": {}})
    appended = state.ingest(first, now=NOW, now_monotonic_ns=1_000_000_000)
    hook = observation(
        "I love you",
        SourceKind.TEXTHOOK,
        "hook-1",
        emitted_at=NOW + timedelta(seconds=1),
    )
    hook = TextObservation(**{**hook.__dict__, "received_monotonic_ns": 2_000_000_000, "metadata": {}})
    revised = state.ingest(
        hook,
        now=NOW + timedelta(seconds=1),
        now_monotonic_ns=2_000_000_000,
    )

    assert appended.events[0].kind is TextEventKind.APPENDED
    assert revised.events[0].kind is TextEventKind.UPDATED
    assert revised.events[0].record.line_id == appended.events[0].record.line_id


def test_lower_quality_ocr_cannot_downgrade_hook_record():
    state = TextCoordinatorState(session_id="session")
    first = state.ingest(observation("correct text", SourceKind.TEXTHOOK, "hook-1"), now=NOW)
    second = state.ingest(
        observation("correet text", SourceKind.OCR, "ocr-1", emitted_at=NOW + timedelta(milliseconds=25)),
        now=NOW + timedelta(milliseconds=25),
    )

    assert second.ack.status is IngressStatus.DUPLICATE
    assert second.events == ()
    assert state.snapshot().records[0] == first.events[0].record


def test_ocr_after_already_frozen_hook_is_suppressed_as_supporting_evidence():
    state = TextCoordinatorState(session_id="session")
    hook = observation("correct text", SourceKind.TEXTHOOK, "hook-1")
    hook = TextObservation(**{**hook.__dict__, "received_monotonic_ns": 1_000_000_000, "metadata": {}})
    first = state.ingest(hook, now=NOW, now_monotonic_ns=1_000_000_000)
    state.freeze(first.events[0].record.line_id, now=NOW + timedelta(milliseconds=100))
    ocr = observation(
        "correet text",
        SourceKind.OCR,
        "ocr-1",
        emitted_at=NOW + timedelta(seconds=1),
    )
    ocr = TextObservation(**{**ocr.__dict__, "received_monotonic_ns": 2_000_000_000, "metadata": {}})
    result = state.ingest(
        ocr,
        now=NOW + timedelta(seconds=1),
        now_monotonic_ns=2_000_000_000,
    )

    assert result.ack.status is IngressStatus.DUPLICATE
    assert len(state.snapshot().records) == 1


def test_unrelated_text_freezes_previous_then_appends_next():
    state = TextCoordinatorState(session_id="session")
    state.ingest(observation("first", SourceKind.TEXTHOOK, "1"), now=NOW)
    result = state.ingest(
        observation("completely different", SourceKind.TEXTHOOK, "2", emitted_at=NOW + timedelta(seconds=1)),
        now=NOW + timedelta(seconds=1),
    )

    assert [event.kind for event in result.events] == [TextEventKind.FROZEN, TextEventKind.APPENDED]
    assert result.events[0].record.state is TextRecordState.FROZEN
    assert result.events[1].record.stream_sequence == 2


def test_recurrence_after_an_intervening_line_always_gets_a_new_record():
    state = TextCoordinatorState(session_id="session")

    first = state.ingest(observation("repeated", SourceKind.MANUAL, "1"), now=NOW)
    middle = state.ingest(
        observation("intervening", SourceKind.MANUAL, "2", emitted_at=NOW + timedelta(milliseconds=10)),
        now=NOW + timedelta(milliseconds=10),
    )
    repeated = state.ingest(
        observation("repeated", SourceKind.MANUAL, "3", emitted_at=NOW + timedelta(milliseconds=20)),
        now=NOW + timedelta(milliseconds=20),
    )

    records = state.snapshot().records
    assert [record.text for record in records] == ["repeated", "intervening", "repeated"]
    assert [record.stream_sequence for record in records] == [1, 2, 3]
    assert first.ack.line_id != middle.ack.line_id != repeated.ack.line_id


def test_back_to_back_exact_duplicate_is_suppressed_after_same_source_window():
    state = TextCoordinatorState(session_id="session")
    first = state.ingest(
        observation("repeated", SourceKind.TEXTHOOK, "1", source_instance="hook-1"),
        now=NOW,
        now_monotonic_ns=1_000_000_000,
    )
    repeated = state.ingest(
        observation(
            "repeated",
            SourceKind.TEXTHOOK,
            "2",
            emitted_at=NOW + timedelta(minutes=1),
            source_instance="hook-1",
        ),
        now=NOW + timedelta(minutes=1),
        now_monotonic_ns=61_000_000_000,
    )

    assert repeated.ack.status is IngressStatus.DUPLICATE
    assert repeated.ack.line_id == first.ack.line_id
    assert repeated.events == ()
    assert len(state.snapshot().records) == 1


def test_back_to_back_exact_duplicate_is_suppressed_from_any_source():
    state = TextCoordinatorState(session_id="session")
    first = state.ingest(
        observation("repeated", SourceKind.TEXTHOOK, "1", source_instance="hook-1"),
        now=NOW,
        now_monotonic_ns=1_000_000_000,
    )
    repeated = state.ingest(
        observation(
            "repeated",
            SourceKind.MANUAL,
            "2",
            emitted_at=NOW + timedelta(minutes=1),
            source_instance="manual-entry",
        ),
        now=NOW + timedelta(minutes=1),
        now_monotonic_ns=61_000_000_000,
    )

    assert repeated.ack.status is IngressStatus.DUPLICATE
    assert repeated.ack.line_id == first.ack.line_id
    assert repeated.events == ()
    assert len(state.snapshot().records) == 1


def test_same_source_fragments_are_visible_immediately_then_joined_by_revision():
    state = TextCoordinatorState(session_id="session")
    first = observation("first fragment", SourceKind.TEXTHOOK, "1", source_instance="hook-4")
    first = TextObservation(**{**first.__dict__, "merge_fragments": True, "metadata": {}})
    second = observation(
        "second fragment",
        SourceKind.TEXTHOOK,
        "2",
        emitted_at=NOW + timedelta(milliseconds=25),
        source_instance="hook-4",
    )
    second = TextObservation(**{**second.__dict__, "merge_fragments": True, "metadata": {}})

    appended = state.ingest(first, now=NOW)
    revised = state.ingest(second, now=NOW + timedelta(milliseconds=25))

    assert appended.events[0].kind is TextEventKind.APPENDED
    assert revised.events[0].kind is TextEventKind.UPDATED
    assert revised.events[0].record.text == "first fragment\nsecond fragment"


def test_windows_speech_corrected_hypothesis_replaces_the_previous_revision():
    state = TextCoordinatorState(session_id="session")
    first = observation("first fragment", SourceKind.SPEECH_RECOGNITION, "speech-1", source_instance="speech-4")
    first = TextObservation(**{**first.__dict__, "merge_fragments": True, "metadata": {}})
    second = observation(
        "second fragment",
        SourceKind.SPEECH_RECOGNITION,
        "speech-2",
        emitted_at=NOW + timedelta(milliseconds=25),
        source_instance="speech-4",
    )
    second = TextObservation(**{**second.__dict__, "merge_fragments": True, "metadata": {}})

    appended = state.ingest(first, now=NOW)
    revised = state.ingest(second, now=NOW + timedelta(milliseconds=25))

    assert appended.events[0].kind is TextEventKind.APPENDED
    assert revised.events[0].kind is TextEventKind.UPDATED
    assert revised.events[0].record.source_kind is SourceKind.SPEECH_RECOGNITION
    assert revised.events[0].record.text == "second fragment"


def test_windows_speech_cumulative_hypotheses_remain_one_line():
    state = TextCoordinatorState(session_id="session")
    hypotheses = [
        "ダウドワ",
        "ダウトワが",
        "ダウドワが",
        "ダウド我が",
        "ダウド我が古き友よし",
        "ダウド我が古き友よしば",
        "ダウド我が古き友よしばら",
        "ダウド我が古き友よしばらく",
        "ダウド我が古き友よしばらくぶ",
        "ダウド我が古き友よしばらくぶりだが、",
        "ダウド我が古き友よしばらくぶりだが、再びお前に興味が向いたんでね。",
    ]

    latest = None
    for index, hypothesis in enumerate(hypotheses):
        item = observation(
            hypothesis,
            SourceKind.SPEECH_RECOGNITION,
            f"speech-{index}",
            emitted_at=NOW + timedelta(milliseconds=index * 25),
            source_instance="speech-4",
        )
        item = TextObservation(
            **{
                **item.__dict__,
                "merge_fragments": True,
                "revision_window_ms": 2500,
                "metadata": {"speech_final": index == len(hypotheses) - 1},
            }
        )
        latest = state.ingest(
            item,
            now=NOW + timedelta(milliseconds=index * 25),
            now_monotonic_ns=1_000_000_000 + index * 25_000_000,
        )

    assert latest is not None
    assert len(state.snapshot().records) == 1
    assert latest.events[0].record.text == hypotheses[-1]


def test_windows_speech_final_result_can_correct_a_longer_hypothesis():
    state = TextCoordinatorState(session_id="session")
    hypothesis = observation(
        "我が古き友よしばらくぶりだが余分な言葉",
        SourceKind.SPEECH_RECOGNITION,
        "speech-1",
        source_instance="speech-4",
    )
    hypothesis = TextObservation(
        **{
            **hypothesis.__dict__,
            "merge_fragments": True,
            "revision_window_ms": 2500,
            "metadata": {"speech_final": False},
        }
    )
    final = observation(
        "我が古き友よしばらくぶりだが",
        SourceKind.SPEECH_RECOGNITION,
        "speech-2",
        emitted_at=NOW + timedelta(milliseconds=25),
        source_instance="speech-4",
    )
    final = TextObservation(
        **{
            **final.__dict__,
            "merge_fragments": True,
            "revision_window_ms": 2500,
            "metadata": {"speech_final": True},
        }
    )

    state.ingest(hypothesis, now=NOW, now_monotonic_ns=1_000_000_000)
    revised = state.ingest(
        final,
        now=NOW + timedelta(milliseconds=25),
        now_monotonic_ns=1_025_000_000,
    )

    assert revised.events[0].kind is TextEventKind.UPDATED
    assert revised.events[0].record.text == final.raw_text


def test_duplicate_observation_id_is_idempotent():
    state = TextCoordinatorState(session_id="session")
    state.ingest(observation("hello", SourceKind.CLIPBOARD, "same"), now=NOW)
    duplicate = state.ingest(observation("different", SourceKind.MANUAL, "same"), now=NOW)

    assert duplicate.ack.status is IngressStatus.DUPLICATE
    assert duplicate.events == ()
    assert len(state.snapshot().records) == 1


def test_delayed_unacknowledged_observation_is_retained_in_live_stream():
    state = TextCoordinatorState(session_id="session")
    delayed = observation("old", SourceKind.TEXTHOOK, "delayed", emitted_at=NOW - timedelta(minutes=3))
    result = state.ingest(delayed, now=NOW)

    assert result.ack.status is IngressStatus.ACCEPTED
    assert result.events[0].record.text == "old"
    assert state.snapshot().records[0].observation_ids == ("delayed",)


def test_freeze_is_atomic_and_late_revision_becomes_a_new_line():
    state = TextCoordinatorState(session_id="session")
    appended = state.ingest(observation("draft", SourceKind.OCR, "1"), now=NOW)
    line_id = appended.events[0].record.line_id
    frozen = state.freeze(line_id, now=NOW + timedelta(milliseconds=10))
    late = state.ingest(
        observation("draft corrected", SourceKind.TEXTHOOK, "2", emitted_at=NOW + timedelta(milliseconds=20)),
        now=NOW + timedelta(milliseconds=20),
    )

    assert frozen[0].record.state is TextRecordState.FROZEN
    assert late.events[-1].kind is TextEventKind.APPENDED
    assert late.events[-1].record.line_id != line_id


def test_revision_deadline_uses_monotonic_time_not_wall_clock_changes():
    state = TextCoordinatorState(session_id="session")
    first = observation("draft", SourceKind.MANUAL, "1")
    first = TextObservation(
        **{
            **first.__dict__,
            "received_monotonic_ns": 1_000_000_000,
            "revision_window_ms": 100,
            "metadata": {},
        }
    )
    appended = state.ingest(first, now=NOW, now_monotonic_ns=1_000_000_000)

    # A backwards wall-clock adjustment must not freeze the line early.
    assert (
        state.freeze_due(
            now=NOW - timedelta(hours=1),
            now_monotonic_ns=1_099_000_000,
        )
        == ()
    )
    frozen = state.freeze_due(
        now=NOW - timedelta(hours=1),
        now_monotonic_ns=1_100_000_000,
    )

    assert frozen[0].record.line_id == appended.events[0].record.line_id
    assert frozen[0].record.state is TextRecordState.FROZEN


def test_snapshot_is_immutable_and_has_sequence_barrier():
    state = TextCoordinatorState(session_id="session")
    state.ingest(observation("one", SourceKind.CLIPBOARD, "1"), now=NOW)
    snapshot = state.snapshot()
    state.ingest(
        observation("two", SourceKind.CLIPBOARD, "2", emitted_at=NOW + timedelta(seconds=1)),
        now=NOW + timedelta(seconds=1),
    )

    assert snapshot.snapshot_sequence == 1
    assert tuple(record.text for record in snapshot.records) == ("one",)


def test_expiry_uses_first_seen_stream_time_not_old_capture_time():
    state = TextCoordinatorState(session_id="session")
    late_capture = observation(
        "late source result",
        SourceKind.OCR,
        "late",
        emitted_at=NOW,
    )
    late_capture = TextObservation(
        **{
            **late_capture.__dict__,
            "captured_at_utc": NOW - timedelta(minutes=10),
            "metadata": {},
        }
    )
    appended = state.ingest(late_capture, now=NOW)
    line_id = appended.events[0].record.line_id
    state.freeze(line_id, now=NOW + timedelta(milliseconds=10))

    assert state.expire_before(NOW - timedelta(seconds=1)) == ()
    expired = state.expire_before(NOW + timedelta(seconds=1))
    assert expired[0].kind is TextEventKind.EXPIRED
    assert expired[0].record.line_id == line_id
    assert expired[0].record.state is TextRecordState.EXPIRED
    assert state.snapshot().records == ()
    assert state.get(line_id) is None

    replacement = state.ingest(
        observation(
            "replacement",
            SourceKind.CLIPBOARD,
            "replacement",
            emitted_at=NOW + timedelta(seconds=2),
        ),
        now=NOW + timedelta(seconds=2),
    )
    replacement_id = replacement.events[-1].record.line_id
    frozen = state.freeze(replacement_id, now=NOW + timedelta(seconds=3))

    assert replacement.events[-1].record.stream_sequence == 2
    assert frozen[-1].record.state is TextRecordState.FROZEN


def test_concurrent_producers_receive_unique_authoritative_sequences():
    state = TextCoordinatorState(session_id="session")

    # State itself is intentionally single-owner; this lock models the actor mailbox's
    # linearization point while stressing producer-side observation construction.
    from threading import Lock

    lock = Lock()

    def ingest(index: int) -> int:
        item = observation(f"line {index}", SourceKind.MANUAL, str(index))
        with lock:
            return state.ingest(item, now=NOW + timedelta(milliseconds=index)).events[-1].record.stream_sequence

    with ThreadPoolExecutor(max_workers=10) as pool:
        sequences = list(pool.map(ingest, range(100)))

    assert sorted(sequences) == list(range(1, 101))
    assert len({record.line_id for record in state.snapshot().records}) == 100


def test_ten_producers_process_ten_thousand_observations_without_duplicates():
    actor = TextCoordinatorActor(state=TextCoordinatorState(session_id="stress"))
    actor.start()

    def produce(producer: int) -> list[int]:
        sequences = []
        for offset in range(1_000):
            index = producer * 1_000 + offset
            item = observation(f"line {index}", SourceKind.MANUAL, f"{producer}:{offset}")
            result = actor.ref.ask(IngestCommand(item), timeout=2)
            sequences.append(result.ack.stream_sequence)
        return sequences

    try:
        with ThreadPoolExecutor(max_workers=10) as pool:
            sequences = [sequence for batch in pool.map(produce, range(10)) for sequence in batch]
        snapshot = actor.ref.ask(SnapshotCommand(), timeout=2)
    finally:
        actor.stop(drain=True, timeout=5)

    assert sorted(sequences) == list(range(1, 10_001))
    assert len(snapshot.records) == 10_000
    assert len({record.line_id for record in snapshot.records}) == 10_000


def test_actor_schedules_the_full_cross_source_upgrade_window_for_ocr():
    scheduled: list[tuple[str, float]] = []
    actor = TextCoordinatorActor(
        state=TextCoordinatorState(session_id="scheduler"),
        schedule_freeze=lambda line_id, delay: scheduled.append((line_id, delay)),
    )
    actor.start()
    try:
        result = actor.ref.ask(IngestCommand(observation("draft", SourceKind.OCR, "ocr")), timeout=1)
    finally:
        actor.stop(drain=True, timeout=1)

    assert scheduled == [(result.ack.line_id, 5.0)]
