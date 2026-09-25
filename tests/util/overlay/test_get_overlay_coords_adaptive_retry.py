import asyncio
import copy
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from PIL import Image

from GameSentenceMiner.util.overlay import get_overlay_coords
from GameSentenceMiner.util.text_log import TextSource


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

    def run(text_at_capture, *, reference=None, source=TextSource.HOOKER, retries=5, ocr_duration=0.02):
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
        line = SimpleNamespace(id="line-1", text=reference, source=source) if reference else None
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
