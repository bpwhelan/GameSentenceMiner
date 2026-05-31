from __future__ import annotations

from datetime import datetime, timedelta

from PIL import Image, ImageDraw

from GameSentenceMiner.ocr.gsm_ocr import SecondPassResult, TwoPassConfig, TwoPassOCRControllerV2


def _make_time(offset_sec: int = 0) -> datetime:
    return datetime(2026, 2, 22, 12, 0, 0) + timedelta(seconds=offset_sec)


def _make_send(sent: list[dict]):
    def _send(text, time, *, response_dict=None, source=None):
        sent.append(
            {
                "text": text,
                "time": time,
                "response_dict": response_dict,
                "source": source,
            }
        )

    return _send


def _make_second_ocr(calls: list[dict], responses: list[str]):
    def _run(img, last_result, filtering, engine, **kw):
        calls.append(
            {
                "img": img,
                "last_result": last_result,
                "filtering": filtering,
                "engine": engine,
                **kw,
            }
        )
        response = responses[min(len(calls) - 1, len(responses) - 1)]
        return SecondPassResult(text=response, orig_text=[response], response_dict={"engine": engine})

    return _run


def _passthrough_filter(text, last_result, *, engine=None, is_second_ocr=False):
    return text, [text] if text else []


def _image_with_text(text: str) -> Image.Image:
    img = Image.new("RGB", (240, 80), "white")
    draw = ImageDraw.Draw(img)
    draw.text((20, 25), text, fill="black")
    return img


def _image_with_light_capture_noise(text: str) -> Image.Image:
    img = _image_with_text(text)
    draw = ImageDraw.Draw(img)
    draw.rectangle((125, 20, 170, 42), fill=(248, 248, 248))
    return img


def _make_controller(
    sent: list[dict],
    calls: list[dict],
    responses: list[str],
    *,
    text_appears_instantly: bool = False,
) -> TwoPassOCRControllerV2:
    return TwoPassOCRControllerV2(
        config=TwoPassConfig(
            two_pass_enabled=True,
            ocr1_engine="meiki_text_detector",
            ocr2_engine="glens",
            text_appears_instantly=text_appears_instantly,
        ),
        filtering=_passthrough_filter,
        send_result=_make_send(sent),
        run_second_ocr=_make_second_ocr(calls, responses),
        save_image=lambda *a, **kw: None,
        get_ocr2_image=lambda coords, img, extra_padding=0: img.crop(coords) if coords else img,
    )


def _make_queued_controller(queued: list[dict]) -> TwoPassOCRControllerV2:
    def _queue_second_pass(
        ocr1_text,
        stable_time,
        img,
        filtering,
        pre_crop_image=None,
        ignore_furigana_filter=False,
        ignore_previous_result=False,
        image_metadata=None,
        response_dict=None,
        source="ocr",
    ):
        queued.append(
            {
                "ocr1_text": ocr1_text,
                "stable_time": stable_time,
                "img": img,
                "filtering": filtering,
                "pre_crop_image": pre_crop_image,
                "ignore_furigana_filter": ignore_furigana_filter,
                "ignore_previous_result": ignore_previous_result,
                "image_metadata": image_metadata,
                "response_dict": response_dict,
                "source": source,
            }
        )
        return True

    return TwoPassOCRControllerV2(
        config=TwoPassConfig(
            two_pass_enabled=True,
            ocr1_engine="meiki_text_detector",
            ocr2_engine="glens",
        ),
        filtering=_passthrough_filter,
        queue_second_pass=_queue_second_pass,
        save_image=lambda *a, **kw: None,
        get_ocr2_image=lambda coords, img, extra_padding=0: img.crop(coords) if coords else img,
    )


def test_v2_text_stability_runs_second_ocr_before_text_disappears():
    sent: list[dict] = []
    calls: list[dict] = []
    ctrl = _make_controller(sent, calls, ["refined"])
    text = "今日はいい天気ですね。"
    img = _image_with_text(text)

    ctrl.handle_ocr_result(text, [text], _make_time(0), img)
    ctrl.handle_ocr_result(text, [text], _make_time(1), img)

    assert len(calls) == 1
    assert [item["text"] for item in sent] == ["refined"]


