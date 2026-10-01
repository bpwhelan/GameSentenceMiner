import asyncio
import copy
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from PIL import Image

from GameSentenceMiner.text_pipeline.coordinator import TextCoordinatorState
from GameSentenceMiner.text_pipeline.models import SourceKind, TextObservation
from GameSentenceMiner.util.overlay import get_overlay_coords
from GameSentenceMiner.util.text_log import GameText, TextSource


@pytest.fixture
def scan_workflow(monkeypatch):
    """Run real retry orchestration against fresh, timestamped fake captures."""
    clock = SimpleNamespace(now=0.0, send_duration=0.0, fail_capture_after=None)
    captures = []
    reads = []
    sleeps = []
    payloads = []
    options = SimpleNamespace(
        adaptive_ocr_retries=True,
        text_appears_instantly=False,
        use_text_filtering=False,
    )
    processor = get_overlay_coords.OverlayProcessor()
    processor.ocr_language = "en"
    processor.lens = processor.meikiocr = processor.screenai = None

    async def fake_sleep(delay):
        sleeps.append(delay)
        clock.now += delay

    async def send(payload):
        payloads.append(copy.deepcopy(payload))
        clock.now += clock.send_duration

    monkeypatch.setattr(
        get_overlay_coords, "time", SimpleNamespace(time=lambda: clock.now, monotonic=lambda: clock.now)
    )
    monkeypatch.setattr(
        get_overlay_coords,
        "asyncio",
        SimpleNamespace(sleep=fake_sleep, current_task=asyncio.current_task, CancelledError=asyncio.CancelledError),
    )
    monkeypatch.setattr(get_overlay_coords, "get_overlay_config", lambda: options)
    monkeypatch.setattr(processor, "_get_effective_engine", lambda: "oneocr")
    monkeypatch.setattr(processor, "_is_supplement_mode_enabled", lambda: False)
    monkeypatch.setattr(processor, "_is_sentence_recycled", lambda text: False)
    monkeypatch.setattr(processor, "_send_sentence_recycled_status", lambda **kwargs: None)
    monkeypatch.setattr(processor, "_get_overlay_minimum_character_size", lambda: 0)
    monkeypatch.setattr(processor, "_filter_local_ocr_results_by_language", lambda results: results)
    monkeypatch.setattr(processor, "_correct_ocr_text", lambda results, sentence: (results, False))
    monkeypatch.setattr(processor, "_correct_ocr_with_backlog", lambda results, sentence: results)
    monkeypatch.setattr(processor, "_convert_oneocr_results_to_percentages", lambda results, *args: results)
    monkeypatch.setattr(processor, "_send_word_coordinates_with_presence", send)
    monkeypatch.setattr(processor, "_record_overlay_scan", AsyncMock())

    def run(
        text_at_capture,
        *,
        reference=None,
        source=SourceKind.TEXTHOOK.value,
        retries=5,
        ocr_duration=0.02,
        scene="test-game",
        source_instance="test-hook",
        line=None,
    ):
        def capture():
            if clock.fail_capture_after is not None and len(captures) >= clock.fail_capture_after:
                return None, 0, 0, 100, 100
            captured = Image.new("RGB", (100, 100))
            captured.info["captured_at"] = clock.now
            captures.append(captured)
            return captured, 0, 0, 100, 100

        def recognize(captured, **kwargs):
            assert captured is captures[-1]
            reads.append(captured.info["captured_at"])
            text = text_at_capture(reads[-1], len(reads))
            clock.now += ocr_duration
            if text is None:
                return False, [], [], [], None, None
            return True, [text], [{"text": text, "words": []}], [(0, 0, 100, 100)], None, None

        recognize.readable_name = "Fake OCR"
        processor.oneocr = recognize
        monkeypatch.setattr(processor, "get_image_to_ocr", capture)
        line = line or (
            SimpleNamespace(id="line-1", text=reference, source=source, scene=scene, source_instance=source_instance)
            if reference
            else None
        )
        asyncio.run(processor._do_work(line=line, source=source, local_ocr_retry=retries))

    return SimpleNamespace(
        run=run,
        options=options,
        clock=clock,
        captures=captures,
        reads=reads,
        sleeps=sleeps,
        payloads=payloads,
        processor=processor,
    )


