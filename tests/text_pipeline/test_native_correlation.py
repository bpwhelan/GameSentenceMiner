import random
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from itertools import count
from types import SimpleNamespace

import pytest

from GameSentenceMiner.native import ocr, text_correlation
from GameSentenceMiner.text_pipeline.coordinator import TextCoordinatorState
from GameSentenceMiner.text_pipeline.models import SourceKind, TextObservation, TextRecordState

requires_classifier = pytest.mark.skipif(
    not hasattr(ocr._extension, "classify_dialogue"), reason="dialogue extension unavailable"
)
requires_detector = pytest.mark.skipif(
    not hasattr(ocr._extension, "DialogueSkipDetector"), reason="skip detector unavailable"
)


@requires_classifier
def test_rust_and_reference_match_at_window_and_similarity_boundaries():
    classify = ocr._extension.classify_dialogue
    state = TextCoordinatorState()
    now = datetime.now(UTC)
    base = TextObservation("obs", SourceKind.OCR, "first", "日本語", now, now, now, 10)
    record = state.ingest(base).events[-1].record
    rng = random.Random(720)
    sources = [SourceKind.OCR, SourceKind.TEXTHOOK, SourceKind.SPEECH_RECOGNITION]
    samples = ["読む\x1c本", "読む　本", "読む", "読む本", "読む本\t先", "abcdefghij", "abcXXXXhij", "𠀀", " "]
    for _ in range(4000):
        text = rng.choice(samples)
        line = replace(
            record,
            text=rng.choice(samples),
            source_kind=rng.choice(sources),
            state=rng.choice([TextRecordState.FROZEN, TextRecordState.PROVISIONAL]),
            scene=rng.choice(["", "one", "two"]),
            stats_status=rng.choice(["accepted", "skipped"]),
        )
        open_line = replace(line, source_kind=SourceKind.SPEECH_RECOGNITION, state=TextRecordState.PROVISIONAL)
        obs = replace(
            base,
            raw_text=text,
            source_kind=rng.choice(sources),
            metadata={"scene": "one", "speech_final": rng.randrange(2), "skip_landing_confirmed": rng.randrange(2)},
            source_instance=rng.choice(["first", "second"]),
            remove_matching_prefix=True,
            merge_fragments=bool(rng.randrange(2)),
        )
        prior = (rng.choice(samples), rng.choice(["another", line.line_id]))
        clock = rng.choice([10, 110, 111, 2_000_000_010, 5_000_000_010, 5_000_000_011])
        state._open_deadline_monotonic_ns = 110
        state.cross_source_similarity = rng.choice([0, 50, 60, 70, 90, 100])
        expected = state._classify_reference(obs, text, clock, line, open_line, prior)
        got = text_correlation.decide(
            classify,
            obs,
            text,
            "one",
            clock,
            line,
            open_line,
            prior,
            110,
            (2_000_000_000, 5_000_000_000, state.cross_source_similarity),
        )
        assert got == expected, (obs, line, expected, got)


def test_lone_surrogate_falls_back_before_appending_or_revising():
    now = datetime.now(UTC)
    state = TextCoordinatorState()
    obs = TextObservation("odd", SourceKind.OCR, "ocr", "\ud800", now, now, now, 1)
    first = state.ingest(obs)
    second = state.ingest(replace(obs, observation_id="again"))
    assert first.events[0].record.text == obs.raw_text
    assert second.ack.line_id == first.ack.line_id
    assert state.metrics.duplicates == 1


@requires_classifier
def test_cross_source_decisions_match_the_configured_score_on_its_boundary():
    from rapidfuzz import fuzz

    classify = ocr._extension.classify_dialogue
    for length in range(2, 97):
        before = "𠀀" * length
        newest = (before, "ocr", "a", "", 0, False, True, False)
        for same in range(length):
            after = before[:same] + "文" * (length - same)
            incoming = (after, "texthook", "b", "", 0, False, False, False, False, False)
            expected = fuzz.ratio(before, after)
            for threshold in (70, int(expected), int(expected) + 1):
                action, _, _ = classify(incoming, newest, None, None, None, (0, 1, threshold))
                assert (action == "duplicate_newest") == (expected >= threshold), (length, same, expected, threshold)


@requires_detector
def test_skip_detector_matches_reference_through_replacements_and_quiet(monkeypatch):
    from GameSentenceMiner.text_pipeline import skip_detection as skip

    monkeypatch.setenv("GSM_NATIVE_TEXT_MODE", "native")
    native = skip.make_detector()
    assert not isinstance(native, skip.SkipDetector)
    reference = skip.SkipDetector()
    rng = random.Random(3187)
    for i in range(1200):
        if i % 113 == 0:
            reference.reset()
            native.reset()
        source = (SourceKind.TEXTHOOK, "source" + str(rng.randrange(4)))
        text = rng.choice(["日本語。", "ｶﾞ𠀀１1", "a\ud800", "こ\u3099", "·Ⅳ☂", "𠮷"]) * rng.randrange(1, 220)
        now = i * 37_000_000
        control = rng.randrange(6) == 0
        assert native.observe(source, text, now, skip_control=control) == reference.observe(
            source, text, now, skip_control=control
        )
        assert (native.suspended, native.confirmed) == (reference.suspended, reference.confirmed)
        assert (native.reason, native.quiet_ns) == (reference.reason, reference.quiet_ns)
        for later in (now, now + 1_500_000_000, now + 2_500_000_001):
            assert native.quiet(later) == reference.quiet(later)