def test_v2_text_appears_instantly_runs_second_ocr_on_first_text_frame():
    sent: list[dict] = []
    calls: list[dict] = []
    ctrl = _make_controller(sent, calls, ["refined"], text_appears_instantly=True)
    text = "今日はいい天気ですね。"
    img = _image_with_text(text)

    ctrl.handle_ocr_result(text, [text], _make_time(0), img)

    assert len(calls) == 1
    assert [item["text"] for item in sent] == ["refined"]


def test_v2_text_growth_waits_for_final_stable_frame():
    sent: list[dict] = []
    calls: list[dict] = []
    ctrl = _make_controller(sent, calls, ["refined-full"])

    ctrl.handle_ocr_result("今日は", ["今日は"], _make_time(0), _image_with_text("今日は"))
    ctrl.handle_ocr_result("今日はいい天気", ["今日はいい天気"], _make_time(1), _image_with_text("今日はいい天気"))
    assert calls == []

    full = "今日はいい天気ですね。"
    img = _image_with_text(full)
    ctrl.handle_ocr_result(full, [full], _make_time(2), img)
    ctrl.handle_ocr_result(full, [full], _make_time(3), img)

    assert len(calls) == 1
    assert [item["text"] for item in sent] == ["refined-full"]


def test_v2_text_truncated_same_line_waits_for_blank_flush():
    queued: list[dict] = []
    ctrl = _make_queued_controller(queued)

    full = "「はやい、はやい」みすず"
    truncated = "はやい、はやい」"
    ctrl.handle_ocr_result(full, [full], _make_time(0), _image_with_text(full))
    ctrl.handle_ocr_result(truncated, [truncated], _make_time(1), _image_with_text(full))

    assert queued == []

    ctrl.handle_ocr_result("", [], _make_time(2), _image_with_text(""))
    assert len(queued) == 1
    assert queued[0]["ocr1_text"] == full


def test_v2_detector_same_coords_not_reocr_on_pixel_change():
    """Detector dedup is now purely box/coords based (no pixel signature):
    while a detection box stays at the same coords, its crop is OCR'd once and
    not re-OCR'd even if the cropped pixels change. Re-OCR only happens after
    the box disappears (see ``..._reocr_after_box_disappears``)."""
    sent: list[dict] = []
    calls: list[dict] = []
    ctrl = _make_controller(sent, calls, ["first-refined", "second-refined"])
    coords = (10, 10, 180, 60)

    first_img = _image_with_text("first")
    ctrl.handle_ocr_result("", [], _make_time(0), first_img, detection_boxes=[{"box": coords}], crop_coords=coords)
    ctrl.handle_ocr_result("", [], _make_time(1), first_img, detection_boxes=[{"box": coords}], crop_coords=coords)
    ctrl.handle_ocr_result("", [], _make_time(2), first_img, detection_boxes=[{"box": coords}], crop_coords=coords)
    ctrl.handle_ocr_result("", [], _make_time(3), first_img, detection_boxes=[{"box": coords}], crop_coords=coords)

    second_img = _image_with_text("second")
    ctrl.handle_ocr_result("", [], _make_time(4), second_img, detection_boxes=[{"box": coords}], crop_coords=coords)
    ctrl.handle_ocr_result("", [], _make_time(5), second_img, detection_boxes=[{"box": coords}], crop_coords=coords)

    assert len(calls) == 1
    assert [item["text"] for item in sent] == ["first-refined"]


def test_v2_detector_reocr_after_box_disappears():
    """Re-OCR at the same coords is allowed once the box disappears and
    reappears (the disappearance clears the latched last-detection coords)."""
    sent: list[dict] = []
    calls: list[dict] = []
    ctrl = _make_controller(sent, calls, ["first-refined", "second-refined"])
    coords = (10, 10, 180, 60)

    first_img = _image_with_text("first")
    ctrl.handle_ocr_result("", [], _make_time(0), first_img, detection_boxes=[{"box": coords}], crop_coords=coords)
    ctrl.handle_ocr_result("", [], _make_time(1), first_img, detection_boxes=[{"box": coords}], crop_coords=coords)

    # Box disappears, then a (changed) box reappears at the same coords.
    ctrl.handle_ocr_result("", [], _make_time(2), first_img, detection_boxes=[], crop_coords=None)
    second_img = _image_with_text("second")
    ctrl.handle_ocr_result("", [], _make_time(3), second_img, detection_boxes=[{"box": coords}], crop_coords=coords)
    ctrl.handle_ocr_result("", [], _make_time(4), second_img, detection_boxes=[{"box": coords}], crop_coords=coords)

    assert len(calls) == 2
    assert [item["text"] for item in sent] == ["first-refined", "second-refined"]