def test_adaptive_retry_scans_almost_immediately_on_growth(scan_workflow):
    scan = scan_workflow
    scan.run(lambda _at, index: ["a", "ab", "abc"][index - 1], reference="abc")

    assert scan.sleeps == pytest.approx([0.1, 0.01])
    assert scan.reads == pytest.approx([0.0, 0.12, 0.15])
    assert len({id(capture) for capture in scan.captures}) == 3
    assert [payload.get("is_final", False) for payload in scan.payloads] == [False, False, True]


def test_adaptive_retry_does_not_accept_two_early_identical_partial_reads(scan_workflow):
    scan = scan_workflow
    scan.run(lambda at, _index: "a" if at < 0.4 else "ab", reference="ab")

    assert len(scan.reads) > 2
    assert scan.payloads[-1]["data"][0]["text"] == "ab"
    assert scan.payloads[-1]["is_final"] is True


def test_adaptive_retry_keeps_scanning_growth_beyond_five_passes_with_a_time_limit(scan_workflow):
    scan = scan_workflow
    scan.run(lambda _at, index: "a" * index)

    assert len(scan.reads) > 5
    assert 4.0 <= scan.clock.now <= 4.1
    assert sum(payload.get("is_final", False) for payload in scan.payloads) == 1
    assert scan.payloads[-1]["is_final"] is True
    assert scan.payloads[-1]["data"][0]["text"] == "a" * len(scan.reads)


def test_adaptive_retry_waits_for_a_quiet_period_without_a_reference(scan_workflow):
    scan = scan_workflow
    scan.run(lambda _at, _index: "unchanging text")

    assert 1.0 <= scan.reads[-1] < 2.0
    assert scan.sleeps == pytest.approx([0.1, 0.2, 0.4, 0.8])
    assert scan.payloads[-1]["is_final"] is True


def test_adaptive_retry_backs_off_on_unrelated_changes_and_stays_bounded(scan_workflow):
    scan = scan_workflow
    scan.run(lambda _at, index: "abc" if index % 2 else "xyz")

    assert scan.sleeps[:5] == pytest.approx([0.1, 0.2, 0.4, 0.8, 1.0])
    assert all(delay <= 1.0 for delay in scan.sleeps)
    assert 4.0 <= scan.clock.now <= 4.1
    assert scan.payloads[-1]["is_final"] is True


def test_adaptive_retry_starts_no_capture_after_its_deadline(scan_workflow):
    scan = scan_workflow
    scan.run(lambda _at, index: "abc" if index % 2 else "xyz")

    assert all(captured_at < 4.02 for captured_at in scan.reads)


def test_adaptive_retry_finalizes_last_text_when_remaining_passes_are_blank(scan_workflow):
    scan = scan_workflow
    scan.run(lambda _at, index: "ab" if index == 1 else None)

    assert 4.0 <= scan.clock.now <= 4.1
    assert scan.payloads[-1]["is_final"] is True
    assert scan.payloads[-1]["data"][0]["text"] == "ab"


def test_adaptive_retry_finalizes_last_text_when_capture_fails(scan_workflow):
    scan = scan_workflow
    scan.clock.fail_capture_after = 2
    scan.run(lambda _at, index: "a" * index)

    assert len(scan.reads) == 2
    assert scan.payloads[-1]["is_final"] is True
    assert scan.payloads[-1]["data"][0]["text"] == "aa"


def test_adaptive_retry_yields_without_extra_delay_after_expensive_processing(scan_workflow):
    scan = scan_workflow
    scan.clock.send_duration = 0.2
    scan.run(lambda _at, index: ["a", "ab", "abc"][index - 1], reference="abc")

    assert scan.sleeps == [0.0, 0.0]
    assert scan.payloads[-1]["is_final"] is True


def test_adaptive_retry_finalizes_if_the_deadline_expires_during_send(scan_workflow):
    scan = scan_workflow
    scan.clock.send_duration = 5.0
    scan.run(lambda _at, index: "a" * index)

    assert len(scan.reads) == 1
    assert [payload.get("is_final", False) for payload in scan.payloads] == [False, True]


def test_adaptive_retry_does_not_count_ocr_time_as_agreement_between_captures(scan_workflow):
    scan = scan_workflow
    scan.run(lambda _at, _index: "ab", ocr_duration=0.6)

    assert len(scan.reads) == 3
    assert scan.reads == pytest.approx([0.0, 0.7, 1.5])


