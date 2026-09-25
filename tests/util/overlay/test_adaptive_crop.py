import asyncio
import copy
from types import SimpleNamespace
from unittest.mock import AsyncMock

from PIL import Image

from GameSentenceMiner.util.overlay import get_overlay_coords
from GameSentenceMiner.util.overlay.adaptive_crop import AdaptiveOverlayCrop, shift_ocr_boxes
from GameSentenceMiner.util.text_log import TextSource


def _line(text, x1, y1, x2, y2):
    return {
        "text": text,
        "bounding_rect": {"x1": x1, "y1": y1, "x2": x2, "y2": y1, "x3": x2, "y3": y2, "x4": x1, "y4": y2},
        "words": [],
    }


def test_reference_follows_dialogue_in_second_screen_region():
    crop = AdaptiveOverlayCrop()
    size = (2000, 1200)
    assert crop.region_for_frame(size, (size, "scene"), 0.0) is None

    crop.observe(
        [
            _line("謎の背景文字", 300, 180, 1400, 400),
            _line("おまえらの目の前にある", 220, 915, 1100, 980),
            _line("発光した扉だ", 220, 995, 870, 1050),
        ],
        size,
        "おまえらの目の前にある発光した扉だ",
        0.0,
        full_scan=True,
    )

    region = crop.region_for_frame(size, (size, "scene"), 0.1)
    assert region is not None
    assert region[0] <= 220 and region[2] >= 1800
    assert region[1] > 400 and region[3] >= 1050
    assert (region[2] - region[0]) * (region[3] - region[1]) < size[0] * size[1] / 2


def test_crop_reacquires_when_text_moves_or_capture_changes():
    crop = AdaptiveOverlayCrop()
    size = (1000, 600)
    crop.region_for_frame(size, (size, "scene-a"), 0.0)
    crop.observe([_line("old", 100, 440, 350, 490)], size, "old", 0.0, full_scan=True)
    region = crop.region_for_frame(size, (size, "scene-a"), 0.1)

    assert region is not None
    assert crop.needs_full_scan([_line("old", 100, 440, 350, 490)], "new dialogue", region)
    assert crop.region_for_frame(size, (size, "scene-a"), 3.1) is None
    assert crop.region_for_frame(size, (size, "scene-b"), 0.2) is None


def test_crop_reacquires_when_text_reaches_an_interior_edge():
    region = (100, 200, 900, 500)
    assert AdaptiveOverlayCrop.needs_full_scan([_line("growing left", 4, 60, 250, 110)], None, region, (1000, 600))
    assert not AdaptiveOverlayCrop.needs_full_scan(
        [_line("at screen edge", 4, 60, 250, 110)], None, (0, 200, 900, 500), (1000, 600)
    )


def test_periodic_scan_prefers_dense_dialogue_over_one_long_ui_line():
    crop = AdaptiveOverlayCrop()
    size = (1000, 600)
    crop.region_for_frame(size, (size, "scene"), 0.0)
    crop.observe(
        [
            _line("unrelated interface text is quite long", 80, 80, 600, 115),
            _line("the dialogue starts right here", 100, 450, 760, 485),
            _line("and continues on this line", 100, 490, 690, 525),
        ],
        size,
        None,
        0.0,
        full_scan=True,
    )

    region = crop.region_for_frame(size, (size, "scene"), 0.1)
    assert region is not None and region[1] > 250


def test_shift_ocr_boxes_rebases_rotated_line_and_word_coordinates():
    lines = [
        {
            "text": "台詞",
            "bounding_rect": {"x1": 2, "y1": 3, "x2": 10, "y2": 4, "x3": 9, "y3": 20, "x4": 1, "y4": 19},
            "words": [{"text": "台", "bounding_rect": {"x1": 2, "y1": 3, "x3": 5, "y3": 20}}],
        }
    ]

    shift_ocr_boxes(lines, 400, 500)

    assert lines[0]["bounding_rect"] == {
        "x1": 402,
        "y1": 503,
        "x2": 410,
        "y2": 504,
        "x3": 409,
        "y3": 520,
        "x4": 401,
        "y4": 519,
    }
    assert lines[0]["words"][0]["bounding_rect"]["x3"] == 405


