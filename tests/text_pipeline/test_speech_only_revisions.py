from dataclasses import replace
from datetime import timedelta

import pytest

from GameSentenceMiner.text_pipeline.coordinator import IngestCommand, TextCoordinatorActor, TextCoordinatorState
from GameSentenceMiner.text_pipeline.models import IngressStatus, SourceKind, TextEventKind, TextRecordState
from tests.text_pipeline.test_text_coordinator import NOW, observation


@pytest.mark.parametrize("source", [kind for kind in SourceKind if kind is not SourceKind.SPEECH_RECOGNITION])
def test_non_speech_lines_arrive_complete_without_a_revision_window(source):
    state = TextCoordinatorState()
    item = replace(observation("Completed dialogue", source, "first"), merge_fragments=True, revision_window_ms=5000)
    result = state.ingest(item, now=NOW)
    assert [event.kind for event in result.events] == [TextEventKind.APPENDED]
    record = result.events[0].record
    assert record.state is TextRecordState.FROZEN
    assert record.finalized_at_utc == NOW
    assert record.revision == 1
    assert state.freeze(record.line_id) == ()
    assert state.freeze_due(now=NOW + timedelta(seconds=10), now_monotonic_ns=10_000_000_000) == ()


def test_non_speech_payloads_are_never_merged_into_an_existing_line():
    state = TextCoordinatorState()
    first = state.ingest(replace(observation("First fragment", SourceKind.TEXTHOOK, "one"), merge_fragments=True))
    second = state.ingest(replace(observation("Second fragment", SourceKind.TEXTHOOK, "two"), merge_fragments=True))
    assert first.ack.line_id != second.ack.line_id
    assert [record.text for record in state.snapshot().records] == ["First fragment", "Second fragment"]
    assert [event.kind for event in second.events] == [TextEventKind.APPENDED]


@pytest.mark.parametrize("sources", [(SourceKind.OCR, SourceKind.TEXTHOOK), (SourceKind.TEXTHOOK, SourceKind.OCR)])
def test_cross_source_duplicates_do_not_rewrite_an_admitted_line(sources):
    state = TextCoordinatorState()
    first = state.ingest(observation("I love you", sources[0], "one"), now=NOW)
    second = state.ingest(observation("I Iove you", sources[1], "two"), now=NOW)
    assert second.ack.status is IngressStatus.DUPLICATE
    assert second.ack.line_id == first.ack.line_id
    assert second.events == ()
    assert state.snapshot().records[0] == first.events[0].record


def test_normal_input_does_not_interrupt_an_open_speech_hypothesis():
    state = TextCoordinatorState()
    first = replace(observation("Speech draft", SourceKind.SPEECH_RECOGNITION, "one"), merge_fragments=True)
    state.ingest(first, now=NOW)
    normal = state.ingest(observation("Game dialogue", SourceKind.TEXTHOOK, "normal"), now=NOW)
    revised = state.ingest(replace(first, observation_id="two", raw_text="Speech correction"), now=NOW)
    assert normal.events[-1].record.state is TextRecordState.FROZEN
    assert revised.ack.line_id != normal.ack.line_id
    assert revised.events[0].kind is TextEventKind.UPDATED
    assert revised.events[0].record.text == "Speech correction"
    assert len(state.snapshot().records) == 2


def test_only_speech_schedules_a_finalization_timer():
    scheduled = []
    actor = TextCoordinatorActor(schedule_freeze=lambda line_id, delay: scheduled.append((line_id, delay)))
    actor.start()
    try:
        for source in SourceKind:
            item = replace(observation(source.value, source, source.value), revision_window_ms=2500)
            result = actor.ref.ask(IngestCommand(item), timeout=1)
            if source is SourceKind.SPEECH_RECOGNITION:
                speech_id = result.ack.line_id
    finally:
        actor.stop(drain=True, timeout=1)
    assert scheduled == [(speech_id, 2.5)]


def test_shutdown_finalizes_speech_even_when_a_completed_line_arrived_after_it():
    from GameSentenceMiner.text_pipeline.runtime import AuthoritativeTextRuntime

    events = []
    runtime = AuthoritativeTextRuntime(events.append)
    try:
        speech = runtime.ingest(
            replace(observation("Speech draft", SourceKind.SPEECH_RECOGNITION, "speech"), revision_window_ms=60_000)
        )
        runtime.ingest(observation("Completed game dialogue", SourceKind.TEXTHOOK, "hook"))
    finally:
        assert runtime.stop()
    assert any(event.kind is TextEventKind.FROZEN and event.record.line_id == speech.ack.line_id for event in events)