def test_v2_detector_same_coords_ignores_minor_capture_noise():
    sent: list[dict] = []
    calls: list[dict] = []
    ctrl = _make_controller(sent, calls, ["first-refined", "unexpected-repeat"])
    coords = (10, 10, 180, 60)

    first_img = _image_with_text("first")
    ctrl.handle_ocr_result("", [], _make_time(0), first_img, detection_boxes=[{"box": coords}], crop_coords=coords)
    ctrl.handle_ocr_result("", [], _make_time(1), first_img, detection_boxes=[{"box": coords}], crop_coords=coords)

    noisy_img = _image_with_light_capture_noise("first")
    ctrl.handle_ocr_result("", [], _make_time(2), noisy_img, detection_boxes=[{"box": coords}], crop_coords=coords)
    ctrl.handle_ocr_result("", [], _make_time(3), noisy_img, detection_boxes=[{"box": coords}], crop_coords=coords)

    assert len(calls) == 1
    assert [item["text"] for item in sent] == ["first-refined"]


def test_v2_detector_same_crop_not_requeued_while_lens_in_flight():
    queued: list[dict] = []
    ctrl = _make_queued_controller(queued)
    coords = (10, 10, 180, 60)

    first_img = _image_with_text("first")
    ctrl.handle_ocr_result("", [], _make_time(0), first_img, detection_boxes=[{"box": coords}], crop_coords=coords)
    ctrl.handle_ocr_result("", [], _make_time(1), first_img, detection_boxes=[{"box": coords}], crop_coords=coords)

    changed_img = _image_with_text("second")
    ctrl.handle_ocr_result("", [], _make_time(2), changed_img, detection_boxes=[{"box": coords}], crop_coords=coords)
    ctrl.handle_ocr_result("", [], _make_time(3), changed_img, detection_boxes=[{"box": coords}], crop_coords=coords)

    assert len(queued) == 1


def test_v2_detector_same_coords_suppressed_after_completion():
    """Marking OCR2 complete clears only the in-flight latch; the same coords
    stay suppressed by the last-detection coords, so a changed crop at the same
    position is not requeued while the box persists (box/coords-only dedup)."""
    queued: list[dict] = []
    ctrl = _make_queued_controller(queued)
    coords = (10, 10, 180, 60)

    first_img = _image_with_text("first")
    ctrl.handle_ocr_result("", [], _make_time(0), first_img, detection_boxes=[{"box": coords}], crop_coords=coords)
    ctrl.handle_ocr_result("", [], _make_time(1), first_img, detection_boxes=[{"box": coords}], crop_coords=coords)
    ctrl.mark_v2_detection_ocr2_complete(coords, duplicate=False)

    changed_img = _image_with_text("second")
    ctrl.handle_ocr_result("", [], _make_time(2), changed_img, detection_boxes=[{"box": coords}], crop_coords=coords)
    ctrl.handle_ocr_result("", [], _make_time(3), changed_img, detection_boxes=[{"box": coords}], crop_coords=coords)

    assert len(queued) == 1


def test_v2_detector_duplicate_latches_same_crop_until_box_disappears():
    queued: list[dict] = []
    ctrl = _make_queued_controller(queued)
    coords = (10, 10, 180, 60)

    img = _image_with_text("first")
    ctrl.handle_ocr_result("", [], _make_time(0), img, detection_boxes=[{"box": coords}], crop_coords=coords)
    ctrl.handle_ocr_result("", [], _make_time(1), img, detection_boxes=[{"box": coords}], crop_coords=coords)
    ctrl.mark_v2_detection_ocr2_complete(coords, duplicate=True)

    noisy_img = _image_with_light_capture_noise("first")
    ctrl.handle_ocr_result("", [], _make_time(2), noisy_img, detection_boxes=[{"box": coords}], crop_coords=coords)
    ctrl.handle_ocr_result("", [], _make_time(3), noisy_img, detection_boxes=[{"box": coords}], crop_coords=coords)
    assert len(queued) == 1

    ctrl.handle_ocr_result("", [], _make_time(4), img, detection_boxes=[], crop_coords=None)
    ctrl.handle_ocr_result("", [], _make_time(5), img, detection_boxes=[{"box": coords}], crop_coords=coords)
    ctrl.handle_ocr_result("", [], _make_time(6), img, detection_boxes=[{"box": coords}], crop_coords=coords)

    assert len(queued) == 2