def test_adaptive_retry_finishes_immediately_if_the_known_sentence_is_already_present(scan_workflow):
    scan = scan_workflow
    scan.run(lambda _at, _index: "abc", reference="abc")

    assert len(scan.reads) == 1
    assert scan.sleeps == []
    assert scan.payloads[-1]["is_final"] is True


def test_adaptive_retry_captures_the_missing_ending_from_the_reported_vlr_line(scan_workflow, monkeypatch):
    scan = scan_workflow
    sentence = "そこでみんなには、これからボディチェックを受けてもらおうと思う。"
    # The runtime log stopped at pass six, after 1.2 seconds. The speaker name
    # made the unfinished dialogue long enough to pass the fuzzy length guard.
    frames = [
        "ファイそこ",
        "ファイそこでみんなに",
        "ファイそこでみんなには、これか",
        "ファイそこでみんなには、これからボディ",
        "ファイそこでみんなには、これからボディチェックを",
        "ファイそこでみんなには、これからボディチェックを受けてもら",
        "ファイそこでみんなには、これからボディチェックを受けてもらおうと",
        "ファイ" + sentence,
    ]
    monkeypatch.setattr(
        scan.processor,
        "_correct_ocr_text",
        get_overlay_coords.OverlayProcessor._correct_ocr_text.__get__(scan.processor),
    )
    scan.run(lambda _at, index: frames[index - 1], reference=sentence, ocr_duration=0.16)

    assert len(scan.reads) == len(frames)
    assert scan.payloads[-1]["data"][0]["text"] == frames[-1]
    assert [payload.get("is_final", False) for payload in scan.payloads] == [False] * 7 + [True]


@pytest.mark.parametrize("missing_characters", [1, 2, 3, 5])
@pytest.mark.parametrize("speaker", ["", "ファイ"])
@pytest.mark.parametrize("footer", ["", "医務室"])
def test_adaptive_retry_does_not_finish_on_a_fuzzy_partial_sentence(scan_workflow, missing_characters, speaker, footer):
    scan = scan_workflow
    sentence = "そこでみんなにはこれからボディチェックを受けてもらおうと思う"
    incomplete = speaker + sentence[:-missing_characters] + footer
    complete = speaker + sentence + footer
    scan.run(lambda _at, index: incomplete if index == 1 else complete, reference=sentence)

    assert len(scan.reads) == 2
    assert scan.payloads[-1]["data"][0]["text"] == complete
    assert [payload.get("is_final", False) for payload in scan.payloads] == [False, True]


def test_adaptive_retry_waits_for_quiet_agreement_when_full_text_has_uncorrected_misreads(scan_workflow):
    scan = scan_workflow
    sentence = "そこでみんなにはこれからボディチェックを受けてもらおうと思う"
    misread = "ファイ" + sentence.replace("受", "授")
    scan.run(lambda _at, _index: misread, reference=sentence)

    assert 1.0 <= scan.reads[-1] < 2.0
    assert scan.payloads[-1]["is_final"] is True


def test_adaptive_retry_still_finishes_immediately_after_safe_ocr_correction(scan_workflow, monkeypatch):
    scan = scan_workflow
    sentence = "そこでみんなにはこれからボディチェックを受けてもらおうと思う"
    monkeypatch.setattr(
        scan.processor,
        "_correct_ocr_text",
        get_overlay_coords.OverlayProcessor._correct_ocr_text.__get__(scan.processor),
    )
    scan.run(lambda _at, _index: "ファイ" + sentence.replace("受", "授"), reference=sentence)

    assert len(scan.reads) == 1
    assert scan.payloads[-1]["is_final"] is True


def test_legacy_retries_keep_fuzzy_sentence_convergence(scan_workflow):
    scan = scan_workflow
    scan.options.adaptive_ocr_retries = False
    sentence = "そこでみんなにはこれからボディチェックを受けてもらおうと思う"
    scan.run(lambda _at, _index: "ファイ" + sentence.replace("受", "授"), reference=sentence)

    assert len(scan.reads) == 1
    assert scan.payloads[-1]["is_final"] is True


@pytest.mark.parametrize("blank", [None, ""])
def test_adaptive_retry_resets_growth_and_agreement_after_a_blank_pass(scan_workflow, blank):
    scan = scan_workflow
    scan.run(lambda _at, index: ["a", "ab", blank, "ab", "abc"][index - 1], reference="abc")

    assert scan.sleeps == pytest.approx([0.1, 0.01, 0.1, 0.2])
    assert scan.payloads[-1]["data"][0]["text"] == "abc"