def test_adaptive_overlay_retry_uses_smaller_image_and_keeps_screen_coordinates(monkeypatch):
    processor = get_overlay_coords.OverlayProcessor()
    processor.ocr_language = "en"
    clock = SimpleNamespace(now=0.0)
    phase = SimpleNamespace(value="growth")
    sizes = []
    sent = []
    config = SimpleNamespace(
        adaptive_ocr_retries=True,
        text_appears_instantly=False,
        use_overlay_area_config=False,
        use_text_filtering=True,
    )

    async def fake_sleep(delay):
        clock.now += delay

    async def send(payload):
        sent.append(copy.deepcopy(payload))

    def capture():
        return Image.new("RGB", (1000, 600), "white"), 30, 40, 1000, 600

    def recognize(image, **_kwargs):
        sizes.append(image.size)
        if phase.value == "moved" and image.size == (1000, 600):
            lines = [_line("new dialogue", 100, 80, 520, 120)]
        elif phase.value == "moved":
            left, top, _, _ = processor._adaptive_crop.box
            lines = [_line("old dialogue", 100 - left, 450 - top, 600 - left, 500 - top)]
        elif len(sizes) == 1:
            lines = [_line("noise", 100, 80, 500, 120), _line("dialogue", 100, 450, 600, 500)]
        else:
            left, top, _, _ = processor._adaptive_crop.box
            lines = [_line("dialogue grows", 100 - left, 450 - top, 720 - left, 500 - top)]
        rect = lines[-1]["bounding_rect"]
        coords = (rect["x1"], rect["y1"], rect["x3"], rect["y3"])
        return True, [line["text"] for line in lines], lines, [coords], coords, {"lines": copy.deepcopy(lines)}

    recognize.readable_name = "Fake OCR"
    processor.oneocr = recognize
    monkeypatch.setattr(
        get_overlay_coords, "time", SimpleNamespace(time=lambda: clock.now, monotonic=lambda: clock.now)
    )
    monkeypatch.setattr(
        get_overlay_coords,
        "asyncio",
        SimpleNamespace(sleep=fake_sleep, current_task=asyncio.current_task, CancelledError=asyncio.CancelledError),
    )
    monkeypatch.setattr(get_overlay_coords, "get_overlay_config", lambda: config)
    monkeypatch.setattr(processor, "get_image_to_ocr", capture)
    monkeypatch.setattr(processor, "_get_effective_engine", lambda: "oneocr")
    monkeypatch.setattr(processor, "_is_supplement_mode_enabled", lambda: False)
    monkeypatch.setattr(processor, "_get_overlay_minimum_character_size", lambda: 0)
    monkeypatch.setattr(processor, "_filter_local_ocr_results_by_language", lambda lines: lines)
    monkeypatch.setattr(processor, "_apply_text_filtering_to_results", lambda response, _minimum: response["lines"])
    monkeypatch.setattr(processor, "_correct_ocr_with_backlog", lambda lines, reference: lines)
    monkeypatch.setattr(processor, "_send_word_coordinates_with_presence", send)
    monkeypatch.setattr(processor, "_record_overlay_scan", AsyncMock())
    monkeypatch.setattr(processor, "_should_stop_local_ocr_attempts", lambda *args: len(sizes) >= 2)

    asyncio.run(processor._do_work(source=TextSource.HOOKER, local_ocr_retry=2))

    assert sizes[0] == (1000, 600)
    assert sizes[1][0] <= 1000 and sizes[1][1] < 600
    assert len(sizes) == 2
    assert processor.last_raw_results[0]["bounding_rect"]["x1"] == 100
    assert processor.last_raw_results[0]["bounding_rect"]["y1"] == 450
    assert sent[-1]["data"][0]["bounding_rect"]["x1"] == 0.13

    phase.value = "moved"
    line = SimpleNamespace(id="next", text="new dialogue", source=TextSource.HOOKER)
    asyncio.run(processor._do_work(line=line, local_ocr_retry=2))

    assert sizes[2][1] < 600  # the saved focus is tried first
    assert sizes[3] == (1000, 600)  # a mismatched line reacquires on the same frame
    assert processor.last_raw_results[0]["bounding_rect"]["y1"] == 80