def test_v2_garbled_growing_edge_not_flushed_early():
    """A hallucinated trailing char mid-evolution must not trigger OCR2 early.

    Regression: OneOCR read 熱 as 热Ｃ; the controller treated the next (longer)
    frame as a brand-new line and flushed the stale partial frame to OCR2.
    """
    queued: list[dict] = []
    ctrl = _make_queued_controller(queued)

    frames = [
        "無理を",
        "無理をすると、すぐに热Ｃ",
        "無理をすると、すぐに熱をだして、肺に六",
        "無理をすると、すぐに熱をだして、肺に穴が空いた。",
    ]
    for i, f in enumerate(frames):
        ctrl.handle_ocr_result(f, [f], _make_time(i), _image_with_text(f))
        assert queued == [], f"flushed early at frame {i}: {f}"

    # Line settles (same final frame again) -> exactly one OCR2 with the full text.
    full = frames[-1]
    ctrl.handle_ocr_result(full, [full], _make_time(len(frames)), _image_with_text(full))
    assert len(queued) == 1
    assert queued[0]["ocr1_text"] == full


def test_v2_lean_evolving_keeps_same_line_on_low_fuzzy_score():
    """When the fuzzy evolving score fails but a long literal prefix is shared,
    the frame is kept as the same evolving line rather than flushed."""
    queued: list[dict] = []
    ctrl = _make_queued_controller(queued)

    prev = "ヒルコ「そりや"
    grown = "ヒルコ「そりゃ許せないよな、こいつは"
    ctrl.handle_ocr_result(prev, [prev], _make_time(0), _image_with_text(prev))
    ctrl.handle_ocr_result(grown, [grown], _make_time(1), _image_with_text(grown))
    assert queued == []


def test_v2_max_pending_age_forces_flush_when_never_stable():
    """A line that keeps evolving (never two stable frames) must still flush
    once it exceeds the max pending age, rather than stalling forever."""
    queued: list[dict] = []
    ctrl = _make_queued_controller(queued)
    ctrl.max_pending_age_seconds = 4.0

    target = "一二三四五六七八九十百千万円冊頁巻章節項"  # 20 distinct chars
    for i, n in enumerate((5, 8, 11, 14)):  # evolving, never stable (≥3 new chars each)
        f = target[:n]
        ctrl.handle_ocr_result(f, [f], _make_time(i), _image_with_text(f))
    assert queued == []  # still within the 4s window

    f = target[:17]
    ctrl.handle_ocr_result(f, [f], _make_time(4), _image_with_text(f))  # age == 4s
    assert len(queued) == 1
    assert queued[0]["ocr1_text"] == target[:17]


def test_v2_box_stability_triggers_ocr2_despite_text_hallucination():
    """When OCR1 supplies a stable text bounding box, OCR2 fires once the box
    holds still for stable_frame_count frames — even if the OCR1 text keeps
    hallucinating a different last character every frame (never two identical,
    never a clean prefix-evolution). Reuses coords-stability, no pixel hash."""
    queued: list[dict] = []
    ctrl = _make_queued_controller(queued)
    coords = (10, 10, 180, 60)

    variants = ["テスト文章あ", "テスト文章ぃ", "テスト文章ぅ"]
    ctrl.handle_ocr_result(variants[0], [variants[0]], _make_time(0), _image_with_text(variants[0]), crop_coords=coords)
    assert queued == []  # one frame of a stable box is not enough
    ctrl.handle_ocr_result(variants[1], [variants[1]], _make_time(1), _image_with_text(variants[1]), crop_coords=coords)
    assert len(queued) == 1  # box held still for 2 frames -> OCR2


def test_v2_box_stability_inactive_without_crop_coords():
    """Box-stability must not fire when OCR1 supplies no crop coords; behaviour
    falls back to text-only stabilization."""
    queued: list[dict] = []
    ctrl = _make_queued_controller(queued)

    variants = ["テスト文章あ", "テスト文章ぃ", "テスト文章ぅ"]
    for i, v in enumerate(variants):
        ctrl.handle_ocr_result(v, [v], _make_time(i), _image_with_text(v))
    assert queued == []