def test_adaptive_retry_ignores_width_and_punctuation_when_detecting_growth(scan_workflow):
    scan = scan_workflow
    scan.run(lambda _at, index: ["Ａ!", "AB?", "ABC"][index - 1], reference="ABC")

    assert scan.sleeps == pytest.approx([0.1, 0.01])


def test_disabling_adaptive_retry_preserves_five_pass_limit_and_delays(scan_workflow):
    scan = scan_workflow
    scan.options.adaptive_ocr_retries = False
    scan.run(lambda _at, index: "a" * index)

    assert len(scan.reads) == 5
    assert scan.sleeps == pytest.approx([1.0] * 4)
    assert scan.payloads[-1]["is_final"] is True


@pytest.mark.parametrize(
    ("source", "retries", "instant", "expected_reads"),
    [
        (TextSource.HOOKER, 0, False, 1),
        (TextSource.OCR, 5, False, 1),
        (TextSource.MANUAL, 5, False, 1),
        (TextSource.HOOKER, 5, True, 2),
    ],
)
def test_adaptive_retry_respects_single_pass_sources_and_instant_mode(
    scan_workflow, source, retries, instant, expected_reads
):
    scan = scan_workflow
    scan.options.text_appears_instantly = instant
    scan.run(lambda _at, index: "a" * index, reference="xyz", source=source, retries=retries)

    assert len(scan.reads) == expected_reads
    assert scan.payloads[-1]["is_final"] is True


def test_adaptive_retry_cancellation_during_fast_retry_stops_work(scan_workflow, monkeypatch):
    scan = scan_workflow
    fake_sleep = get_overlay_coords.asyncio.sleep

    async def cancel_fast_retry(delay):
        if delay < 0.02:
            raise asyncio.CancelledError
        await fake_sleep(delay)

    monkeypatch.setattr(get_overlay_coords.asyncio, "sleep", cancel_fast_retry)
    with pytest.raises(asyncio.CancelledError):
        scan.run(lambda _at, index: "a" * index)

    assert len(scan.reads) == 2
    scan.processor._record_overlay_scan.assert_not_called()


@pytest.mark.parametrize(
    ("previous", "current", "growing"),
    [
        ("a", "ab", True),
        ("MENUabEND", "MENUabcdEND", True),
        ("abcd", "abXcdY", True),
        ("", "abc", False),
        ("abc", "", False),
        ("abc", "abc", False),
        ("abc", "ab", False),
        ("abc", "axcd", False),
        ("abc", "xyzxyz", False),
        ("abc", "cbaxyz", False),
    ],
)
def test_adaptive_retry_requires_preserved_text_in_order(previous, current, growing):
    from GameSentenceMiner.util.overlay.ocr_retry import AdaptiveOCRRetryState

    state = AdaptiveOCRRetryState()
    state.observe(previous, captured_at=0)
    state.observe(current, captured_at=0.1)

    assert (state.retry_delay == 0.01) is growing


def learn_initial_delay(scan, *, early_text="", reference="expected sentence"):
    for _ in range(3):
        old_count = len(scan.reads)
        scan.run(
            lambda _at, index, first=old_count + 1: early_text if index == first else reference,
            reference=reference,
        )
        assert len(scan.reads) == old_count + 2
    assert scan.processor._initial_scan_delay.delay == pytest.approx(0.005)


@pytest.mark.parametrize("adaptive", [False, True])
@pytest.mark.parametrize("instant", [False, True])
@pytest.mark.parametrize("source", [TextSource.HOOKER, SourceKind.TEXTHOOK.value])
def test_initial_scan_delay_learns_from_existing_retries_without_a_toggle(scan_workflow, adaptive, instant, source):
    scan = scan_workflow
    scan.options.adaptive_ocr_retries = adaptive
    scan.options.text_appears_instantly = instant
    for late_reveal in [True, False, True, False, True]:
        old_count = len(scan.reads)
        started_at = scan.clock.now
        scan.run(
            lambda _at, index, first=old_count + 1, late=late_reveal: (
                "前の台詞" if late and index == first else "expected sentence"
            ),
            reference="expected sentence",
            source=source,
        )
        assert scan.reads[old_count] == started_at
        assert len(scan.reads) - old_count == (2 if late_reveal else 1)

    started_at = scan.clock.now
    scan.run(lambda _at, _index: "expected sentence", reference="expected sentence", source=source)
    assert scan.reads[-1] - started_at == pytest.approx(0.005)
    assert len(scan.reads) == 9
    assert scan.payloads[-1]["is_final"] is True