@requires_detector
def test_fast_normalization_matches_python_for_every_admitted_codepoint():
    from GameSentenceMiner.text_pipeline.skip_detection import _compact_reference

    compact = ocr._extension.compact_dialogue
    for value in range(0x110000):
        ch = chr(value)
        result = compact(ch)
        if result is not None:
            assert result == _compact_reference(ch), hex(value)
    assert compact("カ\u3099") is None
    assert compact("\ud800") is None


@pytest.mark.parametrize("reply", [None, ["unknown", "", None], ["duplicate_open", "bad", None], TimeoutError()])
def test_incomplete_broker_decision_evaluates_once_locally(monkeypatch, reply):
    from unittest.mock import Mock

    from GameSentenceMiner.util.communication import bus_client

    bus = Mock()
    if isinstance(reply, Exception):
        bus.request.side_effect = reply
    else:
        bus.request.return_value = reply
    monkeypatch.setattr(bus_client, "get_bus", lambda: bus)
    state = TextCoordinatorState()
    state._classify = text_correlation._desktop
    now = datetime.now(UTC)
    result = state.ingest(TextObservation("a", SourceKind.MANUAL, "manual", "a", now, now, now, 1))
    assert result.ack.status.value == "accepted" and len(state.snapshot().records) == 1
    bus.request.assert_called_once()


@requires_detector
def test_complete_acknowledgments_and_record_snapshots_match_the_reference(monkeypatch):
    from GameSentenceMiner.text_pipeline import coordinator

    def replay(mode):
        monkeypatch.setenv("GSM_NATIVE_TEXT_MODE", mode)
        ids = count(1)
        monkeypatch.setattr(coordinator, "uuid", SimpleNamespace(uuid4=lambda: f"line-{next(ids)}"))
        state = TextCoordinatorState(session_id="fixture", skip_detection=True)
        stamp = datetime(2026, 11, 19, tzinfo=UTC)
        outputs = []
        sources = [
            (SourceKind.TEXTHOOK, "日本語が続く"),
            (SourceKind.OCR, "日本誤が続く"),
            (SourceKind.TEXTHOOK, "日本語が続く　次の台詞"),
            (SourceKind.TEXTHOOK, "日本語が続く　次の台詞"),
            (SourceKind.SPEECH_RECOGNITION, "it"),
            (SourceKind.MANUAL, "手動"),
            (SourceKind.SPEECH_RECOGNITION, "it is"),
            (SourceKind.SPEECH_RECOGNITION, "it"),
            (SourceKind.SPEECH_RECOGNITION, "it is done"),
        ]
        for i in range(72):
            kind, text = sources[i % len(sources)]
            at = stamp + timedelta(milliseconds=i * 60)
            obs = TextObservation(
                str(i),
                kind,
                kind.value,
                text,
                at,
                at,
                at,
                1 + i * 60_000_000,
                source_display_name=kind.value,
                copy_to_clipboard=i % 4 == 0,
                source_sequence=i,
                merge_fragments=True,
                remove_matching_prefix=True,
                revision_window_ms=400,
                metadata={"scene": str(i // 18), "speech_final": i % 9 == 8, "dict_from_ocr": {"box": [4, 2, 3, 1]}},
            )
            outputs.append(state.ingest(obs, now=at))
            if i % 7 == 0:
                outputs.append(state.ingest(obs, now=at))
        outputs.extend(
            [
                state.freeze_due(now=stamp + timedelta(seconds=9), now_monotonic_ns=9_000_000_000),
                state.poll_skip_detection(12_000_000_000),
                state.snapshot(),
                state.expire_before(stamp + timedelta(seconds=20)),
                state.snapshot(),
                state.metrics,
            ]
        )
        return outputs

    assert replay("native") == replay("python")


@requires_detector
def test_empty_text_cannot_evict_an_active_source_and_real_sources_are_bounded(monkeypatch):
    from GameSentenceMiner.text_pipeline.skip_detection import SkipDetector, make_detector

    monkeypatch.setenv("GSM_NATIVE_TEXT_MODE", "native")
    for detector in (make_detector(), SkipDetector()):
        first = (SourceKind.OCR, "first")
        assert detector.observe(first, "読書", 1)
        for i in range(50):
            assert not detector.observe((SourceKind.OCR, str(i)), "。", i + 2)
        assert not detector.observe(first, "読書", 100)
        for i in range(32):
            assert detector.observe((SourceKind.OCR, str(i)), "別", 101 + i)
        assert detector.observe(first, "読書", 200)