def test_v2_box_growth_does_not_trigger_until_box_settles():
    """A growing box (text still spooling) keeps resetting box stability, so
    OCR2 is not triggered until the box stops growing."""
    queued: list[dict] = []
    ctrl = _make_queued_controller(queued)

    # Box width grows each frame (text spooling) -> never box-stable.
    for i, w in enumerate((40, 80, 120)):
        f = "今日" + "は" * (i + 1)
        ctrl.handle_ocr_result(f, [f], _make_time(i), _image_with_text(f), crop_coords=(10, 10, 10 + w, 60))
    assert queued == []

    # Box settles at a fixed width for two frames -> trigger.
    settled = "今日はおはよう"
    ctrl.handle_ocr_result(settled, [settled], _make_time(3), _image_with_text(settled), crop_coords=(10, 10, 160, 60))
    ctrl.handle_ocr_result(settled, [settled], _make_time(4), _image_with_text(settled), crop_coords=(10, 10, 160, 60))
    assert len(queued) == 1


def test_v2_line_wrap_dropped_prefix_does_not_flush_early():
    """When a line wraps (or OCR1 momentarily drops the leading line), the new
    frame's text is disjoint from the pending. The controller must NOT flush the
    half-rendered pending; it waits until the text settles, then fires once.

    Regression for: OCR2 fired on `ヒルコ「…僕は` when OneOCR dropped the upper
    line and returned only `はもう絶対、失敗な` for one frame.
    """
    queued: list[dict] = []
    ctrl = _make_queued_controller(queued)
    line1 = "ヒルコ『僕の願いが叶えば、みんな、幸せになれるんだ。僕は"

    ctrl.handle_ocr_result(
        "ヒルコ『僕", ["ヒルコ『僕"], _make_time(0), _image_with_text("x"), crop_coords=(10, 10, 120, 40)
    )
    ctrl.handle_ocr_result(line1, [line1], _make_time(1), _image_with_text("x"), crop_coords=(10, 10, 560, 40))
    # Wrap frame: OCR dropped line 1, only the lower line is read (disjoint).
    drop = "はもう絶対、失敗な"
    ctrl.handle_ocr_result(drop, [drop], _make_time(2), _image_with_text("x"), crop_coords=(10, 46, 200, 76))
    assert queued == [], "must not flush the half-rendered pending on a wrap/drop"

    # Lower line finishes, then settles (stable repeat) -> exactly one OCR2.
    full2 = "はもう絶対、失敗なんかしないよ」"
    ctrl.handle_ocr_result(full2, [full2], _make_time(3), _image_with_text("x"), crop_coords=(10, 46, 360, 76))
    ctrl.handle_ocr_result(full2, [full2], _make_time(4), _image_with_text("x"), crop_coords=(10, 46, 360, 76))
    assert len(queued) == 1


def test_v2_genuine_new_line_still_flushes_after_previous_settled():
    """A genuinely new line is still captured: the previous line flushes when it
    stabilizes, and the new line flushes when it stabilizes."""
    queued: list[dict] = []
    ctrl = _make_queued_controller(queued)

    a = "おはようございます。"
    ctrl.handle_ocr_result(a, [a], _make_time(0), _image_with_text("x"), crop_coords=(10, 10, 200, 40))
    ctrl.handle_ocr_result(a, [a], _make_time(1), _image_with_text("x"), crop_coords=(10, 10, 200, 40))
    assert len(queued) == 1  # A settled -> flushed

    b = "いってきます。"
    ctrl.handle_ocr_result(b, [b], _make_time(2), _image_with_text("x"), crop_coords=(10, 10, 180, 40))
    ctrl.handle_ocr_result(b, [b], _make_time(3), _image_with_text("x"), crop_coords=(10, 10, 180, 40))
    assert len(queued) == 2  # B settled -> flushed too


def test_v2_text_appears_instantly_detector_runs_second_ocr_on_first_box():
    sent: list[dict] = []
    calls: list[dict] = []
    ctrl = _make_controller(sent, calls, ["first-refined"], text_appears_instantly=True)
    coords = (10, 10, 180, 60)
    img = _image_with_text("first")

    ctrl.handle_ocr_result("", [], _make_time(0), img, detection_boxes=[{"box": coords}], crop_coords=coords)

    assert len(calls) == 1
    assert [item["text"] for item in sent] == ["first-refined"]