def test_initial_scan_delay_converges_near_render_time_using_fewer_existing_scans(scan_workflow):
    scan = scan_workflow
    reference = "expected sentence"
    first_captures = []
    scan_counts = []
    for _ in range(70):
        started_at = scan.clock.now
        old_count = len(scan.reads)
        scan.run(
            lambda at, _index, start=started_at: "話者" if at - start < 0.055 else reference,
            reference=reference,
            ocr_duration=0.15,
        )
        first_captures.append(scan.reads[old_count] - started_at)
        scan_counts.append(len(scan.reads) - old_count)

    assert first_captures[0] == 0
    assert all(0.05 <= delay <= 0.065 for delay in first_captures[-10:])
    assert sum(scan_counts[-10:]) <= 13
    assert max(scan_counts) <= 2


@pytest.mark.parametrize("early_text", [None, "", "ヨシュア"])
def test_initial_scan_delay_learns_from_blank_or_speaker_before_full_dialogue(scan_workflow, early_text):
    scan = scan_workflow
    reference = "かさばるしどうしようかな"
    learn_initial_delay(scan, early_text=early_text, reference=reference)
    started_at = scan.clock.now
    scan.run(lambda _at, _index: reference, reference=reference)

    assert len(scan.reads) == 7
    assert scan.reads[-1] - started_at == pytest.approx(0.005)


@pytest.mark.parametrize("reference", [None, "expected sentence"])
@pytest.mark.parametrize("source", [TextSource.OCR, TextSource.HOTKEY, TextSource.MANUAL, None])
def test_learned_delay_does_not_slow_manual_or_periodic_scans(scan_workflow, source, reference):
    scan = scan_workflow
    learn_initial_delay(scan)
    started_at = scan.clock.now
    scan.run(lambda _at, _index: "expected sentence", reference=reference, source=source, retries=0)

    assert scan.reads[-1] == started_at
    assert len(scan.reads) == 7


@pytest.mark.parametrize("change", [{"scene": "other-game"}, {"source_instance": "other-hook"}])
def test_initial_scan_delay_resets_when_the_game_or_hook_changes(scan_workflow, change):
    scan = scan_workflow
    learn_initial_delay(scan)
    started_at = scan.clock.now
    scan.run(lambda _at, _index: "expected sentence", reference="expected sentence", **change)

    assert scan.reads[-1] == started_at


def test_initial_scan_delay_is_cancellable_before_capturing(scan_workflow, monkeypatch):
    scan = scan_workflow
    learn_initial_delay(scan)

    async def cancel(delay):
        raise asyncio.CancelledError

    monkeypatch.setattr(get_overlay_coords.asyncio, "sleep", cancel)
    with pytest.raises(asyncio.CancelledError):
        scan.run(lambda _at, _index: "expected sentence", reference="expected sentence")
    assert len(scan.reads) == 6


def test_initial_scan_delay_counts_time_already_spent_preparing_the_scan(scan_workflow, monkeypatch):
    scan = scan_workflow
    learn_initial_delay(scan)

    def prepare(_text):
        scan.clock.now += 0.05
        return False

    monkeypatch.setattr(scan.processor, "_is_sentence_recycled", prepare)
    started_at = scan.clock.now
    old_sleeps = len(scan.sleeps)
    scan.run(lambda _at, _index: "expected sentence", reference="expected sentence")

    assert scan.reads[-1] - started_at == pytest.approx(0.05)
    assert len(scan.sleeps) == old_sleeps


def test_cancelled_unconfirmed_line_does_not_teach_an_initial_delay(scan_workflow, monkeypatch):
    scan = scan_workflow
    fake_sleep = get_overlay_coords.asyncio.sleep

    async def cancel(delay):
        raise asyncio.CancelledError

    monkeypatch.setattr(get_overlay_coords.asyncio, "sleep", cancel)
    with pytest.raises(asyncio.CancelledError):
        scan.run(lambda _at, _index: "", reference="expected sentence")
    monkeypatch.setattr(get_overlay_coords.asyncio, "sleep", fake_sleep)
    started_at = scan.clock.now
    scan.run(lambda _at, _index: "expected sentence", reference="expected sentence")

    assert scan.reads[-1] == started_at
    assert len(scan.reads) == 2


def test_projected_live_hook_lines_learn_delay_and_log_each_outcome(scan_workflow, monkeypatch):
    scan = scan_workflow
    state = TextCoordinatorState(session_id="test-session")
    game_log = GameText()
    now = datetime(2026, 9, 28, 21, 8, tzinfo=timezone.utc)
    summaries = []
    monkeypatch.setattr(
        get_overlay_coords.logger, "info", lambda message, *args: summaries.append(message.format(*args))
    )

    def project(text, observation_id):
        result = state.ingest(
            TextObservation(
                observation_id=observation_id,
                source_kind=SourceKind.normalize("texthook"),
                source_instance="sora_1st.exe:#agent",
                source_display_name="agent · sora_1st.exe · #agent",
                raw_text=text,
                captured_at_utc=now,
                emitted_at_utc=now,
                received_at_utc=now,
                received_monotonic_ns=1,
                revision_window_ms=0,
                metadata={"scene": "Trails in the Sky 1st Chapter"},
            ),
            now=now,
        )
        return game_log.upsert_authoritative_line(result.events[0].record)

    line = project("あーあ、完全にグロッキーね。", "line-1")
    assert line.source == "texthook"
    scan.run(lambda _at, index: "オリビエ" if index == 1 else line.text, line=line, ocr_duration=0.15)
    started_at = scan.clock.now
    line = project("いやあ、飲んだ飲んだ。", "line-2")
    scan.run(lambda _at, _index: line.text, line=line, ocr_duration=0.15)

    assert scan.reads[-1] == started_at
    assert len(scan.reads) == 3
    for index, text in enumerate(["これは次の台詞です。", "最後の確認の台詞です。"], start=3):
        line = project(text, f"line-{index}")
        old_count = len(scan.reads)
        scan.run(
            lambda _at, index, first=old_count + 1, text=line.text: "オリビエ" if index == first else text,
            line=line,
            ocr_duration=0.15,
        )
    started_at = scan.clock.now
    line = project("もう一つの台詞だ。", "line-5")
    scan.run(lambda _at, _index: line.text, line=line, ocr_duration=0.15)

    assert scan.reads[-1] - started_at == pytest.approx(0.005)
    assert len(scan.reads) == 8
    completed = [message for message in summaries if message.startswith("Overlay OCR complete:")]
    assert len(completed) == 5
    assert "source: texthook" in completed[0]
    assert "initial delay: 0ms -> 0ms" in completed[0]
    assert "initial match: 0%" in completed[0]
    assert "timing: late_reveal" in completed[0]
    assert "first capture: 0ms, ready capture: 250ms" in completed[0]
    assert "initial delay: 0ms -> 0ms" in completed[1]
    assert "initial match: 100%" in completed[1]
    assert "timing: first_capture_ready" in completed[1]
    assert "initial delay: 0ms -> 0ms" in completed[2]
    assert "initial delay: 0ms -> 5ms" in completed[3]
    assert "initial delay: 5ms -> 5ms" in completed[4]


def test_initial_scan_delay_stays_at_or_below_150ms_even_when_the_game_needs_longer(scan_workflow):
    scan = scan_workflow
    for _ in range(100):
        started_at = scan.clock.now
        old_count = len(scan.reads)
        scan.run(
            lambda at, _index, start=started_at: "話者" if at - start < 0.3 else "expected sentence",
            reference="expected sentence",
            ocr_duration=0.15,
        )

        assert scan.reads[old_count] - started_at <= 0.15 + 1e-9
        assert len(scan.reads) - old_count >= 2

    assert scan.reads[old_count] - started_at == pytest.approx(0.15)


def test_substantial_partial_text_does_not_delay_the_next_line(scan_workflow):
    scan = scan_workflow
    reference = "abcdefghijklmnopqrst"
    scan.run(lambda _at, index: "cdefghijklmnopqrst" if index == 1 else reference, reference=reference)
    started_at = scan.clock.now
    scan.run(lambda _at, _index: reference, reference=reference)

    assert scan.reads[-1] == started_at
    assert len(scan.reads) == 3
